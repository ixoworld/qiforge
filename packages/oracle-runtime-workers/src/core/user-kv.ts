/**
 * Shared pieces of the `ctx.kv` surface (`UserKvSurface`): argument checks,
 * JSON encoding, the hard storage caps, and an in-memory implementation for
 * tests and partial hosts. The Workers host backs the surface with the
 * user's SQLite file instead (`sqlite/user-kv-store.ts`), with the same
 * semantics.
 *
 * The caps exist because the rows share a file with the user's LangGraph
 * checkpoints, sessions and transcript, and that file is exported as the
 * owner copy and re-imported on a cold start: a plugin must not be able to
 * grow it without bound, whatever options it passes.
 */
import type { UserKvSurface, UserKvWriteOptions } from '../plugin-api/types';

/** Longest namespace / key accepted, in characters. */
export const USER_KV_MAX_NAME_LENGTH = 512;

/** Largest stored value: UTF-8 bytes of its JSON text. */
export const USER_KV_MAX_VALUE_BYTES = 256 * 1024;
/** Most rows one namespace may hold (also the largest `maxEntries`). */
export const USER_KV_MAX_ENTRIES_PER_NAMESPACE = 10_000;
/** Most rows the user's store may hold across all namespaces. */
export const USER_KV_MAX_TOTAL_ENTRIES = 50_000;
/**
 * Most bytes the user's store may hold across all namespaces, counting each
 * row's namespace, key and value JSON ({@link userKvRowBytes}).
 */
export const USER_KV_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** The hard caps one store enforces. */
export interface UserKvLimits {
  maxValueBytes: number;
  maxEntriesPerNamespace: number;
  maxTotalEntries: number;
  maxTotalBytes: number;
}

export const USER_KV_LIMITS: Readonly<UserKvLimits> = Object.freeze({
  maxValueBytes: USER_KV_MAX_VALUE_BYTES,
  maxEntriesPerNamespace: USER_KV_MAX_ENTRIES_PER_NAMESPACE,
  maxTotalEntries: USER_KV_MAX_TOTAL_ENTRIES,
  maxTotalBytes: USER_KV_MAX_TOTAL_BYTES,
});

/**
 * The caps a store runs with: the defaults, with `overrides` (tests only;
 * the host never passes any) replacing individual ones.
 */
export function resolveUserKvLimits(
  overrides: Partial<UserKvLimits> = {},
): Readonly<UserKvLimits> {
  const limits = { ...USER_KV_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(
        `user kv limit ${name} must be a positive integer, got ${value}`,
      );
    }
  }
  return Object.freeze(limits);
}

/** Which cap a refused write would have broken. */
export type UserKvLimitKind =
  | 'value'
  | 'namespace-entries'
  | 'entries'
  | 'bytes';

/**
 * A write `ctx.kv` refused because it would break a hard cap. Nothing was
 * written and nothing was evicted: the previous value, if any, is still in
 * place. `actual` is what the store (or, for `value`, the value) would have
 * measured after the write; `max` is the cap.
 */
export class UserKvLimitError extends Error {
  override readonly name = 'UserKvLimitError';

  constructor(
    readonly limit: UserKvLimitKind,
    readonly namespace: string,
    readonly max: number,
    readonly actual: number,
  ) {
    super(userKvLimitMessage(limit, namespace, max, actual));
  }
}

function userKvLimitMessage(
  limit: UserKvLimitKind,
  namespace: string,
  max: number,
  actual: number,
): string {
  const where = `user kv write to namespace "${namespace}" refused`;
  switch (limit) {
    case 'value':
      return `${where}: the value is ${actual} bytes of JSON, the cap is ${max}`;
    case 'namespace-entries':
      return `${where}: the namespace would hold ${actual} entries, the cap is ${max}`;
    case 'entries':
      return `${where}: the store would hold ${actual} entries across all namespaces, the cap is ${max}`;
    case 'bytes':
      return `${where}: the store would hold ${actual} bytes of namespace, key and value across all namespaces, the cap is ${max}`;
  }
}

const utf8 = new TextEncoder();

/** UTF-8 byte length of a stored value's JSON text — what the value cap counts. */
export function userKvValueBytes(json: string): number {
  return utf8.encode(json).byteLength;
}

