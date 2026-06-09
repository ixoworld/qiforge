import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { TASKS_REDIS } from './redis.token.js';

const KEY = {
  lock: (taskId: string) => `tasks:lock:${taskId}`,
  failures: (taskId: string) => `tasks:failures:${taskId}`,
  preview: (token: string) => `tasks:preview:${token}`,
  approval: (taskId: string) => `tasks:approval:${taskId}`,
  approvalByRoom: (roomId: string) => `tasks:approval-room:${roomId}`,
  approvalResolved: (taskId: string) => `tasks:approval-resolved:${taskId}`,
} as const;

export interface FailureInfo {
  count: number;
  lastError: string;
  lastFailedAt: string;
}

export interface PreviewToken {
  owner: string;
  hash: string;
  expiresAt: number;
}

export interface PendingApproval {
  taskId: string;
  owner: string;
  roomId: string;
  output: string;
  createdAt: number;
}

/**
 * Operational state on direct Redis. None of these are user-readable
 * artifacts — they're how the plugin coordinates with itself. They never
 * go through TaskFs.
 */
@Injectable()
export class EphemeralStateService {
  constructor(@Inject(TASKS_REDIS) private readonly redis: Redis) {}

  // --- run lock ---------------------------------------------------------

  async acquireRunLock(taskId: string, ttlSec: number): Promise<boolean> {
    const res = await this.redis.set(KEY.lock(taskId), '1', 'EX', ttlSec, 'NX');
    return res === 'OK';
  }

  async releaseRunLock(taskId: string): Promise<void> {
    await this.redis.del(KEY.lock(taskId));
  }

  // --- failure counter --------------------------------------------------

  async recordFailure(taskId: string, error: string): Promise<number> {
    const key = KEY.failures(taskId);
    const nowIso = new Date().toISOString();
    const tx = this.redis.multi();
    tx.hincrby(key, 'count', 1);
    tx.hset(key, 'lastError', error.slice(0, 1024));
    tx.hset(key, 'lastFailedAt', nowIso);
    const res = await tx.exec();
    const incr = res?.[0]?.[1];
    return typeof incr === 'number' ? incr : Number(incr ?? 0);
  }

  async resetFailures(taskId: string): Promise<void> {
    await this.redis.del(KEY.failures(taskId));
  }

  async getFailures(taskId: string): Promise<FailureInfo | null> {
    const raw = await this.redis.hgetall(KEY.failures(taskId));
    if (!raw || Object.keys(raw).length === 0) return null;
    return {
      count: Number(raw.count ?? 0),
      lastError: raw.lastError ?? '',
      lastFailedAt: raw.lastFailedAt ?? '',
    };
  }

  // --- preview tokens ---------------------------------------------------

  async putPreviewToken(
    token: string,
    payload: PreviewToken,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      KEY.preview(token),
      JSON.stringify(payload),
      'EX',
      ttlSec,
    );
  }

  async consumePreviewToken(token: string): Promise<PreviewToken | null> {
    const key = KEY.preview(token);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    await this.redis.del(key);
    try {
      return JSON.parse(raw) as PreviewToken;
    } catch {
      return null;
    }
  }

  // --- pending approvals ------------------------------------------------

  async putPendingApproval(
    payload: PendingApproval,
    ttlSec: number,
  ): Promise<void> {
    const tx = this.redis.multi();
    tx.set(KEY.approval(payload.taskId), JSON.stringify(payload), 'EX', ttlSec);
    tx.set(KEY.approvalByRoom(payload.roomId), payload.taskId, 'EX', ttlSec);
    await tx.exec();
  }

  async getPendingApproval(taskId: string): Promise<PendingApproval | null> {
    const raw = await this.redis.get(KEY.approval(taskId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PendingApproval;
    } catch {
      return null;
    }
  }

  async getPendingApprovalForRoom(
    roomId: string,
  ): Promise<PendingApproval | null> {
    const taskId = await this.redis.get(KEY.approvalByRoom(roomId));
    if (!taskId) return null;
    return this.getPendingApproval(taskId);
  }

  async clearPendingApproval(taskId: string): Promise<void> {
    const pending = await this.getPendingApproval(taskId);
    const tx = this.redis.multi();
    tx.del(KEY.approval(taskId));
    if (pending) tx.del(KEY.approvalByRoom(pending.roomId));
    await tx.exec();
  }

  /** Returns true if we won the race to resolve this approval. */
  async claimApprovalResolution(taskId: string): Promise<boolean> {
    const res = await this.redis.set(
      KEY.approvalResolved(taskId),
      '1',
      'EX',
      60,
      'NX',
    );
    return res === 'OK';
  }
}
