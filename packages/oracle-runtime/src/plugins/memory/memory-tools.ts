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
 * Default selection — mirrors the old `apps/app` Memory Agent default: search,
 * add, and delete-episode. Forks that need org-owner knowledge writes or the
 * destructive `clear` op pass an explicit list via plugin options.
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
 * Default factory: opens an HTTP MCP client to `MEMORY_MCP_URL` with the
 * per-request UCAN headers from {@link buildMemoryHeaders} and returns the
 * upstream's tool list. A fresh client per request mirrors the old apps/app
 * pattern and ensures each invocation runs against the authenticated user.
 */
export function createDefaultMemoryMcpFactory(
  memoryMcpUrl: string,
): MemoryMcpFactory {
  return async (runCtx) => {
    const headers = await buildMemoryHeaders(runCtx, memoryMcpUrl);
    if (!headers) return null;

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
          defaultToolTimeout: 420_000
        },
      },
    });
    return (await client.getTools()) as unknown as UpstreamMcpTool[];
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
