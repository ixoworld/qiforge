import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { TASKS_REDIS } from './redis.token.js';
import type { TaskFs } from './task-fs.js';

const PREFIX = 'tasks:fs:';
const SCAN_COUNT = 200;

@Injectable()
export class RedisTaskFs implements TaskFs {
  constructor(@Inject(TASKS_REDIS) private readonly redis: Redis) {}

  async read(path: string): Promise<string | null> {
    return this.redis.get(PREFIX + path);
  }

  async write(path: string, content: string): Promise<void> {
    await this.redis.set(PREFIX + path, content);
  }

  async delete(path: string): Promise<void> {
    await this.redis.del(PREFIX + path);
  }

  async list(prefix: string): Promise<string[]> {
    const match = `${PREFIX}${prefix}*`;
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        match,
        'COUNT',
        SCAN_COUNT,
      );
      cursor = next;
      for (const k of keys) {
        out.push(k.substring(PREFIX.length));
      }
    } while (cursor !== '0');
    return out;
  }
}
