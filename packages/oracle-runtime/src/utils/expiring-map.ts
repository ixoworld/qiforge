/**
 * Drop expired entries from a TTL map. The runtime's small lookup caches
 * check expiry lazily on read, which leaves entries for keys that are never
 * read again resident forever; calling this on each write keeps such maps
 * bounded by their active key set without a background timer.
 */
export function sweepExpired<V extends { expiresAt: number }>(
  map: Map<string, V>,
  now: number = Date.now(),
): void {
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) map.delete(key);
  }
}
