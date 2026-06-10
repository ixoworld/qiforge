import { Injectable, Logger } from '@nestjs/common';
import { DeliveryService } from './delivery.js';
import { RedisState } from './redis-state.js';
import { SchedulerService } from './scheduler.js';
import { TaskStore } from './task-store.js';
import { MAX_CONSECUTIVE_FAILURES } from './runtime.js';

/**
 * Cross-plugin DI token: other plugins can inject the gate to stage their
 * own approval requests through the same reply-interception machinery.
 */
export const APPROVAL_GATE_PORT = Symbol('APPROVAL_GATE_PORT');

export interface ApprovalGatePort {
  request(args: {
    taskId: string;
    owner: string;
    roomId: string;
    output: string;
  }): Promise<void>;
}

const APPROVAL_TTL_SEC = 49 * 3600; // 48h expiry window + 1h slack
const REMINDER_AFTER_MS = 24 * 3600 * 1000;
const EXPIRY_AFTER_MS = 48 * 3600 * 1000;
const PREVIEW_CHARS = 1200;

/**
 * The approval gate: stages a run's output for user sign-off, posts the ask
 * into the delivery room, and resolves on the user's reply (via the
 * middleware fast path or the `resolve_pending_approval` tool) or on
 * timeout. Resolution is exactly-once via a Redis SETNX claim.
 */
@Injectable()
export class ApprovalService implements ApprovalGatePort {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    private readonly state: RedisState,
    private readonly scheduler: SchedulerService,
    private readonly delivery: DeliveryService,
    private readonly store: TaskStore,
  ) {}

  async request(args: {
    taskId: string;
    owner: string;
    roomId: string;
    output: string;
  }): Promise<void> {
    await this.state.putPendingApproval(args, APPROVAL_TTL_SEC);
    await this.scheduler.scheduleApprovalTimeouts(
      args,
      REMINDER_AFTER_MS,
      EXPIRY_AFTER_MS,
    );
    const preview =
      args.output.length > PREVIEW_CHARS
        ? `${args.output.slice(0, PREVIEW_CHARS)}\n…`
        : args.output;
    await this.delivery.post(
      args.roomId,
      `✋ **Approval needed** — task \`${args.taskId}\`\n\n${preview}\n\nReply **yes** to deliver this result, or **no** to discard.`,
    );
  }

  /** @returns false when there was nothing to resolve (already handled). */
  async approve(taskId: string): Promise<boolean> {
    const pending = await this.takePending(taskId);
    if (!pending) return false;
    await this.delivery.post(pending.roomId, pending.output);
    await this.state.resetFailures(taskId);
    return true;
  }

  /** @returns false when there was nothing to resolve (already handled). */
  async reject(taskId: string, reason?: string): Promise<boolean> {
    const pending = await this.takePending(taskId);
    if (!pending) return false;
    await this.delivery.post(
      pending.roomId,
      `❌ Result discarded${reason ? ` — ${reason}` : ''}.`,
    );
    await this.recordRejection(
      pending.owner,
      taskId,
      reason ?? 'Rejected by user',
    );
    return true;
  }

  async handleTimeout(args: {
    taskId: string;
    owner: string;
    roomId: string;
    phase: 'reminder' | 'expiry';
  }): Promise<void> {
    if (args.phase === 'reminder') {
      if (await this.state.getPendingApproval(args.taskId)) {
        await this.delivery.post(
          args.roomId,
          `🔔 Task \`${args.taskId}\` is still waiting on your approval. Reply yes / no.`,
        );
      }
      return;
    }
    const pending = await this.takePending(args.taskId);
    if (!pending) return;
    await this.delivery.post(
      args.roomId,
      '⌛ Approval window expired — the pending result was discarded.',
    );
    await this.recordRejection(
      args.owner,
      args.taskId,
      'Approval expired (48h)',
    );
  }

  /** Claim + clear the pending approval atomically-enough for exactly-once. */
  private async takePending(taskId: string) {
    const pending = await this.state.getPendingApproval(taskId);
    if (!pending) return null;
    if (!(await this.state.claimApprovalResolution(taskId))) return null;
    await this.state.clearPendingApproval(pending);
    await this.scheduler.cancelApprovalTimeouts(taskId);
    return pending;
  }

  private async recordRejection(
    owner: string,
    taskId: string,
    reason: string,
  ): Promise<void> {
    const count = await this.state.recordFailure(taskId, reason);
    if (count < MAX_CONSECUTIVE_FAILURES) return;
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
      await this.delivery.post(
        roomId,
        `🛑 Task \`${taskId}\` was rejected ${count} times in a row and is paused for review. Ask me to **suggest a fix** when you're ready.`,
      );
    }
    this.logger.warn(
      `Task ${taskId} moved to failed-pending-review after ${count} rejections`,
    );
  }
}
