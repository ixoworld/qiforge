/* eslint-disable no-console -- console is the logger on workerd (no @ixo/logger); VFS failures must be logged, they cannot throw */
/**
 * A synchronous SQLite VFS that stores file bytes as fixed-size pages in a
 * Durable Object's SQLite storage (`ctx.storage.sql`).
 *
 * Layout in DO storage (v2 — chunked):
 *   vfs2_files(file TEXT PRIMARY KEY, size INTEGER)       -- logical byte length
 *   vfs2_chunks(file TEXT, chunkno INTEGER, data BLOB,      -- 64 KiB chunks
 *               PRIMARY KEY(file, chunkno))                 --  = 16 × 4 KiB pages
 *
 * Chunking exists for BILLING: Durable Object SQLite bills per row
 * read/written regardless of value size, so packing 16 SQLite pages into one
 * 64 KiB row divides row-write and row-read charges by up to 16× versus the
 * v1 one-page-per-row layout. SQLite still sees 4 KiB pages; chunks are
 * purely the storage grain. The v1 tables (`vfs_files`/`vfs_pages`) were
 * never deployed — `ensureSchema` drops them if a dev environment still has
 * them, and any working copy they held simply re-imports from the user's
 * owner-store file on next boot.
 *
 * Only files opened with `SQLITE_OPEN_MAIN_DB` are persisted. Everything else
 * SQLite might open (rollback/statement journals, temp databases, super
 * journals) lives in an in-memory file, MemoryVFS-style. The database wrapper
 * sets `journal_mode=MEMORY`, `synchronous=OFF`, `temp_store=MEMORY`, so in
 * practice only the main database ever touches storage.
 *
 * Durability / atomicity model (read this before changing lock handling):
 * - SQLite writes main-db pages only while it holds the EXCLUSIVE lock on that
 *   file (commit phase). We buffer those page writes in memory (`dirty`) and
 *   flush them in ONE `storage.transactionSync` when SQLite either syncs the
 *   file (`xSync`, only with synchronous>OFF) or releases the exclusive lock
 *   (`xUnlock`, always). A crash mid-commit therefore loses the whole
 *   transaction rather than tearing the file; a crash after the flush loses
 *   nothing. This is what makes `journal_mode=MEMORY` + `synchronous=OFF`
 *   safe here even though it is not on a real filesystem: the "journal" that
 *   protects against process death is the DO storage transaction.
 * - The trade-off: if the flush itself fails (storage error) after SQLite has
 *   already declared the transaction committed (xUnlock path), the pages stay
 *   dirty in memory and are retried on the next flush; `lastFlushError`
 *   records the failure so the wrapper can surface it. Run write transactions
 *   with `synchronous=NORMAL` if you need the failure reported to the
 *   committing statement (xSync then flushes before SQLite finalizes).
 * - Locks are otherwise no-ops: a Durable Object is single-threaded and each
 *   object owns its storage exclusively.
 *
 * Memory footprint: an LRU cache of clean chunks (default ≈ 8 MiB, see
 * `cachePages`) plus whatever is dirty in the current transaction. The file
 * itself is never materialized in memory except by `exportFile`; the owner
 * store reads it through `openSnapshot()` (a consistent, windowed stream)
 * and writes it through `importFromStream()`.
 *
 * Snapshots: a snapshot pins the file's content at open time while SQLite
 * keeps committing. `flush()` captures the PRE-IMAGE of every chunk it is
 * about to overwrite (or truncate away) while a snapshot of that file is
 * open — usually straight from the clean cache, so it costs no storage read
 * — and snapshot readers consult those pre-images first. Memory is bounded
 * by the bytes written during the snapshot's lifetime, not by the file size.
 *
 * Write generation: `vfs2_files.gen` counts flushes that changed the file.
 * The owner-store flush compares it with the generation it last uploaded and
 * skips the whole export when nothing was written — no hashing, no reads.
 *
 * Spill files: names ending in `.vacuum` are rebuilt from scratch (`VACUUM
 * INTO`) and need no crash atomicity, so their dirty chunks are flushed to
 * storage every `SPILL_CHUNKS` instead of being held until commit. That is
 * what keeps a full VACUUM of a multi-hundred-MB file at constant memory.
 */
import { createHash } from 'node:crypto';
import {
  SQLITE_CANTOPEN,
  SQLITE_IOCAP_SAFE_APPEND,
  SQLITE_IOCAP_SEQUENTIAL,
  SQLITE_IOERR,
  SQLITE_IOERR_ACCESS,
  SQLITE_IOERR_CLOSE,
  SQLITE_IOERR_DELETE,
  SQLITE_IOERR_FSYNC,
  SQLITE_IOERR_READ,
  SQLITE_IOERR_SHORT_READ,
  SQLITE_IOERR_TRUNCATE,
  SQLITE_IOERR_UNLOCK,
  SQLITE_IOERR_WRITE,
  SQLITE_LOCK_EXCLUSIVE,
  SQLITE_LOCK_NONE,
  SQLITE_NOTFOUND,
  SQLITE_OK,
  SQLITE_OPEN_CREATE,
  SQLITE_OPEN_DELETEONCLOSE,
  SQLITE_OPEN_MAIN_DB,
} from 'wa-sqlite';

/** Bytes per SQLite page. Matches `PRAGMA page_size=4096`. */
export const VFS_PAGE_SIZE = 4096;

/** SQLite pages packed into one stored row (billing grain). */
export const PAGES_PER_CHUNK = 16;

/** Bytes per stored chunk row (64 KiB — well under the 2 MB DO value cap). */
export const CHUNK_SIZE = VFS_PAGE_SIZE * PAGES_PER_CHUNK;

/**
 * Default number of clean pages worth of chunk cache kept in memory (4 MiB).
 * Measured on devnet against 8 MiB: a turn's working set (~20 chunks) fits
 * either, latency is indistinguishable, and the smaller budget leaves more
 * isolate memory for turns running concurrently on the same server.
 */
export const DEFAULT_CACHE_PAGES = 1024;

/**
 * Chunk rows per multi-row INSERT during flush/import: 3 bindings per row
 * (well under DO SQLite's 100-bound-parameter cap) and ~1 MiB of blob payload
 * per statement.
 */
const FLUSH_BATCH_ROWS = 16;

/** Chunks a snapshot stream hands out per pull (1 MiB). */
const SNAPSHOT_WINDOW_CHUNKS = 16;

/** Dirty chunks a spill file (`.vacuum`) may hold before they go to storage (2 MiB). */
export const SPILL_CHUNKS = 32;

/** Suffix of files rebuilt by `VACUUM INTO` — spilled early, never snapshotted. */
export const VACUUM_FILE_SUFFIX = '.vacuum';

