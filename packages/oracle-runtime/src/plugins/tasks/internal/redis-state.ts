import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

/** The shared ioredis client. Provided by `TasksModule` from `REDIS_URL`. */
export const TASKS_REDIS = Symbol('TASKS_REDIS');

const KEY = {
  lock: (taskId: string) => `tasks:lock:${taskId}`,
  failures: (taskId: string) => `tasks:failures:${taskId}`,
  preview: (token: string) => `tasks:preview:${token}`,
  roomSession: (roomId: string) => `tasks:room-session:${roomId}`,
};

/** A dedicated task room is pinned to its latest run's session for this long. */
const ROOM_SESSION_TTL_SEC = 7 * 24 * 3600;

// Compare-and-mutate scripts so only the current lock holder can extend or
// release: a worker whose lock already expired (and was re-acquired by a
// parallel worker) must not delete or prolong the new holder's lock.
const EXTEND_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('expire', KEYS[1], ARGV[2])
else
  return 0
end`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

export interface FailureInfo {
  count: number;
  lastError: string;
  lastFailedAt: string;
}

export interface PreviewClaim {
  owner: string;
  hash: string;
  /**
   * The request (turn) the preview ran in. `create_task` refuses a token
   * minted in the same turn so the agent is forced to surface the preview
   * and wait for the user to confirm in a new message.
   */
  requestId?: string;
}

/**
 * Operational state on direct Redis: run locks, consecutive-failure counters,
 * preview tokens, and dedicated-room session bindings. None of it is a
 * user-readable artifact, so none of it goes through `TaskFs`.
 */
@Injectable()
export class RedisState {
  constructor(@Inject(TASKS_REDIS) private readonly redis: Redis) {}

  // ── run lock ────────────────────────────────────────────────────────────

  /** @returns the holder token to extend/release with, or null when taken. */
  async acquireRunLock(taskId: string, ttlSec: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(
      KEY.lock(taskId),
      token,
      'EX',
      ttlSec,
      'NX',
    );
    return result === 'OK' ? token : null;
  }

  /** @returns false when the lock is no longer held with `token`. */
  async extendRunLock(
    taskId: string,
    token: string,
    ttlSec: number,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      EXTEND_LOCK_SCRIPT,
      1,
      KEY.lock(taskId),
      token,
      ttlSec,
    );
    return Number(result) === 1;
  }

  async releaseRunLock(taskId: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, KEY.lock(taskId), token);
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

  /**
   * Non-destructive — `create_task` peeks to validate before doing any
   * persisting work, so a validation failure (task limit, bad trigger)
   * doesn't burn the user's token.
   */
  async peekPreview(token: string): Promise<PreviewClaim | null> {
    const raw = await this.redis.get(KEY.preview(token));
    return raw ? (JSON.parse(raw) as PreviewClaim) : null;
  }

  /** Destructive — call once `create_task` has fully committed. */
  async deletePreview(token: string): Promise<void> {
    await this.redis.del(KEY.preview(token));
  }

  // ── room → session binding (dedicated task rooms) ───────────────────────

  /** Pin a dedicated room to the session of its latest run. */
  async setRoomSession(roomId: string, sessionId: string): Promise<void> {
    await this.redis.set(
      KEY.roomSession(roomId),
      sessionId,
      'EX',
      ROOM_SESSION_TTL_SEC,
    );
  }

  /** The session a dedicated room is currently bound to, if any. */
  async getRoomSession(roomId: string): Promise<string | undefined> {
    return (await this.redis.get(KEY.roomSession(roomId))) ?? undefined;
  }

  async clearRoomSession(roomId: string): Promise<void> {
    await this.redis.del(KEY.roomSession(roomId));
  }
}