/**
 * What one row adds to the store's byte total: UTF-8 bytes of its namespace,
 * key and value JSON. Names count because each may be up to
 * {@link USER_KV_MAX_NAME_LENGTH} characters, enough to carry far more than
 * the byte cap across the entry cap if only values were counted.
 */
export function userKvRowBytes(
  namespace: string,
  key: string,
  valueBytes: number,
): number {
  return (
    utf8.encode(namespace).byteLength + utf8.encode(key).byteLength + valueBytes
  );
}

/** The value's byte length; throws {@link UserKvLimitError} above the cap. */
export function assertUserKvValueSize(
  namespace: string,
  json: string,
  limits: Readonly<UserKvLimits>,
): number {
  const bytes = userKvValueBytes(json);
  if (bytes > limits.maxValueBytes) {
    throw new UserKvLimitError('value', namespace, limits.maxValueBytes, bytes);
  }
  return bytes;
}

/** What a store holds after a write, as far as the caps are concerned. */
export interface UserKvUsage {
  namespaceEntries: number;
  totalEntries: number;
  totalBytes: number;
}

/**
 * The first cap a write breaks, or undefined. Only a measure the write grew
 * is checked — a write that added a key for the entry counts, one that grew
 * the stored bytes for the byte total — so a store already above a cap
 * (a file written before the caps existed) can still shrink, replace in
 * place and delete.
 */
export function userKvOverflow(
  namespace: string,
  usage: UserKvUsage,
  grew: { entries: boolean; bytes: boolean },
  limits: Readonly<UserKvLimits>,
): UserKvLimitError | undefined {
  if (grew.entries) {
    if (usage.namespaceEntries > limits.maxEntriesPerNamespace) {
      return new UserKvLimitError(
        'namespace-entries',
        namespace,
        limits.maxEntriesPerNamespace,
        usage.namespaceEntries,
      );
    }
    if (usage.totalEntries > limits.maxTotalEntries) {
      return new UserKvLimitError(
        'entries',
        namespace,
        limits.maxTotalEntries,
        usage.totalEntries,
      );
    }
  }
  if (grew.bytes && usage.totalBytes > limits.maxTotalBytes) {
    return new UserKvLimitError(
      'bytes',
      namespace,
      limits.maxTotalBytes,
      usage.totalBytes,
    );
  }
  return undefined;
}

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

/**
 * Validate a write's options. A `maxEntries` above the per-namespace cap is
 * refused rather than clamped, so a plugin learns its bound is not the one
 * in force.
 */
