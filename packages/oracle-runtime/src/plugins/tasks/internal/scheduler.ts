import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { CronExpressionParser } from 'cron-parser';
import type { Trigger } from './spec.js';

export const RUN_QUEUE = 'task_run';

export const RUN_QUEUE_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { count: 100, age: 24 * 3600 },
  removeOnFail: { count: 200, age: 7 * 24 * 3600 },
};

export interface RunJobData {
  taskId: string;
  owner: string;
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

/**
 * Job id for a task's run, unique per task+fire-time: re-enqueueing the same
 * slot is a no-op, while the next slot of a cron task gets a fresh id even if
 * BullMQ still remembers the completed previous job. BullMQ rejects custom
 * job ids containing `:`, so the ISO timestamp's colons become dots and `@`
 * separates the parts.
 */
export function runJobId(taskId: string, runAtIso: string): string {
  return `${taskId}@${runAtIso.replaceAll(':', '.')}`;
}

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectQueue(RUN_QUEUE) private readonly runQueue: Queue<RunJobData>,
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
      { jobId: runJobId(taskId, runAtIso), delay },
    );
    this.logger.log(
      `Enqueued run for ${taskId} at ${runAtIso} (delay ${delay}ms)`,
    );
  }

  /** Remove every pending (delayed/waiting) run for a task. */
  async cancelRuns(taskId: string): Promise<void> {
    const jobs = await this.runQueue.getJobs(['delayed', 'waiting', 'paused']);
    const mine = jobs.filter((j) => j.data.taskId === taskId);
    await Promise.allSettled(mine.map((j) => j.remove()));
    if (mine.length > 0) {
      this.logger.log(`Cancelled ${mine.length} pending run(s) for ${taskId}`);
    }
  }
}
