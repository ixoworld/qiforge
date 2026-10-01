/**
 * LRU-bounded in-memory Keyv store for the global Nest `CacheModule`.
 *
 * The module's default memory backend is an unbounded Map whose expired
 * entries are only reclaimed when the same key is read again. Several cache
 * key families are derived from per-request material (e.g. the auth
 * middleware keys on a hash of the UCAN token), so keys that are never read
 * twice accumulate for the process lifetime. This store bounds the whole
 * table: least-recently-used entries are evicted once `maxEntries` is
 * exceeded, and expired entries are dropped on access.
 *
 * Implements keyv's `KeyvStoreAdapter` contract structurally — keeping the
 * runtime free of a direct `keyv` dependency (it arrives via
 * `@nestjs/cache-manager`, which wraps whatever `stores` receives).
 */
export class BoundedMemoryStore {
  /** Adapter contract field — keyv inspects it; nothing to configure here. */
  opts: Record<string, unknown> = {};
  namespace?: string;

  private readonly entries = new Map<
    string,
    { value: unknown; expiresAt: number | undefined }
  >();

  constructor(private readonly maxEntries: number) {}

  /** Adapter contract — keyv subscribes to store errors; we never emit any. */
  on(_event: string, _listener: (...args: unknown[]) => void): this {
    return this;
  }

  async get<Value>(key: string): Promise<Value | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Delete-then-set moves the key to the back of the Map's insertion
    // order, which is what makes eviction least-recently-USED rather than
    // least-recently-written.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as Value;
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAt:
        typeof ttl === 'number' && ttl > 0 ? Date.now() + ttl : undefined,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  /** Current entry count — exposed for tests. */
  get size(): number {
    return this.entries.size;
  }
}
