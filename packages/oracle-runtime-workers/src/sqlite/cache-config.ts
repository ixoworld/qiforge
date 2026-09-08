/**
 * `CHUNK_CACHE_BYTES`: the per-object budget of clean 64 KiB chunks the DO
 * VFS keeps in memory (see `DoVfs`). Every user object of a script shares
 * one isolate (128 MB), so this is the knob that trades turn latency (more
 * cache = fewer DO storage reads) against how many active users fit.
 */
import { DEFAULT_CACHE_PAGES, VFS_PAGE_SIZE } from './do-vfs';

export const DEFAULT_CHUNK_CACHE_BYTES = DEFAULT_CACHE_PAGES * VFS_PAGE_SIZE;
export const MIN_CHUNK_CACHE_BYTES = 1024 * 1024;
export const MAX_CHUNK_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Parse the env value (plain bytes, or with a `k`/`m` suffix: `4m`,
 * `4096k`). Unset → default; malformed or out of range → default plus a
 * warning through `warn`.
 */
export function parseChunkCacheBytes(
  raw: string | undefined,
  warn: (message: string) => void = () => undefined,
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CHUNK_CACHE_BYTES;
  const match = /^\s*(\d+)\s*([kKmM]?)\s*$/.exec(raw);
  if (!match) {
    warn(
      `CHUNK_CACHE_BYTES=${JSON.stringify(raw)} is not a byte count — using the default ${DEFAULT_CHUNK_CACHE_BYTES}`,
    );
    return DEFAULT_CHUNK_CACHE_BYTES;
  }
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : 1;
  const bytes = Number(match[1]) * multiplier;
  if (bytes < MIN_CHUNK_CACHE_BYTES || bytes > MAX_CHUNK_CACHE_BYTES) {
    warn(
      `CHUNK_CACHE_BYTES=${raw} is outside ${MIN_CHUNK_CACHE_BYTES}..${MAX_CHUNK_CACHE_BYTES} — using the default ${DEFAULT_CHUNK_CACHE_BYTES}`,
    );
    return DEFAULT_CHUNK_CACHE_BYTES;
  }
  return bytes;
}

/** The `cachePages` open option for a byte budget. */
export function cachePagesForBytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / VFS_PAGE_SIZE));
}
