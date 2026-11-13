/**
 * A tool's thrown error, handed to the model as the call's result.
 *
 * LangChain's ToolNode turns a thrown tool error into an error ToolMessage
 * only when no `wrapToolCall` middleware exists; with one (every agent here
 * has several) it re-throws everything but a schema rejection, and the
 * error ends the whole graph. The main agent converts it in its outer
 * `toolRetryMiddleware` (`onFailure`). A sub-agent had no such layer, so
 * one failed fetch (an MCP tool's `isError` result arrives as a thrown
 * `ToolException`) ended the sub-agent and threw away the results it
 * already had. This middleware gives each sub-agent dispatch the main
 * agent's behaviour: the model reads the error and can try another way or
 * answer from what it has. It is LangChain's own `toolErrorMiddleware`
 * (which always lets LangGraph's interrupt, drain and parent command
 * through) with the runtime's rules for what it converts.
 *
 * Not converted, so the turn still ends: the turn's abort and a turn out of
 * budget (`HarnessLimitError`, also when a middleware wrapped it). A schema
 * rejection is converted to the main agent's "Invalid arguments" text,
 * without ToolNode's argument dump and stack.
 *
 * Every tool is covered, writes included, as on the main agent. A write's
 * failure that leaves its outcome unknown (a timeout, a dropped connection,
 * a 5xx: `isUncertainOutcome`) says so in the result, and the execution
 * middleware inside this layer keeps its run-ledger claim, which refuses an
 * identical write while it stands; the repetition guard refuses the
 * identical call that already failed in the turn.
 *
 * A sub-agent plugin's own middlewares sit inside this layer: one that
 * throws to stop its sub-agent is converted too, like a tool's error.
 */
import { ToolInvocationError, toolErrorMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import type { Logger } from '../../plugin-api/types';
import { isHarnessLimitError } from '../turn-budget';
import { errorMessageOf, errorSummary, NOOP_LOGGER } from '../utils';
import { isUncertainOutcome } from './tool-execution';

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

/**
 * What the model reads for a schema rejection: the reason, not the kwargs
 * dump, the inner error's stack or LangChain's closing line
 * (`Error invoking tool 'x' with kwargs {…} with error: Error: <reason>\n
 * at …\n Please fix the error and try again.`).
 */
export function invalidArgumentsText(error: Error, toolName?: string): string {
  const named = /^Error invoking tool '([^']+)'/.exec(error.message)?.[1];
  const raw = ToolInvocationError.isInstance(error)
    ? error.toolError.message
    : (error.message.split(' with error: ').at(-1) ?? error.message);
  const reason = raw
    .replace(/^Error: /, '')
    .split('\n')
    .filter(
      (line) =>
        !/^\s+at /.test(line) &&
        !/^\s*Please fix the error and try again\.?\s*$/.test(line),
    )
    .join('\n')
    .trim()
    .replace(/\.$/, '');
  return `Invalid arguments for ${named ?? toolName ?? 'the tool'}: ${reason || 'the arguments did not match its schema'}. Check the tool's parameter schema and call it again with corrected arguments.`;
}

/** The note a write's result carries when its failure leaves the outcome unknown. */
export const UNCERTAIN_WRITE_NOTE =
  'Its outcome is unknown: the call may still have taken effect. Check with a read-only call whether it happened before doing anything else, and never repeat it, with these or changed arguments, to work around this error.';

/** The text the model reads for a tool call that threw. */
export function toolErrorResultText(toolName: string, error: unknown): string {
  const message = errorMessageOf(error).trim();
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
  /**
   * Effect of a tool by name; a `write` whose failure leaves its outcome
   * unknown gets {@link UNCERTAIN_WRITE_NOTE}. Unknown tools count as
   * writes.
   */
  effectOf?: (toolName: string) => 'read' | 'write';
  logger?: Logger;
}

export function createToolErrorResultMiddleware(
  options: ToolErrorResultOptions,
): AgentMiddleware {
  const logger = options.logger ?? NOOP_LOGGER;
  return {
    ...toolErrorMiddleware({
      onError: (error, request) => {
        const signal = options.signal?.aborted
          ? options.signal
          : request.runtime.signal;
        // The turn ends: LangChain re-throws the error as it is.
        if (signal?.aborted || isHarnessLimitError(error)) return undefined;
        const { toolCall } = request;
        const toolName = toolCall.name;
        const write = (options.effectOf?.(toolName) ?? 'write') === 'write';
        const uncertain = write && isUncertainOutcome(error, signal);
        logger.log(
          `[tool-error] ${options.agentName}: ${toolName} (${toolCall.id ?? 'no id'}) threw; the error is its result${uncertain ? ' (write, outcome unknown)' : ''}: ${errorSummary(error)}`,
        );
        if (isToolInvocationError(error) && error instanceof Error)
          return invalidArgumentsText(error, toolName);
        const text = toolErrorResultText(toolName, error);
        return uncertain ? `${text}\n\n${UNCERTAIN_WRITE_NOTE}` : text;
      },
    }),
    // LangChain refuses two middlewares of one name; a plugin may add its own
    // `toolErrorMiddleware`.
    name: 'ToolErrorResultMiddleware',
  };
}
