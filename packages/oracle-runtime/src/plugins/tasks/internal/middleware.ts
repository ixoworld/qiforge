import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { createMiddleware, type AgentMiddleware } from 'langchain';
import type { Logger } from '../../../plugin-api/types.js';
import type { GetTasksRuntime } from './runtime.js';

const APPROVE = new Set([
  'yes',
  'y',
  'yeah',
  'yep',
  'ok',
  'okay',
  'sure',
  'approve',
  'approved',
  'do it',
  'go',
  'ship',
  'send',
  'confirm',
  'confirmed',
]);

const REJECT = new Set([
  'no',
  'n',
  'nope',
  'cancel',
  'reject',
  'rejected',
  'stop',
  "don't",
  'dont',
  'discard',
  'abort',
]);

export type FastReply = 'approved' | 'rejected' | 'other';

/**
 * Keyword classification of a reply to a pending approval. Covers the
 * overwhelming majority of replies with zero model cost; everything else
 * returns `'other'` and is handled by the main agent itself (which gets a
 * system-prompt hint plus the `resolve_pending_approval` tool).
 */
export function classifyReplyFast(text: string): FastReply {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return 'other';
  if (APPROVE.has(normalized)) return 'approved';
  if (REJECT.has(normalized)) return 'rejected';
  if (normalized.length <= 32) {
    const words = normalized.split(' ');
    const one = words[0] ?? '';
    const two = words.slice(0, 2).join(' ');
    if (APPROVE.has(one) || APPROVE.has(two)) return 'approved';
    if (REJECT.has(one) || REJECT.has(two)) return 'rejected';
  }
  return 'other';
}

/**
 * The approval gate. Wraps every model call:
 *
 *   - no pending approval for this room → pass through untouched (1 Redis GET)
 *   - clear yes/no reply → resolve via `ApprovalService` and answer with a
 *     short acknowledgement, skipping the model entirely
 *   - anything else → call the model with a system-prompt hint so the agent
 *     can resolve nuanced replies through `resolve_pending_approval`
 *
 * Shares the module's services through the plugin's runtime getter — no
 * private Redis connections, no extra queues.
 */
export function createApprovalGateMiddleware(args: {
  getRuntime: GetTasksRuntime;
  logger?: Logger;
}): AgentMiddleware {
  return createMiddleware({
    name: 'TasksApprovalGate',
    wrapModelCall: async (request, handler) => {
      const runtime = args.getRuntime();
      if (!runtime) return handler(request);

      const roomId = roomIdFromContext(request.runtime.context);
      if (!roomId) return handler(request);

      const taskId = await runtime.state.getPendingTaskForRoom(roomId);
      if (!taskId) return handler(request);

      const text = lastHumanText(request.messages);
      if (!text) return handler(request);

      const decision = classifyReplyFast(text);
      if (decision === 'approved') {
        const resolved = await runtime.approval.approve(taskId);
        if (resolved) {
          args.logger?.log?.(
            `[TasksApprovalGate] approved ${taskId} (fast path)`,
          );
          return new AIMessage('✅ Approved — the result has been delivered.');
        }
        return handler(request);
      }
      if (decision === 'rejected') {
        const resolved = await runtime.approval.reject(taskId);
        if (resolved) {
          args.logger?.log?.(
            `[TasksApprovalGate] rejected ${taskId} (fast path)`,
          );
          return new AIMessage(
            '❌ Rejected — the pending result was discarded.',
          );
        }
        return handler(request);
      }

      // Ambiguous — let the model decide, with context.
      const hint = `\n\nA scheduled task (id: ${taskId}) has a result pending the user's approval in this conversation. If the user's message is responding to that approval request, call the resolve_pending_approval tool; otherwise answer normally.`;
      return handler({
        ...request,
        systemPrompt: `${request.systemPrompt ?? ''}${hint}`,
      });
    },
  });
}

function roomIdFromContext(context: unknown): string | null {
  if (!context || typeof context !== 'object' || !('session' in context))
    return null;
  const session = (context as { session?: unknown }).session;
  if (!session || typeof session !== 'object' || !('roomId' in session))
    return null;
  const roomId = (session as { roomId?: unknown }).roomId;
  return typeof roomId === 'string' && roomId.length > 0 ? roomId : null;
}

function lastHumanText(messages: BaseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!(message instanceof HumanMessage)) continue;
    const { content } = message;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) =>
          typeof part === 'object' && part !== null && 'text' in part
            ? String((part as { text: unknown }).text)
            : '',
        )
        .filter(Boolean)
        .join(' ');
      return text || null;
    }
    return null;
  }
  return null;
}
