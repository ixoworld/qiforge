/* eslint-disable no-console -- console is the logger on workerd (no @ixo/logger); only used for stale-connection warnings */
/**
 * `DoSqliteDatabase` — a small async wrapper around the wa-sqlite API for one
 * SQLite database file stored through `DoVfs` in a Durable Object's storage.
 *
 * - Rows are plain objects keyed by column name. INTEGER columns come back as
 *   `number` (or `bigint` outside the safe-integer range), REAL as `number`,
 *   TEXT as `string`, BLOB as `Uint8Array` (copied out of the wasm heap), NULL
 *   as `null`.
 * - Parameters are bound with `sqlite3.bind_collection` (positional array or
 *   `{ ':name': value }` object). `boolean` binds as 0/1, `undefined` as NULL,
 *   and integral numbers outside int32 are bound as INTEGER (via bigint) so
 *   e.g. millisecond timestamps keep the INTEGER affinity `better-sqlite3`
 *   gives them rather than becoming REAL.
 * - The wa-sqlite API is promise-shaped even for the synchronous build, so
 *   every call here is `async`; nothing actually yields to the event loop
 *   other than microtasks.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  SQLITE_DONE,
  SQLITE_OPEN_CREATE,
  SQLITE_OPEN_READWRITE,
  SQLITE_ROW,
} from 'wa-sqlite';
import {
  DoVfs,
  DoVfsError,
  isDoVfs,
  type Exclusive,
  VACUUM_FILE_SUFFIX,
  VFS_PAGE_SIZE,
  type DoVfsOptions,
  type DoVfsStats,
  type TierFlushResult,
  type TierStatus,
  type VfsSnapshot,
} from './do-vfs';
import type { PageTierOptions } from './page-tier';
import {
  getOrRegisterVfs,
  loadSqlite,
  type SqliteRuntime,
} from './wa-sqlite-loader';

/**
 * Cold-miss retries. A statement outside a transaction re-runs after each
 * resolve; a transaction rolls back, resolves, and re-runs its callback.
 * Every resolve fetches whole 1 MiB segments (plus one of read-ahead) and
 * pins them for the retry, so even a scan across a cold file converges in
 * a handful of rounds; the caps only guard against a bug that keeps
 * recording misses.
 */
const MAX_STATEMENT_MISS_RETRIES = 64;
const MAX_TRANSACTION_MISS_RETRIES = 32;

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlParam = SqlValue | boolean | undefined;
export type SqlParams =
  | ReadonlyArray<SqlParam>
  | Readonly<Record<string, SqlParam>>;
export type SqlRow = Record<string, SqlValue>;

export interface RunResult {
  /** Rows changed by the most recent INSERT/UPDATE/DELETE. */
  changes: number;
}

export interface DoSqliteOpenOptions extends DoVfsOptions {
  /**
   * PRAGMAs applied after opening. Defaults keep only the main file in
   * storage (`journal_mode=MEMORY`, `temp_store=MEMORY`) and let the VFS own
   * durability (`synchronous=OFF`; see `do-vfs.ts` for why that is safe).
   */
  pragmas?: string[];
}

const DEFAULT_PRAGMAS = [
  `PRAGMA page_size=${VFS_PAGE_SIZE}`,
  'PRAGMA journal_mode=MEMORY',
  'PRAGMA synchronous=OFF',
  'PRAGMA temp_store=MEMORY',
];

export interface DoSqliteContext {
  id: { toString(): string };
  storage: DurableObjectStorage;
}

/** VFS name for a Durable Object — one VFS per object, shared by all files it opens. */
export function vfsNameForObject(ctx: DoSqliteContext): string {
  return `do-${ctx.id.toString()}`;
}

/**
 * The async chain holding the connection mutex: a top-level transaction, a
 * `withoutTransactions()` callback, or one statement issued outside both.
 * `inTx` is set from BEGIN until COMMIT/ROLLBACK has run. `held` turns
 * false on release, so a promise chain that outlives its holder (started
 * inside, still running afterwards) queues like any other caller instead
 * of borrowing a lock that is no longer its own.
 */
interface MutexFrame {
  held: boolean;
  inTx: boolean;
}

