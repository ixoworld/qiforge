/**
 * Drops a room's prefetched user context (`UserContextFetcher.invalidate`)
 * after a tool call that changed the user's memory succeeded, so the next
 * session in the room gathers again instead of reading the pre-write answer
 * for the rest of the cache TTL. Channel turns adopt the refreshed context
 * on a later turn; other clients keep their first-contact context.
 *
 * Applied as a tool middleware to the main agent and every sub-agent; a
 * failed call (thrown, or an error `ToolMessage`) leaves the cache alone.
 */
import { type AgentMiddleware, createMiddleware } from 'langchain';
import { isErrorResult } from '../core/middlewares/tool-marks';
import { NOOP_LOGGER } from '../core/utils';
import type { Logger } from '../plugin-api/types';
import {
  MEMORY_ADD_MCP_NAME,
  MEMORY_ADD_ORACLE_KNOWLEDGE_MCP_NAME,
  MEMORY_CLEAR_MCP_NAME,
  MEMORY_DELETE_EDGE_MCP_NAME,
  MEMORY_DELETE_EPISODE_MCP_NAME,
} from '../plugins/memory/memory-tools';
import {
  ADD_ORACLE_DOCUMENT_TOOL_NAME,
  DELETE_ORACLE_DOCUMENT_TOOL_NAME,
} from '../plugins/memory/oracle-document-tools';

/** The memory engine tools that write or delete what the prefetch reads. */
export const MEMORY_WRITE_TOOL_NAMES: readonly string[] = [
  MEMORY_ADD_MCP_NAME,
  MEMORY_ADD_ORACLE_KNOWLEDGE_MCP_NAME,
  MEMORY_DELETE_EPISODE_MCP_NAME,
  MEMORY_DELETE_EDGE_MCP_NAME,
  MEMORY_CLEAR_MCP_NAME,
  ADD_ORACLE_DOCUMENT_TOOL_NAME,
  DELETE_ORACLE_DOCUMENT_TOOL_NAME,
];

export interface UserContextInvalidationOptions {
  /** The turn's oracle room: the prefetch cache key. */
  roomId: string;
  invalidate: (roomId: string) => void;
  /** Tool names that invalidate (default `MEMORY_WRITE_TOOL_NAMES`). */
  toolNames?: Iterable<string>;
  logger?: Logger;
}

export function createUserContextInvalidationMiddleware(
  options: UserContextInvalidationOptions,
): AgentMiddleware {
  const names = new Set(options.toolNames ?? MEMORY_WRITE_TOOL_NAMES);
  const logger = options.logger ?? NOOP_LOGGER;
  return createMiddleware({
    name: 'UserContextInvalidation',
    wrapToolCall: async (request, handler) => {
      const output = await handler(request);
      const toolName = request.toolCall.name;
      if (names.has(toolName) && !isErrorResult(output)) {
        try {
          options.invalidate(options.roomId);
          logger.log(
            `[user-context] invalidated room=${options.roomId} after ${toolName}`,
          );
        } catch (err) {
          logger.warn(
            `[user-context] could not invalidate room=${options.roomId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return output;
    },
  });
}
