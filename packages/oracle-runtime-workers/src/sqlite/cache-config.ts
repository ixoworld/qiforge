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
  return parseByteSize(raw, {
    name: 'CHUNK_CACHE_BYTES',
    fallback: DEFAULT_CHUNK_CACHE_BYTES,
    min: MIN_CHUNK_CACHE_BYTES,
    max: MAX_CHUNK_CACHE_BYTES,
    warn,
  });
}

/** Same grammar for any byte-sized env knob (`TIER_HOT_BUDGET_BYTES`, ...). */
export function parseByteSize(
  raw: string | undefined,
  options: {
    name: string;
    fallback: number;
    min: number;
    max: number;
    warn?: (message: string) => void;
  },
): number {
  const warn = options.warn ?? (() => undefined);
  if (raw === undefined || raw.trim() === '') return options.fallback;
  const match = /^\s*(\d+)\s*([kKmM]?)\s*$/.exec(raw);
  if (!match) {
    warn(
      `${options.name}=${JSON.stringify(raw)} is not a byte count — using the default ${options.fallback}`,
    );
    return options.fallback;
  }
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : 1;
  const bytes = Number(match[1]) * multiplier;
  if (bytes < options.min || bytes > options.max) {
    warn(
      `${options.name}=${raw} is outside ${options.min}..${options.max} — using the default ${options.fallback}`,
    );
    return options.fallback;
  }
  return bytes;
}

/** The `cachePages` open option for a byte budget. */
export function cachePagesForBytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / VFS_PAGE_SIZE));
}
