import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import type { Logger } from '../../plugin-api/types';
import { NOOP_LOGGER } from '../utils';
import { isCapabilityGateRefusal } from './capability-gate';
import { isSummarizationMessage } from './summarization';

export interface ToolRepetitionGuardMiddlewareOptions {
  /**
   * At most this many messages back to scan for a prior identical failed
   * call. The scan never reaches past the start of the current turn;
   * unset, it covers the whole turn.
   */
  lookback?: number;
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

/**
 * Detects when the agent issues the same `(toolName, args)` pair after that
 * exact call already failed in the current turn, and short-circuits before
 * the tool is invoked again. The short-circuit message quotes the earlier
 * error and tells the model to change tools/args instead.
 *
 * A turn starts at the latest human message (the user's, or a sub-agent's
 * task). A failure from an earlier turn never blocks: the user may have
 * fixed its cause and asked again ("I granted access, try again").
 *
 * `toolRetryMiddleware` retries inside one call; this guard prevents the
 * model from making the *next* identical call.
 */
export const createToolRepetitionGuardMiddleware = (
  options: ToolRepetitionGuardMiddlewareOptions = {},
): AgentMiddleware => {
  const logger = options.logger ?? NOOP_LOGGER;
  const lookback = options.lookback ?? Number.POSITIVE_INFINITY;

  return createMiddleware({
    name: 'ToolRepetitionGuardMiddleware',
    wrapToolCall: async (toolCallRequest, handler) => {
      const { toolCall, state } = toolCallRequest;
      const toolName = toolCall.name ?? toolCallRequest.tool?.name;
      if (!toolName) return handler(toolCallRequest);

      const argsKey = canonicalArgsKey(toolCall.args);
      const messages = state.messages ?? [];
      const start = Math.max(
        turnStart(messages),
        messages.length - lookback,
        0,
      );

      for (let i = messages.length - 1; i >= start; i--) {
        const msg = messages[i];
        if (!(msg instanceof ToolMessage)) continue;
        if (msg.status !== 'error') continue;
        // The capability gate refused it without running it; after a
        // `load_capability` the same call is the expected next step.
        if (isCapabilityGateRefusal(msg)) continue;
        if (msg.name !== toolName) continue;

        const priorArgs = findToolCallArgsById(
          messages,
          msg.tool_call_id,
          start,
        );
        if (priorArgs === undefined) continue;
        if (canonicalArgsKey(priorArgs) !== argsKey) continue;

        const priorError = toolMessageText(msg);
        logger.warn(
          `Repetition guard: short-circuiting duplicate failed call to ${toolName}`,
          { toolName, priorError },
        );
        return new ToolMessage({
          content: [
            `You already called \`${toolName}\` with these exact arguments earlier in this turn and it failed with:`,
            '',
            priorError,
            '',
            'Do NOT repeat the same call. Read the error message, then either:',
            '- change the arguments to satisfy the constraint the error describes, OR',
            '- pick a different tool that fits the constraint.',
          ].join('\n'),
          tool_call_id: toolCall.id ?? '',
          name: toolName,
          status: 'error',
        });
      }

      return handler(toolCallRequest);
    },
  });
};

/**
 * Index of the message that opens the current turn: the latest human
 * message, other than the summary the summarizer writes in place of the
 * condensed history (it starts no turn). 0 when there is none.
 */
export function turnStart(messages: readonly BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message &&
      HumanMessage.isInstance(message) &&
      !isSummarizationMessage(message)
    )
      return i;
  }
  return 0;
}

function canonicalArgsKey(args: unknown): string {
  if (args === null || args === undefined) return 'null';
  if (typeof args !== 'object') return JSON.stringify(args);
  if (Array.isArray(args)) {
    return `[${args.map(canonicalArgsKey).join(',')}]`;
  }
  const obj = args as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalArgsKey(obj[k])}`).join(',')}}`;
}

function toolMessageText(msg: ToolMessage): string {
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          const text = (block as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

function findToolCallArgsById(
  messages: BaseMessage[],
  callId: string | undefined,
  start: number,
): unknown {
  if (!callId) return undefined;
  for (let i = messages.length - 1; i >= start; i--) {
    const m = messages[i];
    if (!AIMessage.isInstance(m)) continue;
    const toolCalls = m.tool_calls;
    if (!toolCalls) continue;
    const hit = toolCalls.find((tc) => tc.id === callId);
    if (hit) return hit.args;
  }
  return undefined;
}
