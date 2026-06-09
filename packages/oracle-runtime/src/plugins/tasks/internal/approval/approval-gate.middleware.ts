import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from '../../../../plugin-api/types.js';
import {
  APPROVAL_TIMEOUT_JOB_NAME,
  type ApprovalTimeoutJobData,
} from '../scheduler/queues.js';
import { IntentClassifier, type IntentLabel } from './intent-classifier.js';

const APPROVAL_RESOLVE_JOB_NAME = 'resolve';

export type ApprovalResolveJobData = {
  kind: 'resolve';
  taskId: string;
  decision: 'approved' | 'rejected';
};

export type ApprovalQueueJobData =
  | ApprovalTimeoutJobData
  | ApprovalResolveJobData;

const APPROVAL_BY_ROOM = (roomId: string) => `tasks:approval-room:${roomId}`;
const APPROVAL_RESOLVED = (taskId: string) =>
  `tasks:approval-resolved:${taskId}`;

export interface ApprovalGateMiddlewareOptions {
  redis: Redis;
  approvalQueue: Queue<ApprovalQueueJobData>;
  logger?: Logger;
}

/**
 * Pre-LLM intercept. When the user has a pending approval against the room
 * their message landed in, classify the reply (yes/no) and resolve via a
 * BullMQ `resolve` job rather than reaching the LLM. The user gets an
 * immediate acknowledgement; the worker handles the post-message work
 * (clearing state, recording failure, posting delivery).
 *
 * The middleware never imports `ApprovalService` directly — the worker owns
 * that side of the gate. This keeps the middleware closure dependency-free
 * (Redis + a Queue handle is everything it needs).
 */
export function createApprovalGateMiddleware(
  opts: ApprovalGateMiddlewareOptions,
): AgentMiddleware {
  const classifier = new IntentClassifier();
  return createMiddleware({
    name: 'TasksApprovalGate',
    beforeModel: {
      hook: async (state, runtime) => {
        const roomId = extractRoomId(runtime.context);
        if (!roomId) return;

        const taskId = await opts.redis.get(APPROVAL_BY_ROOM(roomId));
        if (!taskId) return;

        const text = lastUserText(state.messages);
        if (!text) return;

        const decision: IntentLabel = classifier.fastPath(text);
        if (decision === 'other') return; // let the agent handle it normally

        // Idempotent claim — first reply wins.
        const claimed = await opts.redis.set(
          APPROVAL_RESOLVED(taskId),
          '1',
          'EX',
          60,
          'NX',
        );
        if (claimed !== 'OK') {
          opts.logger?.log?.(
            `[TasksApprovalGate] resolution for ${taskId} already claimed — skipping`,
          );
          return;
        }

        await opts.approvalQueue.add(
          APPROVAL_RESOLVE_JOB_NAME,
          { kind: 'resolve', taskId, decision },
          { jobId: `${taskId}-resolve` },
        );

        const ack =
          decision === 'approved'
            ? '✅ Approved — delivering the result now.'
            : '❌ Rejected — discarded the pending result.';

        return {
          messages: [new AIMessage({ content: ack })],
          jumpTo: 'end',
        };
      },
      canJumpTo: ['end'],
    },
  });
}

export { APPROVAL_RESOLVE_JOB_NAME, APPROVAL_TIMEOUT_JOB_NAME };

function extractRoomId(context: unknown): string | null {
  if (!context || typeof context !== 'object') return null;
  if (!('session' in context)) return null;
  const session = (context as { session?: unknown }).session;
  if (!session || typeof session !== 'object') return null;
  if (!('roomId' in session)) return null;
  const roomId = (session as { roomId?: unknown }).roomId;
  return typeof roomId === 'string' && roomId.length > 0 ? roomId : null;
}

function lastUserText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof HumanMessage) {
      const c = m.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        // Best-effort: join string parts
        return c
          .map((part) =>
            typeof part === 'string'
              ? part
              : typeof (part as { text?: unknown })?.text === 'string'
                ? (part as { text: string }).text
                : '',
          )
          .filter(Boolean)
          .join(' ');
      }
      return null;
    }
  }
  return null;
}
