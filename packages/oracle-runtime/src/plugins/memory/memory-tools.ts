import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { z } from 'zod';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import { buildMemoryHeaders } from './memory-ucan.js';

/**
 * Tool names the upstream Memory Engine MCP server exposes (prefixed with the
 * server name configured in `MultiServerMCPClient`). The plugin surfaces these
 * upstream tools as-is — name, description, and schema all come from the
 * upstream server. Wrapping them locally with a different shape (as an earlier
 * iteration did) caused upstream-side schema rejections at invoke time
 * because the wrapper schema didn't match the server's contract.
 */
export const MEMORY_SEARCH_MCP_NAME = 'memory-engine__search_memory_engine';
export const MEMORY_ADD_MCP_NAME = 'memory-engine__add_memory';
export const MEMORY_ADD_ORACLE_KNOWLEDGE_MCP_NAME =
  'memory-engine__add_oracle_knowledge';
export const MEMORY_DELETE_EPISODE_MCP_NAME = 'memory-engine__delete_episode';
export const MEMORY_DELETE_EDGE_MCP_NAME = 'memory-engine__delete_edge';
export const MEMORY_CLEAR_MCP_NAME = 'memory-engine__clear';

/**
 * Default selection: search, add, delete-episode, and clear — the user must
 * always be able to ask for a full memory wipe, so the destructive `clear`
 * stays in the default set. Forks that need org-owner knowledge writes (or
 * want to drop `clear`) pass an explicit list via plugin options.
 */
export const DEFAULT_MEMORY_TOOLS = [
  MEMORY_SEARCH_MCP_NAME,
  MEMORY_ADD_MCP_NAME,
  MEMORY_DELETE_EPISODE_MCP_NAME,
  MEMORY_CLEAR_MCP_NAME,
] as const;

/**
 * Minimal shape every upstream MCP tool exposes. `@langchain/mcp-adapters`
 * returns `StructuredTool` instances whose runtime shape includes these
 * fields. The plugin only depends on this slice; tests can satisfy it with a
 * plain object.
 */
export interface UpstreamMcpTool {
  name: string;
  description: string;
  schema: z.ZodType;
  invoke: (input: unknown) => Promise<unknown>;
}

export type MemoryMcpFactory = (
  runCtx: RuntimeContext,
) => Promise<UpstreamMcpTool[] | null>;

/**
 * Tool *definitions* (name/description/schema) published by a Memory Engine
 * MCP server. User-independent — the per-user part of a memory call is the
 * auth headers, which are minted per request and applied at invoke time.
 */
interface MemoryToolDef {
  name: string;
  description: string;
  schema: z.ZodType;
}

interface CachedToolDefs {
  defs: MemoryToolDef[];
  expiresAt: number;
}

/**
 * Definitions change only when the upstream server deploys, so a short TTL
 * keeps the surface fresh while taking the MCP connect + tools/list network
 * round-trip off nearly every chat turn.
 */
const TOOL_DEFS_TTL_MS = 5 * 60 * 1000;

/** Cached upstream definitions, keyed by MCP URL. */
const toolDefsCache = new Map<string, CachedToolDefs>();

/**
 * MCP URLs with a background definition refresh in flight. Guards against a
 * burst of turns each spawning its own connect when an entry expires.
 */
const refreshInFlight = new Set<string>();

/** Test hook: drop all cached upstream tool definitions. */
export function clearMemoryToolDefsCache(): void {
  toolDefsCache.clear();
  refreshInFlight.clear();
}

async function connectAndListTools(
  memoryMcpUrl: string,
  headers: Record<string, string>,
): Promise<UpstreamMcpTool[]> {
  const client = new MultiServerMCPClient({
    useStandardContentBlocks: true,
    prefixToolNameWithServerName: true,
    mcpServers: {
      'memory-engine': {
        type: 'http',
        transport: 'http',
        url: memoryMcpUrl,
        headers,
        reconnect: {
          enabled: true,
          maxAttempts: 3,
          delayMs: 2000,
        },
        defaultToolTimeout: 420_000,
      },
    },
  });
  return (await client.getTools()) as unknown as UpstreamMcpTool[];
}

/**
 * Bind cached definitions to this request's auth headers. The MCP client is
 * created lazily on the first actual invocation (and shared across the
 * request's memory tools), so turns that never touch memory pay zero
 * Memory-Engine round-trips.
 */