export class DoSqliteDatabase {
  private db: number | null;
  /** Open transaction levels on the connection (1 = BEGIN, +1 per savepoint). */
  private txDepth = 0;
  private savepointSeq = 0;
  /**
   * The connection mutex (see `withMutex()`): transactions, statements
   * issued outside a transaction, and `withoutTransactions()` callbacks
   * queue on it, so a statement never runs inside another chain's open
   * transaction.
   */
  private txQueue: Promise<void> = Promise.resolve();
  /** Serialises individual statements on this connection (see `serialized()`). */
  private opQueue: Promise<void> = Promise.resolve();
  /** The frame of the chain that holds the mutex, visible to everything it awaits. */
  private readonly holder = new AsyncLocalStorage<MutexFrame>();

  private constructor(
    private readonly runtime: SqliteRuntime,
    db: number,
    readonly vfs: DoVfs,
    readonly fileName: string,
    private readonly pragmas: readonly string[],
  ) {
    this.db = db;
  }

  /**
   * Open (creating if needed) `fileName` in the object's storage. The VFS for
   * this object is registered on first use and re-bound to the new storage if
   * the object was re-instantiated inside the same isolate.
   */
  static async open(
    ctx: DoSqliteContext,
    fileName = 'oracle.db',
    options: DoSqliteOpenOptions = {},
  ): Promise<DoSqliteDatabase> {
    const runtime = await loadSqlite();
    const vfsName = vfsNameForObject(ctx);
    let created = false;
    const vfs = getOrRegisterVfs(
      runtime,
      vfsName,
      () => {
        created = true;
        return new DoVfs(vfsName, ctx.storage, options);
      },
      isDoVfs,
    );
    if (!created && !vfs.isAttachedTo(ctx.storage)) {
      // Same object id, new instance: the previous instance was evicted with
      // its connections open. Close them (no storage is touched — pending
      // page state was discarded) so the wasm side doesn't leak, then re-bind.
      for (const stale of vfs.takeConnections()) {
        try {
          await runtime.sqlite3.close(stale);
        } catch (error) {
          console.warn(
            `[sqlite] failed to close stale connection ${stale} on VFS ${vfsName}`,
            error,
          );
        }
      }
      vfs.attach(ctx.storage);
    }
    if (!created) {
      vfs.configureCache(options.cachePages);
      vfs.configureTier(options.tier);
    }
    const pragmas = options.pragmas ?? DEFAULT_PRAGMAS;
    const db = await DoSqliteDatabase.openConnection(
      runtime,
      vfs,
      fileName,
      pragmas,
    );
    return new DoSqliteDatabase(runtime, db, vfs, fileName, pragmas);
  }

