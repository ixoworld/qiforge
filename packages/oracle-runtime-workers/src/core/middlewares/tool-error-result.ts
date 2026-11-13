/**
 * A tool's thrown error, handed to the model as the call's result.
 *
 * LangChain's ToolNode turns a thrown tool error into an error ToolMessage
 * only when no `wrapToolCall` middleware exists; with one (every agent here
 * has several) it re-throws everything but a schema rejection, and the
 * error ends the whole graph. The main agent converts it in its outer
 * `toolRetryMiddleware` (`onFailure`). A sub-agent has no such layer, so
 * one failed fetch (an MCP tool's `isError` result arrives as a thrown
 * `ToolException`) ended the sub-agent and threw away the results it
 * already had. This middleware gives the sub-agent the main agent's
 * behaviour: the model reads the error and can try another way or answer
 * from what it has.
 *
 * What is not a tool failure still propagates: the turn's abort, a turn out
 * of budget (`HarnessLimitError`), LangGraph's control signals (interrupt,
 * drain, parent command) and a schema rejection, which ToolNode itself turns
 * into its own error result.
 *
 * Every tool is covered, writes included, as on the main agent: a write
 * whose failure leaves its outcome unknown keeps its claim in the run
 * ledger (`tool-execution.ts`, inside this layer), which refuses an
 * identical write while it stands, and the repetition guard refuses the
 * identical call that already failed in the turn.
 */
import { ToolMessage } from '@langchain/core/messages';
import { isGraphBubbleUp } from '@langchain/langgraph';
import {
  type AgentMiddleware,
  createMiddleware,
  ToolInvocationError,
} from 'langchain';
import type { Logger } from '../../plugin-api/types';
import { isHarnessLimitError } from '../turn-budget';
import { NOOP_LOGGER } from '../utils';

/** Characters of a thrown error's message the model reads as the result. */
export const TOOL_ERROR_RESULT_MAX_CHARS = 4_000;

/**
 * The model's arguments failed the tool's schema (LangChain's ToolNode
 * throws `ToolInvocationError` before the tool runs). Matched by class AND by
 * name / message shape: a bundle can carry the class twice (ESM and CJS
 * entry points), and then `instanceof` is false for the very error it names.
 * LangChain wraps an error a middleware throws in a `MiddlewareError` (same
 * name and message, the original as `cause`), so the causes are walked too.
 */
export function isToolInvocationError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 32 && current instanceof Error; depth += 1) {
    if (current instanceof ToolInvocationError) return true;
    if (
      current.name === 'ToolInvocationError' ||
      /^Error invoking tool '.+' with kwargs /.test(current.message)
    )
      return true;
    current = current.cause;
  }
  return false;
}

/** The first line of an error's message (or the value as text). */
export function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}

/** The text the model reads for a tool call that threw. */
export function toolErrorResultText(toolName: string, error: unknown): string {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).trim();
  const shown =
    message.length > TOOL_ERROR_RESULT_MAX_CHARS
      ? `${message.slice(0, TOOL_ERROR_RESULT_MAX_CHARS)}… (${message.length - TOOL_ERROR_RESULT_MAX_CHARS} more characters)`
      : message;
  return `${toolName} failed: ${shown || 'no error message'}`;
}

export interface ToolErrorResultOptions {
  /** The agent whose tools these are, for the log line. */
  agentName: string;
  /**
   * The turn's abort signal. The graph's own signal
   * (`request.runtime.signal`) is checked as well.
   */
  signal?: AbortSignal;
  logger?: Logger;
}

export function createToolErrorResultMiddleware(
  options: ToolErrorResultOptions,
): AgentMiddleware {
  const logger = options.logger ?? NOOP_LOGGER;
  return createMiddleware({
    name: 'ToolErrorResultMiddleware',
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request);
      } catch (error) {
        if (
          isGraphBubbleUp(error) ||
          options.signal?.aborted ||
          request.runtime.signal?.aborted ||
          isHarnessLimitError(error) ||
          isToolInvocationError(error)
        )
          throw error;
        const { toolCall } = request;
        logger.warn(
          `[tool-error] ${options.agentName}: ${toolCall.name} (${toolCall.id ?? 'no id'}) threw; the error is its result: ${errorSummary(error)}`,
        );
        return new ToolMessage({
          content: toolErrorResultText(toolCall.name, error),
          tool_call_id: toolCall.id ?? '',
          name: toolCall.name,
          status: 'error',
        });
      }
    },
  });
}
