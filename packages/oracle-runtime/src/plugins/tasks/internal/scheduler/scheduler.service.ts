import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { CronExpressionParser } from 'cron-parser';
import type { Trigger } from '../domain/trigger.js';
import {
  APPROVAL_TIMEOUT_JOB_NAME,
  QUEUE_NAMES,
  RUN_JOB_NAME,
  type ApprovalTimeoutJobData,
  type ApprovalTimeoutPhase,
  type TaskRunJobData,
} from './queues.js';

const RUN_JOB_ID = (taskId: string, runId: string) => `${taskId}-run-${runId}`;
const APPROVAL_JOB_ID = (taskId: string, phase: ApprovalTimeoutPhase) =>
  `${taskId}-approval-${phase}`;

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.RUN)
    private readonly runQueue: Queue<TaskRunJobData>,
    @InjectQueue(QUEUE_NAMES.APPROVAL)
    private readonly approvalQueue: Queue<ApprovalTimeoutJobData>,
  ) {}

  /**
   * Compute the next-fire ISO timestamp for a trigger. Returns null for
   * one-shot triggers that are already past.
   */
  nextRunAt(trigger: Trigger, from: Date = new Date()): string | null {
    if (trigger.type === 'time.once') {
      const at = new Date(trigger.runAtIso);
      return at.getTime() > from.getTime() ? at.toISOString() : null;
    }
    try {
      const it = CronExpressionParser.parse(trigger.pattern, {
        currentDate: from,
        tz: trigger.tz,
      });
      return it.next().toDate().toISOString();
    } catch (err) {
      this.logger.warn(
        `Invalid cron pattern "${trigger.pattern}" tz=${trigger.tz}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Enqueue the next run for a task. Idempotent on `(taskId, runId)`.
   * Returns the runId of the scheduled job, or null if nothing was queued
   * (e.g. one-shot already past).
   */
  async enqueueNextRun(
    taskId: string,
    owner: string,
    nextRunAtIso: string | null,
  ): Promise<string | null> {
    if (!nextRunAtIso) return null;
    const delay = Math.max(0, new Date(nextRunAtIso).getTime() - Date.now());
    const runId = randomUUID();
    const data: TaskRunJobData = { taskId, owner, runId };
    await this.runQueue.add(RUN_JOB_NAME, data, {
      jobId: RUN_JOB_ID(taskId, runId),
      delay,
    });
    return runId;
  }

  /**
   * Cancel every pending run for a task (delayed + waiting). Active runs
   * complete on their own.
   */
  async cancelAllRuns(taskId: string): Promise<number> {
    let removed = 0;
    const jobs = await this.runQueue.getJobs(['delayed', 'waiting', 'paused']);
    for (const job of jobs) {
      if (job.data?.taskId === taskId) {
        await job.remove().catch(() => {
          /* ignore — job may have advanced */
        });
        removed++;
      }
    }
    return removed;
  }

  // --- approval timeouts ------------------------------------------------

  async scheduleApprovalTimeouts(
    taskId: string,
    owner: string,
    roomId: string,
    reminderDelayMs: number,
    expiryDelayMs: number,
  ): Promise<void> {
    await this.approvalQueue.add(
      APPROVAL_TIMEOUT_JOB_NAME,
      { taskId, owner, roomId, phase: 'reminder' },
      { jobId: APPROVAL_JOB_ID(taskId, 'reminder'), delay: reminderDelayMs },
    );
    await this.approvalQueue.add(
      APPROVAL_TIMEOUT_JOB_NAME,
      { taskId, owner, roomId, phase: 'expiry' },
      { jobId: APPROVAL_JOB_ID(taskId, 'expiry'), delay: expiryDelayMs },
    );
  }

  async cancelApprovalTimeouts(taskId: string): Promise<void> {
    await Promise.allSettled([
      this.approvalQueue.remove(APPROVAL_JOB_ID(taskId, 'reminder')),
      this.approvalQueue.remove(APPROVAL_JOB_ID(taskId, 'expiry')),
    ]);
  }
}
