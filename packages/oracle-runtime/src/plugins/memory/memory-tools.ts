import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import { buildMemoryHeaders } from './memory-ucan.js';

/**
 * Minimal surface a Memory Engine MCP tool needs to expose to be proxied: an
 * identifier and an `invoke` method. `MultiServerMCPClient.getTools()`
 * returns `DynamicStructuredTool[]` which trivially satisfies this shape, and
 * unit tests can satisfy it with a plain object — no SDK ceremony.
 */
export interface MemoryMcpProxyTool {
  name: string;
  invoke: (input: unknown) => Promise<unknown>;
}

/**
 * Tool names the upstream Memory Engine MCP server exposes (prefixed with the
 * server name configured in `MultiServerMCPClient`). Listed as constants so
 * tests and the runtime filter never depend on stringly-typed lookups.
 */
export const MEMORY_SEARCH_MCP_NAME = 'memory-engine__search_memory_engine';
export const MEMORY_ADD_MCP_NAME = 'memory-engine__add_memory';
export const MEMORY_DELETE_MCP_NAME = 'memory-engine__delete_episode';
export const MEMORY_CLEAR_MCP_NAME = 'memory-engine__clear';

/** Public tool names the agent sees. */
export const MEMORY_SEARCH_TOOL = 'search_memory';
export const MEMORY_SAVE_TOOL = 'save_memory';
export const MEMORY_READ_TOOL = 'read_memory';
export const MEMORY_DELETE_TOOL = 'delete_memory';
export const MEMORY_CLEAR_TOOL = 'clear_memory';

/**
 * Memory tools are intentionally bound to the main agent (visibility=always)
 * AND forwarded into every sub-agent's tool list via the runtime
 * passthrough filter. `clear_memory` is excluded from the passthrough — it
 * is irreversibly destructive and only the main agent should be able to call
 * it after explicit user consent.
 */

/**
 * Factory for the underlying MCP tools list. Header building, DID resolution
 * and UCAN minting all happen lazily inside the factory closure so the MCP
 * connection is opened with the headers valid for the in-flight call.
 *
 * Authoring contract:
 *   - The factory must return either the upstream tools list (for proxy) or
 *     `null` when auth cannot be built (caller surfaces a clean error).
 */
export type MemoryMcpFactory = (
  runCtx: RuntimeContext,
) => Promise<MemoryMcpProxyTool[] | null>;

/**
 * Default factory keyed to `MEMORY_MCP_URL`. Builds UCAN headers via
 * {@link buildMemoryHeaders} on every call and opens a fresh MCP client so
 * each invocation runs against the user that triggered it.
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
        },
      },
    });
    return client.getTools();
  };
}

interface ProxyHandlerArgs {
  factory: MemoryMcpFactory;
  mcpToolName: string;
  publicToolName: string;
}

/**
 * Build a handler that proxies a validated input through the MCP client.
 * Resolves the upstream tool on every call so per-request headers are honored.
 */
function buildProxyHandler({
  factory,
  mcpToolName,
  publicToolName,
}: ProxyHandlerArgs) {
  return async (args: unknown, ctx: RuntimeContext): Promise<unknown> => {
    const mcpTools = await factory(ctx);
    if (!mcpTools) {
      return `[Error calling ${publicToolName}: memory authorization unavailable for this session]`;
    }
    const target = mcpTools.find((t) => t.name === mcpToolName);
    if (!target) {
      throw new Error(
        `${publicToolName}: upstream MCP tool "${mcpToolName}" is not exposed by the configured Memory Engine server.`,
      );
    }
    return target.invoke(args);
  };
}

const SEARCH_DESCRIPTION = `Search the user's long-term memory and the oracle's knowledge base for content semantically related to the query. Returns the matching memories with their IDs and scopes. Use this BEFORE answering questions that may depend on past conversations, prior decisions, or persistent user facts.`;

const SAVE_DESCRIPTION = `Save a new fact or observation as a memory the agent can recall in future turns. Use this when the user shares a durable preference, fact, or relationship that should outlive this conversation. Write the memory as a self-contained statement (include who/what/when/why) — your future self will read it without this conversation's context.`;

const READ_DESCRIPTION = `Read a specific memory by ID. Use this after \`search_memory\` returns a relevant entry and you need the full content. The ID comes from a previous search result.`;

const DELETE_DESCRIPTION = `Delete a specific memory by ID. Use this when a memory has been proven incorrect, is duplicated, or the user explicitly asks to forget something. Irreversible.`;