/** Suffix of the staging file a streamed import writes before the atomic rename. */
export const IMPORT_FILE_SUFFIX = '.importing';

const SQLITE_HEADER_MAGIC = 'SQLite format 3\0';

export interface DoVfsOptions {
  /**
   * Max clean pages held in the LRU cache (dirty pages are never evicted).
   * Applied on every `open()`: an isolate that already holds this object's
   * VFS is resized to the new budget (excess clean chunks are dropped).
   */
  cachePages?: number;
}

export interface DoVfsStats {
  cachedPages: number;
  dirtyPages: number;
  openFiles: number;
  flushes: number;
  storageReads: number;
  storageWrites: number;
  /** Billing proxy: chunk rows written to / read from DO storage. */
  rowsWritten: number;
  rowsRead: number;
  /** Chunk lookups served from the clean cache vs. read from storage. */
  cacheHits: number;
  cacheMisses: number;
  /** Configured cache budget. */
  cacheCapacityChunks: number;
  cacheBudgetBytes: number;
}

/**
 * A consistent view of one persistent file as of `openSnapshot()`. `open()`
 * may be called any number of times (the owner store measures the gzipped
 * length in one pass and uploads in a second); every stream reads the same
 * bytes even while SQLite keeps committing. `close()` releases the captured
 * pre-images — always call it.
 */
export interface VfsSnapshot {
  readonly name: string;
  readonly size: number;
  /** Write generation the snapshot was taken at (see `writeGeneration`). */
  readonly generation: number;
  open(): ReadableStream<Uint8Array>;
  close(): void;
}

interface SnapshotState {
  name: string;
  size: number;
  totalChunks: number;
  /** Chunk pre-images captured because a later flush overwrote/deleted them. */
  shadow: Map<number, Uint8Array>;
  open: boolean;
}

interface PersistentFile {
  kind: 'persistent';
  name: string;
  flags: number;
  size: number;
  /** Flushes that changed the file (mirrors `vfs2_files.gen`). */
  gen: number;
  lock: number;
  /** Chunks written since the last flush, keyed by chunk number (full 64 KiB buffers). */
  dirty: Map<number, Uint8Array>;
  /** Lowest page count the file was truncated to since the last flush (chunks past it are deleted on flush). */
  truncateToPages: number | null;
  sizeDirty: boolean;
  /** Flush dirty chunks early (no crash atomicity needed — see file header). */
  spill: boolean;
}

interface MemoryFile {
  kind: 'memory';
  name: string;
  flags: number;
  size: number;
  data: Uint8Array;
}

type OpenFile = PersistentFile | MemoryFile;

interface ChunkRow extends Record<string, SqlStorageValue> {
  chunkno: number;
  data: ArrayBuffer;
}

interface FileMetaRow extends Record<string, SqlStorageValue> {
  size: number;
  gen: number;
}

/** Simple LRU of clean chunks keyed by `${file}\u0000${chunkno}`; Map iteration order = recency. */
class ChunkCache {
  private readonly map = new Map<string, Uint8Array>();

  constructor(private capacity: number) {}

  get size(): number {
    return this.map.size;
  }

  get capacityChunks(): number {
    return this.capacity;
  }

  /** Resize the budget; drops the least recently used chunks past it. */
  setCapacity(capacity: number): void {
    this.capacity = Math.max(1, capacity);
    this.evict();
  }

  get(file: string, chunkno: number): Uint8Array | undefined {
    const key = ChunkCache.key(file, chunkno);
    const chunk = this.map.get(key);
    if (chunk !== undefined) {
      this.map.delete(key);
      this.map.set(key, chunk);
    }
    return chunk;
  }

  set(file: string, chunkno: number, chunk: Uint8Array): void {
    const key = ChunkCache.key(file, chunkno);
    this.map.delete(key);
    this.map.set(key, chunk);
    this.evict();
  }

  private evict(): void {
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  /** Drop every cached chunk of `file` with chunkno >= `fromChunk`. */
  dropFrom(file: string, fromChunk: number): void {
    const prefix = `${file}\u0000`;
    for (const key of this.map.keys()) {
      if (!key.startsWith(prefix)) continue;
      const chunkno = Number(key.slice(prefix.length));
      if (chunkno >= fromChunk) this.map.delete(key);
    }
  }

  dropFile(file: string): void {
    this.dropFrom(file, 0);
  }

  clear(): void {
    this.map.clear();
  }

  private static key(file: string, chunkno: number): string {
    return `${file}\u0000${chunkno}`;
  }
}

/**
 * Errors raised by VFS helpers (`exportFile`, `importFile`, ...). VFS methods
 * called by SQLite never throw; they return SQLite error codes instead.
 */
export class DoVfsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoVfsError';
  }
}

export class DoVfs implements SQLiteVFS {
  /** Maximum path length SQLite may hand us (the glue caps at 64 unless overridden). */
  readonly mxPathName = 64;

  private storage: DurableObjectStorage;
  private schemaReady = false;
  private readonly cache: ChunkCache;
  private readonly openFiles = new Map<number, OpenFile>();
  private readonly memoryFiles = new Map<string, MemoryFile>();
  /** Persistent files currently open, by name (a file may be open through several fileIds). */
  private readonly persistentByName = new Map<string, PersistentFile>();
  /** Open snapshots by file name (at most one per file). */
  private readonly snapshots = new Map<string, SnapshotState>();
  private readonly stats: DoVfsStats = {
    cachedPages: 0,
    dirtyPages: 0,
    openFiles: 0,
    flushes: 0,
    storageReads: 0,
    storageWrites: 0,
    rowsWritten: 0,
    rowsRead: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheCapacityChunks: 0,
    cacheBudgetBytes: 0,
  };

  /** Last error thrown by a flush that SQLite could not be told about (see file header). */
  lastFlushError: unknown = undefined;

  constructor(
    readonly name: string,
    storage: DurableObjectStorage,
    options: DoVfsOptions = {},
  ) {
    this.storage = storage;
    this.cache = new ChunkCache(DoVfs.chunksForPages(options.cachePages));
  }

  private static chunksForPages(cachePages: number | undefined): number {
    return Math.max(
      1,
      Math.ceil((cachePages ?? DEFAULT_CACHE_PAGES) / PAGES_PER_CHUNK),
    );
  }

  /** Apply a (new) clean-chunk budget; see `DoVfsOptions.cachePages`. */
  configureCache(cachePages: number | undefined): void {
    this.cache.setCapacity(DoVfs.chunksForPages(cachePages));
  }

  isAttachedTo(storage: DurableObjectStorage): boolean {
    return this.storage === storage;
  }

