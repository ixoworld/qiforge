import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ApprovalService } from './approval.js';
import { APPROVAL_QUEUE, type ApprovalTimeoutJobData } from './scheduler.js';

/** Fires the 24h approval reminder and the 48h expiry. */
@Processor(APPROVAL_QUEUE, { concurrency: 10 })
export class ApprovalTimeoutWorker extends WorkerHost {
  constructor(private readonly approval: ApprovalService) {
    super();
  }

  async process(job: Job<ApprovalTimeoutJobData>): Promise<void> {
    await this.approval.handleTimeout(job.data);
  }
}
