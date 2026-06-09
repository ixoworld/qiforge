import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ApprovalService } from '../approval/approval.service.js';
import type { ApprovalQueueJobData } from '../approval/approval-gate.middleware.js';
import { APPROVAL_TIMEOUT_JOB_NAME, QUEUE_NAMES } from '../scheduler/queues.js';

/**
 * Handles the `task_approval` queue. Two job names:
 *
 *   - `timeout` (with `phase: 'reminder' | 'expiry'`) — scheduled at
 *     approval-request time by `ApprovalService`.
 *   - `resolve` — pushed by `approval-gate.middleware` when a user replies
 *     yes/no in the approval room.
 *
 * Dispatch is by job name, not job data, so the middleware doesn't need
 * to know about timeout job shapes.
 */
@Processor(QUEUE_NAMES.APPROVAL)
export class ApprovalEventsWorker extends WorkerHost {
  private readonly logger = new Logger(ApprovalEventsWorker.name);

  constructor(private readonly approval: ApprovalService) {
    super();
  }

  async process(job: Job<ApprovalQueueJobData>): Promise<void> {
    if (job.name === APPROVAL_TIMEOUT_JOB_NAME) {
      const data = job.data as Extract<
        ApprovalQueueJobData,
        { phase: 'reminder' | 'expiry' }
      >;
      await this.approval.handleTimeout({
        taskId: data.taskId,
        owner: data.owner,
        roomId: data.roomId,
        phase: data.phase,
      });
      return;
    }
    if (job.name === 'resolve') {
      const data = job.data as Extract<
        ApprovalQueueJobData,
        { kind: 'resolve' }
      >;
      if (data.decision === 'approved')
        await this.approval.approve(data.taskId);
      else await this.approval.reject(data.taskId);
      return;
    }
    this.logger.warn(`Unknown approval job: name=${job.name}`);
  }
}
