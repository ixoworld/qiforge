/* eslint-disable no-console -- console is the logger on workerd; tier maintenance failures are logged, never thrown into SQLite */
/**
 * The R2 page tier — cold chunks of a user's working copy live in R2, hot
 * chunks stay in Durable Object SQLite (`vfs2_chunks`), and the file SQLite
 * sees is the union of both.
 *
 * Why: DO SQLite storage is $0.20 per GB-month and capped at 10 GB per
 * object; R2 is $0.015 per GB-month with no per-object cap. A daily user
 * touches a few MB of a working copy that may be hundreds of MB, so most of
 * the file is cold most of the time. The tier keeps the working set where
 * SQLite can read it synchronously and moves the rest where it is cheap.
 *
 * Layout in R2 (one prefix per Durable Object):
 *   <prefix>/<file>/<segno>.<gen>   — a SEGMENT: 16 consecutive 64 KiB
 *                                     chunks (1 MiB), chunk-aligned, sparse
 *                                     slots zero-filled. Immutable: a rewrite
 *                                     is a new key (gen + 1); the old key is
 *                                     deleted after the map points away.
 *
 * Layout in DO storage (the map — small, read once per file open):
 *   vfs2_tier_segments(file, segno, gen, mask)   mask: 16 bits, one per
 *                                                chunk slot that is valid
 *                                                in the object
 *   vfs2_tier_access(file, period, bits)         bitmap of chunks touched
 *                                                per period (a day)
 *   vfs2_chunks gains `mask`: a hot row may be PARTIAL (pages written over
 *   a cold base); pages outside its mask are read from the R2 slot.
 *
 * Rules the VFS enforces (see `do-vfs.ts`):
 * - A hot row is the truth for the pages in its mask; the R2 slot is the
 *   truth for the rest; neither → zeros (sparse).
 * - Reads of cold pages cannot block (the VFS is synchronous): a miss is
 *   recorded and the statement fails with `SQLITE_IOERR`; the database
 *   wrapper fetches the segment(s), fills the clean cache, and retries the
 *   statement (or the whole transaction). Writes never miss: a page written
 *   over a cold base becomes a partial hot row.
 * - Eviction (`DoVfs.tierFlush`) only moves chunks that no turn touched for
 *   `evictAfterPeriods` periods; a segment is rewritten from the hot rows
 *   plus its previous object, then the evicted rows are deleted in ONE
 *   storage transaction with the map update, so a crash leaves at worst an
 *   orphan object (swept later) and never a hole.
 *
 * Costs the design is built around (R2 list prices): Class A (put/list/
 * delete) $4.50 per million, Class B (get) $0.36 per million. Hence whole
 * 1 MiB segments (one op per 16 chunks), a daily eviction pass, no per-chunk
 * objects, and no R2 call on the hot path of a turn.
 */
import { CHUNK_SIZE, PAGES_PER_CHUNK } from './chunk-layout';

/** Chunks per R2 segment object (1 MiB). Also the snapshot window, so a cold window is one GET. */
export const SEGMENT_CHUNKS = 16;
export const SEGMENT_BYTES = SEGMENT_CHUNKS * CHUNK_SIZE;

/** All 16 pages of a chunk present. */
export const FULL_MASK = (1 << PAGES_PER_CHUNK) - 1;
/** All 16 slots of a segment valid. */
const FULL_SEGMENT_MASK = (1 << SEGMENT_CHUNKS) - 1;

/** Soft target for hot bytes per file; eviction logs when it cannot get under it. */
export const DEFAULT_TIER_HOT_BUDGET_BYTES = 16 * 1024 * 1024;
/** Access-tracking period: a chunk untouched for `evictAfterPeriods` of these is cold. */
export const DEFAULT_TIER_PERIOD_MS = 24 * 60 * 60_000;
export const DEFAULT_TIER_EVICT_AFTER_PERIODS = 2;
/** Access bitmaps kept per file (older periods are dropped on each eviction pass). */
export const TIER_ACCESS_HISTORY_PERIODS = 8;
/** Segments rewritten per eviction pass — bounds time, memory (2 MiB in flight) and R2 subrequests. */
export const DEFAULT_TIER_MAX_SEGMENTS_PER_PASS = 64;
/**
 * Cold bytes one statement/transaction may pin in memory across its retries
 * (see `DoVfs.resolveMisses`): a scan over more cold data than this fails
 * with a clear error rather than thrashing the clean cache.
 */
