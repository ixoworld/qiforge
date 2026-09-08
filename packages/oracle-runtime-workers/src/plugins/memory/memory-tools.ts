import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { clientSchemaToZod } from '../../core/utils';
import { withCallTimeout } from '../mcp-call-timeout';
import type { z } from 'zod';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';
import { adaptMcpClientTools } from '../mcp-tool-adapter';
import { buildMemoryHeaders } from './memory-ucan';

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
 * Minimal shape every upstream MCP tool exposes after adaptation
 * ({@link adaptMcpClientTools} normalises the client's JSON-Schema tools to
 * this). The plugin only depends on this slice; tests can satisfy it with a
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

/** Cached upstream definitions, keyed by MCP URL (per isolate). */
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

/**
 * How long a request's MCP client survives after its last invocation before
 * being closed. There is no explicit request-end hook on the tool path, so
 * idle-close is what bounds client lifetime — without it every turn that
 * touched memory leaked a connected client (transport, sessions, tool set)
 * for the life of the isolate.
 */
const IDLE_CLIENT_CLOSE_MS = 5 * 60 * 1000;
/** Our own per-call limit (never given to the SDK — see `mcp-call-timeout.ts`). */
const MEMORY_TOOL_TIMEOUT_MS = 420_000;

function createMemoryMcpClient(
  memoryMcpUrl: string,
  headers: Record<string, string>,
): MultiServerMCPClient {
  return new MultiServerMCPClient({
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
      },
    },
  });
}

/**
 * Connect, snapshot the upstream tool *definitions*, and always close the
 * client — defs are plain data, so the connection has nothing left to serve.
 */
/**
 * Log the raw upstream schema of `search_memory_engine` once per isolate —
 * the artefact that settles whether an enum reached the model or a
 * conversion fallback threw it away.
 */
let schemaDump: MemorySchemaDump | null = null;

export interface MemorySchemaDump {
  tool: string;
  toolCount: number;
  /** `JSON.stringify` of the schema exactly as `client.getTools()` handed it over. */
  rawSchema: string;
  /** Whether `clientSchemaToZod` accepts it (false = permissive-record fallback). */
  convertible: boolean;
  capturedAt: string;
}

/** The last captured upstream schema in this isolate (`GET /debug/storage`). */
export function getMemorySchemaDump(): MemorySchemaDump | null {
  return schemaDump;
}

