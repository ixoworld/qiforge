/**
 * Shared pieces of the `ctx.kv` surface (`UserKvSurface`): argument checks,
 * JSON encoding, and an in-memory implementation for tests and partial hosts.
 * The Workers host backs the surface with the user's SQLite file instead
 * (`sqlite/user-kv-store.ts`), with the same semantics.
 */
import type { UserKvSurface, UserKvWriteOptions } from '../plugin-api/types';

/** Longest namespace / key accepted, in characters. */
export const USER_KV_MAX_NAME_LENGTH = 512;

export function assertUserKvName(
  kind: 'namespace' | 'key',
  value: string,
): void {
  if (value.length === 0 || value.length > USER_KV_MAX_NAME_LENGTH) {
    throw new RangeError(
      `user kv ${kind} must be 1-${USER_KV_MAX_NAME_LENGTH} characters, got ${value.length}`,
    );
  }
}

export function assertUserKvOptions(options: UserKvWriteOptions): void {
  const { idleTtlMs, maxEntries } = options;
  if (
    idleTtlMs !== undefined &&
    (!Number.isFinite(idleTtlMs) || idleTtlMs <= 0)
  ) {
    throw new RangeError(
      `user kv idleTtlMs must be a positive number, got ${idleTtlMs}`,
    );
  }
  if (
    maxEntries !== undefined &&
    (!Number.isInteger(maxEntries) || maxEntries < 1)
  ) {
    throw new RangeError(
      `user kv maxEntries must be a positive integer, got ${maxEntries}`,
    );
  }
}

/**
 * Serialise a value for storage. Rejects what JSON cannot carry (a bare
 * `undefined`, a function, a symbol) instead of storing something the next
 * read cannot return.
 */
export function encodeUserKvValue(value: unknown): string {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') {
    throw new TypeError('user kv values must be JSON-serialisable');
  }
  return json;
}

export function decodeUserKvValue(json: string): unknown {
  return JSON.parse(json);
}

interface MemoryEntry {
  json: string;
  idleTtlMs?: number;
  expiresAt?: number;
}

/**
 * In-memory {@link UserKvSurface}: per-namespace maps whose insertion order
 * is recency (a hit re-inserts the entry). Expiry is lazy, enforced on access
 * and on bounded writes. Values are stored serialised, so callers get copies.
 */
export function createMemoryUserKv(
  options: { now?: () => number } = {},
): UserKvSurface {
  const now = options.now ?? Date.now;
  const namespaces = new Map<string, Map<string, MemoryEntry>>();

  const bucket = (namespace: string): Map<string, MemoryEntry> => {
    let entries = namespaces.get(namespace);
    if (!entries) {
      entries = new Map();
      namespaces.set(namespace, entries);
    }
    return entries;
  };

  /** The live entry (refreshed and marked most recently used), or undefined. */
  const touch = (
    entries: Map<string, MemoryEntry>,
    key: string,
  ): MemoryEntry | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    entries.delete(key);
    if (entry.expiresAt !== undefined && entry.expiresAt <= now()) {
      return undefined;
    }
    if (entry.idleTtlMs !== undefined) {
      entry.expiresAt = now() + entry.idleTtlMs;
    }
    entries.set(key, entry);
    return entry;
  };

  const write = (
    entries: Map<string, MemoryEntry>,
    key: string,
    value: unknown,
    opts: UserKvWriteOptions,
  ): void => {
    entries.delete(key);
    if (value !== undefined) {
      const entry: MemoryEntry = { json: encodeUserKvValue(value) };
      if (opts.idleTtlMs !== undefined) {
        entry.idleTtlMs = opts.idleTtlMs;
        entry.expiresAt = now() + opts.idleTtlMs;
      }
      entries.set(key, entry);
    }
    if (opts.maxEntries === undefined) return;
    const cutoff = now();
    for (const [k, entry] of entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= cutoff) {
        entries.delete(k);
      }
    }
    while (entries.size > opts.maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  return {
    async get(namespace, key) {
      assertUserKvName('namespace', namespace);
      assertUserKvName('key', key);
      const entry = touch(bucket(namespace), key);
      return entry ? decodeUserKvValue(entry.json) : undefined;
    },
    async set(namespace, key, value, opts = {}) {
      assertUserKvName('namespace', namespace);
      assertUserKvName('key', key);
      assertUserKvOptions(opts);
      encodeUserKvValue(value);
      write(bucket(namespace), key, value, opts);
    },
    async update(namespace, key, fn, opts = {}) {
      assertUserKvName('namespace', namespace);
      assertUserKvName('key', key);
      assertUserKvOptions(opts);
      const entries = bucket(namespace);
      const entry = touch(entries, key);
      const next = fn(entry ? decodeUserKvValue(entry.json) : undefined);
      write(entries, key, next, opts);
      return next === undefined
        ? undefined
        : decodeUserKvValue(encodeUserKvValue(next));
    },
    async delete(namespace, key) {
      assertUserKvName('namespace', namespace);
      assertUserKvName('key', key);
      bucket(namespace).delete(key);
    },
  };
}