export const DEFAULT_TIER_MISS_PIN_BYTES = 32 * 1024 * 1024;
/** Orphan sweep (list + delete unreferenced keys) every this many maintenance runs. */
const ORPHAN_SWEEP_EVERY = 16;
/** R2 `delete()` accepts up to 1000 keys per call. */
const R2_DELETE_BATCH = 1000;

export interface PageTierOptions {
  bucket: R2Bucket;
  /** Key prefix owned by this object (the DO id string); everything under it is ours to delete. */
  prefix: string;
  hotBudgetBytes?: number;
  periodMs?: number;
  evictAfterPeriods?: number;
  maxSegmentsPerPass?: number;
  /** Cold bytes one statement/transaction may pin while it is retried (default 32 MiB). */
  missPinBytes?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export interface ResolvedPageTierOptions {
  bucket: R2Bucket;
  prefix: string;
  hotBudgetBytes: number;
  periodMs: number;
  evictAfterPeriods: number;
  maxSegmentsPerPass: number;
  missPinBytes: number;
  now: () => number;
}

export function resolvePageTierOptions(
  options: PageTierOptions,
): ResolvedPageTierOptions {
  return {
    bucket: options.bucket,
    prefix: options.prefix.replace(/\/+$/, ''),
    hotBudgetBytes: options.hotBudgetBytes ?? DEFAULT_TIER_HOT_BUDGET_BYTES,
    periodMs: options.periodMs ?? DEFAULT_TIER_PERIOD_MS,
    evictAfterPeriods:
      options.evictAfterPeriods ?? DEFAULT_TIER_EVICT_AFTER_PERIODS,
    maxSegmentsPerPass:
      options.maxSegmentsPerPass ?? DEFAULT_TIER_MAX_SEGMENTS_PER_PASS,
    missPinBytes: options.missPinBytes ?? DEFAULT_TIER_MISS_PIN_BYTES,
    now: options.now ?? (() => Date.now()),
  };
}

export interface SegmentEntry {
  gen: number;
  /** Bit `s` set = slot `s` (chunk `segno * 16 + s`) is valid in the object. */
  mask: number;
}

export interface PageTierStats {
  /** Segment objects referenced by the map, across files. */
  coldSegments: number;
  /** Chunk slots valid in R2 (≈ cold bytes / 64 KiB). */
  coldChunks: number;
  r2Gets: number;
  r2Puts: number;
  r2Deletes: number;
  r2Lists: number;
  /** Cold reads that failed a statement and were resolved by a fetch. */
  coldMisses: number;
  missResolutions: number;
  evictedChunks: number;
  evictionPasses: number;
  pendingDeletes: number;
}

interface SegmentRow extends Record<string, SqlStorageValue> {
  segno: number;
  gen: number;
  mask: number;
}

interface AccessRow extends Record<string, SqlStorageValue> {
  period: number;
  bits: ArrayBuffer;
}

export function segmentOf(chunkno: number): number {
  return Math.floor(chunkno / SEGMENT_CHUNKS);
}

export function slotOf(chunkno: number): number {
  return chunkno - segmentOf(chunkno) * SEGMENT_CHUNKS;
}

/** Bitmap helpers (little-endian bit order within bytes). */
export function bitmapHas(bits: Uint8Array, index: number): boolean {
  const byte = bits[index >> 3];
  return byte !== undefined && (byte & (1 << (index & 7))) !== 0;
}

function bitmapSet(bits: Uint8Array, index: number): void {
  const i = index >> 3;
  if (i < bits.byteLength) bits[i] = (bits[i] ?? 0) | (1 << (index & 7));
}

/** OR `b` into a copy of `a` grown to fit both. */
function bitmapMerge(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.max(a.byteLength, b.byteLength));
  out.set(a);
  for (let i = 0; i < b.byteLength; i++) out[i] = (out[i] ?? 0) | (b[i] ?? 0);
  return out;
}