  /**
   * Re-bind to a (new) DurableObjectState's storage. Used when the same DO id
   * is re-instantiated in an isolate that still holds this VFS registered
   * (the previous instance was evicted without closing its connections). All
   * in-memory state — including files the dead instance left open — is
   * discarded; the caller closes the stale SQLite connections first via
   * `takeConnections()`.
   */
  attach(storage: DurableObjectStorage): void {
    this.storage = storage;
    this.schemaReady = false;
    this.cache.clear();
    this.memoryFiles.clear();
    this.persistentByName.clear();
    this.openFiles.clear();
    this.snapshots.clear();
    this.lastFlushError = undefined;
  }

  /** SQLite connection handles opened through this VFS (tracked by `DoSqliteDatabase`). */
  private readonly connections = new Set<number>();

  trackConnection(db: number): void {
    this.connections.add(db);
  }

  untrackConnection(db: number): void {
    this.connections.delete(db);
  }

  /**
   * Hand over every tracked connection and forget all pending page state so
   * closing them touches neither the old storage nor the new one. Only used
   * when re-attaching after an eviction.
   */
  takeConnections(): number[] {
    const handles = Array.from(this.connections);
    this.connections.clear();
    for (const file of this.persistentByName.values()) {
      file.dirty.clear();
      file.truncateToPages = null;
      file.sizeDirty = false;
      file.flags &= ~SQLITE_OPEN_DELETEONCLOSE;
    }
    return handles;
  }

  getStats(): DoVfsStats {
    let dirty = 0;
    for (const file of this.persistentByName.values()) dirty += file.dirty.size;
    return {
      ...this.stats,
      cachedPages: this.cache.size * PAGES_PER_CHUNK,
      dirtyPages: dirty * PAGES_PER_CHUNK,
      openFiles: this.openFiles.size,
      cacheCapacityChunks: this.cache.capacityChunks,
      cacheBudgetBytes: this.cache.capacityChunks * CHUNK_SIZE,
    };
  }

  /**
   * VFS methods must not throw across the wasm boundary; record the cause (so
   * `DoSqliteDatabase` can attach it to the SQLite error it surfaces), log it,
   * and answer SQLite with `code`.
   */
  private fail(codeName: string, error: unknown, code: number): number {
    this.lastFlushError = error;
    console.error(`[do-vfs ${this.name}] ${codeName}:`, error);
    return code;
  }

  // ---------------------------------------------------------------------------
  // sqlite3_vfs methods
  // ---------------------------------------------------------------------------

  xOpen(
    name: string | null,
    fileId: number,
    flags: number,
    pOutFlags: DataView,
  ): number {
    try {
      if ((flags & SQLITE_OPEN_MAIN_DB) !== 0) {
        if (name === null) return SQLITE_CANTOPEN;
        let file = this.persistentByName.get(name);
        if (file === undefined) {
          this.ensureSchema();
          const meta = this.readStoredMeta(name);
          if (meta === undefined) {
            if ((flags & SQLITE_OPEN_CREATE) === 0) return SQLITE_CANTOPEN;
            this.storage.sql.exec(
              'INSERT INTO vfs2_files (file, size, gen) VALUES (?, 0, 0)',
              name,
            );
            this.stats.storageWrites++;
            this.stats.rowsWritten++;
          }
          file = {
            kind: 'persistent',
            name,
            flags,
            size: meta?.size ?? 0,
            gen: meta?.gen ?? 0,
            lock: SQLITE_LOCK_NONE,
            dirty: new Map(),
            truncateToPages: null,
            sizeDirty: false,
            spill: name.endsWith(VACUUM_FILE_SUFFIX),
          };
          this.persistentByName.set(name, file);
        }
        this.openFiles.set(fileId, file);
        pOutFlags.setInt32(0, flags, true);
        return SQLITE_OK;
      }

      // Journals, temp databases, sub-journals: memory only.
      const memName =
        name ??
        `temp-${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36)}`;
      let mem = this.memoryFiles.get(memName);
      if (mem === undefined) {
        if ((flags & SQLITE_OPEN_CREATE) === 0) return SQLITE_CANTOPEN;
        mem = {
          kind: 'memory',
          name: memName,
          flags,
          size: 0,
          data: new Uint8Array(0),
        };
        this.memoryFiles.set(memName, mem);
      }
      this.openFiles.set(fileId, mem);
      pOutFlags.setInt32(0, flags, true);
      return SQLITE_OK;
    } catch (error) {
      return this.fail('SQLITE_CANTOPEN', error, SQLITE_CANTOPEN);
    }
  }

  xClose(fileId: number): number {
    const file = this.openFiles.get(fileId);
    if (file === undefined) return SQLITE_IOERR_CLOSE;
    this.openFiles.delete(fileId);
    try {
      if (file.kind === 'memory') {
        if ((file.flags & SQLITE_OPEN_DELETEONCLOSE) !== 0)
          this.memoryFiles.delete(file.name);
        return SQLITE_OK;
      }
      this.flush(file);
      if (!this.isOpen(file)) {
        this.persistentByName.delete(file.name);
        if ((file.flags & SQLITE_OPEN_DELETEONCLOSE) !== 0)
          this.deletePersistent(file.name);
      }
      return SQLITE_OK;
    } catch (error) {
      return this.fail('SQLITE_IOERR_CLOSE', error, SQLITE_IOERR_CLOSE);
    }
  }

  xRead(fileId: number, pData: Uint8Array, iOffset: number): number {
    const file = this.openFiles.get(fileId);
    if (file === undefined) return SQLITE_IOERR_READ;
    try {
      if (file.kind === 'memory') return readMemory(file, pData, iOffset);
      return this.readPersistent(file, pData, iOffset);
    } catch (error) {
      return this.fail('SQLITE_IOERR_READ', error, SQLITE_IOERR_READ);
    }
  }

  xWrite(fileId: number, pData: Uint8Array, iOffset: number): number {
    const file = this.openFiles.get(fileId);
    if (file === undefined) return SQLITE_IOERR_WRITE;
    try {
      if (file.kind === 'memory') return writeMemory(file, pData, iOffset);
      this.writePersistent(file, pData, iOffset);
      return SQLITE_OK;
    } catch (error) {
      return this.fail('SQLITE_IOERR_WRITE', error, SQLITE_IOERR_WRITE);
    }
  }

  xTruncate(fileId: number, iSize: number): number {
    const file = this.openFiles.get(fileId);
    if (file === undefined) return SQLITE_IOERR_TRUNCATE;
    try {
      if (file.kind === 'memory') {
        file.size = Math.min(file.size, iSize);
        return SQLITE_OK;
      }
      this.truncatePersistent(file, iSize);
      return SQLITE_OK;
    } catch (error) {
      return this.fail('SQLITE_IOERR_TRUNCATE', error, SQLITE_IOERR_TRUNCATE);
    }
  }

