import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

/** The shared ioredis client. Provided by `TasksModule` from `REDIS_URL`. */
export const TASKS_REDIS = Symbol('TASKS_REDIS');

const KEY = {
  lock: (taskId: string) => `tasks:lock:${taskId}`,
  failures: (taskId: string) => `tasks:failures:${taskId}`,
  preview: (token: string) => `tasks:preview:${token}`,
  approval: (taskId: string) => `tasks:approval:${taskId}`,
  approvalByRoom: (roomId: string) => `tasks:approval-room:${roomId}`,
  approvalClaim: (taskId: string) => `tasks:approval-resolved:${taskId}`,
};

export interface FailureInfo {
  count: number;
  lastError: string;
  lastFailedAt: string;
}

export interface PreviewClaim {
  owner: string;
  hash: string;
}

export interface PendingApproval {
  taskId: string;
  owner: string;
  roomId: string;
  output: string;
}

/**
 * Operational state on direct Redis: run locks, consecutive-failure counters,
 * preview tokens, and pending approvals. None of it is a user-readable
 * artifact, so none of it goes through `TaskFs`.
 */
@Injectable()
export class RedisState {
  constructor(@Inject(TASKS_REDIS) private readonly redis: Redis) {}

  // ── run lock ────────────────────────────────────────────────────────────

  async acquireRunLock(taskId: string, ttlSec: number): Promise<boolean> {
    return (
      (await this.redis.set(KEY.lock(taskId), '1', 'EX', ttlSec, 'NX')) === 'OK'
    );
  }

  async releaseRunLock(taskId: string): Promise<void> {
    await this.redis.del(KEY.lock(taskId));
  }

  // ── consecutive-failure counter (reset on every successful run) ─────────

  async recordFailure(taskId: string, error: string): Promise<number> {
    const key = KEY.failures(taskId);
    const tx = this.redis.multi();
    tx.hincrby(key, 'count', 1);
    tx.hset(
      key,
      'lastError',
      error.slice(0, 1024),
      'lastFailedAt',
      new Date().toISOString(),
    );
    const results = await tx.exec();
    return Number(results?.[0]?.[1] ?? 0);
  }

  async resetFailures(taskId: string): Promise<void> {
    await this.redis.del(KEY.failures(taskId));
  }

  async getFailures(taskId: string): Promise<FailureInfo | null> {
    const raw = await this.redis.hgetall(KEY.failures(taskId));
    if (!raw.count) return null;
    return {
      count: Number(raw.count),
      lastError: raw.lastError ?? '',
      lastFailedAt: raw.lastFailedAt ?? '',
    };
  }

  // ── preview tokens (one-shot, short TTL) ────────────────────────────────

  async putPreview(
    token: string,
    claim: PreviewClaim,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      KEY.preview(token),
      JSON.stringify(claim),
      'EX',
      ttlSec,
    );
  }

  /** Read-and-delete — a preview token is single-use. */
  async consumePreview(token: string): Promise<PreviewClaim | null> {
    const raw = await this.redis.getdel(KEY.preview(token));
    return raw ? (JSON.parse(raw) as PreviewClaim) : null;
  }

  // ── pending approvals ───────────────────────────────────────────────────

  async putPendingApproval(
    pending: PendingApproval,
    ttlSec: number,
  ): Promise<void> {
    const tx = this.redis.multi();
    tx.set(KEY.approval(pending.taskId), JSON.stringify(pending), 'EX', ttlSec);
    tx.set(KEY.approvalByRoom(pending.roomId), pending.taskId, 'EX', ttlSec);
    await tx.exec();
  }

  async getPendingApproval(taskId: string): Promise<PendingApproval | null> {
    const raw = await this.redis.get(KEY.approval(taskId));
    return raw ? (JSON.parse(raw) as PendingApproval) : null;
  }

  async getPendingTaskForRoom(roomId: string): Promise<string | null> {
    return this.redis.get(KEY.approvalByRoom(roomId));
  }

  async clearPendingApproval(pending: PendingApproval): Promise<void> {
    await this.redis.del(
      KEY.approval(pending.taskId),
      KEY.approvalByRoom(pending.roomId),
    );
  }

  /** SETNX claim so duplicate replies / redeliveries resolve exactly once. */
  async claimApprovalResolution(taskId: string): Promise<boolean> {
    return (
      (await this.redis.set(
        KEY.approvalClaim(taskId),
        '1',
        'EX',
        300,
        'NX',
      )) === 'OK'
    );
  }
}