export function bitmapFor(
  chunks: Iterable<number>,
  totalChunks: number,
): Uint8Array {
  const bits = new Uint8Array(Math.max(1, Math.ceil(totalChunks / 8)));
  for (const chunkno of chunks) bitmapSet(bits, chunkno);
  return bits;
}

/**
 * The tier's persistent map plus its R2 client. One instance per `DoVfs`;
 * all synchronous methods run against DO storage (inside the caller's
 * `transactionSync` when they mutate), all `async` methods talk to R2.
 */
export class PageTier {
  private readonly segments = new Map<string, Map<number, SegmentEntry>>();
  private schemaReady = false;
  private readonly pendingDeletes = new Set<string>();
  private maintenanceRuns = 0;
  /** Tiny LRU of raw segment bytes for sequential readers (snapshot windows). */
  private readonly segmentCache = new Map<string, Uint8Array>();
  private static readonly SEGMENT_CACHE_ENTRIES = 2;
  readonly stats: PageTierStats = {
    coldSegments: 0,
    coldChunks: 0,
    r2Gets: 0,
    r2Puts: 0,
    r2Deletes: 0,
    r2Lists: 0,
    coldMisses: 0,
    missResolutions: 0,
    evictedChunks: 0,
    evictionPasses: 0,
    pendingDeletes: 0,
  };

  constructor(
    private storage: DurableObjectStorage,
    readonly options: ResolvedPageTierOptions,
  ) {}

  /** Re-bind after the object was re-instantiated (see `DoVfs.attach`). */
  attach(storage: DurableObjectStorage): void {
    this.storage = storage;
    this.schemaReady = false;
    this.segments.clear();
    this.segmentCache.clear();
    this.maxGen.clear();
  }

