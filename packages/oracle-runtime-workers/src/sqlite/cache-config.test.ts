import { describe, expect, it } from 'vitest';
import {
  cachePagesForBytes,
  DEFAULT_CHUNK_CACHE_BYTES,
  parseChunkCacheBytes,
} from './cache-config';
import { PAGES_PER_CHUNK, VFS_PAGE_SIZE } from './do-vfs';

describe('parseChunkCacheBytes', () => {
  it('defaults to 4 MiB when unset', () => {
    expect(parseChunkCacheBytes(undefined)).toBe(4 * 1024 * 1024);
    expect(parseChunkCacheBytes('')).toBe(DEFAULT_CHUNK_CACHE_BYTES);
  });

  it('accepts bytes and k/m suffixes', () => {
    expect(parseChunkCacheBytes('4194304')).toBe(4 * 1024 * 1024);
    expect(parseChunkCacheBytes('4m')).toBe(4 * 1024 * 1024);
    expect(parseChunkCacheBytes(' 4096K ')).toBe(4 * 1024 * 1024);
  });

  it('falls back to the default (with a warning) on junk or out-of-range values', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(parseChunkCacheBytes('lots', warn)).toBe(DEFAULT_CHUNK_CACHE_BYTES);
    expect(parseChunkCacheBytes('1', warn)).toBe(DEFAULT_CHUNK_CACHE_BYTES);
    expect(parseChunkCacheBytes('1g', warn)).toBe(DEFAULT_CHUNK_CACHE_BYTES);
    expect(parseChunkCacheBytes('999m', warn)).toBe(DEFAULT_CHUNK_CACHE_BYTES);
    expect(warnings).toHaveLength(4);
  });
});

describe('cachePagesForBytes', () => {
  it('maps a byte budget to whole 4 KiB pages (16 per chunk)', () => {
    expect(cachePagesForBytes(8 * 1024 * 1024)).toBe(2048);
    expect(cachePagesForBytes(4 * 1024 * 1024) / PAGES_PER_CHUNK).toBe(64);
    expect(cachePagesForBytes(VFS_PAGE_SIZE / 2)).toBe(1);
  });
});