  xSync(fileId: number, _flags: number): number {
    const file = this.openFiles.get(fileId);
    if (file === undefined) return SQLITE_IOERR_FSYNC;
    if (file.kind === 'memory') return SQLITE_OK;
    try {
      this.flush(file);
      return SQLITE_OK;
    } catch (error) {
      return this.fail('SQLITE_IOERR_FSYNC', error, SQLITE_IOERR_FSYNC);
    }
  }

  xFileSize(fileId: number, pSize64: DataView): number {
    const file = this.openFiles.get(fileId);
    if (file === undefined) return SQLITE_IOERR;
    pSize64.setBigInt64(0, BigInt(file.size), true);
    return SQLITE_OK;
  }

  xLock(fileId: number, flags: number): number {
    const file = this.openFiles.get(fileId);
    if (file === undefined) return SQLITE_IOERR;
    if (file.kind === 'persistent') file.lock = flags;
    return SQLITE_OK;
  }

  xUnlock(fileId: number, flags: number): number {
    const file = this.openFiles.get(fileId);
    if (file === undefined) return SQLITE_IOERR;
    if (file.kind === 'memory') return SQLITE_OK;
    const hadExclusive = file.lock >= SQLITE_LOCK_EXCLUSIVE;
    file.lock = flags;
    if (hadExclusive && flags < SQLITE_LOCK_EXCLUSIVE) {
      try {
        this.flush(file);
      } catch (error) {
        // SQLite already considers the transaction committed here; keep the
        // pages dirty so the next flush retries, and surface the failure.
        return this.fail('SQLITE_IOERR_UNLOCK', error, SQLITE_IOERR_UNLOCK);
      }
    }
    return SQLITE_OK;
  }

  xCheckReservedLock(_fileId: number, pResOut: DataView): number {
    pResOut.setInt32(0, 0, true);
    return SQLITE_OK;
  }

  xFileControl(_fileId: number, _op: number, _pArg: DataView): number {
    return SQLITE_NOTFOUND;
  }

  xSectorSize(_fileId: number): number {
    return VFS_PAGE_SIZE;
  }

  xDeviceCharacteristics(_fileId: number): number {
    return SQLITE_IOCAP_SAFE_APPEND | SQLITE_IOCAP_SEQUENTIAL;
  }

  xDelete(name: string, _syncDir: number): number {
    try {
      if (this.memoryFiles.delete(name)) return SQLITE_OK;
      if (this.persistentByName.has(name)) {
        // SQLite never deletes an open main database; refuse rather than corrupt.
        return SQLITE_IOERR_DELETE;
      }
      this.ensureSchema();
      this.deletePersistent(name);
      return SQLITE_OK;
    } catch (error) {
      return this.fail('SQLITE_IOERR_DELETE', error, SQLITE_IOERR_DELETE);
    }
  }

  /** `_flags` (EXISTS / READWRITE / READ) all get the same answer: storage is always writable. */
  xAccess(name: string, _flags: number, pResOut: DataView): number {
    try {
      let exists: boolean;
      if (this.memoryFiles.has(name) || this.persistentByName.has(name)) {
        exists = true;
      } else {
        this.ensureSchema();
        exists = this.readStoredMeta(name) !== undefined;
      }
      pResOut.setInt32(0, exists ? 1 : 0, true);
      return SQLITE_OK;
    } catch (error) {
      return this.fail('SQLITE_IOERR_ACCESS', error, SQLITE_IOERR_ACCESS);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers exposed to the runtime (not called by SQLite)
  // ---------------------------------------------------------------------------

  /** Whether `name` exists in storage (or is an open persistent file). */
  fileExists(name: string): boolean {
    if (this.persistentByName.has(name)) return true;
    this.ensureSchema();
    return this.readStoredMeta(name) !== undefined;
  }

  /** Logical size in bytes of a persistent file, or undefined when absent. */
  fileSize(name: string): number | undefined {
    const open = this.persistentByName.get(name);
    if (open !== undefined) return open.size;
    this.ensureSchema();
    return this.readStoredMeta(name)?.size;
  }

  /**
   * Number of flushes that changed `name` (0 for a file that was never
   * written). Bumped by every flush that wrote chunks, truncated or resized,
   * by imports and by renames — never by reads. Two equal generations mean
   * byte-identical content; the converse does not hold (a rewrite of the
   * same bytes still bumps it), so callers that care hash as a second gate.
   */
  writeGeneration(name: string): number {
    const open = this.persistentByName.get(name);
    if (open !== undefined) return open.gen;
    this.ensureSchema();
    return this.readStoredMeta(name)?.gen ?? 0;
  }

  /**
   * Concatenate the stored pages of `name` in order: the result is the SQLite
   * file exactly as a filesystem VFS would hold it. Pending (unflushed) pages
   * are flushed first, so this must not be called from inside a SQLite
   * transaction on that file. Materializes the whole file in memory.
   */
  exportFile(name: string): Uint8Array {
    const open = this.persistentByName.get(name);
    if (open !== undefined) {
      if (open.lock >= SQLITE_LOCK_EXCLUSIVE) {
        throw new DoVfsError(
          `cannot export '${name}' while a write transaction is open`,
        );
      }
      this.flush(open);
    }
    this.ensureSchema();
    const size = open?.size ?? this.readStoredMeta(name)?.size;
    if (size === undefined)
      throw new DoVfsError(`file '${name}' does not exist`);
    const out = new Uint8Array(size);
    const totalChunks = Math.ceil(size / CHUNK_SIZE);
    // Read in windows so a large file doesn't need a single giant result set
    // (64 chunks = 4 MiB per query).
    const window = 64;
    for (let start = 0; start < totalChunks; start += window) {
      const rows = this.storage.sql
        .exec<ChunkRow>(
          'SELECT chunkno, data FROM vfs2_chunks WHERE file = ? AND chunkno >= ? AND chunkno < ? ORDER BY chunkno',
          name,
          start,
          start + window,
        )
        .toArray();
      this.stats.storageReads++;
      this.stats.rowsRead += rows.length;
      for (const row of rows) {
        const offset = row.chunkno * CHUNK_SIZE;
        const bytes = new Uint8Array(row.data);
        const n = Math.min(bytes.byteLength, size - offset);
        if (n > 0) out.set(bytes.subarray(0, n), offset);
      }
    }
    return out;
  }

  /**
   * Replace the contents of `name` with `bytes` (split into pages) inside one
   * storage transaction. The file must not be open. If the header says the
   * database was left in WAL mode (which this VFS cannot serve — it has no
   * shared memory), the header is rewritten to rollback-journal mode; a file
   * that was closed cleanly by its previous owner carries no pending WAL.
   */
  importFile(name: string, bytes: Uint8Array): void {
    if (this.persistentByName.has(name)) {
      throw new DoVfsError(`cannot import into '${name}' while it is open`);
    }
    this.assertNoSnapshot(name, 'import into');
    if (bytes.byteLength >= 100 && !startsWith(bytes, SQLITE_HEADER_MAGIC)) {
      throw new DoVfsError(
        'import rejected: not a SQLite 3 database (bad header magic)',
      );
    }
    const normalized = normalizeJournalModeHeader(bytes);
    this.ensureSchema();
    this.cache.dropFile(name);
    this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM vfs2_chunks WHERE file = ?', name);
      this.storage.sql.exec(
        'INSERT INTO vfs2_files (file, size, gen) VALUES (?, ?, 1) ON CONFLICT(file) DO UPDATE SET size = excluded.size, gen = vfs2_files.gen + 1',
        name,
        normalized.byteLength,
      );
      this.stats.rowsWritten += 1;
      const totalChunks = Math.ceil(normalized.byteLength / CHUNK_SIZE);
      const rows: Array<[number, Uint8Array]> = [];
      for (let chunkno = 0; chunkno < totalChunks; chunkno++) {
        const chunk = new Uint8Array(CHUNK_SIZE);
        const start = chunkno * CHUNK_SIZE;
        chunk.set(
          normalized.subarray(
            start,
            Math.min(start + CHUNK_SIZE, normalized.byteLength),
          ),
        );
        rows.push([chunkno, chunk]);
        if (rows.length === FLUSH_BATCH_ROWS) {
          this.upsertChunks(name, rows);
          rows.length = 0;
        }
      }
      if (rows.length > 0) this.upsertChunks(name, rows);
    });
    this.stats.storageWrites++;
  }

