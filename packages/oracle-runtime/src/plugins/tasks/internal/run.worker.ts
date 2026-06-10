import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ApprovalService } from './approval.js';
import { DeliveryService } from './delivery.js';
import { AgentInvoker } from './invoker.js';
import { RedisState } from './redis-state.js';
import {
  MAX_CONSECUTIVE_FAILURES,
  TASKS_RUNTIME_CONFIG,
  type TasksRuntimeConfig,
} from './runtime.js';
import {
  nextRunAtFor,
  RUN_QUEUE,
  SchedulerService,
  type RunJobData,
} from './scheduler.js';
import { TaskStore } from './task-store.js';
import type { TaskSpec } from './spec.js';

/**
 * The hot path. Per run: load spec → run the agent on the task's persistent
 * session → deliver (or stage for approval) → persist next-run bookkeeping →
 * enqueue the next cron occurrence.
 *
 * Errors are thrown so BullMQ retries with backoff; the consecutive-failure
 * counter only moves when a run exhausts its final attempt (see
 * `onJobFailed`), so one flaky run can't burn the whole threshold.
 */
@Processor(RUN_QUEUE, { concurrency: 5 })
export class TaskRunWorker extends WorkerHost {
  private readonly logger = new Logger(TaskRunWorker.name);

  constructor(
    private readonly store: TaskStore,
    private readonly state: RedisState,
    private readonly scheduler: SchedulerService,
    private readonly delivery: DeliveryService,
    private readonly approval: ApprovalService,
    private readonly invoker: AgentInvoker,
    @Inject(TASKS_RUNTIME_CONFIG) private readonly config: TasksRuntimeConfig,
  ) {
    super();
  }

  async process(job: Job<RunJobData>): Promise<void> {
    const { taskId, owner } = job.data;

    const spec = await this.store.load(owner, taskId);
    if (!spec) {
      this.logger.warn(`Task ${taskId} not found — skipping run`);
      return;
    }
    if (spec.frontmatter.status !== 'active') {
      this.logger.log(
        `Task ${taskId} is ${spec.frontmatter.status} — skipping run`,
      );
      return;
    }

    if (!(await this.state.acquireRunLock(taskId, this.config.runLockTtlSec))) {
      this.logger.warn(`Task ${taskId} already running — duplicate skipped`);
      return;
    }

    try {
      const roomId = await this.delivery.resolveRoom(spec);
      if (!roomId) {
        throw new Error('Could not resolve a delivery room');
      }

      const output = await this.invoker.runOnce({
        did: owner,
        message: spec.body,
        // Anchor the throwaway session in the task's delivery room so
        // `RequestPreparer` skips its own Matrix room-resolution lookup.
        roomId:
          spec.frontmatter.delivery.roomId === 'main' ? undefined : roomId,
      });

      if (spec.frontmatter.approval === 'before-delivery') {
        await this.approval.request({ taskId, owner, roomId, output });
      } else {
        // `post` throws on Matrix failure → the run fails → BullMQ retries.
        // A silent log-and-continue here would mean "task succeeded" while
        // the user never saw the result.
        await this.delivery.post(roomId, output);
      }

      await this.state.resetFailures(taskId);
      await this.finishRun(spec);
    } finally {
      await this.state.releaseRunLock(taskId);
    }
  }

  /** One-shot → completed. Cron → persist + enqueue the next occurrence. */
  private async finishRun(spec: TaskSpec): Promise<void> {
    const { id, owner, trigger } = spec.frontmatter;
    if (trigger.type === 'time.once') {
      await this.store.setStatus(owner, id, 'completed', null);
      return;
    }
    const next = nextRunAtFor(trigger);
    await this.store.setStatus(owner, id, 'active', next);
    if (next) await this.scheduler.enqueueRun(id, owner, next);
  }

  @OnWorkerEvent('failed')
  onJobFailed(job: Job<RunJobData> | undefined, error: Error): void {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // BullMQ will retry — not final yet
    void this.recordFinalFailure(job.data, error).catch((err: Error) =>
      this.logger.error(
        `Failure bookkeeping for ${job.data.taskId} failed: ${err.message}`,
      ),
    );
  }

  private async recordFinalFailure(
    data: RunJobData,
    error: Error,
  ): Promise<void> {
    const { taskId, owner } = data;
    const count = await this.state.recordFailure(taskId, error.message);
    this.logger.warn(
      `Task ${taskId} run failed (${count} consecutive): ${error.message}`,
    );
    if (count < MAX_CONSECUTIVE_FAILURES) {
      // The next cron occurrence was never enqueued (the run aborted before
      // finishRun) — reschedule so a transient failure doesn't kill the task.
      const spec = await this.store.load(owner, taskId);
      if (
        spec?.frontmatter.status === 'active' &&
        spec.frontmatter.trigger.type === 'time.cron'
      ) {
        const next = nextRunAtFor(spec.frontmatter.trigger);
        if (next) {
          await this.store.setStatus(owner, taskId, 'active', next);
          await this.scheduler.enqueueRun(taskId, owner, next);
        }
      }
      return;
    }
    const spec = await this.store.setStatus(
      owner,
      taskId,
      'failed-pending-review',
      null,
    );
    if (!spec) return;
    await this.scheduler.cancelRuns(taskId);
    const roomId = await this.delivery.resolveRoom(spec);
    if (roomId) {
      await this.delivery.safePost(
        roomId,
        `🛑 Task \`${taskId}\` failed ${count} times in a row and is paused for review. Ask me to **suggest a fix** when you're ready.`,
      );
    }
  }
}