  private static async openConnection(
    runtime: SqliteRuntime,
    vfs: DoVfs,
    fileName: string,
    pragmas: readonly string[],
  ): Promise<number> {
    // Opening reads the file header and the pragmas read page 1 — before
    // any statement of ours could retry a cold miss. Chunk 0 is never
    // evicted, but a pin-less retry here keeps a reopen robust regardless.
    let pinned = false;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await DoSqliteDatabase.openConnectionOnce(
            runtime,
            vfs,
            fileName,
            pragmas,
          );
        } catch (error) {
          if (!vfs.hasMisses() || attempt >= MAX_STATEMENT_MISS_RETRIES)
            throw error;
          await vfs.resolveMisses();
          pinned = true;
          vfs.missRetries++;
        }
      }
    } finally {
      if (pinned) vfs.releasePins();
    }
  }

  private static async openConnectionOnce(
    runtime: SqliteRuntime,
    vfs: DoVfs,
    fileName: string,
    pragmas: readonly string[],
  ): Promise<number> {
    const db = await runtime.sqlite3.open_v2(
      fileName,
      SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
      vfs.name,
    );
    vfs.trackConnection(db);
    try {
      for (const pragma of pragmas) {
        for await (const stmt of runtime.sqlite3.statements(db, pragma)) {
          while ((await runtime.sqlite3.step(stmt)) === SQLITE_ROW) {
            // PRAGMA statements may return a row; drain it.
          }
        }
      }
    } catch (error) {
      vfs.untrackConnection(db);
      await runtime.sqlite3.close(db);
      throw error;
    }
    return db;
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  /** SQLite library version of the loaded build. */
  get sqliteVersion(): string {
    return this.runtime.sqlite3.libversion();
  }

  private handle(): number {
    if (this.db === null)
      throw new Error(`database '${this.fileName}' is closed`);
    return this.db;
  }

  /**
   * Run `sql` (one or more statements) and return every row produced. When
   * `params` is given it is bound to each statement that declares parameters.
   * `T` narrows the row shape for the caller; it is not validated at runtime.
   */
  async exec<T extends SqlRow = SqlRow>(
    sql: string,
    params?: SqlParams,
  ): Promise<T[]> {
    return this.withMutex(() =>
      this.serialized(() =>
        this.retryingColdMisses(() => this.execUnlocked<T>(sql, params)),
      ),
    );
  }

  /** Run a statement that produces no rows of interest; returns the change count. */
  async run(sql: string, params?: SqlParams): Promise<RunResult> {
    return this.withMutex(() =>
      this.serialized(() =>
        this.retryingColdMisses(() => this.runUnlocked(sql, params)),
      ),
    );
  }

  /** The caller's mutex frame, when its async chain holds the mutex right now. */
  private ownFrame(): MutexFrame | undefined {
    const frame = this.holder.getStore();
    return frame?.held === true ? frame : undefined;
  }

  /**
   * Run `fn` holding the connection mutex. Re-entrant: a chain that already
   * holds it (a transaction body, a `withoutTransactions()` callback, and
   * everything they await) runs `fn` at once; any other chain queues until
   * the holder is done — a statement issued while another chain's
   * transaction is open runs after its COMMIT or ROLLBACK, never inside it.
   *
   * A holder must not await work that another chain started and that
   * itself needs the mutex: that work waits for the holder, the holder for
   * the work.
   */
  private async withMutex<T>(
    fn: (frame: MutexFrame) => Promise<T>,
  ): Promise<T> {
    const own = this.ownFrame();
    if (own !== undefined) return fn(own);
    const previous = this.txQueue;
    let release: () => void = () => undefined;
    this.txQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const frame: MutexFrame = { held: true, inTx: false };
    try {
      return await this.holder.run(frame, () => fn(frame));
    } finally {
      frame.held = false;
      release();
    }
  }

  /**
   * Run one statement, re-running it after a cold-miss resolve. Only
   * outside a transaction: inside one, SQLite may have put the pager into
   * its error state, so the transaction as a whole is rolled back and
   * retried by `transaction()` instead.
   */
  private async retryingColdMisses<T>(op: () => Promise<T>): Promise<T> {
    if (this.ownFrame()?.inTx === true) return op();
    let pinned = false;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await op();
          // A few statements swallow an I/O error into their result instead
          // of failing (`PRAGMA integrity_check` reports it as corruption):
          // misses left behind by a "successful" statement mean exactly
          // that, so resolve and run it again.
          if (this.vfs.hasMisses() && attempt < MAX_STATEMENT_MISS_RETRIES) {
            await this.vfs.resolveMisses();
            pinned = true;
            this.vfs.missRetries++;
            continue;
          }
          return result;
        } catch (error) {
          if (!this.vfs.hasMisses() || attempt >= MAX_STATEMENT_MISS_RETRIES)
            throw error;
          await this.vfs.resolveMisses();
          pinned = true;
          this.vfs.missRetries++;
        }
      }
    } finally {
      if (pinned) this.vfs.releasePins();
    }
  }

  /**
   * One statement at a time per connection. wa-sqlite's prepare/step/finalize
   * cycle is not re-entrant across interleaved async callers (LangGraph reads
   * a checkpoint while another write is mid-flight) — without this the
   * interleaving surfaces as SQLITE_MISUSE ("bad parameter or other API misuse").
   */
  private async serialized<T>(op: () => Promise<T>): Promise<T> {
    const previous = this.opQueue;
    let release: () => void = () => undefined;
    this.opQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await op();
    } finally {
      release();
    }
  }

  private async execUnlocked<T extends SqlRow = SqlRow>(
    sql: string,
    params?: SqlParams,
  ): Promise<T[]> {
    const { sqlite3 } = this.runtime;
    const db = this.handle();
    const rows: T[] = [];
    const bindings = params === undefined ? undefined : toBindings(params);
    try {
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (bindings !== undefined && sqlite3.bind_parameter_count(stmt) > 0) {
          sqlite3.bind_collection(stmt, bindings);
        }
        let columns: string[] | undefined;
        while ((await sqlite3.step(stmt)) === SQLITE_ROW) {
          columns ??= sqlite3.column_names(stmt);
          rows.push(toRow<T>(columns, sqlite3.row(stmt)));
        }
      }
    } catch (error) {
      throw this.withVfsCause(error);
    }
    this.throwIfFlushFailed();
    return rows;
  }

  private async runUnlocked(
    sql: string,
    params?: SqlParams,
  ): Promise<RunResult> {
    const { sqlite3 } = this.runtime;
    const db = this.handle();
    const bindings = params === undefined ? undefined : toBindings(params);
    try {
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (bindings !== undefined && sqlite3.bind_parameter_count(stmt) > 0) {
          sqlite3.bind_collection(stmt, bindings);
        }
        let rc: number;
        do {
          rc = await sqlite3.step(stmt);
        } while (rc !== SQLITE_DONE);
      }
    } catch (error) {
      throw this.withVfsCause(error);
    }
    this.throwIfFlushFailed();
    return { changes: sqlite3.changes(db) };
  }

  /** First row of `sql`, or undefined. */
  async get<T extends SqlRow = SqlRow>(
    sql: string,
    params?: SqlParams,
  ): Promise<T | undefined> {
    const rows = await this.exec<T>(sql, params);
    return rows[0];
  }

  /**
   * Run `fn` inside a transaction. Top-level transactions hold the
   * connection mutex (see `withMutex()`) from BEGIN to COMMIT/ROLLBACK — a
   * Durable Object is single-threaded but async, and LangGraph issues
   * `put`/`putWrites` concurrently, so two callers awaiting `BEGIN` at the
   * same time would otherwise collide ("cannot start a transaction within a
   * transaction"), and a statement from another chain would join the open
   * transaction. True nesting (a `transaction()` call made *inside* `fn`'s
   * async chain) is detected with AsyncLocalStorage and becomes a
   * SAVEPOINT. Commits when `fn` resolves, rolls back and rethrows when it
   * rejects. The VFS flushes committed pages to storage atomically when
   * SQLite releases the write lock at COMMIT.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.ownFrame()?.inTx === true) return this.savepoint(fn);
    return this.withMutex(async (frame) => {
      // A cold page inside `fn` fails a statement with SQLITE_IOERR; the
      // transaction is rolled back, the segment(s) fetched and pinned, and
      // `fn` re-run from the top (it must be re-runnable: the checkpointer's
      // and stores' callbacks only issue statements). The pins are released
      // to the LRU once the transaction ends either way.
      let pinned = false;
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            return await this.transactionAttempt(frame, fn);
          } catch (error) {
            if (
              !this.vfs.hasMisses() ||
              attempt >= MAX_TRANSACTION_MISS_RETRIES
            )
              throw error;
            await this.vfs.resolveMisses();
            pinned = true;
            this.vfs.missRetries++;
          }
        }
      } finally {
        if (pinned) this.vfs.releasePins();
      }
    });
  }

  /** One BEGIN … COMMIT of `fn`, rolled back when anything in it fails. */
  private async transactionAttempt<T>(
    frame: MutexFrame,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.run('BEGIN IMMEDIATE');
    frame.inTx = true;
    this.txDepth = 1;
    try {
      const result = await fn();
      await this.run('COMMIT');
      // Misses a statement swallowed (see `retryingColdMisses`) must not
      // trigger a retry of some later, unrelated error.
      this.vfs.clearMisses();
      return result;
    } catch (error) {
      // Also after a failed COMMIT: SQLite keeps the transaction open when
      // a deferred constraint fails it. When SQLite already rolled back on
      // its own, this ROLLBACK fails harmlessly.
      try {
        await this.run('ROLLBACK');
      } catch {
        // The original error is more useful than a rollback failure.
      }
      throw error;
    } finally {
      // Only now: until ROLLBACK/COMMIT has run, the transaction is open.
      frame.inTx = false;
      this.txDepth = 0;
    }
  }

  /** A nested `transaction()`: a SAVEPOINT inside the caller's transaction. */
  private async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    const savepoint = `sp_${++this.savepointSeq}`;
    await this.run(`SAVEPOINT ${savepoint}`);
    this.txDepth++;
    try {
      const result = await fn();
      await this.run(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      try {
        await this.run(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        // The original error is more useful than a rollback failure.
      }
      throw error;
    } finally {
      this.txDepth--;
    }
  }

  /**
   * Run `fn` while HOLDING the connection mutex without opening a
   * transaction — for statements SQLite refuses to run inside one
   * (`VACUUM`) and for work no transaction may interleave with. Transactions
   * and statements of other chains queue behind it; statements, nested
   * `withoutTransactions()` and transactions inside `fn` run at once.
   */
  async withoutTransactions<T>(fn: () => Promise<T>): Promise<T> {
    if (this.ownFrame()?.inTx === true) {
      throw new DoVfsError(
        'withoutTransactions() cannot run inside a transaction',
      );
    }
    return this.withMutex(() => fn());
  }

  /**
   * Destroy `fileName` in this object's storage regardless of connection
   * state: force-closes every SQLite connection tracked on the object's VFS,
   * clears its open-file registry, and deletes the pages. For "drop the
   * working copy" flows (owner file deleted upstream, tests) where a leaked
   * handle must not wedge the object forever.
   */
  static async wipe(
    ctx: DoSqliteContext,
    fileName = 'oracle.db',
    options: { tier?: PageTierOptions } = {},
  ): Promise<void> {
    const runtime = await loadSqlite();
    const vfsName = vfsNameForObject(ctx);
    const vfs = getOrRegisterVfs(
      runtime,
      vfsName,
      () => new DoVfs(vfsName, ctx.storage, { tier: options.tier }),
      isDoVfs,
    );
    vfs.configureTier(options.tier);
    for (const handle of vfs.takeConnections()) {
      try {
        await runtime.sqlite3.close(handle);
      } catch (error) {
        console.warn(
          `[sqlite] wipe: failed to close connection ${handle}`,
          error,
        );
      }
    }
    // Re-attach to the same storage: clears the open-file registry so a
    // leaked xOpen handle cannot block the delete.
    vfs.attach(ctx.storage);
    vfs.deleteFile(fileName);
    // The R2 side of the working copy goes with it (nothing references it
    // any more; the owner's file upstream is untouched).
    await vfs.deleteTierObjects();
  }

  // ---------------------------------------------------------------------------
  // R2 page tier controls (see do-vfs.ts / page-tier.ts)
  // ---------------------------------------------------------------------------

  get tierEnabled(): boolean {
    return this.vfs.tierEnabled;
  }

  /**
   * One eviction pass. It holds the connection mutex only for its short
   * synchronous steps (plan, read a segment's rows, commit a segment) and
   * never across R2 I/O, so a turn that starts mid-pass is not held up
   * for the rest of it (see `DoVfs.tierFlush`).
   */
  async tierFlush(
    opts: { force?: boolean; maxSegments?: number } = {},
  ): Promise<TierFlushResult> {
    if (this.ownFrame()?.inTx === true)
      throw new DoVfsError('tierFlush() is not allowed inside a transaction');
    return this.vfs.tierFlush(this.fileName, opts, this.exclusive);
  }

  /** Runs a synchronous VFS step holding the connection mutex. */
  private readonly exclusive: Exclusive = <T>(step: () => T): Promise<T> =>
    this.withoutTransactions(async () => step());

  /** Persist the chunks touched since the last call (call at the end of a turn). */
  recordAccess(): void {
    this.vfs.recordAccess(this.fileName);
  }

  tierStatus(): TierStatus {
    return this.vfs.tierStatus(this.fileName);
  }

  /** Delete queued/orphaned R2 objects. */
  async tierMaintenance(
    opts: { sweep?: boolean } = {},
  ): Promise<{ deleted: number }> {
    return this.vfs.tierMaintenance(opts);
  }

  /** Pull every cold chunk back into storage (the file is then fully hot). */
  async materializeTier(): Promise<{ chunks: number }> {
    if (this.ownFrame()?.inTx === true)
      throw new DoVfsError(
        'materializeTier() is not allowed inside a transaction',
      );
    return this.withoutTransactions(() => this.vfs.materialize(this.fileName));
  }

  /** Close the connection. Buffered pages are flushed by the VFS on close. */
  async close(): Promise<void> {
    if (this.db === null) return;
    const db = this.db;
    this.db = null;
    this.txDepth = 0;
    this.vfs.untrackConnection(db);
    await this.runtime.sqlite3.close(db);
    this.throwIfFlushFailed();
  }

  /** The database file bytes (`SQLite format 3\0`...). Not allowed inside a transaction. */
  async export(): Promise<Uint8Array> {
    if (this.txDepth > 0)
      throw new DoVfsError('export() is not allowed inside a transaction');
    return this.vfs.exportFile(this.fileName);
  }

  /**
   * Replace the database with `bytes` (a SQLite file, e.g. one written by the
   * Node runtime). Closes the connection, swaps the pages in one storage
   * transaction and reopens with the same pragmas.
   */
  async import(bytes: Uint8Array): Promise<void> {
    if (this.txDepth > 0)
      throw new DoVfsError('import() is not allowed inside a transaction');
    const wasOpen = this.db !== null;
    await this.close();
    this.vfs.importFile(this.fileName, bytes);
    if (wasOpen) {
      this.db = await DoSqliteDatabase.openConnection(
        this.runtime,
        this.vfs,
        this.fileName,
        this.pragmas,
      );
    }
  }

  /** Hex SHA-256 of `export()`. */
  async checksum(): Promise<string> {
    if (this.txDepth > 0)
      throw new DoVfsError('checksum() is not allowed inside a transaction');
    return this.vfs.fileChecksum(this.fileName);
  }

  /**
   * Replace the file with a streamed SQLite image (see
   * `DoVfs.importFromStream`). Reopens the connection afterwards.
   */
  async importFromStream(stream: ReadableStream<Uint8Array>): Promise<number> {
    if (this.txDepth > 0)
      throw new DoVfsError(
        'importFromStream() is not allowed inside a transaction',
      );
    const wasOpen = this.db !== null;
    await this.close();
    try {
      return await this.vfs.importFromStream(this.fileName, stream);
    } finally {
      // Reopen whether the import landed or was rejected: the caller keeps
      // using this handle either way (a rejected stream leaves the file as it was).
      if (wasOpen) {
        this.db = await DoSqliteDatabase.openConnection(
          this.runtime,
          this.vfs,
          this.fileName,
          this.pragmas,
        );
      }
    }
  }

  /**
   * A consistent, re-readable view of the file as of now (see
   * `VfsSnapshot`). Waits for an in-flight transaction to finish, pins the
   * content, then releases the transaction lock — later commits proceed
   * while the snapshot is read. The caller MUST `close()` it.
   */
  async snapshot(): Promise<VfsSnapshot> {
    return this.withoutTransactions(async () =>
      this.vfs.openSnapshot(this.fileName),
    );
  }

  /** Flush count that changed the file — see `DoVfs.writeGeneration`. */
  get writeGeneration(): number {
    return this.vfs.writeGeneration(this.fileName);
  }

  /** `PRAGMA freelist_count` / `page_count`: how much of the file is free. */
  async pageUsage(): Promise<{ pageCount: number; freelistCount: number }> {
    const pages = await this.get<{ page_count: number }>('PRAGMA page_count');
    const free = await this.get<{ freelist_count: number }>(
      'PRAGMA freelist_count',
    );
    return {
      pageCount: Number(pages?.page_count ?? 0),
      freelistCount: Number(free?.freelist_count ?? 0),
    };
  }

  /** The connection's `PRAGMA cache_size` (negative = KiB, positive = pages). */
  async cacheSizePragma(): Promise<number> {
    const row = await this.get<{ cache_size: number }>('PRAGMA cache_size');
    return Number(row?.cache_size ?? 0);
  }

  /**
   * Rebuild the file without its free pages at constant memory: `VACUUM INTO`
   * a spill file (its pages go to storage every couple of MiB instead of
   * being held until commit — see the VFS header), then swap it into place
   * in one storage transaction and reopen. Holds the transaction lock for
   * the duration; must not run inside a transaction or while a snapshot of
   * the file is open. Transiently needs 2× the file in DO storage.
   */
  async compact(): Promise<{ beforeBytes: number; afterBytes: number }> {
    if (this.ownFrame()?.inTx === true)
      throw new DoVfsError('compact() is not allowed inside a transaction');
    const target = `${this.fileName}${VACUUM_FILE_SUFFIX}`;
    return this.withoutTransactions(async () => {
      const beforeBytes = this.fileSize;
      if (this.vfs.fileExists(target)) this.vfs.deleteFile(target);
      // VACUUM reads the whole file through the synchronous path; a cold
      // chunk would fail and restart it. Bring everything home first.
      if (this.vfs.tierEnabled) await this.vfs.materialize(this.fileName);
      // `fileName` is a constant of the runtime, never user input.
      await this.run(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      await this.close();
      try {
        this.vfs.renameFile(target, this.fileName);
      } finally {
        this.db = await DoSqliteDatabase.openConnection(
          this.runtime,
          this.vfs,
          this.fileName,
          this.pragmas,
        );
      }
      return { beforeBytes, afterBytes: this.fileSize };
    });
  }

  /** Logical file size in bytes. */
  get fileSize(): number {
    return this.vfs.fileSize(this.fileName) ?? 0;
  }

  vfsStats(): DoVfsStats {
    return this.vfs.getStats();
  }

  /** Bytes of wasm linear memory currently allocated (grows, never shrinks). */
  get wasmHeapBytes(): number {
    return this.runtime.module.HEAPU8.byteLength;
  }

  /**
   * SQLite reports VFS failures as bare "disk I/O error"s; when the VFS
   * recorded the underlying exception, attach it as the error's `cause` and
   * mention it in the message so the real reason is visible.
   */
  private withVfsCause(error: unknown): unknown {
    const cause = this.vfs.lastFlushError;
    if (cause === undefined || !(error instanceof Error)) return error;
    this.vfs.lastFlushError = undefined;
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    const wrapped = new Error(`${error.message} (VFS: ${causeMessage})`, {
      cause,
    });
    wrapped.name = error.name;
    return wrapped;
  }

  private throwIfFlushFailed(): void {
    const error = this.vfs.lastFlushError;
    if (error === undefined) return;
    this.vfs.lastFlushError = undefined;
    throw error instanceof Error ? error : new Error(String(error));
  }
}

// -----------------------------------------------------------------------------
// value conversion
// -----------------------------------------------------------------------------

const INT32_MAX = 0x7fffffff;
const INT32_MIN = -0x80000000;

function toBinding(value: SqlParam): SQLiteCompatibleType | null {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (value > INT32_MAX || value < INT32_MIN)
  ) {
    return BigInt(value);
  }
  return value;
}

function toBindings(
  params: SqlParams,
):
  | Array<SQLiteCompatibleType | null>
  | Record<string, SQLiteCompatibleType | null> {
  if (Array.isArray(params)) {
    return (params as ReadonlyArray<SqlParam>).map(toBinding);
  }
  const out: Record<string, SQLiteCompatibleType | null> = {};
  for (const [key, value] of Object.entries(
    params as Readonly<Record<string, SqlParam>>,
  )) {
    out[key] = toBinding(value);
  }
  return out;
}

function toRow<T extends SqlRow>(
  columns: string[],
  values: Array<SQLiteCompatibleType | null>,
): T {
  const row: SqlRow = {};
  for (let i = 0; i < columns.length; i++) {
    const name = columns[i];
    if (name === undefined) continue;
    const value = values[i];
    row[name] = Array.isArray(value) ? Uint8Array.from(value) : (value ?? null);
  }
  return row as T;
}