const CLEAR_DESCRIPTION = `Wipe all of the user's personal memories. Destructive and irreversible — only call after the user has explicitly and unambiguously asked to clear everything (e.g. "delete all my memories"). NEVER call this without explicit user consent in the current turn.`;

const searchSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language search query. Be precise — include names, dates, and concepts the matching memory would contain.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Max number of results (1-20). Defaults to upstream behaviour.'),
});

const saveSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      'The memory content. Write a self-contained statement covering who, what, when, and why. Avoid pronouns whose referent only makes sense in the current conversation.',
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Optional metadata (tags, source, related_event_id). Use sparingly — content should be the source of truth.',
    ),
});

const readSchema = z.object({
  memory_id: z
    .string()
    .min(1)
    .describe(
      'The ID of the memory to read. Obtained from a prior `search_memory` result.',
    ),
});

const deleteSchema = z.object({
  memory_id: z
    .string()
    .min(1)
    .describe(
      'The ID of the memory to delete. Obtained from a prior `search_memory` result.',
    ),
});

const clearSchema = z.object({
  confirm: z
    .literal(true)
    .describe(
      'Must be the literal `true`. Required as a structural safeguard — never pass without explicit user consent in this turn.',
    ),
});

/**
 * Construct the five memory plugin tools. Handlers proxy validated input
 * through the upstream Memory Engine MCP server using the supplied factory.
 *
 * The agent sees the friendly public names (`search_memory`, `save_memory`,
 * `read_memory`, `delete_memory`, `clear_memory`); each maps to the
 * corresponding `memory-engine__*` MCP tool surfaced by the upstream server.
 */
export function createMemoryTools(factory: MemoryMcpFactory): PluginTool[] {
  const search = tool(
    async (rawArgs, ctx) => {
      const parsed = searchSchema.parse(rawArgs);
      const handler = buildProxyHandler({
        factory,
        mcpToolName: MEMORY_SEARCH_MCP_NAME,
        publicToolName: MEMORY_SEARCH_TOOL,
      });
      return handler(parsed, ctx);
    },
    {
      name: MEMORY_SEARCH_TOOL,
      description: SEARCH_DESCRIPTION,
      schema: searchSchema,
    },
  );

  const save = tool(
    async (rawArgs, ctx) => {
      const parsed = saveSchema.parse(rawArgs);
      const handler = buildProxyHandler({
        factory,
        mcpToolName: MEMORY_ADD_MCP_NAME,
        publicToolName: MEMORY_SAVE_TOOL,
      });
      return handler(parsed, ctx);
    },
    {
      name: MEMORY_SAVE_TOOL,
      description: SAVE_DESCRIPTION,
      schema: saveSchema,
    },
  );

  const read = tool(
    async (rawArgs, ctx) => {
      const parsed = readSchema.parse(rawArgs);
      // `read_memory` is a targeted retrieve: pass the id through the search
      // path so the upstream can filter on it. The MCP server returns the
      // matching memory unchanged.
      const handler = buildProxyHandler({
        factory,
        mcpToolName: MEMORY_SEARCH_MCP_NAME,
        publicToolName: MEMORY_READ_TOOL,
      });
      return handler({ query: parsed.memory_id, limit: 1 }, ctx);
    },
    {
      name: MEMORY_READ_TOOL,
      description: READ_DESCRIPTION,
      schema: readSchema,
    },
  );

  const remove = tool(
    async (rawArgs, ctx) => {
      const parsed = deleteSchema.parse(rawArgs);
      const handler = buildProxyHandler({
        factory,
        mcpToolName: MEMORY_DELETE_MCP_NAME,
        publicToolName: MEMORY_DELETE_TOOL,
      });
      return handler({ episode_id: parsed.memory_id }, ctx);
    },
    {
      name: MEMORY_DELETE_TOOL,
      description: DELETE_DESCRIPTION,
      schema: deleteSchema,
    },
  );

  const clear = tool(
    async (rawArgs, ctx) => {
      clearSchema.parse(rawArgs);
      const handler = buildProxyHandler({
        factory,
        mcpToolName: MEMORY_CLEAR_MCP_NAME,
        publicToolName: MEMORY_CLEAR_TOOL,
      });
      return handler({}, ctx);
    },
    {
      name: MEMORY_CLEAR_TOOL,
      description: CLEAR_DESCRIPTION,
      schema: clearSchema,
    },
  );

  return [search, save, read, remove, clear];
}