export function assertUserKvOptions(
  options: UserKvWriteOptions,
  limits: Readonly<UserKvLimits> = USER_KV_LIMITS,
): void {
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
  if (maxEntries !== undefined && maxEntries > limits.maxEntriesPerNamespace) {
    throw new RangeError(
      `user kv maxEntries must be at most ${limits.maxEntriesPerNamespace} (the per-namespace cap), got ${maxEntries}`,
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
  /** Row bytes ({@link userKvRowBytes}): namespace + key + value JSON. */
  bytes: number;
  idleTtlMs?: number;
  expiresAt?: number;
}

/**
 * In-memory {@link UserKvSurface}: per-namespace maps whose insertion order
 * is recency (a hit re-inserts the entry). Expiry is lazy, enforced on access
 * and on bounded writes. Values are stored serialised, so callers get copies.
 * Enforces the same hard caps as the SQLite store; `limits` overrides them
 * for tests.
 */
export function createMemoryUserKv(
  options: { now?: () => number; limits?: Partial<UserKvLimits> } = {},
): UserKvSurface {
  const now = options.now ?? Date.now;
  const limits = resolveUserKvLimits(options.limits);
  const namespaces = new Map<string, Map<string, MemoryEntry>>();

  const bucket = (namespace: string): Map<string, MemoryEntry> => {
    let entries = namespaces.get(namespace);
    if (!entries) {
      entries = new Map();
      namespaces.set(namespace, entries);
    }
    return entries;
  };

  const expired = (entry: MemoryEntry, cutoff: number): boolean =>
    entry.expiresAt !== undefined && entry.expiresAt <= cutoff;

  /** The live entry (refreshed and marked most recently used), or undefined. */
  const touch = (
    entries: Map<string, MemoryEntry>,
    key: string,
  ): MemoryEntry | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    entries.delete(key);
    if (expired(entry, now())) return undefined;
    if (entry.idleTtlMs !== undefined) {
      entry.expiresAt = now() + entry.idleTtlMs;
    }
    entries.set(key, entry);
    return entry;
  };

  const usage = (entries: Map<string, MemoryEntry>): UserKvUsage => {
    let totalEntries = 0;
    let totalBytes = 0;
    for (const ns of namespaces.values()) {
      totalEntries += ns.size;
      for (const entry of ns.values()) totalBytes += entry.bytes;
    }
    return { namespaceEntries: entries.size, totalEntries, totalBytes };
  };

  /** Drop expired entries of every namespace; returns how many went. */
  const sweepExpired = (): number => {
    const cutoff = now();
    let swept = 0;
    for (const ns of namespaces.values()) {
      for (const [key, entry] of ns) {
        if (expired(entry, cutoff)) {
          ns.delete(key);
          swept++;
        }
      }
    }
    return swept;
  };

  /**
   * Run `body` against `entries` all-or-nothing: if it throws, the namespace
   * is put back exactly as it was (order, values, deadlines), the way the
   * SQLite store's transaction rolls back.
   */
  const atomically = <T>(
    entries: Map<string, MemoryEntry>,
    body: () => T,
  ): T => {
    const before = [...entries].map(([key, entry]): [string, MemoryEntry] => [
      key,
      { ...entry },
    ]);
    try {
      return body();
    } catch (error) {
      entries.clear();
      for (const [key, entry] of before) entries.set(key, entry);
      throw error;
    }
  };

  /**
   * Replace (or, for `json === undefined`, delete) the entry, apply the
   * write's own `maxEntries` trim, then refuse with {@link UserKvLimitError}
   * if a hard cap is broken even after the store-wide expired entries are
   * swept. Callers run it inside {@link atomically}.
   */
  const write = (
    namespace: string,
    entries: Map<string, MemoryEntry>,
    key: string,
    json: string | undefined,
    opts: UserKvWriteOptions,
  ): void => {
    const previous = entries.get(key);
    const live =
      previous !== undefined && !expired(previous, now())
        ? previous
        : undefined;
    entries.delete(key);
    let bytes = 0;
    if (json !== undefined) {
      bytes = userKvRowBytes(
        namespace,
        key,
        assertUserKvValueSize(namespace, json, limits),
      );
      const entry: MemoryEntry = { json, bytes };
      if (opts.idleTtlMs !== undefined) {
        entry.idleTtlMs = opts.idleTtlMs;
        entry.expiresAt = now() + opts.idleTtlMs;
      }
      entries.set(key, entry);
    }
    if (opts.maxEntries !== undefined) {
      const cutoff = now();
      for (const [k, entry] of entries) {
        if (expired(entry, cutoff)) entries.delete(k);
      }
      while (entries.size > opts.maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    }
    if (json === undefined) return;
    // The replaced row has the same namespace and key, so comparing row
    // bytes compares value bytes.
    const grew = {
      entries: live === undefined,
      bytes: bytes > (live?.bytes ?? 0),
    };
    if (!grew.entries && !grew.bytes) return;
    let overflow = userKvOverflow(namespace, usage(entries), grew, limits);
    if (overflow && sweepExpired() > 0) {
      overflow = userKvOverflow(namespace, usage(entries), grew, limits);
    }
    if (overflow) throw overflow;
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
      assertUserKvOptions(opts, limits);
      const json = encodeUserKvValue(value);
      const entries = bucket(namespace);
      atomically(entries, () => write(namespace, entries, key, json, opts));
    },
    async update(namespace, key, fn, opts = {}) {
      assertUserKvName('namespace', namespace);
      assertUserKvName('key', key);
      assertUserKvOptions(opts, limits);
      const entries = bucket(namespace);
      const json = atomically(entries, () => {
        const entry = touch(entries, key);
        const next = fn(entry ? decodeUserKvValue(entry.json) : undefined);
        const encoded =
          next === undefined ? undefined : encodeUserKvValue(next);
        write(namespace, entries, key, encoded, opts);
        return encoded;
      });
      return json === undefined ? undefined : decodeUserKvValue(json);
    },
    async delete(namespace, key) {
      assertUserKvName('namespace', namespace);
      assertUserKvName('key', key);
      bucket(namespace).delete(key);
    },
  };
}