  /** Remove a persistent file and all of its pages. The file must not be open. */
  deleteFile(name: string): void {
    if (this.persistentByName.has(name)) {
      throw new DoVfsError(`cannot delete '${name}' while it is open`);
    }
    this.assertNoSnapshot(name, 'delete');
    this.ensureSchema();
    this.deletePersistent(name);
  }

  /**
   * Hex SHA-256 of the file as `exportFile` would return it, hashed window
   * by window (never materialized). Synchronous storage reads make it a
   * consistent view even without a snapshot.
   */
  async fileChecksum(name: string): Promise<string> {
    const open = this.persistentByName.get(name);
    if (open !== undefined) {
      if (open.lock >= SQLITE_LOCK_EXCLUSIVE) {
        throw new DoVfsError(
          `cannot checksum '${name}' while a write transaction is open`,
        );
      }
      this.flush(open);
    }
    this.ensureSchema();
    const size = open?.size ?? this.readStoredMeta(name)?.size;
    if (size === undefined)
      throw new DoVfsError(`file '${name}' does not exist`);
    const hash = createHash('sha256');
    const totalChunks = Math.ceil(size / CHUNK_SIZE);
    for (let start = 0; start < totalChunks; start += SNAPSHOT_WINDOW_CHUNKS) {
      const end = Math.min(totalChunks, start + SNAPSHOT_WINDOW_CHUNKS);
      hash.update(this.readWindow(name, size, start, end, undefined));
    }
    return hash.digest('hex');
  }

  /**
   * Pin the current content of `name` (see `VfsSnapshot`). Pending pages are
   * flushed first, so this must not be called while a write transaction is
   * open on the file; one snapshot per file at a time.
   */
  openSnapshot(name: string): VfsSnapshot {
    if (this.snapshots.has(name))
      throw new DoVfsError(`a snapshot of '${name}' is already open`);
    const open = this.persistentByName.get(name);
    if (open !== undefined) {
      if (open.lock >= SQLITE_LOCK_EXCLUSIVE) {
        throw new DoVfsError(
          `cannot snapshot '${name}' while a write transaction is open`,
        );
      }
      this.flush(open);
    }
    this.ensureSchema();
    const meta = open
      ? { size: open.size, gen: open.gen }
      : this.readStoredMeta(name);
    if (meta === undefined)
      throw new DoVfsError(`file '${name}' does not exist`);
    const state: SnapshotState = {
      name,
      size: meta.size,
      totalChunks: Math.ceil(meta.size / CHUNK_SIZE),
      shadow: new Map(),
      open: true,
    };
    this.snapshots.set(name, state);
    return {
      name,
      size: meta.size,
      generation: meta.gen,
      open: () => this.snapshotStream(state),
      close: () => {
        if (!state.open) return;
        state.open = false;
        state.shadow.clear();
        if (this.snapshots.get(name) === state) this.snapshots.delete(name);
      },
    };
  }

