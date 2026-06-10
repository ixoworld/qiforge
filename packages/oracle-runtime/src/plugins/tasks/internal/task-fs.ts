import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { TASKS_REDIS } from './redis-state.js';

/**
 * The storage port for user-readable task artifacts (`spec.md`). Filesystem
 * semantics, nothing more — so when the runtime grows a UCAN per-user
 * filesystem (same auth model as sandbox), the swap is one DI binding.
 *
 * Ephemeral coordination state (locks, failure counters, pending approvals)
 * deliberately does NOT go through this port — see `RedisState`.
 */
export const TASK_FS = Symbol('TASK_FS');

export interface TaskFs {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  /** Absolute paths under `prefix`. */
  list(prefix: string): Promise<string[]>;
}

const KEY_PREFIX = 'tasks:fs:';

@Injectable()
export class RedisTaskFs implements TaskFs {
  constructor(@Inject(TASKS_REDIS) private readonly redis: Redis) {}

  async read(path: string): Promise<string | null> {
    return this.redis.get(KEY_PREFIX + path);
  }

  async write(path: string, content: string): Promise<void> {
    await this.redis.set(KEY_PREFIX + path, content);
  }

  async delete(path: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + path);
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${KEY_PREFIX}${prefix}*`,
        'COUNT',
        200,
      );
      cursor = next;
      for (const key of keys) out.push(key.slice(KEY_PREFIX.length));
    } while (cursor !== '0');
    return out;
  }
}
