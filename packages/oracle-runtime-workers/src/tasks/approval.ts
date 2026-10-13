import { z } from 'zod';
import type { OracleTaskRecord } from '../plugin-api/types';
import { canonicalArguments } from '../core/middlewares/tool-execution';
import { markdownDigest } from './topic-deliverables';

export const TaskApprovalRequestSchema = z
  .object({
    id: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    occurrence: z.string().datetime(),
    delivery: z.enum(['pending', 'delivered']),
  })
  .strict();
export type TaskApprovalRequest = z.infer<typeof TaskApprovalRequestSchema>;
export const TaskApprovalDecisionSchema = z
  .object({
    approvalRequestId: z.string().uuid(),
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(4000).optional(),
  })
  .strict();
export type TaskApprovalDecision = z.infer<typeof TaskApprovalDecisionSchema>;
export const TaskApprovalReceiptSchema = TaskApprovalDecisionSchema.extend({
  taskId: z.string().min(1),
  actorDid: z.string().startsWith('did:'),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  occurrence: z.string().datetime(),
  decidedAt: z.string().datetime(),
}).strict();
export type TaskApprovalReceipt = z.infer<typeof TaskApprovalReceiptSchema>;

export function taskApprovalDigest(
  task: OracleTaskRecord,
  occurrence: string,
): Promise<string> {
  return markdownDigest(
    canonicalArguments({
      title: task.title,
      intent: task.intent,
      schedule: task.schedule,
      approval: task.approval,
      deliveryRoomId: task.deliveryRoomId,
      executionProfile: task.executionProfile,
      occurrence,
    }),
  );
}