  ensureSchema(): void {
    if (this.schemaReady) return;
    this.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS vfs2_tier_segments (file TEXT NOT NULL, segno INTEGER NOT NULL, gen INTEGER NOT NULL, mask INTEGER NOT NULL, PRIMARY KEY (file, segno))',
    );
    this.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS vfs2_tier_access (file TEXT NOT NULL, period INTEGER NOT NULL, bits BLOB NOT NULL, PRIMARY KEY (file, period))',
    );
    // Generation counter per file: keys are never reused, even after a
    // segment row was dropped (truncate/import) — a delete queued for an old
    // key must never hit a fresh object.
    this.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS vfs2_tier_meta (file TEXT PRIMARY KEY, max_gen INTEGER NOT NULL)',
    );
    this.schemaReady = true;
  }

  /** In-memory high-water mark of generations handed out per file (persisted by `setSegment`). */
  private readonly maxGen = new Map<string, number>();

  /** A generation number no object of `file` has ever carried. */
  allocateGen(file: string): number {
    this.ensureSchema();
    let max = this.maxGen.get(file);
    if (max === undefined) {
      const meta = this.storage.sql
        .exec<{
          max_gen: number;
        }>('SELECT max_gen FROM vfs2_tier_meta WHERE file = ?', file)
        .toArray()[0];
      max = meta?.max_gen ?? 0;
      for (const entry of this.segmentsOf(file).values())
        max = Math.max(max, entry.gen);
    }
    max += 1;
    this.maxGen.set(file, max);
    return max;
  }

  currentPeriod(now = this.options.now()): number {
    return Math.floor(now / this.options.periodMs);
  }

  key(file: string, segno: number, gen: number): string {
    return `${this.options.prefix}/${file}/${segno}.${gen}`;
  }

  private filePrefix(file: string): string {
    return `${this.options.prefix}/${file}/`;
  }

  // ---------------------------------------------------------------------------
  // The map (DO storage, synchronous)
  // ---------------------------------------------------------------------------

  /** Segment entries of `file`, loaded from storage on first use. */
  segmentsOf(file: string): Map<number, SegmentEntry> {
    let map = this.segments.get(file);
    if (map !== undefined) return map;
    this.ensureSchema();
    map = new Map();
    const rows = this.storage.sql
      .exec<SegmentRow>(
        'SELECT segno, gen, mask FROM vfs2_tier_segments WHERE file = ?',
        file,
      )
      .toArray();
    for (const row of rows)
      map.set(row.segno, { gen: row.gen, mask: row.mask });
    this.segments.set(file, map);
    this.recount();
    return map;
  }

  /** Whether chunk `chunkno` of `file` has a valid slot in R2. */
  slotInR2(file: string, chunkno: number): boolean {
    const entry = this.segmentsOf(file).get(segmentOf(chunkno));
    return entry !== undefined && (entry.mask & (1 << slotOf(chunkno))) !== 0;
  }

  /** Upsert one segment entry — call inside the caller's storage transaction. */
  setSegment(file: string, segno: number, entry: SegmentEntry): void {
    this.ensureSchema();
    this.storage.sql.exec(
      'INSERT INTO vfs2_tier_segments (file, segno, gen, mask) VALUES (?, ?, ?, ?) ON CONFLICT(file, segno) DO UPDATE SET gen = excluded.gen, mask = excluded.mask',
      file,
      segno,
      entry.gen,
      entry.mask,
    );
    const max = Math.max(this.maxGen.get(file) ?? 0, entry.gen);
    this.maxGen.set(file, max);
    this.storage.sql.exec(
      'INSERT INTO vfs2_tier_meta (file, max_gen) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET max_gen = max(vfs2_tier_meta.max_gen, excluded.max_gen)',
      file,
      max,
    );
    this.segmentsOf(file).set(segno, { ...entry });
    this.recount();
  }

  /**
   * Forget every segment of `file` (its content is being replaced or the
   * file deleted) — inside the caller's storage transaction. The objects are
   * queued for deletion; run `maintenance()` afterwards.
   */
  dropFile(file: string): void {
    this.ensureSchema();
    const map = this.segmentsOf(file);
    for (const [segno, entry] of map)
      this.pendingDeletes.add(this.key(file, segno, entry.gen));
    this.storage.sql.exec(
      'DELETE FROM vfs2_tier_segments WHERE file = ?',
      file,
    );
    this.storage.sql.exec('DELETE FROM vfs2_tier_access WHERE file = ?', file);
    map.clear();
    this.dropSegmentCache(file);
    this.recount();
    this.stats.pendingDeletes = this.pendingDeletes.size;
  }

  /**
   * The file was truncated to `keepChunks` chunks: slots at or past it are
   * no longer valid (a later grow must read zeros, never stale bytes). Whole
   * segments past the boundary are dropped and their objects queued for
   * deletion; the boundary segment keeps its object with a narrowed mask.
   * Inside the caller's storage transaction.
   */
  truncate(file: string, keepChunks: number): void {
    const map = this.segmentsOf(file);
    if (map.size === 0) return;
    this.ensureSchema();
    const boundary = segmentOf(Math.max(0, keepChunks));
    for (const [segno, entry] of Array.from(map.entries())) {
      if (
        segno > boundary ||
        (segno === boundary && keepChunks % SEGMENT_CHUNKS === 0)
      ) {
        this.pendingDeletes.add(this.key(file, segno, entry.gen));
        this.storage.sql.exec(
          'DELETE FROM vfs2_tier_segments WHERE file = ? AND segno = ?',
          file,
          segno,
        );
        map.delete(segno);
      } else if (segno === boundary) {
        const keepSlots = keepChunks - boundary * SEGMENT_CHUNKS; // 1..15
        const mask = entry.mask & ((1 << keepSlots) - 1);
        if (mask !== entry.mask) {
          this.storage.sql.exec(
            'UPDATE vfs2_tier_segments SET mask = ? WHERE file = ? AND segno = ?',
            mask,
            file,
            segno,
          );
          entry.mask = mask;
        }
      }
    }
    this.dropSegmentCache(file);
    this.recount();
    this.stats.pendingDeletes = this.pendingDeletes.size;
  }

  private recount(): void {
    let segments = 0;
    let chunks = 0;
    for (const map of this.segments.values()) {
      for (const entry of map.values()) {
        if (entry.mask === 0) continue;
        segments++;
        chunks += popcount16(entry.mask);
      }
    }
    this.stats.coldSegments = segments;
    this.stats.coldChunks = chunks;
  }

  // ---------------------------------------------------------------------------
  // Access tracking (which chunks a turn touched, per period)
  // ---------------------------------------------------------------------------

  /** OR `touched` into the bitmap of `period` for `file` (one row write). */
  recordAccess(
    file: string,
    period: number,
    touched: Iterable<number>,
    totalChunks: number,
  ): void {
    this.ensureSchema();
    const fresh = bitmapFor(touched, totalChunks);
    const row = this.storage.sql
      .exec<AccessRow>(
        'SELECT period, bits FROM vfs2_tier_access WHERE file = ? AND period = ?',
        file,
        period,
      )
      .toArray()[0];
    const merged =
      row === undefined ? fresh : bitmapMerge(new Uint8Array(row.bits), fresh);
    this.storage.sql.exec(
      'INSERT INTO vfs2_tier_access (file, period, bits) VALUES (?, ?, ?) ON CONFLICT(file, period) DO UPDATE SET bits = excluded.bits',
      file,
      period,
      toArrayBuffer(merged),
    );
  }

  /**
   * Bitmap of chunks touched in the last `periods` periods (including the
   * current one), plus the in-memory `touched` set of the current one.
   * Rows older than `TIER_ACCESS_HISTORY_PERIODS` are dropped.
   */
  recentBitmap(
    file: string,
    periods: number,
    touched: Iterable<number>,
    totalChunks: number,
    now = this.options.now(),
  ): Uint8Array {
    this.ensureSchema();
    const current = this.currentPeriod(now);
    const oldest = current - (periods - 1);
    const rows = this.storage.sql
      .exec<AccessRow>(
        'SELECT period, bits FROM vfs2_tier_access WHERE file = ? AND period >= ?',
        file,
        oldest,
      )
      .toArray();
    let bits = bitmapFor(touched, totalChunks);
    for (const row of rows) bits = bitmapMerge(bits, new Uint8Array(row.bits));
    this.storage.sql.exec(
      'DELETE FROM vfs2_tier_access WHERE file = ? AND period < ?',
      file,
      current - (TIER_ACCESS_HISTORY_PERIODS - 1),
    );
    return bits;
  }

  // ---------------------------------------------------------------------------
  // R2 (async)
  // ---------------------------------------------------------------------------

  /** The segment object bytes (exactly SEGMENT_BYTES, zero-padded), or null when the map has no entry. */
  async getSegment(file: string, segno: number): Promise<Uint8Array | null> {
    const entry = this.segmentsOf(file).get(segno);
    if (entry === undefined) return null;
    return this.getSegmentAt(file, segno, entry);
  }

  /**
   * The bytes of a specific generation of a segment — what a snapshot took
   * at open time even if the map has moved on since (the old object is
   * only deleted once no snapshot is open).
   */
  async getSegmentAt(
    file: string,
    segno: number,
    entry: SegmentEntry,
  ): Promise<Uint8Array | null> {
    if (entry.mask === 0) return null;
    const key = this.key(file, segno, entry.gen);
    const cached = this.segmentCache.get(key);
    if (cached !== undefined) {
      this.segmentCache.delete(key);
      this.segmentCache.set(key, cached);
      return cached;
    }
    const object = await this.options.bucket.get(key);
    this.stats.r2Gets++;
    if (object === null) {
      throw new PageTierError(
        `tier segment ${key} is referenced by the map but missing in R2`,
      );
    }
    const raw = new Uint8Array(await object.arrayBuffer());
    const bytes =
      raw.byteLength === SEGMENT_BYTES ? raw : padTo(raw, SEGMENT_BYTES);
    this.segmentCache.set(key, bytes);
    while (this.segmentCache.size > PageTier.SEGMENT_CACHE_ENTRIES) {
      const oldest = this.segmentCache.keys().next();
      if (oldest.done) break;
      this.segmentCache.delete(oldest.value);
    }
    return bytes;
  }

  /** Write a new generation of `segno`; returns the key written. Does NOT touch the map. */
  async putSegment(
    file: string,
    segno: number,
    gen: number,
    bytes: Uint8Array,
  ): Promise<string> {
    const key = this.key(file, segno, gen);
    await this.options.bucket.put(key, toArrayBuffer(bytes));
    this.stats.r2Puts++;
    return key;
  }

  queueDelete(key: string): void {
    this.pendingDeletes.add(key);
    this.stats.pendingDeletes = this.pendingDeletes.size;
  }

  dropSegmentCache(file: string): void {
    const prefix = this.filePrefix(file);
    for (const key of Array.from(this.segmentCache.keys()))
      if (key.startsWith(prefix)) this.segmentCache.delete(key);
  }

  /**
   * Delete queued keys (objects the map no longer references) and, every
   * `ORPHAN_SWEEP_EVERY` runs or when `sweep` is set, list the prefix and
   * delete anything the map does not reference — the leftovers of a crash
   * between a put and its map update. Never throws.
   */
  async maintenance(
    opts: { sweep?: boolean } = {},
  ): Promise<{ deleted: number }> {
    let deleted = 0;
    const keys = Array.from(this.pendingDeletes);
    this.pendingDeletes.clear();
    try {
      deleted += await this.deleteKeys(keys);
    } catch (err) {
      for (const key of keys) this.pendingDeletes.add(key);
      console.warn(
        `[page-tier] delete of ${keys.length} object(s) failed: ${errorMessage(err)}`,
      );
    }
    this.maintenanceRuns++;
    if (
      opts.sweep === true ||
      this.maintenanceRuns % ORPHAN_SWEEP_EVERY === 0
    ) {
      try {
        deleted += await this.sweepOrphans();
      } catch (err) {
        console.warn(`[page-tier] orphan sweep failed: ${errorMessage(err)}`);
      }
    }
    this.stats.pendingDeletes = this.pendingDeletes.size;
    return { deleted };
  }

  /** Every object under the prefix (keys). */
  async listKeys(): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.options.bucket.list({
        prefix: `${this.options.prefix}/`,
        ...(cursor !== undefined && { cursor }),
      });
      this.stats.r2Lists++;
      for (const object of page.objects) keys.push(object.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
    return keys;
  }

  private async sweepOrphans(): Promise<number> {
    const referenced = new Set<string>();
    this.ensureSchema();
    const rows = this.storage.sql
      .exec<
        SegmentRow & { file: string }
      >('SELECT file, segno, gen, mask FROM vfs2_tier_segments')
      .toArray();
    for (const row of rows)
      referenced.add(this.key(row.file, row.segno, row.gen));
    const orphans = (await this.listKeys()).filter(
      (key) => !referenced.has(key),
    );
    return this.deleteKeys(orphans);
  }

  /** Delete everything under the prefix (the object's working copy is being wiped). */
  async deleteAll(): Promise<number> {
    this.pendingDeletes.clear();
    this.segmentCache.clear();
    this.stats.pendingDeletes = 0;
    return this.deleteKeys(await this.listKeys());
  }

  private async deleteKeys(keys: string[]): Promise<number> {
    for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
      const batch = keys.slice(i, i + R2_DELETE_BATCH);
      await this.options.bucket.delete(batch);
      this.stats.r2Deletes++;
    }
    return keys.length;
  }
}

export class PageTierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageTierError';
  }
}

function popcount16(mask: number): number {
  let n = mask & FULL_SEGMENT_MASK;
  let count = 0;
  while (n !== 0) {
    n &= n - 1;
    count++;
  }
  return count;
}

function padTo(bytes: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(bytes.subarray(0, Math.min(bytes.byteLength, length)));
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer } = bytes;
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength &&
    buffer instanceof ArrayBuffer
  )
    return buffer;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
