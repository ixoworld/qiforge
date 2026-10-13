/**
 * A small least-recently-used map bounded by entry count and by a total
 * weight (bytes, characters). `Map` keeps insertion order, so re-inserting on
 * every hit makes the first key the least recently used one.
 */
export class LruMap<K, V> {
  private readonly entries = new Map<K, { value: V; weight: number }>();
  private totalWeight = 0;

  constructor(
    private readonly limits: {
      maxEntries: number;
      maxWeight?: number;
      weigh?: (value: V) => number;
    },
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get weight(): number {
    return this.totalWeight;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Stores `value` unless it alone exceeds the weight bound; evicts the least recently used entries to fit. */
  set(key: K, value: V): void {
    const weight = this.limits.weigh?.(value) ?? 0;
    const maxWeight = this.limits.maxWeight ?? Infinity;
    this.delete(key);
    if (weight > maxWeight) return;
    while (
      this.entries.size > 0 &&
      (this.entries.size >= this.limits.maxEntries ||
        this.totalWeight + weight > maxWeight)
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    this.entries.set(key, { value, weight });
    this.totalWeight += weight;
  }

  delete(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
  }
}
