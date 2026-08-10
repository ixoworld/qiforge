import { describe, expect, it, vi } from 'vitest';
import {
  activeEngagementCacheKey,
  DEFAULT_ENGAGEMENT_CACHE_TTL_SECONDS,
  engagementCacheTtlSeconds,
  InMemoryActiveEngagementCache,
  RedisActiveEngagementCache,
} from './active-engagement-cache.js';

const KEY = activeEngagementCacheKey('did:ixo:user-1');
const VALUE = { roomId: '!room:ixo', threadId: 'evt-1' };

function silentLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('InMemoryActiveEngagementCache', () => {
  it('round-trips a value and deletes it', async () => {
    const cache = new InMemoryActiveEngagementCache();

    await cache.set(KEY, VALUE, 60);
    expect(await cache.get(KEY)).toEqual(VALUE);

    await cache.delete(KEY);
    expect(await cache.get(KEY)).toBeNull();
  });

  it('expires lazily on read — no timer holds the process open', async () => {
    let now = 1_000;
    const cache = new InMemoryActiveEngagementCache({ now: () => now });

    await cache.set(KEY, VALUE, 10);
    now += 9_999;
    expect(await cache.get(KEY)).toEqual(VALUE);

    now += 2;
    expect(await cache.get(KEY)).toBeNull();
  });
});

describe('RedisActiveEngagementCache', () => {
  it('stores JSON with the TTL and reads it back', async () => {
    const set = vi.fn(async () => undefined);
    const cache = new RedisActiveEngagementCache(
      {
        get: async () => JSON.stringify(VALUE),
        set,
        del: async () => undefined,
      },
      silentLogger(),
    );

    await cache.set(KEY, VALUE, 120);
    expect(set).toHaveBeenCalledWith(KEY, JSON.stringify(VALUE), 120);
    expect(await cache.get(KEY)).toEqual(VALUE);
  });

  it('treats an outage as a miss and a no-op, never a throw', async () => {
    const logger = silentLogger();
    const boom = async () => {
      throw new Error('ECONNREFUSED');
    };
    const cache = new RedisActiveEngagementCache(
      { get: boom, set: boom, del: boom },
      logger,
    );

    expect(await cache.get(KEY)).toBeNull();
    await expect(cache.set(KEY, VALUE, 60)).resolves.toBeUndefined();
    await expect(cache.delete(KEY)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('reads an unparseable value as a miss', async () => {
    const cache = new RedisActiveEngagementCache(
      {
        get: async () => 'not json',
        set: async () => undefined,
        del: async () => undefined,
      },
      silentLogger(),
    );

    expect(await cache.get(KEY)).toBeNull();
  });
});

describe('engagementCacheTtlSeconds', () => {
  const now = new Date('2026-07-22T12:00:00.000Z');

  it('outlives the escrow deadline it describes', () => {
    const oneHourOut = new Date(now.getTime() + 3600_000).toISOString();

    // The reservation window plus a day's margin: the replica can never
    // expire while the job it routes is still live.
    expect(engagementCacheTtlSeconds(oneHourOut, now)).toBe(3600 + 24 * 3600);
  });

  it('falls back to the bounded default without a deadline', () => {
    expect(engagementCacheTtlSeconds(undefined, now)).toBe(
      DEFAULT_ENGAGEMENT_CACHE_TTL_SECONDS,
    );
    expect(engagementCacheTtlSeconds('not a date', now)).toBe(
      DEFAULT_ENGAGEMENT_CACHE_TTL_SECONDS,
    );
  });

  it('keeps a floor for a deadline that has all but passed', () => {
    const past = new Date(now.getTime() - 30 * 24 * 3600_000).toISOString();
    expect(engagementCacheTtlSeconds(past, now)).toBe(3600);
  });
});
