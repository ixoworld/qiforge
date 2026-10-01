/**
 * Insert into a Map used as an LRU: the key moves to the back of the
 * insertion order, and the oldest entries are evicted once `maxEntries` is
 * exceeded. For process-lifetime caches keyed by unbounded request-derived
 * ids (threads, rooms, events), the cap is what keeps them from growing for
 * as long as the process lives.
 */
export function lruInsert<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  maxEntries: number,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