  private snapshotStream(state: SnapshotState): ReadableStream<Uint8Array> {
    let cursor = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          if (!state.open) {
            controller.error(
              new DoVfsError(`snapshot of '${state.name}' was closed`),
            );
            return;
          }
          if (cursor >= state.totalChunks) {
            controller.close();
            return;
          }
          const end = Math.min(
            state.totalChunks,
            cursor + SNAPSHOT_WINDOW_CHUNKS,
          );
          controller.enqueue(
            this.readWindow(state.name, state.size, cursor, end, state.shadow),
          );
          cursor = end;
        },
      },
      // One window in flight: the consumer (gzip, tus part buffer) pulls the
      // next 1 MiB only after it drained the previous one.
      { highWaterMark: 1 },
    );
  }

  /**
   * Bytes of chunks `[start, end)` of `name` exactly as stored, capped at
   * `size`. Pre-images in `shadow` win over storage. Windows bypass the clean
   * cache so a whole-file read never evicts the working set.
   */
  private readWindow(
    name: string,
    size: number,
    start: number,
    end: number,
    shadow: Map<number, Uint8Array> | undefined,
  ): Uint8Array {
    const from = start * CHUNK_SIZE;
    const to = Math.min(size, end * CHUNK_SIZE);
    const out = new Uint8Array(Math.max(0, to - from));
    const rows = this.storage.sql
      .exec<ChunkRow>(
        'SELECT chunkno, data FROM vfs2_chunks WHERE file = ? AND chunkno >= ? AND chunkno < ? ORDER BY chunkno',
        name,
        start,
        end,
      )
      .toArray();
    this.stats.storageReads++;
    this.stats.rowsRead += rows.length;
    const place = (chunkno: number, bytes: Uint8Array): void => {
      const offset = chunkno * CHUNK_SIZE - from;
      const n = Math.min(bytes.byteLength, out.byteLength - offset);
      if (n > 0) out.set(bytes.subarray(0, n), offset);
    };
    for (const row of rows) {
      if (shadow?.has(row.chunkno)) continue;
      place(row.chunkno, new Uint8Array(row.data));
    }
    if (shadow) {
      for (let chunkno = start; chunkno < end; chunkno++) {
        const pre = shadow.get(chunkno);
        if (pre !== undefined) place(chunkno, pre);
      }
    }
    return out;
  }

  /**
   * Replace `name` with the bytes of `stream` (a decompressed SQLite file of
   * unknown length), written in 64 KiB chunks to a staging file as they
   * arrive and swapped into place in ONE storage transaction at the end. A
   * failure mid-stream leaves `name` untouched. Never holds more than one
   * batch (~1 MiB) in memory. Returns the byte length written.
   */
  async importFromStream(
    name: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<number> {
    if (this.persistentByName.has(name)) {
      throw new DoVfsError(`cannot import into '${name}' while it is open`);
    }
    this.assertNoSnapshot(name, 'import into');
    this.ensureSchema();
    const staging = `${name}${IMPORT_FILE_SUFFIX}`;
    this.deletePersistent(staging);
    const reader = stream.getReader();
    let pending = new Uint8Array(CHUNK_SIZE);
    let fill = 0;
    let chunkno = 0;
    let total = 0;
    let headerChecked = false;
    let rows: Array<[number, Uint8Array]> = [];
    const flushRows = (): void => {
      if (rows.length === 0) return;
      const batch = rows;
      rows = [];
      this.storage.transactionSync(() => this.upsertChunks(staging, batch));
      this.stats.storageWrites++;
    };
    const checkHeader = (chunk: Uint8Array, length: number): void => {
      if (headerChecked) return;
      headerChecked = true;
      if (length >= 100 && !startsWith(chunk, SQLITE_HEADER_MAGIC)) {
        throw new DoVfsError(
          'import rejected: not a SQLite 3 database (bad header magic)',
        );
      }
      // WAL-flagged header → rollback-journal mode (this VFS has no shared memory).
      if (length >= 100 && (chunk[18] === 2 || chunk[19] === 2)) {
        chunk[18] = 1;
        chunk[19] = 1;
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let offset = 0;
        while (offset < value.byteLength) {
          const n = Math.min(CHUNK_SIZE - fill, value.byteLength - offset);
          pending.set(value.subarray(offset, offset + n), fill);
          fill += n;
          offset += n;
          total += n;
          if (fill === CHUNK_SIZE) {
            if (chunkno === 0) checkHeader(pending, fill);
            rows.push([chunkno++, pending]);
            pending = new Uint8Array(CHUNK_SIZE);
            fill = 0;
            if (rows.length === FLUSH_BATCH_ROWS) flushRows();
          }
        }
      }
      if (fill > 0) {
        if (chunkno === 0) checkHeader(pending, fill);
        rows.push([chunkno++, pending]);
      }
      flushRows();
      this.cache.dropFile(name);
      this.storage.transactionSync(() => {
        this.storage.sql.exec('DELETE FROM vfs2_chunks WHERE file = ?', name);
        this.storage.sql.exec(
          'UPDATE vfs2_chunks SET file = ? WHERE file = ?',
          name,
          staging,
        );
        this.storage.sql.exec(
          'INSERT INTO vfs2_files (file, size, gen) VALUES (?, ?, 1) ON CONFLICT(file) DO UPDATE SET size = excluded.size, gen = vfs2_files.gen + 1',
          name,
          total,
        );
        this.storage.sql.exec('DELETE FROM vfs2_files WHERE file = ?', staging);
        this.stats.rowsWritten += chunkno + 1;
      });
      this.stats.storageWrites++;
      return total;
    } catch (error) {
      try {
        this.deletePersistent(staging);
      } catch {
        // The import error is the one worth reporting.
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Atomically replace `to` with the content of `from` (both must be closed
   * and `to` unsnapshotted). Used to swap a `VACUUM INTO` output into place.
   */
  renameFile(from: string, to: string): void {
    if (this.persistentByName.has(from) || this.persistentByName.has(to)) {
      throw new DoVfsError(`cannot rename '${from}' → '${to}' while open`);
    }
    this.assertNoSnapshot(to, 'replace');
    this.ensureSchema();
    const meta = this.readStoredMeta(from);
    if (meta === undefined)
      throw new DoVfsError(`file '${from}' does not exist`);
    this.cache.dropFile(from);
    this.cache.dropFile(to);
    this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM vfs2_chunks WHERE file = ?', to);
      this.storage.sql.exec(
        'UPDATE vfs2_chunks SET file = ? WHERE file = ?',
        to,
        from,
      );
      this.storage.sql.exec(
        'INSERT INTO vfs2_files (file, size, gen) VALUES (?, ?, 1) ON CONFLICT(file) DO UPDATE SET size = excluded.size, gen = vfs2_files.gen + 1',
        to,
        meta.size,
      );
      this.storage.sql.exec('DELETE FROM vfs2_files WHERE file = ?', from);
      this.stats.rowsWritten += Math.ceil(meta.size / CHUNK_SIZE) + 1;
    });
    this.stats.storageWrites++;
  }

  private assertNoSnapshot(name: string, verb: string): void {
    if (this.snapshots.has(name)) {
      throw new DoVfsError(`cannot ${verb} '${name}' while a snapshot is open`);
    }
  }

  /** Force any buffered pages of every open file into storage. */
  flushAll(): void {
    for (const file of this.persistentByName.values()) this.flush(file);
  }

  // ---------------------------------------------------------------------------
  // Persistent file internals
  // ---------------------------------------------------------------------------

  private isOpen(file: PersistentFile): boolean {
    for (const open of this.openFiles.values()) {
      if (open === file) return true;
    }
    return false;
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS vfs2_files (file TEXT PRIMARY KEY, size INTEGER NOT NULL)',
    );
    this.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS vfs2_chunks (file TEXT NOT NULL, chunkno INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (file, chunkno))',
    );
    // Write generation (added after the first deployments): older working
    // copies get the column with gen = 0.
    const columns = this.storage.sql
      .exec<{ name: string }>('PRAGMA table_info(vfs2_files)')
      .toArray()
      .map((row) => row.name);
    if (!columns.includes('gen')) {
      this.storage.sql.exec(
        'ALTER TABLE vfs2_files ADD COLUMN gen INTEGER NOT NULL DEFAULT 0',
      );
    }
    // v1 (one page per row) never shipped; drop dev-environment leftovers so
    // a stale un-chunked working copy can't shadow the re-import path.
    this.storage.sql.exec('DROP TABLE IF EXISTS vfs_pages');
    this.storage.sql.exec('DROP TABLE IF EXISTS vfs_files');
    // Staging files of an import or VACUUM that died mid-way are garbage.
    for (const suffix of [IMPORT_FILE_SUFFIX, VACUUM_FILE_SUFFIX]) {
      const leftovers = this.storage.sql
        .exec<{
          file: string;
        }>(
          'SELECT file FROM vfs2_files WHERE substr(file, -?) = ?',
          suffix.length,
          suffix,
        )
        .toArray();
      for (const row of leftovers) this.deletePersistent(row.file);
    }
    this.schemaReady = true;
  }

  private readStoredMeta(
    name: string,
  ): { size: number; gen: number } | undefined {
    const rows = this.storage.sql
      .exec<FileMetaRow>(
        'SELECT size, gen FROM vfs2_files WHERE file = ?',
        name,
      )
      .toArray();
    this.stats.storageReads++;
    this.stats.rowsRead += rows.length;
    const row = rows[0];
    return row === undefined ? undefined : { size: row.size, gen: row.gen };
  }

  /**
   * The chunk holding `chunkno`, from (in order) the dirty set, the clean
   * cache, then storage. Returns a buffer that must be treated as read-only
   * unless it came from `dirty` — writers copy before mutating.
   */
  private loadChunk(
    file: PersistentFile,
    chunkno: number,
  ): Uint8Array | undefined {
    const dirty = file.dirty.get(chunkno);
    if (dirty !== undefined) return dirty;
    const cached = this.cache.get(file.name, chunkno);
    if (cached !== undefined) {
      this.stats.cacheHits++;
      return cached;
    }
    if (
      file.truncateToPages !== null &&
      chunkno * PAGES_PER_CHUNK >= file.truncateToPages
    )
      return undefined;
    this.stats.cacheMisses++;
    const rows = this.storage.sql
      .exec<ChunkRow>(
        'SELECT chunkno, data FROM vfs2_chunks WHERE file = ? AND chunkno = ?',
        file.name,
        chunkno,
      )
      .toArray();
    this.stats.storageReads++;
    this.stats.rowsRead += rows.length;
    const row = rows[0];
    if (row === undefined) return undefined;
    let chunk = new Uint8Array(row.data);
    if (chunk.byteLength !== CHUNK_SIZE) {
      const full = new Uint8Array(CHUNK_SIZE);
      full.set(chunk.subarray(0, Math.min(chunk.byteLength, CHUNK_SIZE)));
      chunk = full;
    }
    this.cache.set(file.name, chunkno, chunk);
    return chunk;
  }

  /** A dirty (mutable) buffer for `chunkno`, copied from clean state if needed. */
  private dirtyChunk(file: PersistentFile, chunkno: number): Uint8Array {
    let chunk = file.dirty.get(chunkno);
    if (chunk !== undefined) return chunk;
    const clean = this.loadChunk(file, chunkno);
    chunk = clean !== undefined ? clean.slice() : new Uint8Array(CHUNK_SIZE);
    file.dirty.set(chunkno, chunk);
    return chunk;
  }

  private readPersistent(
    file: PersistentFile,
    pData: Uint8Array,
    iOffset: number,
  ): number {
    const want = pData.byteLength;
    const available = Math.max(0, Math.min(want, file.size - iOffset));
    let done = 0;
    while (done < available) {
      const pos = iOffset + done;
      const chunkno = Math.floor(pos / CHUNK_SIZE);
      const inChunk = pos - chunkno * CHUNK_SIZE;
      const n = Math.min(CHUNK_SIZE - inChunk, available - done);
      const chunk = this.loadChunk(file, chunkno);
      if (chunk === undefined) {
        pData.fill(0, done, done + n); // sparse region
      } else {
        pData.set(chunk.subarray(inChunk, inChunk + n), done);
      }
      done += n;
    }
    if (available < want) {
      pData.fill(0, available);
      return SQLITE_IOERR_SHORT_READ;
    }
    return SQLITE_OK;
  }

  private writePersistent(
    file: PersistentFile,
    pData: Uint8Array,
    iOffset: number,
  ): void {
    let done = 0;
    while (done < pData.byteLength) {
      const pos = iOffset + done;
      const chunkno = Math.floor(pos / CHUNK_SIZE);
      const inChunk = pos - chunkno * CHUNK_SIZE;
      const n = Math.min(CHUNK_SIZE - inChunk, pData.byteLength - done);
      // Always merge into the full chunk buffer (a page write touches 1/16th
      // of its chunk). `dirtyChunk` copies clean state exactly once; pData is
      // copied implicitly by `set` (it aliases the wasm heap).
      const chunk = this.dirtyChunk(file, chunkno);
      chunk.set(pData.subarray(done, done + n), inChunk);
      done += n;
    }
    const end = iOffset + pData.byteLength;
    if (end > file.size) {
      file.size = end;
      file.sizeDirty = true;
    }
    if (file.spill && file.dirty.size >= SPILL_CHUNKS) this.flush(file);
  }

  private truncatePersistent(file: PersistentFile, iSize: number): void {
    if (iSize >= file.size) return;
    const keepPages = Math.ceil(iSize / VFS_PAGE_SIZE);
    const keepChunks = Math.ceil(keepPages / PAGES_PER_CHUNK);
    for (const chunkno of Array.from(file.dirty.keys())) {
      if (chunkno >= keepChunks) file.dirty.delete(chunkno);
    }
    this.cache.dropFrom(file.name, keepChunks);
    file.truncateToPages =
      file.truncateToPages === null
        ? keepPages
        : Math.min(file.truncateToPages, keepPages);
    file.size = iSize;
    file.sizeDirty = true;
    // Zero the bytes past the new end inside the last surviving chunk, so a
    // later grow-then-read never resurrects stale bytes.
    if (keepChunks > 0) {
      const tail = iSize - (keepChunks - 1) * CHUNK_SIZE;
      if (tail < CHUNK_SIZE) {
        const last = this.loadChunk(file, keepChunks - 1);
        if (last !== undefined) {
          const copy =
            file.dirty.get(keepChunks - 1) === last ? last : last.slice();
          copy.fill(0, tail);
          file.dirty.set(keepChunks - 1, copy);
        }
      }
    }
  }

  /** First chunk fully past the page-count boundary `keepPages`. */
  private static chunkFloor(keepPages: number): number {
    return Math.ceil(keepPages / PAGES_PER_CHUNK);
  }

  /** Write dirty chunks, truncation and size of `file` to storage in one transaction. */
  private flush(file: PersistentFile): void {
    if (
      file.dirty.size === 0 &&
      file.truncateToPages === null &&
      !file.sizeDirty
    )
      return;
    const truncateTo = file.truncateToPages;
    const dirty = Array.from(file.dirty.entries()).sort((a, b) => a[0] - b[0]);
    const size = file.size;
    const snapshot = this.snapshots.get(file.name);
    if (snapshot !== undefined) {
      // Pin the pre-image of everything this flush overwrites or deletes.
      const touched = dirty.map(([chunkno]) => chunkno);
      if (truncateTo !== null) {
        for (
          let chunkno = DoVfs.chunkFloor(truncateTo);
          chunkno < snapshot.totalChunks;
          chunkno++
        )
          touched.push(chunkno);
      }
      this.shadowPreImages(file, snapshot, touched);
    }
    this.storage.transactionSync(() => {
      if (truncateTo !== null) {
        this.storage.sql.exec(
          'DELETE FROM vfs2_chunks WHERE file = ? AND chunkno >= ?',
          file.name,
          DoVfs.chunkFloor(truncateTo),
        );
      }
      for (let i = 0; i < dirty.length; i += FLUSH_BATCH_ROWS) {
        this.upsertChunks(file.name, dirty.slice(i, i + FLUSH_BATCH_ROWS));
      }
      this.storage.sql.exec(
        'UPDATE vfs2_files SET size = ?, gen = gen + 1 WHERE file = ?',
        size,
        file.name,
      );
      this.stats.rowsWritten += 1;
    });
    file.gen += 1;
    this.stats.storageWrites++;
    this.stats.flushes++;
    for (const [chunkno, chunk] of dirty)
      this.cache.set(file.name, chunkno, chunk);
    file.dirty.clear();
    file.truncateToPages = null;
    file.sizeDirty = false;
  }

  /**
   * Capture, for an open snapshot of `file`, the stored content of every
   * chunk in `chunknos` that lies inside the snapshot and is not shadowed
   * yet. The clean cache usually still holds the pre-image (a write copies
   * the clean chunk through it); otherwise one storage read per chunk.
   */
  private shadowPreImages(
    file: PersistentFile,
    snapshot: SnapshotState,
    chunknos: number[],
  ): void {
    const missing: number[] = [];
    for (const chunkno of chunknos) {
      if (chunkno >= snapshot.totalChunks || snapshot.shadow.has(chunkno))
        continue;
      const cached = this.cache.get(file.name, chunkno);
      if (cached !== undefined) snapshot.shadow.set(chunkno, cached);
      else missing.push(chunkno);
    }
    for (let i = 0; i < missing.length; i += SNAPSHOT_WINDOW_CHUNKS) {
      const batch = missing.slice(i, i + SNAPSHOT_WINDOW_CHUNKS);
      const rows = this.storage.sql
        .exec<ChunkRow>(
          `SELECT chunkno, data FROM vfs2_chunks WHERE file = ? AND chunkno IN (${batch.map(() => '?').join(', ')})`,
          file.name,
          ...batch,
        )
        .toArray();
      this.stats.storageReads++;
      this.stats.rowsRead += rows.length;
      for (const row of rows)
        snapshot.shadow.set(row.chunkno, new Uint8Array(row.data));
      // A chunk with no stored row was sparse at snapshot time: zeros.
      for (const chunkno of batch) {
        if (!snapshot.shadow.has(chunkno))
          snapshot.shadow.set(chunkno, new Uint8Array(CHUNK_SIZE));
      }
    }
  }

  private upsertChunks(
    name: string,
    rows: ReadonlyArray<readonly [number, Uint8Array]>,
  ): void {
    if (rows.length === 0) return;
    const placeholders = rows.map(() => '(?, ?, ?)').join(', ');
    const bindings: Array<string | number | ArrayBuffer> = [];
    for (const [chunkno, chunk] of rows) {
      bindings.push(name, chunkno, toArrayBuffer(chunk));
    }
    this.storage.sql.exec(
      `INSERT OR REPLACE INTO vfs2_chunks (file, chunkno, data) VALUES ${placeholders}`,
      ...bindings,
    );
    this.stats.rowsWritten += rows.length;
  }

  private deletePersistent(name: string): void {
    this.assertNoSnapshot(name, 'delete');
    this.cache.dropFile(name);
    this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM vfs2_chunks WHERE file = ?', name);
      this.storage.sql.exec('DELETE FROM vfs2_files WHERE file = ?', name);
    });
    this.stats.storageWrites++;
  }
}

