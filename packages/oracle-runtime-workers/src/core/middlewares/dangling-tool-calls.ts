/**
 * A turn that dies between the model's tool call and the tool's result — the
 * user aborted it, or the runtime was reset while the tool ran — leaves the
 * checkpoint with an assistant message whose `tool_calls` have no
 * `ToolMessage`. OpenRouter chat completions tolerate that history; the
 * ChatGPT-subscription lane (Responses API) rejects every later turn on the
 * session with `400 No tool output found for function call …`. This
 * middleware answers each unanswered call, for the model request only, with
 * a tool result that says the call was interrupted. The checkpoint is left as
 * it is: nothing is rewritten in place, and the model is free to call the
 * tool again.
 */
import {
  type BaseMessage,
  isAIMessage,
  isToolMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import type { Logger } from '../../plugin-api/types';
import { NOOP_LOGGER } from '../utils';

export interface DanglingToolCallRepairMiddlewareOptions {
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

/** The result handed to the model for a tool call that never returned. */
export function interruptedToolResult(toolName: string): string {
  return `The call to ${toolName} was interrupted before it returned a result (the turn was aborted or the runtime restarted while it ran), so nothing from it was recorded. Its external outcome is unknown: it may already have completed. Reconcile the result before repeating any write; only safe reads may be retried.`;
}

export interface DanglingToolCallRepair {
  /** The original array when nothing was missing, otherwise a repaired copy. */
  messages: BaseMessage[];
  /** How many tool calls were answered. */
  repaired: number;
}

/**
 * Insert a synthetic `ToolMessage` for every `tool_calls` entry of an
 * assistant message that has no `ToolMessage` among the tool messages that
 * directly follow it. The synthetic results go right after the real ones,
 * before the next non-tool message, which is the position every provider's
 * request converter requires.
 */
export function repairDanglingToolCalls(
  messages: BaseMessage[],
): DanglingToolCallRepair {
  const out: BaseMessage[] = [];
  let repaired = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    out.push(message);
    if (!isAIMessage(message)) continue;
    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) continue;

    const answered = new Set<string>();
    let next = i + 1;
    while (next < messages.length && isToolMessage(messages[next]!)) {
      const toolMessage = messages[next] as ToolMessage;
      answered.add(toolMessage.tool_call_id);
      out.push(toolMessage);
      next += 1;
    }
    for (const call of toolCalls) {
      if (!call.id || answered.has(call.id)) continue;
      out.push(
        new ToolMessage({
          tool_call_id: call.id,
          name: call.name,
          content: interruptedToolResult(call.name),
          status: 'error',
        }),
      );
      repaired += 1;
    }
    i = next - 1;
  }
  return { messages: repaired === 0 ? messages : out, repaired };
}

export const createDanglingToolCallRepairMiddleware = (
  options?: DanglingToolCallRepairMiddlewareOptions,
): AgentMiddleware => {
  const logger = options?.logger ?? NOOP_LOGGER;
  return createMiddleware({
    name: 'DanglingToolCallRepairMiddleware',
    wrapModelCall: async (request, handler) => {
      const { messages, repaired } = repairDanglingToolCalls(request.messages);
      if (repaired === 0) return handler(request);
      logger.warn(
        `[DanglingToolCallRepair] ${repaired} tool call(s) had no result in the thread history; answered as interrupted for this model call`,
      );
      return handler({ ...request, messages });
    },
  });
};