/** Snapshot `search_memory_engine`'s raw schema + whether it converts. */
export function buildMemorySchemaDump(
  tools: ReadonlyArray<{ name: string; schema?: unknown }>,
): MemorySchemaDump | null {
  const tool = tools.find((t) => t.name.endsWith('search_memory_engine'));
  if (!tool) return null;
  let text: string;
  try {
    text = JSON.stringify(tool.schema);
  } catch {
    text = String(tool.schema);
  }
  const convertible =
    typeof tool.schema === 'object' &&
    tool.schema !== null &&
    clientSchemaToZod(tool.schema as Record<string, unknown>, tool.name) !==
      null;
  return {
    tool: tool.name,
    toolCount: tools.length,
    rawSchema: text.slice(0, 8000),
    convertible,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * On-demand capture for `GET /debug/memory-schema`: connect with the given
 * auth headers, snapshot the tool schema, close.
 */
export async function fetchMemorySchemaDump(
  memoryMcpUrl: string,
  headers: Record<string, string>,
): Promise<MemorySchemaDump | null> {
  const client = createMemoryMcpClient(memoryMcpUrl, headers);
  try {
    const dump = buildMemorySchemaDump(await client.getTools());
    if (dump) schemaDump = dump;
    return dump;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function dumpSchemaOnce(
  tools: ReadonlyArray<{ name: string; schema?: unknown }>,
): void {
  if (schemaDump) return;
  const tool = tools.find((t) => t.name.endsWith('search_memory_engine'));
  if (!tool) return;
  let text: string;
  try {
    text = JSON.stringify(tool.schema);
  } catch {
    text = String(tool.schema);
  }
  const convertible =
    typeof tool.schema === 'object' &&
    tool.schema !== null &&
    clientSchemaToZod(tool.schema as Record<string, unknown>, tool.name) !==
      null;
  schemaDump = {
    tool: tool.name,
    toolCount: tools.length,
    rawSchema: text.slice(0, 8000),
    convertible,
    capturedAt: new Date().toISOString(),
  };
  console.log(
    `[memory] raw schema of ${tool.name} (${tools.length} tools, convertible=${convertible}): ${text.slice(0, 4000)}`,
  );
}

async function listToolDefs(
  memoryMcpUrl: string,
  headers: Record<string, string>,
): Promise<MemoryToolDef[]> {
  const client = createMemoryMcpClient(memoryMcpUrl, headers);
  try {
    const raw = await client.getTools();
    dumpSchemaOnce(raw);
    const tools = adaptMcpClientTools(raw, console);
    return tools.map(({ name, description, schema }) => ({
      name,
      description,
      schema,
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Bind cached definitions to this request's auth headers. The MCP client is
 * created lazily on the first actual invocation (and shared across the
 * request's memory tools), so turns that never touch memory pay zero
 * Memory-Engine round-trips. The client is closed after
 * `IDLE_CLIENT_CLOSE_MS` without an invocation; a later call simply
 * reconnects.
 */
function buildLazyUpstreamTools(
  defs: MemoryToolDef[],
  memoryMcpUrl: string,
  headers: Record<string, string>,
  onTurnEnd?: (dispose: () => void | Promise<void>) => void,
): UpstreamMcpTool[] {
  let connection: Promise<{
    client: MultiServerMCPClient;
    byName: Map<string, UpstreamMcpTool>;
  }> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const closeConnection = (): void => {
    const current = connection;
    connection = null;
    console.log(`[memory] closing MCP client (${current ? 'open' : 'none'})`);
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (!current) return;
    void current
      .then(({ client }) => client.close())
      .then(
        () => console.log('[memory] MCP client closed'),
        (err: unknown) =>
          console.warn(
            `[memory] MCP client close failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
      );
  };

  // Close when the turn ends (the client is per request anyway). The idle
  // timer is only the fallback for hosts without a turn-end hook: a pending
  // timer keeps a Durable Object resident and blocks hibernation.
  const scheduleIdleClose = (): void => {
    if (onTurnEnd) return;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(closeConnection, IDLE_CLIENT_CLOSE_MS);
  };
  let closeRegistered = false;
  const registerTurnEndClose = (): void => {
    if (!onTurnEnd || closeRegistered) return;
    closeRegistered = true;
    onTurnEnd(() => closeConnection());
  };

  const connect = (): NonNullable<typeof connection> => {
    if (!connection) {
      registerTurnEndClose();
      connection = (async () => {
        const client = createMemoryMcpClient(memoryMcpUrl, headers);
        try {
          const tools = adaptMcpClientTools(await client.getTools(), console);
          return { client, byName: new Map(tools.map((t) => [t.name, t])) };
        } catch (error) {
          await client.close().catch(() => undefined);
          throw error;
        }
      })();
      // A failed connect must not poison the rest of the run — clear the
      // memo so a later invocation retries with a fresh client.
      connection.catch(() => {
        connection = null;
      });
    }
    return connection;
  };

  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    schema: def.schema,
    invoke: async (input: unknown) => {
      const { byName } = await connect();
      const upstream = byName.get(def.name);
      if (!upstream) {
        scheduleIdleClose();
        throw new Error(
          `Memory Engine no longer exposes "${def.name}" — cached definition is stale, retry shortly.`,
        );
      }
      const startedAt = Date.now();
      try {
        return await withCallTimeout(
          () => upstream.invoke(input),
          MEMORY_TOOL_TIMEOUT_MS,
          `memory tool ${def.name}`,
          closeConnection,
        );
      } catch (error) {
        // The SSE layer only sees "tool did not complete" for a thrown tool;
        // the reason has to be in the object's logs.
        console.warn(
          `[memory] tool ${def.name} failed after ${Date.now() - startedAt} ms: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw error;
      } finally {
        scheduleIdleClose();
      }
    },
  }));
}

/**
 * Default factory: authenticates with the per-request UCAN headers from
 * {@link buildMemoryHeaders}, then serves the upstream tool list.
 *
 * The first request per isolate connects and lists tools exactly like the
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
        void listToolDefs(memoryMcpUrl, headers)
          .then((defs) => {
            toolDefsCache.set(memoryMcpUrl, {
              defs,
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
      return buildLazyUpstreamTools(
        cached.defs,
        memoryMcpUrl,
        headers,
        runCtx.onTurnEnd,
      );
    }

    const defs = await listToolDefs(memoryMcpUrl, headers);
    toolDefsCache.set(memoryMcpUrl, {
      defs,
      expiresAt: Date.now() + TOOL_DEFS_TTL_MS,
    });
    // Cold path binds lazy tools too (instead of returning tools tied to the
    // listing client, which is closed above) — the first actual invocation
    // reconnects, exactly like the warm path.
    return buildLazyUpstreamTools(
      defs,
      memoryMcpUrl,
      headers,
      runCtx.onTurnEnd,
    );
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
