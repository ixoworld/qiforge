import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ApprovalService } from '../approval/approval.service.js';
import { TASKS_CONFIG, type TasksConfig } from '../config.token.js';
import { PostResultService } from '../delivery/post-result.js';
import { RoomResolver } from '../delivery/room-resolver.js';
import {
  parseSpec,
  renderSpec,
  specPath,
  type TaskSpec,
} from '../domain/spec.js';
import { AutomationInvoker } from '../runtime/automation-invoker.js';
import { QUEUE_NAMES, type TaskRunJobData } from '../scheduler/queues.js';
import { SchedulerService } from '../scheduler/scheduler.service.js';
import { EphemeralStateService } from '../store/ephemeral-state.js';
import { TASK_FS, type TaskFs } from '../store/task-fs.js';

/**
 * Loads the spec, invokes the main agent via `MessagesService`, hands the
 * result to delivery (or the approval gate), updates `nextRunAt`, reschedules
 * if recurring. No `createMainAgent`, no `buildRuntimeContext`, no AMBIENT.
 */
@Processor(QUEUE_NAMES.RUN)
export class TaskRunWorker extends WorkerHost {
  private readonly logger = new Logger(TaskRunWorker.name);

  constructor(
    @Inject(TASK_FS) private readonly fs: TaskFs,
    private readonly invoker: AutomationInvoker,
    private readonly state: EphemeralStateService,
    private readonly scheduler: SchedulerService,
    private readonly approval: ApprovalService,
    private readonly roomResolver: RoomResolver,
    private readonly post: PostResultService,
    @Inject(TASKS_CONFIG) private readonly config: TasksConfig,
  ) {
    super();
  }

  async process(job: Job<TaskRunJobData>): Promise<void> {
    const { taskId, owner, runId } = job.data;

    const md = await this.fs.read(specPath(owner, taskId));
    if (!md) {
      this.logger.warn(`Task ${taskId} not found for owner ${owner}; skipping`);
      return;
    }

    const spec = parseSpec(md);
    if (!isRunnable(spec.frontmatter.status)) {
      this.logger.log(
        `Task ${taskId} status=${spec.frontmatter.status} — skipping run`,
      );
      return;
    }

    const acquired = await this.state.acquireRunLock(
      taskId,
      this.config.runLockTtlSec,
    );
    if (!acquired) {
      this.logger.warn(
        `Task ${taskId} run lock held — duplicate delivery skipped`,
      );
      return;
    }

    try {
      await this.executeOnce(spec, taskId, owner, runId);
    } catch (err) {
      await this.handleFailure(spec, taskId, owner, err);
      throw err; // let BullMQ retry per its backoff policy
    } finally {
      await this.state.releaseRunLock(taskId);
    }
  }

  private async executeOnce(
    spec: TaskSpec,
    taskId: string,
    owner: string,
    runId: string,
  ): Promise<void> {
    const result = await this.invoker.invoke({
      userDid: owner,
      message: spec.body,
      taskId,
      runId,
      modelTier: spec.frontmatter.modelTier,
    });

    const deliveryRoom = this.roomResolver.resolveDeliveryRoom(
      spec,
      result.mainRoomId,
    );
    if (!deliveryRoom) {
      this.logger.warn(
        `No delivery room resolved for task ${taskId} — output dropped`,
      );
    } else if (spec.frontmatter.approval === 'before-delivery') {
      await this.approval.request({
        taskId,
        owner,
        roomId: deliveryRoom,
        preview: result.output,
      });
    } else {
      await this.post.postRunResult(deliveryRoom, result.output);
    }

    await this.state.resetFailures(taskId);
    await this.updateSpecAndReschedule(spec, owner, taskId);
  }

  private async handleFailure(
    spec: TaskSpec,
    taskId: string,
    owner: string,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const count = await this.state.recordFailure(taskId, message);
    if (count < this.config.maxConsecutiveFailures) return;

    // Threshold reached: mark task failed-pending-review and notify.
    try {
      const updated: TaskSpec = {
        ...spec,
        frontmatter: {
          ...spec.frontmatter,
          status: 'failed-pending-review',
          stats: { ...spec.frontmatter.stats, nextRunAt: null },
        },
      };
      await this.fs.write(specPath(owner, taskId), renderSpec(updated));
      await this.scheduler.cancelAllRuns(taskId);
      const deliveryRoom = this.roomResolver.resolveDeliveryRoom(spec, null);
      if (deliveryRoom) {
        await this.post.postFailedPendingReview(deliveryRoom, taskId);
      }
    } catch (markErr) {
      this.logger.error(
        `Failed to mark task ${taskId} as failed-pending-review: ${
          (markErr as Error).message
        }`,
      );
    }
  }

  /**
   * For one-shot tasks: mark `completed`. For cron: compute next, persist,
   * enqueue. Both update the on-disk spec.
   */
  private async updateSpecAndReschedule(
    spec: TaskSpec,
    owner: string,
    taskId: string,
  ): Promise<void> {
    const next =
      spec.frontmatter.trigger.type === 'time.cron'
        ? this.scheduler.nextRunAt(spec.frontmatter.trigger)
        : null;
    const status: TaskSpec['frontmatter']['status'] =
      spec.frontmatter.trigger.type === 'time.once'
        ? 'completed'
        : spec.frontmatter.status;
    const updated: TaskSpec = {
      ...spec,
      frontmatter: {
        ...spec.frontmatter,
        status,
        stats: { ...spec.frontmatter.stats, nextRunAt: next },
      },
    };
    await this.fs.write(specPath(owner, taskId), renderSpec(updated));
    if (next && status === 'active') {
      await this.scheduler.enqueueNextRun(taskId, owner, next);
    }
  }
}

function isRunnable(status: TaskSpec['frontmatter']['status']): boolean {
  return status === 'active' || status === 'draft';
}