export function isDoVfs(vfs: SQLiteVFS): vfs is DoVfs {
  return vfs instanceof DoVfs;
}

// -----------------------------------------------------------------------------
// Memory file helpers (journals / temp files)
// -----------------------------------------------------------------------------

function readMemory(
  file: MemoryFile,
  pData: Uint8Array,
  iOffset: number,
): number {
  const begin = Math.min(iOffset, file.size);
  const end = Math.min(iOffset + pData.byteLength, file.size);
  const n = end - begin;
  if (n > 0) pData.set(file.data.subarray(begin, end));
  if (n < pData.byteLength) {
    pData.fill(0, n);
    return SQLITE_IOERR_SHORT_READ;
  }
  return SQLITE_OK;
}

function writeMemory(
  file: MemoryFile,
  pData: Uint8Array,
  iOffset: number,
): number {
  const end = iOffset + pData.byteLength;
  if (end > file.data.byteLength) {
    const grown = new Uint8Array(Math.max(end, file.data.byteLength * 2, 8192));
    grown.set(file.data.subarray(0, file.size));
    file.data = grown;
  }
  file.data.set(pData, iOffset);
  file.size = Math.max(file.size, end);
  return SQLITE_OK;
}

// -----------------------------------------------------------------------------
// Byte helpers
// -----------------------------------------------------------------------------

function toArrayBuffer(page: Uint8Array): ArrayBuffer {
  const { buffer } = page;
  if (
    page.byteOffset === 0 &&
    page.byteLength === buffer.byteLength &&
    buffer instanceof ArrayBuffer
  ) {
    return buffer;
  }
  const copy = new Uint8Array(page.byteLength);
  copy.set(page);
  return copy.buffer;
}

function startsWith(bytes: Uint8Array, ascii: string): boolean {
  if (bytes.byteLength < ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Header bytes 18 (write version) and 19 (read version) are 2 for WAL-mode
 * databases and 1 for rollback-journal databases. Returns the input unchanged
 * unless it is a WAL-flagged SQLite file, in which case a copy with both bytes
 * set to 1 is returned.
 */
export function normalizeJournalModeHeader(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 100 || !startsWith(bytes, SQLITE_HEADER_MAGIC))
    return bytes;
  if (bytes[18] !== 2 && bytes[19] !== 2) return bytes;
  const copy = bytes.slice();
  copy[18] = 1;
  copy[19] = 1;
  return copy;
}
