import type { Logger } from '../../plugin-api/types.js';
import { errorMessage } from './util.js';

/**
 * A key/value store with per-entry expiry, holding the replica of each user's
 * active engagement. Deliberately dumb: values go in and come back out as
 * `unknown`, because the payload is validated against the engagement schema by
 * the service that owns it, not trusted from the store.
 *
 * Both implementations are non-throwing by contract — the replica is an
 * optimisation over the durable Matrix record, so a store failure must degrade
 * to a miss, never into a chat turn.
 */
export interface ActiveEngagementCacheStore {
  /** The stored value, or `null` when absent, expired, or unreadable. */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The Redis commands the cache needs, adapted from the app's ioredis client. */
export interface EngagementCacheRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

interface MemoryEntry {
  value: unknown;
  expiresAtMs: number;
}

/**
 * The no-Redis implementation: a plain in-process `Map`. Entries expire lazily
 * on read (and on the next write to the same key) — a timer for a cache whose
 * durable copy is one Matrix read away would cost more than it saves.
 *
 * Per-process, so it does not survive a restart or span replicas. That is the
 * accepted trade: a cold cache falls back to the durable per-room lookup.
 */
export class InMemoryActiveEngagementCache implements ActiveEngagementCacheStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly now: () => number;

  constructor(deps: { now?: () => number } = {}) {
    this.now = deps.now ?? Date.now;
  }

  async get(key: string): Promise<unknown> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAtMs: this.now() + ttlSeconds * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/**
 * The Redis implementation, used when the oracle is deployed with `REDIS_URL`.
 * Shared across replicas and surviving restarts, so the "work or support?"
 * decision stays a single fast read even on a freshly booted process.
 *
 * Every command is wrapped: a Redis outage reads as a cache miss and writes
 * as a no-op, both logged once at `warn`, and the durable Matrix record
 * carries on being the truth.
 */
export class RedisActiveEngagementCache implements ActiveEngagementCacheStore {
  constructor(
    private readonly redis: EngagementCacheRedis,
    private readonly logger: Logger,
  ) {}

  async get(key: string): Promise<unknown> {
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (error) {
      this.logger.warn(
        `[oracle-payments] engagement cache read failed for ${key}, falling back to room state: ${errorMessage(error)}`,
      );
      return null;
    }
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      // A value written by an older/newer shape: treat as absent and let the
      // next write replace it.
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), ttlSeconds);
    } catch (error) {
      this.logger.warn(
        `[oracle-payments] engagement cache write failed for ${key}: ${errorMessage(error)}`,
      );
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (error) {
      this.logger.warn(
        `[oracle-payments] engagement cache delete failed for ${key}: ${errorMessage(error)}`,
      );
    }
  }
}

/** Namespaced cache key for a user's active engagement. */
export function activeEngagementCacheKey(userDid: string): string {
  return `oracle-payments:active-engagement:${userDid}`;
}

/** Replica lifetime when the engagement carries no escrow deadline. */
export const DEFAULT_ENGAGEMENT_CACHE_TTL_SECONDS = 7 * 24 * 3600;

/** Kept alive this much past the escrow deadline it describes. */
const CACHE_TTL_MARGIN_SECONDS = 24 * 3600;

/** Floor, so a nearly-expired reservation still gets a usable cache entry. */
const MIN_CACHE_TTL_SECONDS = 3600;

/**
 * How long a replica may live: comfortably past the escrow window it
 * describes, so it never expires while the job it routes is still live, and
 * bounded so an abandoned engagement stops being cached on its own.
 */
export function engagementCacheTtlSeconds(
  expiresAt: string | undefined,
  now: Date,
): number {
  if (expiresAt === undefined) return DEFAULT_ENGAGEMENT_CACHE_TTL_SECONDS;
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return DEFAULT_ENGAGEMENT_CACHE_TTL_SECONDS;
  const seconds =
    Math.floor((deadline - now.getTime()) / 1000) + CACHE_TTL_MARGIN_SECONDS;
  return Math.max(MIN_CACHE_TTL_SECONDS, seconds);
}
