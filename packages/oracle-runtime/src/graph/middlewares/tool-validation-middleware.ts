import type { BaseMessage } from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware, ToolMessage } from 'langchain';
import type { Logger } from '../../plugin-api/types.js';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ToolValidationMiddlewareOptions {
  /**
   * Tool names whose dangling `ToolMessage` outputs should be stripped before
   * the next model call. These are typically sub-agent tools whose responses
   * are summarised by their parent agent rather than being interpreted by the
   * model directly.
   */
  skipToolNames?: string[];
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

/**
 * Catches tool validation errors (Zod / schema mismatches) and turns them
 * into a `ToolMessage` describing the failure, so the model can recover
 * instead of the graph crashing.
 *
 * Also strips `ToolMessage`s for tools listed in `skipToolNames` from the
 * state before the next model call — used today for sub-agent tools whose
 * structured output is consumed by their callers, not the LLM.
 */
export const createToolValidationMiddleware = (
  options: ToolValidationMiddlewareOptions = {},
): AgentMiddleware => {
  const logger = options.logger ?? NOOP_LOGGER;
  const skipToolNames = new Set(options.skipToolNames ?? []);

  return createMiddleware({
    name: 'ToolValidationMiddleware',
    wrapToolCall: async (toolCallRequest, handler) => {
      const { toolCall } = toolCallRequest;
      try {
        return await handler(toolCallRequest);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : '';
        const isSchemaError =
          errorMessage.includes('did not match expected schema') ||
          errorMessage.includes('Received tool input did not match') ||
          errorMessage.includes('schema') ||
          (error instanceof Error && error.name === 'ZodError');

        if (!isSchemaError) throw error;

        const toolName = toolCall.name ?? toolCallRequest.tool?.name ?? '';
        logger.warn(`Tool validation error for ${toolName}: ${errorMessage}`, {
          toolName,
          toolArgs: toolCall.args,
          error: errorMessage,
        });

        return new ToolMessage({
          content: `Error: The tool "${toolName}" was called with invalid parameters. ${errorMessage}. Please check the tool's required parameters and try again with the correct format.`,
          tool_call_id: toolCall.id ?? '',
          name: toolName,
        });
      }
    },
    beforeModel(state) {
      if (skipToolNames.size === 0) return state;

      const toolMessage = state.messages.find(
        (message: BaseMessage) => message.type === 'tool',
      );

      if (toolMessage?.name && skipToolNames.has(toolMessage.name)) {
        logger.log(
          `Tool validation middleware: ${toolMessage.name} is a skip-listed tool, removing tool messages before next model call`,
        );
        return {
          ...state,
          messages: state.messages.filter(
            (message: BaseMessage) => message.type !== 'tool',
          ),
        };
      }
      return state;
    },
  });
};