function buildLazyUpstreamTools(
  defs: MemoryToolDef[],
  memoryMcpUrl: string,
  headers: Record<string, string>,
): UpstreamMcpTool[] {
  let upstreamByName: Promise<Map<string, UpstreamMcpTool>> | null = null;
  const connect = (): Promise<Map<string, UpstreamMcpTool>> => {
    if (!upstreamByName) {
      upstreamByName = connectAndListTools(memoryMcpUrl, headers).then(
        (tools) => new Map(tools.map((t) => [t.name, t])),
      );
      // A failed connect must not poison the rest of the run — clear the
      // memo so a later invocation retries with a fresh client.
      upstreamByName.catch(() => {
        upstreamByName = null;
      });
    }
    return upstreamByName;
  };

  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    schema: def.schema,
    invoke: async (input: unknown) => {
      const byName = await connect();
      const upstream = byName.get(def.name);
      if (!upstream) {
        throw new Error(
          `Memory Engine no longer exposes "${def.name}" — cached definition is stale, retry shortly.`,
        );
      }
      return upstream.invoke(input);
    },
  }));
}

/**
 * Default factory: authenticates with the per-request UCAN headers from
 * {@link buildMemoryHeaders}, then serves the upstream tool list.
 *
 * The first request per process connects and lists tools exactly like the
 * old always-fetch path, then snapshots the definitions. Subsequent requests
 * skip the network entirely and bind lazy tools that open their own
 * authenticated client only when the agent actually calls one. An EXPIRED
 * entry is served as-is (definitions only change on upstream deploys) while
 * a background refresh re-snapshots it — TTL expiry never lands the
 * connect + tools/list round-trip on a chat turn. Auth semantics are
 * unchanged: header minting still happens (and gates the tool surface) on
 * every request.
 */
export function createDefaultMemoryMcpFactory(
  memoryMcpUrl: string,
): MemoryMcpFactory {
  return async (runCtx) => {
    const headers = await buildMemoryHeaders(runCtx, memoryMcpUrl);
    if (!headers) return null;

    const cached = toolDefsCache.get(memoryMcpUrl);
    if (cached) {
      if (
        cached.expiresAt <= Date.now() &&
        !refreshInFlight.has(memoryMcpUrl)
      ) {
        refreshInFlight.add(memoryMcpUrl);
        void connectAndListTools(memoryMcpUrl, headers)
          .then((tools) => {
            toolDefsCache.set(memoryMcpUrl, {
              defs: tools.map(({ name, description, schema }) => ({
                name,
                description,
                schema,
              })),
              expiresAt: Date.now() + TOOL_DEFS_TTL_MS,
            });
          })
          .catch((err: unknown) => {
            // Keep serving the stale defs; the next expired-cache turn
            // retries the refresh.
            runCtx.logger.warn(
              `[memory] background tool-defs refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .finally(() => {
            refreshInFlight.delete(memoryMcpUrl);
          });
      }
      return buildLazyUpstreamTools(cached.defs, memoryMcpUrl, headers);
    }

    const tools = await connectAndListTools(memoryMcpUrl, headers);
    toolDefsCache.set(memoryMcpUrl, {
      defs: tools.map(({ name, description, schema }) => ({
        name,
        description,
        schema,
      })),
      expiresAt: Date.now() + TOOL_DEFS_TTL_MS,
    });
    return tools;
  };
}

/**
 * Adapt one upstream MCP tool into a `PluginTool`. Name, description, and
 * schema are taken VERBATIM from upstream — the agent sees the same contract
 * the Memory Engine server publishes, and our handler is a thin passthrough
 * to `mcpTool.invoke`.
 */
function adaptMcpTool(mcpTool: UpstreamMcpTool): PluginTool {
  return {
    name: mcpTool.name,
    description: mcpTool.description,
    schema: mcpTool.schema,
    handler: async (args) => mcpTool.invoke(args),
  };
}

/**
 * Fetch the upstream Memory Engine MCP tools for this request and return them
 * as `PluginTool[]`. Filtered by `selectedTools` so forks can scope the
 * surface (e.g. drop `clear`, add `add_oracle_knowledge` for org-owner mode).
 *
 * Returns `[]` when the factory cannot mint auth — the agent then sees no
 * memory tools rather than getting a half-built request to upstream.
 */
export async function fetchMemoryTools(
  runCtx: RuntimeContext,
  factory: MemoryMcpFactory,
  selectedTools: readonly string[] = DEFAULT_MEMORY_TOOLS,
): Promise<PluginTool[]> {
  const mcpTools = await factory(runCtx);
  if (!mcpTools) return [];

  const allow = new Set(selectedTools);
  return mcpTools.filter((t) => allow.has(t.name)).map(adaptMcpTool);
}
