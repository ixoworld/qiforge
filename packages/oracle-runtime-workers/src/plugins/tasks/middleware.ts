/**
 * Adds pending approval guidance to the model prompt. Natural-language replies
 * are intent hints only; the signed owner host action records the decision.
 */
import type { BaseMessage } from '@langchain/core/messages';
import { createMiddleware, type AgentMiddleware } from 'langchain';
import type { Logger, OracleTasksSurface } from '../../plugin-api/types';
import { pendingApprovalOf } from '../../tasks/store';
import {
  stripTurnTimeNote,
  TURN_TIME_NOTE_KWARG,
} from '../../core/turn-time-note';

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
 * EXACT-match classification of a reply to a pending approval. Normalization
 * is lowercase + punctuation-to-space + whitespace collapse; anything that is
 * not a verbatim member of the approve/reject sets is `'other'` — no prefix
 * or length heuristics, so "ok so what does this do" never reads as approval.
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
 * The hint to append when tasks are awaiting approval, or undefined when
 * nothing is pending. Exported for direct unit testing.
 */
export async function computeApprovalHint(
  surface: OracleTasksSurface,
  lastHumanReply: string,
): Promise<string | undefined> {
  const records = await surface.list();
  const pending = records.filter(
    (record) =>
      record.status === 'active' && pendingApprovalOf(record) !== undefined,
  );
  if (pending.length === 0) return undefined;

  const decision = classifyReplyFast(lastHumanReply);
  const only = pending.length === 1 ? pending[0] : undefined;
  if (only && decision === 'approved') {
    return (
      `\n\n[Task approval gate] The reply appears to mean APPROVES for task ${only.id} ("${only.title}"). ` +
      'Direct the owner to the authenticated approval interface. A conversation reply or model tool cannot authorize execution. Do not claim the run has started.'
    );
  }
  if (only && decision === 'rejected') {
    return (
      `\n\n[Task approval gate] The reply appears to mean DECLINES for task ${only.id} ("${only.title}"). ` +
      'Direct the owner to the authenticated approval interface to record the decision. No pending run is authorized.'
    );
  }
  const listing = pending
    .map((record) => `${record.id} ("${record.title}")`)
    .join(', ');
  return (
    `\n\n[Task approval gate] ${pending.length} task run(s) are waiting for the user's approval: ${listing}. ` +
    'Direct the owner to the authenticated approval interface. Requested instruction changes require a new approval; notes are audit data. ' +
    'Otherwise answer normally and remind the user of the pending approval.'
  );
}

/** Defensive read of `{ user: { did } }` off the untyped invoke context. */
export function userDidFromContext(context: unknown): string | undefined {
  if (!context || typeof context !== 'object' || !('user' in context)) {
    return undefined;
  }
  const { user } = context;
  if (!user || typeof user !== 'object' || !('did' in user)) return undefined;
  const { did } = user;
  return typeof did === 'string' && did.length > 0 ? did : undefined;
}

/**
 * Text of the latest HumanMessage — string content or joined text parts —
 * as the user sent it: without the turn time note the runtime puts in front.
 */
export function lastHumanText(messages: BaseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.type !== 'human') continue;
    return textOfContent(
      stripTurnTimeNote(
        message.content,
        message.additional_kwargs?.[TURN_TIME_NOTE_KWARG],
      ),
    );
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

export interface TaskApprovalGateOptions {
  /**
   * Per-user surface lookup. The plugin stashes each request's `ctx.tasks`
   * keyed by user DID (see `tasks.plugin.ts`) because middlewares are built
   * once at boot while the surface is per-user.
   */
  surfaceFor: (userDid: string) => OracleTasksSurface | undefined;
  logger?: Logger;
}

export function createTaskApprovalGateMiddleware(
  options: TaskApprovalGateOptions,
): AgentMiddleware {
  return createMiddleware({
    name: 'TaskApprovalGateMiddleware',
    wrapModelCall: async (request, handler) => {
      let hint: string | undefined;
      try {
        const did = userDidFromContext(request.runtime.context);
        const surface = did ? options.surfaceFor(did) : undefined;
        if (surface) {
          const text = lastHumanText(request.messages);
          if (text) hint = await computeApprovalHint(surface, text);
        }
      } catch (err) {
        options.logger?.warn(
          `[TaskApprovalGate] gate errored — passing through: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!hint) return handler(request);
      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(hint),
      });
    },
  });
}
