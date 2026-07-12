import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  VERIFIED_WORK_SUBMITTER,
  type CompletedTaskRun,
  type VerifiedWorkSubmitter,
} from '../../evals/verified-work.js';
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
import { buildApprovalGuardedMessage } from './prompts.js';
import { TaskStore } from './task-store.js';
import type { TaskSpec } from './spec.js';

/**
 * The hot path. Per run: load spec → run the agent → deliver (or, for a
 * `before-action` task, draft and ask the user to approve in the task's room)
 * → persist next-run bookkeeping → enqueue the next cron occurrence.
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
    private readonly invoker: AgentInvoker,
    @Inject(TASKS_RUNTIME_CONFIG) private readonly config: TasksRuntimeConfig,
    @Optional()
    @Inject(VERIFIED_WORK_SUBMITTER)
    private readonly verifiedWork: VerifiedWorkSubmitter | null = null,
  ) {
    super();
  }

  async process(job: Job<RunJobData>): Promise<void> {
    const { taskId, owner } = job.data;
    const startedAt = Date.now();
    this.logger.log(
      `Run start: ${taskId} (job ${job.id ?? '?'}, attempt ${job.attemptsMade + 1})`,
    );

    const spec = await this.store.load(owner, taskId);
    if (!spec) {
      this.logger.warn(`Task ${taskId} not found — skipping run`);
      return;
    }
    // A fresh `before-action` run SUPERSEDES an unanswered draft: the run
    // below re-binds the room to the new session and deletes the old one, so
    // the stale draft simply stops being continuable. Everything else
    // (paused, cancelled, completed, failed-pending-review) skips.
    const supersedesPendingDraft =
      spec.frontmatter.status === 'pending-approval' &&
      spec.frontmatter.approval === 'before-action';
    if (spec.frontmatter.status !== 'active' && !supersedesPendingDraft) {
      this.logger.log(
        `Task ${taskId} is ${spec.frontmatter.status} — skipping run`,
      );
      return;
    }

    const lockToken = await this.state.acquireRunLock(
      taskId,
      this.config.runLockTtlSec,
    );
    if (!lockToken) {
      this.logger.warn(`Task ${taskId} already running — duplicate skipped`);
      return;
    }

    // Agent runs can outlive the lock TTL — keep extending while we hold it
    // so a parallel worker can't start a duplicate mid-run.
    const heartbeat = setInterval(
      () => {
        this.state
          .extendRunLock(taskId, lockToken, this.config.runLockTtlSec)
          .then((extended) => {
            if (!extended) {
              this.logger.warn(
                `Run-lock extension failed for ${taskId} — lock lost or expired`,
              );
            }
          })
          .catch((err: unknown) =>
            this.logger.warn(
              `Run-lock heartbeat errored for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      },
      Math.max(this.config.runLockTtlSec / 3, 10) * 1000,
    );

    try {
      const roomId = await this.delivery.resolveRoom(spec);
      if (!roomId) {
        throw new Error('Could not resolve a delivery room');
      }

      let output: string;
      let anchorEventId: string | undefined;
      let completedRun: Omit<CompletedTaskRun, 'deliveredEventId'> | undefined;
      const beforeAction = spec.frontmatter.approval === 'before-action';
      if (beforeAction) {
        // A `before-action` task always has a dedicated room. Each run is a
        // persistent conversation: the agent drafts the action and asks for
        // approval, the room is bound to the run's session, and the user's
        // plainly-typed reply continues that thread via the normal chat path.
        const prev = await this.state.getRoomSession(roomId);
        // The run-marker is a REAL Matrix event and IS the run's session id —
        // the session is rooted at a real event like any normal chat session,
        // so threaded replies resolve to it natively (no binding required).
        anchorEventId = await this.delivery.post(
          roomId,
          `🕒 **${spec.frontmatter.title}** — run started`,
        );
        const result = await this.invoker.runConversational({
          did: owner,
          roomId,
          anchorEventId,
          message: buildApprovalGuardedMessage(taskId, spec.body),
        });
        output = result.output;
        await this.state.setRoomSession(roomId, {
          sessionId: result.sessionId,
          taskId,
          owner,
        });
        // The previous run's session/thread is stale now the room points at
        // the new one — tear it down (best-effort) so it can't accumulate.
        if (prev && prev.sessionId !== result.sessionId) {
          await this.invoker.deleteSession(owner, prev.sessionId);
        }
      } else {
        const run = await this.invoker.runOnce({
          did: owner,
          message: spec.body,
          // Anchor the throwaway session in the task's delivery room so
          // `RequestPreparer` skips its own Matrix room-resolution lookup.
          roomId:
            spec.frontmatter.delivery.roomId === 'main' ? undefined : roomId,
        });
        output = run.output;
        // Only a delivered run is completed WORK — a `before-action` run
        // only produced a draft awaiting approval, so it makes no claim.
        completedRun = {
          taskId,
          owner,
          title: spec.frontmatter.title,
          output: run.output,
          roomId,
          sessionId: run.sessionId,
          requestId: job.id,
          messages: run.messages,
        };
      }

      // `post` throws on Matrix failure → the run fails → BullMQ retries. A
      // silent log-and-continue here would mean "task succeeded" while the
      // user never saw the result (or the draft+ask). Drafts thread under the
      // run marker so quote-replies to them resolve to the run's session.
      const deliveredEventId = await this.delivery.post(
        roomId,
        output,
        anchorEventId,
      );

      await this.state.resetFailures(taskId);
      await this.finishRun(spec);

      // Fire-and-forget: the claim submission is non-throwing by contract
      // and must never turn a delivered run into a failed one; the ledger
      // entry it writes gates settlement until the verdict resolves.
      if (completedRun && this.verifiedWork) {
        const submitter = this.verifiedWork;
        void submitter
          .submitCompletedTask({ ...completedRun, deliveredEventId })
          .catch((err: unknown) =>
            this.logger.warn(
              `Verified-work submission for ${taskId} errored: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
      this.logger.log(
        `Run end: ${taskId} in ${Date.now() - startedAt}ms (${output.length} chars, ${beforeAction ? 'draft-for-approval' : 'delivered'})`,
      );
    } finally {
      clearInterval(heartbeat);
      await this.state.releaseRunLock(taskId, lockToken);
    }
  }

  /**
   * `never` tasks: one-shot → completed, cron → persist + enqueue the next
   * occurrence. `before-action` tasks instead land on `pending-approval` —
   * the draft was posted and the task now waits on the user. A cron task's
   * cadence keeps going regardless: the next run is enqueued and, if the
   * draft is still unanswered when it fires, supersedes it.
   */
  private async finishRun(spec: TaskSpec): Promise<void> {
    const { id, owner, trigger, approval } = spec.frontmatter;

    if (approval === 'before-action') {
      // Conditional on active/pending-approval: a pause/cancel issued while
      // the run was in flight must not be clobbered.
      if (trigger.type === 'time.once') {
        await this.store.setStatus(owner, id, 'pending-approval', null, {
          onlyIfStatus: ['active', 'pending-approval'],
        });
        return;
      }
      const next = nextRunAtFor(trigger);
      const updated = await this.store.setStatus(
        owner,
        id,
        'pending-approval',
        next,
        { onlyIfStatus: ['active', 'pending-approval'] },
      );
      if (updated && next) await this.scheduler.enqueueRun(id, owner, next);
      return;
    }

    if (trigger.type === 'time.once') {
      // Conditional: a pause/cancel issued while the run was in flight must
      // not be clobbered with 'completed'.
      await this.store.setStatus(owner, id, 'completed', null, {
        onlyIfStatus: ['active'],
      });
      return;
    }
    const next = nextRunAtFor(trigger);
    // `updateNextRun` preserves the live status and refuses non-active
    // tasks — if the user paused/cancelled mid-run, nothing is written or
    // enqueued; resume recomputes the schedule.
    const updated = await this.store.updateNextRun(owner, id, next);
    if (updated && next) await this.scheduler.enqueueRun(id, owner, next);
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

  @OnWorkerEvent('error')
  onWorkerError(error: Error): void {
    this.logger.error(`Run worker error: ${error.message}`);
  }

  @OnWorkerEvent('stalled')
  onJobStalled(jobId: string): void {
    this.logger.warn(`Run job stalled: ${jobId}`);
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

    const spec = await this.store.load(owner, taskId);
    if (!spec) return;

    const oneShot = spec.frontmatter.trigger.type === 'time.once';
    if (!oneShot && count < MAX_CONSECUTIVE_FAILURES) {
      // The next cron occurrence was never enqueued (the run aborted before
      // finishRun) — reschedule so a transient failure doesn't kill the task.
      const next = nextRunAtFor(spec.frontmatter.trigger);
      if (next && (await this.store.updateNextRun(owner, taskId, next))) {
        await this.scheduler.enqueueRun(taskId, owner, next);
      }
      return;
    }

    // A one-shot has no next occurrence to silently retry into — the user
    // is waiting on a result that will never come, so any final failure is
    // loud. Cron tasks get here only at the consecutive-failure threshold.
    const updated = await this.store.setStatus(
      owner,
      taskId,
      'failed-pending-review',
      null,
      { onlyIfStatus: ['active'] },
    );
    if (!updated) return;
    await this.scheduler.cancelRuns(taskId);
    const roomId = await this.delivery.resolveRoom(updated);
    if (roomId) {
      await this.delivery.safePost(
        roomId,
        oneShot
          ? `🛑 Your scheduled task \`${taskId}\` failed and is paused for review: ${error.message.slice(0, 200)}\n\nAsk me to **suggest a fix** when you're ready.`
          : `🛑 Task \`${taskId}\` failed ${count} times in a row and is paused for review. Ask me to **suggest a fix** when you're ready.`,
      );
    }
  }
}
