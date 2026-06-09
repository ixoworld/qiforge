import { Inject, Injectable, Logger } from '@nestjs/common';
import { EphemeralStateService } from '../store/ephemeral-state.js';
import { SchedulerService } from '../scheduler/scheduler.service.js';
import {
  specPath,
  parseSpec,
  renderSpec,
  type TaskSpec,
} from '../domain/spec.js';
import { TASK_FS, type TaskFs } from '../store/task-fs.js';
import { TASKS_CONFIG } from '../config.token.js';
import type { TasksConfig } from '../config.token.js';
import { PostResultService } from '../delivery/post-result.js';

export const APPROVAL_GATE_PORT = Symbol('APPROVAL_GATE_PORT');

export interface ApprovalGatePort {
  /**
   * Cross-plugin entry point: stage an approval request against a room.
   * The Tasks plugin's middleware will pick up the user's reply and resolve
   * via the same `approve` / `reject` path used by the tasks runtime.
   */
  request(args: {
    taskId: string;
    owner: string;
    roomId: string;
    preview: string;
  }): Promise<void>;
}

const APPROVAL_TTL_SEC = 49 * 3600; // 48h expiry + 1h slack
const REMINDER_AFTER_MS = 24 * 3600 * 1000;
const EXPIRY_AFTER_MS = 48 * 3600 * 1000;
const PREVIEW_MAX_CHARS = 1200;

@Injectable()
export class ApprovalService implements ApprovalGatePort {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    private readonly state: EphemeralStateService,
    private readonly scheduler: SchedulerService,
    private readonly postResult: PostResultService,
    @Inject(TASK_FS) private readonly fs: TaskFs,
    @Inject(TASKS_CONFIG) private readonly config: TasksConfig,
  ) {}

  /** ApprovalGatePort entry point (also used internally). */
  async request(args: {
    taskId: string;
    owner: string;
    roomId: string;
    preview: string;
  }): Promise<void> {
    const preview = truncate(args.preview, PREVIEW_MAX_CHARS);
    await this.state.putPendingApproval(
      {
        taskId: args.taskId,
        owner: args.owner,
        roomId: args.roomId,
        output: args.preview,
        createdAt: Date.now(),
      },
      APPROVAL_TTL_SEC,
    );
    await this.scheduler.scheduleApprovalTimeouts(
      args.taskId,
      args.owner,
      args.roomId,
      REMINDER_AFTER_MS,
      EXPIRY_AFTER_MS,
    );
    await this.postResult.postApprovalRequest(
      args.roomId,
      args.taskId,
      preview,
    );
  }

  async approve(taskId: string): Promise<void> {
    if (!(await this.state.claimApprovalResolution(taskId))) return;
    const pending = await this.state.getPendingApproval(taskId);
    if (!pending) return;
    try {
      await this.postResult.postRunResult(pending.roomId, pending.output);
      await this.state.resetFailures(taskId);
    } finally {
      await this.cleanup(taskId);
    }
  }

  async reject(taskId: string, reason?: string): Promise<void> {
    if (!(await this.state.claimApprovalResolution(taskId))) return;
    const pending = await this.state.getPendingApproval(taskId);
    if (!pending) return;
    try {
      const count = await this.state.recordFailure(
        taskId,
        reason ? `Rejected: ${reason}` : 'Rejected by user',
      );
      await this.postResult.postRejection(pending.roomId, reason);
      if (count >= this.config.maxConsecutiveFailures) {
        await this.markFailedPendingReview(pending.owner, taskId);
      }
    } finally {
      await this.cleanup(taskId);
    }
  }

  async handleTimeout(args: {
    taskId: string;
    owner: string;
    roomId: string;
    phase: 'reminder' | 'expiry';
  }): Promise<void> {
    const pending = await this.state.getPendingApproval(args.taskId);
    if (!pending) return;
    if (args.phase === 'reminder') {
      await this.postResult.postApprovalReminder(args.roomId, args.taskId);
      return;
    }
    // expiry
    if (!(await this.state.claimApprovalResolution(args.taskId))) return;
    try {
      await this.state.recordFailure(args.taskId, 'Approval expired (48h)');
      await this.postResult.postApprovalExpired(args.roomId);
      await this.markFailedPendingReview(args.owner, args.taskId);
    } finally {
      await this.cleanup(args.taskId);
    }
  }

  private async cleanup(taskId: string): Promise<void> {
    await this.state.clearPendingApproval(taskId);
    await this.scheduler.cancelApprovalTimeouts(taskId);
  }

  private async markFailedPendingReview(
    owner: string,
    taskId: string,
  ): Promise<void> {
    try {
      const md = await this.fs.read(specPath(owner, taskId));
      if (!md) return;
      const spec = parseSpec(md);
      if (spec.frontmatter.status === 'cancelled') return;
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
    } catch (err) {
      this.logger.warn(
        `Failed to mark task ${taskId} as failed-pending-review: ${(err as Error).message}`,
      );
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n…[truncated]`;
}
