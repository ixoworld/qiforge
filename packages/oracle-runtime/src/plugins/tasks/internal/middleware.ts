import type { BaseMessage } from '@langchain/core/messages';
import { createMiddleware, type AgentMiddleware } from 'langchain';
import type { Logger } from '../../../plugin-api/types.js';
import { type GetTasksRuntime } from './runtime.js';

const APPROVE = new Set([
  'yes',
  'y',
  'yes please',
  'approve',
  'approved',
  'approve it',
  'i approve',
  'ok',
  'okay',
  'ok do it',
  'okay do it',
  'do it',
  'go',
  'go ahead',
  'send',
  'send it',
  'yes send it',
  'ship',
  'ship it',
  'lgtm',
  'looks good',
  'sure',
  'confirm',
  'confirmed',
  'proceed',
]);

const REJECT = new Set([
  'no',
  'n',
  'nope',
  'no thanks',
  'cancel',
  'cancel it',
  'reject',
  'rejected',
  'reject it',
  'i reject',
  'decline',
  'declined',
  'stop',
  "don't",
  'dont',
  "don't send",
  'dont send',
  "don't send it",
  'discard',
  'discard it',
  'abort',
]);

export type FastReply = 'approved' | 'rejected' | 'other';

/**
 * EXACT-match classification of a reply to a pending draft. Normalization is
 * lowercase + punctuation-to-space + whitespace collapse; anything that isn't
 * a verbatim member of the approve/reject sets is `'other'` — no prefix or
 * length heuristics, so "ok so what does this do" never reads as approval.
 * `'other'` replies are handled by the model itself (it gets a system-prompt
 * hint plus the `resolve_task_approval` tool).
 */
export function classifyReplyFast(text: string): FastReply {
  const normalized = text
    .toLowerCase()
    .replace(/[.!?,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (APPROVE.has(normalized)) return 'approved';
  if (REJECT.has(normalized)) return 'rejected';
  return 'other';
}

/**
 * The task-room approval gate. Wraps every model call, but the first check is
 * an in-memory prefix test on the session id — normal chats never touch
 * Redis. When the turn IS the bound session of a task room whose task is
 * `pending-approval`:
 *
 *   - plain yes/no reply → resolve via `ApprovalFlow` BEFORE the model runs
 *     (deterministic bookkeeping), then hint the model to act / stand down
 *   - anything else → no status change; hint the model that a draft is
 *     pending and that it should call `resolve_task_approval` after handling
 *     a nuanced approval
 *
 * Never short-circuits the model and never posts to Matrix — status
 * bookkeeping and system-prompt hints only. Any internal error degrades to a
 * plain pass-through.
 */
export function createTaskRoomGateMiddleware(args: {
  getRuntime: GetTasksRuntime;
  logger?: Logger;
}): AgentMiddleware {
  // Gate computation: undefined = pass through untouched, a string = the
  // system-prompt hint to append. Resolving the approval (the status flip)
  // happens in here, BEFORE the model runs — deterministic bookkeeping.
  const computeHint = async (
    context: unknown,
    messages: BaseMessage[],
  ): Promise<string | undefined> => {
    const runtime = args.getRuntime();
    if (!runtime) return undefined;

    const session = sessionFromContext(context);
    if (!session || !session.roomId) return undefined;

    // One Redis GET keyed by room. Run sessions are rooted at real Matrix
    // events (indistinguishable from normal sessions by id), so the binding
    // is the discriminator: only the session a task room is currently bound
    // to is gated. Absent key → normal chat, pass through. The state client
    // fails fast on Redis trouble and the caller is fail-open.
    const binding = await runtime.state.getRoomSession(session.roomId);
    // No binding, or the turn isn't on the bound session: this is the task's
    // own draft run, or a stale thread — pass through.
    if (!binding || binding.sessionId !== session.id) return undefined;

    const spec = await runtime.store.load(binding.owner, binding.taskId);
    if (!spec || spec.frontmatter.status !== 'pending-approval') {
      return undefined;
    }

    const text = lastHumanText(messages);
    if (!text) return undefined;

    const decision = classifyReplyFast(text);
    if (decision === 'other') {
      return (
        `\n\n[Task approval gate] Task ${binding.taskId} has a draft pending the user's approval in this room. ` +
        'If this reply approves it (possibly with tweaks), act accordingly and then call `resolve_task_approval` with the outcome; ' +
        'if it requests changes, revise the draft and ask again.'
      );
    }

    const outcome = decision === 'approved' ? 'approved' : 'declined';
    const resolved = await runtime.approvalFlow.resolve(
      binding.owner,
      binding.taskId,
      outcome,
    );
    if (!resolved.ok) {
      // The status moved between our check and the resolve (race) — hinting
      // "the user approved" against a no-longer-pending draft risks a double
      // execution, so degrade to a plain pass-through.
      args.logger?.warn(
        `[TaskRoomApprovalGate] resolve(${binding.taskId}, ${outcome}) refused: ${resolved.error}`,
      );
      return undefined;
    }
    args.logger?.log(
      `[TaskRoomApprovalGate] ${binding.taskId} ${outcome} (fast path) → ${resolved.status}`,
    );
    return outcome === 'approved'
      ? `\n\n[Task approval gate] The user APPROVED the pending action for task ${binding.taskId} — perform the action now exactly as drafted, then confirm to the user what you did.`
      : `\n\n[Task approval gate] The user DECLINED the pending action for task ${binding.taskId} — do NOT perform the action; acknowledge briefly and stop.`;
  };

  return createMiddleware({
    name: 'TaskRoomApprovalGate',
    wrapModelCall: async (request, handler) => {
      let hint: string | undefined;
      try {
        hint = await computeHint(request.runtime.context, request.messages);
      } catch (err) {
        args.logger?.warn(
          `[TaskRoomApprovalGate] gate errored — passing through: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!hint) return handler(request);
      return handler({
        ...request,
        systemPrompt: request.systemPrompt + hint,
      });
    },
  });
}

/** Defensive read of `{ session: { id, roomId? } }` off the untyped context. */
function sessionFromContext(
  context: unknown,
): { id: string; roomId?: string } | null {
  if (!context || typeof context !== 'object' || !('session' in context)) {
    return null;
  }
  const { session } = context;
  if (!session || typeof session !== 'object' || !('id' in session)) {
    return null;
  }
  const { id } = session;
  if (typeof id !== 'string' || id.length === 0) return null;
  const roomId =
    'roomId' in session && typeof session.roomId === 'string'
      ? session.roomId
      : undefined;
  return { id, roomId };
}

/** Text of the latest HumanMessage — string content or joined text parts. */
function lastHumanText(messages: BaseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.type !== 'human') continue;
    return textOfContent(message.content);
  }
  return null;
}

function textOfContent(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(content)) return null;
  const parts: unknown[] = content;
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      texts.push(part);
      continue;
    }
    if (
      part !== null &&
      typeof part === 'object' &&
      'text' in part &&
      typeof part.text === 'string'
    ) {
      texts.push(part.text);
    }
  }
  const joined = texts.join(' ').trim();
  return joined.length > 0 ? joined : null;
}
