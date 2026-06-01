import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import type { Logger } from '../../plugin-api/types.js';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ToolRepetitionGuardMiddlewareOptions {
  /**
   * How many messages back to scan for a prior identical failed call.
   * Default 20 — enough to catch in-turn loops without trawling whole histories.
   */
  lookback?: number;
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

/**
 * Detects when the agent issues the same `(toolName, args)` pair after that
 * exact call already failed inside the recent window, and short-circuits
 * before the tool is invoked again. The short-circuit message quotes the
 * earlier error and tells the model to change tools/args instead.
 *
 * Why this exists: in-turn retry loops where the LLM ignores a tool's error
 * envelope and re-issues the identical call. The existing
 * `toolRetryMiddleware` retries inside one call; this guard prevents the
 * model from making the *next* identical call.
 */
export const createToolRepetitionGuardMiddleware = (
  options: ToolRepetitionGuardMiddlewareOptions = {},
): AgentMiddleware => {
  const logger = options.logger ?? NOOP_LOGGER;
  const lookback = options.lookback ?? 20;

  return createMiddleware({
    name: 'ToolRepetitionGuardMiddleware',
    wrapToolCall: async (toolCallRequest, handler) => {
      const { toolCall, state } = toolCallRequest;
      const toolName = toolCall.name ?? toolCallRequest.tool?.name;
      if (!toolName) return handler(toolCallRequest);

      const argsKey = canonicalArgsKey(toolCall.args);
      const messages = state.messages ?? [];
      const start = Math.max(0, messages.length - lookback);

      for (let i = messages.length - 1; i >= start; i--) {
        const msg = messages[i];
        if (!(msg instanceof ToolMessage)) continue;
        if (msg.status !== 'error') continue;
        if (msg.name !== toolName) continue;

        const priorArgs = findToolCallArgsById(messages, msg.tool_call_id);
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
): unknown {
  if (!callId) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!AIMessage.isInstance(m)) continue;
    const toolCalls = m.tool_calls;
    if (!toolCalls) continue;
    const hit = toolCalls.find((tc) => tc.id === callId);
    if (hit) return hit.args;
  }
  return undefined;
}
