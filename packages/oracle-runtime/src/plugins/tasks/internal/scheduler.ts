import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { CronExpressionParser } from 'cron-parser';
import type { Trigger } from './spec.js';

export const RUN_QUEUE = 'task_run';
export const APPROVAL_QUEUE = 'task_approval';

export const RUN_QUEUE_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { count: 100, age: 24 * 3600 },
  removeOnFail: { count: 200, age: 7 * 24 * 3600 },
};

export const APPROVAL_QUEUE_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'fixed', delay: 10_000 },
  removeOnComplete: { count: 100, age: 24 * 3600 },
  removeOnFail: { count: 100, age: 7 * 24 * 3600 },
};

export interface RunJobData {
  taskId: string;
  owner: string;
}

export interface ApprovalTimeoutJobData {
  taskId: string;
  owner: string;
  roomId: string;
  phase: 'reminder' | 'expiry';
}

/**
 * Next fire time for a trigger, or null when there is none (one-shot in the
 * past, unparseable cron). Pure — exported for direct unit testing.
 */
export function nextRunAtFor(
  trigger: Trigger,
  from: Date = new Date(),
): string | null {
  if (trigger.type === 'time.once') {
    const at = new Date(trigger.runAtIso);
    return at.getTime() > from.getTime() ? at.toISOString() : null;
  }
  try {
    return CronExpressionParser.parse(trigger.pattern, {
      currentDate: from,
      tz: trigger.tz,
    })
      .next()
      .toDate()
      .toISOString();
  } catch {
    return null;
  }
}

@Injectable()
export class SchedulerService {
  constructor(
    @InjectQueue(RUN_QUEUE) private readonly runQueue: Queue<RunJobData>,
    @InjectQueue(APPROVAL_QUEUE)
    private readonly approvalQueue: Queue<ApprovalTimeoutJobData>,
  ) {}

  /** Enqueue the next run. A task has at most one pending run job at a time. */
  async enqueueRun(
    taskId: string,
    owner: string,
    runAtIso: string,
  ): Promise<void> {
    const delay = Math.max(0, new Date(runAtIso).getTime() - Date.now());
    await this.runQueue.add(
      'run',
      { taskId, owner },
      // Unique per task+fire-time: re-enqueueing the same slot is a no-op,
      // while the next slot of a cron task gets a fresh id even if BullMQ
      // still remembers the completed previous job.
      { jobId: `${taskId}:${runAtIso}`, delay },
    );
  }

  /** Remove every pending (delayed/waiting) run for a task. */
  async cancelRuns(taskId: string): Promise<void> {
    const jobs = await this.runQueue.getJobs(['delayed', 'waiting', 'paused']);
    await Promise.allSettled(
      jobs.filter((j) => j.data.taskId === taskId).map((j) => j.remove()),
    );
  }

  async scheduleApprovalTimeouts(
    data: Omit<ApprovalTimeoutJobData, 'phase'>,
    reminderDelayMs: number,
    expiryDelayMs: number,
  ): Promise<void> {
    await this.approvalQueue.add(
      'timeout',
      { ...data, phase: 'reminder' },
      {
        jobId: `${data.taskId}:reminder:${randomUUID()}`,
        delay: reminderDelayMs,
      },
    );
    await this.approvalQueue.add(
      'timeout',
      { ...data, phase: 'expiry' },
      { jobId: `${data.taskId}:expiry:${randomUUID()}`, delay: expiryDelayMs },
    );
  }

  async cancelApprovalTimeouts(taskId: string): Promise<void> {
    const jobs = await this.approvalQueue.getJobs(['delayed', 'waiting']);
    await Promise.allSettled(
      jobs.filter((j) => j.data.taskId === taskId).map((j) => j.remove()),
    );
  }
}
