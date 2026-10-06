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
