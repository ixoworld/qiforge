import { type AgentMiddleware, createMiddleware } from 'langchain';
import { NOOP_LOGGER } from '../core/utils';
import type { Logger } from '../plugin-api/types';
import {
  MEMORY_ADD_MCP_NAME,
  MEMORY_ADD_ORACLE_KNOWLEDGE_MCP_NAME,
  MEMORY_CLEAR_MCP_NAME,
  MEMORY_DELETE_EDGE_MCP_NAME,
  MEMORY_DELETE_EPISODE_MCP_NAME,
} from '../plugins/memory/memory-tools';

/** The memory engine tools that write or delete what the prefetch reads. */
export const MEMORY_WRITE_TOOL_NAMES: readonly string[] = [
  MEMORY_ADD_MCP_NAME,
  MEMORY_ADD_ORACLE_KNOWLEDGE_MCP_NAME,
  MEMORY_DELETE_EPISODE_MCP_NAME,
  MEMORY_DELETE_EDGE_MCP_NAME,
  MEMORY_CLEAR_MCP_NAME,
];

export interface UserContextInvalidationOptions {
  /** The turn's oracle room: the prefetch cache key. */
  roomId: string;
  invalidate: (roomId: string) => void | Promise<void>;
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
      const toolName = request.toolCall.name;
      if (names.has(toolName)) {
        await options.invalidate(options.roomId);
        logger.log(
          `[user-context] invalidated room=${options.roomId} before ${toolName}`,
        );
      }
      const output = await handler(request);
      return output;
    },
  });
}
