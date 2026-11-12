/**
 * Where the current turn starts in a thread's messages, and what a mid-turn
 * summary keeps of the turn it condensed.
 *
 * A turn opens at the latest human message the user (or, in a sub-agent,
 * the dispatching agent) wrote. The runtime writes human messages of its
 * own — the summary that replaces a condensed history, the re-attachment
 * `view_attachment` appends — and neither opens a turn.
 *
 * The summarizer can fire between two model steps of one turn and replace
 * everything but the last few messages, the turn's opening message and its
 * earlier tool calls included. The summary it writes then carries the
 * calls of the turn it removed (`turn_carry`) and stands in as the turn's
 * opening, so the repetition guard still knows what already ran this turn.
 * A summary written at a turn boundary carries nothing and opens nothing.
 */
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { isAttachmentViewMessage } from '../../attachments/retention';
import { isCapabilityGateRefusal } from './capability-gate';
import { isToolNotRun } from '../tool-not-run';
import { SEND_FILE_TOOL } from '../../plugins/sandbox/send-file';
import { standaloneMessagesOf } from '../../delivery/standalone';

export const SUMMARY_PREFIX = 'Here is a summary of the conversation to date:';

/**
 * `true` for the condensed-history message the summarization middleware
 * writes into graph state. List endpoints use this to keep it out of the
 * user-visible transcript.
 */
export function isSummarizationMessage(message: BaseMessage): boolean {
  if (message.additional_kwargs?.lc_source === 'summarization') return true;
  const { content } = message;
  return typeof content === 'string' && content.startsWith(SUMMARY_PREFIX);
}

/** A tool call of the current turn that a mid-turn summary condensed away. */
export interface CarriedToolCall {
  name: string;
  args: unknown;
  /** `error` when its result was an error (the capability gate's refusals are not carried). */
  status: 'success' | 'error';
  /** The start of its result, for the repetition guard to quote. */
  result: string;
  /**
   * A `send_file` call's `ToolMessage.artifact` and tool call id, or those
   * of a call that handed over standalone messages: the Reply Plan still
   * owes the user that file or those messages after the summary removed the
   * call.
   */
  artifact?: unknown;
  id?: string;
}

/** `additional_kwargs` key of the calls a mid-turn summary carries. */
const TURN_CARRY = 'turn_carry';

/** Characters of a carried result kept (the guard quotes at most this much). */
export const CARRIED_RESULT_CHARS = 800;

/** The calls `message` carries when it is a summary written mid-turn, else `undefined`. */
export function turnCarryOf(
  message: BaseMessage,
): CarriedToolCall[] | undefined {
  if (!isSummarizationMessage(message)) return undefined;
  const raw: unknown = message.additional_kwargs?.[TURN_CARRY];
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry: unknown): CarriedToolCall[] => {
    if (!entry || typeof entry !== 'object') return [];
    const name: unknown = Reflect.get(entry, 'name');
    const status: unknown = Reflect.get(entry, 'status');
    const result: unknown = Reflect.get(entry, 'result');
    const artifact: unknown = Reflect.get(entry, 'artifact');
    const id: unknown = Reflect.get(entry, 'id');
    if (typeof name !== 'string') return [];
    if (status !== 'success' && status !== 'error') return [];
    return [
      {
        name,
        args: Reflect.get(entry, 'args'),
        status,
        result: typeof result === 'string' ? result : '',
        ...(artifact !== undefined ? { artifact } : {}),
        ...(typeof id === 'string' ? { id } : {}),
      },
    ];
  });
}

/**
 * A turn opens at a human message other than the ones the runtime writes
 * itself, or at a summary that carries the calls of a turn it condensed
 * mid-way.
 */
function opensTurn(message: BaseMessage | undefined): boolean {
  if (!message || !HumanMessage.isInstance(message)) return false;
  if (isSummarizationMessage(message))
    return turnCarryOf(message) !== undefined;
  return !isAttachmentViewMessage(message);
}

/** Index of the message that opens the current turn; 0 when there is none. */
export function turnStart(messages: readonly BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--)
    if (opensTurn(messages[i])) return i;
  return 0;
}

/** The indexes of every turn-opening message, oldest first. */
export function turnOpenings(messages: readonly BaseMessage[]): number[] {
  const openings: number[] = [];
  messages.forEach((message, index) => {
    if (opensTurn(message)) openings.push(index);
  });
  return openings;
}

function resultText(message: ToolMessage): string {
  const { content } = message;
  const text =
    typeof content === 'string'
      ? content
      : content
          .map((block) =>
            typeof block === 'string'
              ? block
              : 'text' in block && typeof block.text === 'string'
                ? block.text
                : '',
          )
          .join('\n');
  return text.length <= CARRIED_RESULT_CHARS
    ? text
    : `${text.slice(0, CARRIED_RESULT_CHARS)}…`;
}

/**
 * The calls of the current turn that a summary of `before` would remove: the
 * turn's opening is among the removed messages (it is not in `keptIds`), so
 * the turn continues after the summary. `undefined` when the summary falls
 * on a turn boundary (the whole current turn is kept). Calls an earlier
 * mid-turn summary of this same turn carried are carried on.
 */
export function carriedCallsOfTurn(
  before: readonly BaseMessage[],
  keptIds: ReadonlySet<string>,
): CarriedToolCall[] | undefined {
  const start = turnStart(before);
  const opening = before[start];
  if (!opening || !HumanMessage.isInstance(opening)) return undefined;
  if (opening.id !== undefined && keptIds.has(opening.id)) return undefined;
  const carried: CarriedToolCall[] = [...(turnCarryOf(opening) ?? [])];
  const calls = new Map<string, { name: string; args: unknown }>();
  for (let i = start; i < before.length; i += 1) {
    const message = before[i];
    if (!message || (message.id !== undefined && keptIds.has(message.id)))
      continue;
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? [])
        if (call.id) calls.set(call.id, { name: call.name, args: call.args });
      continue;
    }
    if (
      !ToolMessage.isInstance(message) ||
      isCapabilityGateRefusal(message) ||
      isToolNotRun(message)
    )
      continue;
    const call = calls.get(message.tool_call_id);
    if (!call) continue;
    carried.push({
      name: message.name ?? call.name,
      args: call.args,
      status: message.status === 'error' ? 'error' : 'success',
      result: resultText(message),
      ...(message.artifact !== undefined &&
      (call.name === SEND_FILE_TOOL ||
        standaloneMessagesOf(message.artifact).length > 0)
        ? { artifact: message.artifact, id: message.tool_call_id }
        : {}),
    });
  }
  return carried;
}

/** `additional_kwargs` that make a summary carry `calls` (see `turnCarryOf`). */
export function turnCarryKwargs(
  calls: readonly CarriedToolCall[],
): Record<string, unknown> {
  return { [TURN_CARRY]: calls.map((call) => ({ ...call })) };
}
