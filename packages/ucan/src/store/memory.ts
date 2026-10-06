/* eslint-disable no-console */
/**
 * @fileoverview In-memory invocation store for replay protection
 *
 * This module provides a simple in-memory implementation of the InvocationStore
 * interface for tracking used invocation CIDs to prevent replay attacks.
 *
 * For production use with multiple instances, consider using a distributed
 * store like Redis.
 */

import type { InvocationStore } from '../types.js';

/**
 * Entry in the invocation store
 */
interface StoreEntry {
  /** Timestamp when this entry expires */
  expiresAt: number;
}

/**
 * Default cap on the number of entries an in-memory store keeps.
 */
export const DEFAULT_INVOCATION_STORE_MAX_ENTRIES = 100_000;

/** Minimum time between two sweeps triggered by inserts at the cap. */
const FULL_SWEEP_INTERVAL_MS = 1_000;

/**
 * Options for {@link InMemoryInvocationStore}
 */
export interface InMemoryInvocationStoreOptions {
  /** TTL for entries added without one (default: 24 hours) */
  defaultTtlMs?: number;
  /** Interval of the automatic cleanup (default: 1 hour) */
  cleanupIntervalMs?: number;
  /** Whether to run the automatic cleanup on a timer (default: true) */
  enableAutoCleanup?: boolean;
  /**
   * Maximum number of entries (default: 100,000). When an insert finds the
   * store full, expired entries are swept first (at most once per second);
   * if it is still full the oldest entries are evicted. An evicted invocation that has not expired
   * yet could be presented again, so size the cap above the number of
   * distinct invocations expected within their lifetime.
   */
  maxEntries?: number;
}

/**
 * In-memory implementation of InvocationStore for replay protection
 *
 * Features:
 * - Automatic TTL-based expiration (the validator passes each invocation's
 *   remaining lifetime as the TTL)
 * - Atomic `addIfAbsent()` and `delete()` for race-free replay marks
 * - Bounded size: expired entries are swept and the oldest evicted at the cap
 * - Periodic cleanup of expired entries
 *
 * Limitations:
 * - Data is lost on process restart
 * - Not suitable for distributed deployments
 *
 * @example
 * ```typescript
 * const store = new InMemoryInvocationStore();
 *
 * // Mark an invocation as used, refusing one that already is
 * if (!(await store.addIfAbsent(invocationCid, ttlMs))) {
 *   throw new Error('Replay attack detected');
 * }
 * ```
 */
export class InMemoryInvocationStore implements InvocationStore {
  private store = new Map<string, StoreEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** Default TTL: 24 hours */
  private readonly defaultTtlMs: number;

  /** Cleanup interval: 1 hour */
  private readonly cleanupIntervalMs: number;

  /** Maximum number of entries */
  private readonly maxEntries: number;

  /** When an insert at the cap last swept expired entries */
  private lastFullSweepAt = -Infinity;

  /**
   * Create a new in-memory invocation store
   *
   * @param options - Configuration options
   * @param options.defaultTtlMs - Default TTL for entries (default: 24 hours)
   * @param options.cleanupIntervalMs - Interval for cleanup (default: 1 hour)
   * @param options.enableAutoCleanup - Whether to enable automatic cleanup (default: true)
   * @param options.maxEntries - Maximum number of entries (default: 100,000)
   */
  constructor(options: InMemoryInvocationStoreOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 24 * 60 * 60 * 1000; // 24 hours
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60 * 60 * 1000; // 1 hour
    this.maxEntries =
      options.maxEntries ?? DEFAULT_INVOCATION_STORE_MAX_ENTRIES;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError(
        `maxEntries must be a positive integer, got ${String(options.maxEntries)}`,
      );
    }

    if (options.enableAutoCleanup !== false) {
      this.startAutoCleanup();
    }
  }

  /**
   * Check if an invocation CID has already been used
   *
   * @param cid - The CID of the invocation
   * @returns True if the CID has been used and is not expired
   */
  async has(cid: string): Promise<boolean> {
    return this.isLive(cid, Date.now());
  }

  /**
   * Mark an invocation CID as used
   *
   * @param cid - The CID of the invocation
   * @param ttlMs - Time-to-live in milliseconds (default: 24 hours)
   */
  async add(cid: string, ttlMs?: number): Promise<void> {
    this.insert(cid, ttlMs, Date.now());
  }

  /**
   * Mark an invocation CID as used unless it already is. The check and the
   * insert run in one synchronous step, so concurrent callers in this
   * process cannot both succeed.
   *
   * @param cid - The CID of the invocation
   * @param ttlMs - Time-to-live in milliseconds (default: 24 hours)
   * @returns True when this call placed the mark
   */
  async addIfAbsent(cid: string, ttlMs?: number): Promise<boolean> {
    const now = Date.now();
    if (this.isLive(cid, now)) return false;
    this.insert(cid, ttlMs, now);
    return true;
  }

  /**
   * Remove the mark of an invocation CID
   *
   * @param cid - The CID of the invocation
   */
  async delete(cid: string): Promise<void> {
    this.store.delete(cid);
  }

  private isLive(cid: string, now: number): boolean {
    const entry = this.store.get(cid);
    if (!entry) {
      return false;
    }

    // Check if expired
    if (now > entry.expiresAt) {
      this.store.delete(cid);
      return false;
    }

    return true;
  }

  private insert(cid: string, ttlMs: number | undefined, now: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    // Re-inserting moves the entry to the newest position.
    this.store.delete(cid);
    // A full store of live entries frees nothing on a sweep, so the scan
    // runs at most once per interval; in between the oldest are evicted.
    if (
      this.store.size >= this.maxEntries &&
      now - this.lastFullSweepAt >= FULL_SWEEP_INTERVAL_MS
    ) {
      this.lastFullSweepAt = now;
      this.sweepExpired(now);
    }
    // Map iteration follows insertion order, so the first keys are the
    // oldest entries.
    for (const oldest of this.store.keys()) {
      if (this.store.size < this.maxEntries) break;
      this.store.delete(oldest);
    }
    this.store.set(cid, {
      expiresAt: now + ttl,
    });
  }

  private sweepExpired(now: number): number {
    let cleaned = 0;
    for (const [cid, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(cid);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * Remove all expired entries from the store
   */
  async cleanup(): Promise<void> {
    const cleaned = this.sweepExpired(Date.now());

    if (cleaned > 0) {
      console.log(
        `[InMemoryInvocationStore] Cleaned up ${cleaned} expired entries`,
      );
    }
  }

  /**
   * Get the current size of the store
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Clear all entries from the store
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Start automatic cleanup interval
   */
  private startAutoCleanup(): void {
    if (this.cleanupInterval) {
      return;
    }

    this.cleanupInterval = setInterval(() => {
      void this.cleanup();
    }, this.cleanupIntervalMs);

    // Don't prevent process from exiting
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Stop automatic cleanup and release resources
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}

/**
 * Create an invocation store instance
 * Factory function for easier testing and dependency injection
 *
 * @param options - Store configuration
 * @returns An InvocationStore implementation
 */
export function createInvocationStore(
  options?: InMemoryInvocationStoreOptions,
): InvocationStore {
  return new InMemoryInvocationStore(options);
}

// TODO: Add Redis implementation for distributed deployments
// TODO: Add SQLite implementation for persistence across restarts
// TODO: Add metrics/monitoring for store size and cleanup operations
