/**
 * Every provider's request converter needs each assistant message's
 * `tool_calls` answered by the tool messages that directly follow it. Two
 * histories break that, and this middleware mends both for the model request
 * only (the checkpoint is left as it is: nothing is rewritten in place):
 *
 * - Messages a sub-agent forwarded into the chat (`forwardTools`, marked with
 *   `forwardedFrom`) are left out: they are for the UI, and the parent call's
 *   own result is what the model reads.
 * - A result that arrived later. A sub-agent that forwards its own tool calls
 *   (`forwardTools`, `subagent-as-tool.ts`) hands back a `Command` whose
 *   forwarded assistant and tool messages come before the parent call's own
 *   result, so that result lands after them; with parallel calls, after
 *   another call's forwarded messages too. The result is moved up to its
 *   call. Before this, such a call read as interrupted and the model was told
 *   "nothing from it was recorded, call it again" for every sub-agent call
 *   that forwarded anything.
 * - A result that never came. A turn that dies between the model's tool call
 *   and the tool's result (the user aborted it, or the runtime was reset
 *   while the tool ran) leaves the call unanswered. OpenRouter chat
 *   completions tolerate that history; the ChatGPT-subscription lane
 *   (Responses API) rejects every later turn on the session with
 *   `400 No tool output found for function call …`. Such a call is answered
 *   with a tool result that says it was interrupted, and the model is free to
 *   call the tool again.
 */
import {
  type BaseMessage,
  HumanMessage,
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
  return `The call to ${toolName} was interrupted before it returned a result (the turn was aborted or the runtime restarted while it ran), so nothing from it was recorded. Call it again if its result is still needed.`;
}

/**
 * `additional_kwargs` key a forwarded sub-agent message carries
 * (`FORWARDED_FROM_KEY` in `subagent-as-tool.ts`, repeated here so the
 * middleware does not import the sub-agent wrapper).
 */
const FORWARDED_FROM = 'forwardedFrom';

/** The messages without those a sub-agent forwarded into the chat: they are for the UI, not the model. */
export function withoutForwarded(messages: BaseMessage[]): BaseMessage[] {
  const kept = messages.filter(
    (message) =>
      typeof message.additional_kwargs?.[FORWARDED_FROM] !== 'string',
  );
  return kept.length === messages.length ? messages : kept;
}

export interface DanglingToolCallRepair {
  /** The original array when nothing was changed, otherwise a repaired copy. */
  messages: BaseMessage[];
  /** How many tool calls were answered as interrupted (no result anywhere). */
  repaired: number;
  /** How many results were moved up to their call from later in the turn. */
  regrouped: number;
}

/**
 * The index of the tool message answering `callId` after `from`, before the
 * next human message (a result never answers a call of an earlier turn), and
 * not already taken; -1 when there is none.
 */
function laterResult(
  messages: readonly BaseMessage[],
  from: number,
  callId: string,
  taken: ReadonlySet<number>,
): number {
  for (let j = from; j < messages.length; j += 1) {
    const candidate = messages[j]!;
    if (HumanMessage.isInstance(candidate)) return -1;
    if (
      !taken.has(j) &&
      isToolMessage(candidate) &&
      candidate.tool_call_id === callId
    )
      return j;
  }
  return -1;
}

/**
 * Answer every `tool_calls` entry of an assistant message right after it:
 * first with the tool messages that directly follow it, then with its result
 * from later in the turn (moved up, see the file comment), else with a
 * synthetic result that says the call was interrupted. Results go before the
 * next non-tool message, the position every provider's request converter
 * requires.
 */
export function repairDanglingToolCalls(
  messages: BaseMessage[],
): DanglingToolCallRepair {
  const out: BaseMessage[] = [];
  /** Indexes of results moved up to their call; skipped where they were. */
  const taken = new Set<number>();
  let repaired = 0;
  let regrouped = 0;
  for (let i = 0; i < messages.length; i += 1) {
    if (taken.has(i)) continue;
    const message = messages[i]!;
    out.push(message);
    if (!isAIMessage(message)) continue;
    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) continue;

    const answered = new Set<string>();
    let next = i + 1;
    while (next < messages.length && isToolMessage(messages[next]!)) {
      if (!taken.has(next)) {
        const toolMessage = messages[next] as ToolMessage;
        answered.add(toolMessage.tool_call_id);
        out.push(toolMessage);
      }
      next += 1;
    }
    for (const call of toolCalls) {
      if (!call.id || answered.has(call.id)) continue;
      const later = laterResult(messages, next, call.id, taken);
      if (later !== -1) {
        taken.add(later);
        answered.add(call.id);
        out.push(messages[later]!);
        regrouped += 1;
        continue;
      }
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
  return {
    messages: repaired === 0 && regrouped === 0 ? messages : out,
    repaired,
    regrouped,
  };
}

export const createDanglingToolCallRepairMiddleware = (
  options?: DanglingToolCallRepairMiddlewareOptions,
): AgentMiddleware => {
  const logger = options?.logger ?? NOOP_LOGGER;
  return createMiddleware({
    name: 'DanglingToolCallRepairMiddleware',
    wrapModelCall: async (request, handler) => {
      const visible = withoutForwarded(request.messages);
      const { messages, repaired, regrouped } =
        repairDanglingToolCalls(visible);
      if (repaired === 0 && regrouped === 0)
        return visible === request.messages
          ? handler(request)
          : handler({ ...request, messages });
      if (repaired > 0)
        logger.warn(
          `[DanglingToolCallRepair] ${repaired} tool call(s) had no result in the thread history; answered as interrupted for this model call`,
        );
      if (regrouped > 0)
        logger.debug?.(
          `[DanglingToolCallRepair] ${regrouped} tool result(s) moved up to their call (forwarded sub-agent messages came between)`,
        );
      return handler({ ...request, messages });
    },
  });
};
