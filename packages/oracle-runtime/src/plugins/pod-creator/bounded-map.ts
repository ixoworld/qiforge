/**
 * A Map with an entry cap and an idle TTL, for plugin-singleton state that
 * would otherwise grow for the process lifetime. Reads and writes refresh an
 * entry's recency and idle deadline; when the cap is exceeded the
 * least-recently-used entry is evicted. Expiry is lazy — enforced on access,
 * not by timers — so the structure is safe to hold indefinitely.
 */
export interface BoundedMapOptions {
  /** Maximum live entries; the least-recently-used entry is evicted beyond it. */
  maxEntries: number;
  /** Idle time after the last read/write before an entry expires. */
  ttlMs: number;
  /** Clock override for tests. */
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class BoundedMap<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: BoundedMapOptions) {
    this.maxEntries = options.maxEntries;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to mark as most-recently-used and extend the idle deadline.
    this.entries.delete(key);
    entry.expiresAt = this.now() + this.ttlMs;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    this.evict();
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Drop expired entries, then trim oldest-first down to the cap. */
  private evict(): void {
    const cutoff = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= cutoff) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }
}
