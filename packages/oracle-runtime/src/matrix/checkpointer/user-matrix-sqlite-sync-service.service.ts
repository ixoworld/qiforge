import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';

import { Cron, CronExpression } from '@nestjs/schedule';
import { hours } from '@nestjs/throttler';
import fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { SqliteSaver } from '@ixo/sqlite-saver';
import path from 'path';
import {
  CheckpointIntegrityError,
  type CheckpointBackupStore,
  type CheckpointDownloadResult,
  type CheckpointStoreKind,
  type CheckpointUploadResult,
} from './checkpoint-backup-store.js';
import { MatrixCheckpointStore } from './matrix-checkpoint-store.js';
import {
  fetchMediaUploadSizeLimit,
  type MatrixMediaEvent,
} from './matrix-upload-utils.js';
import { type BaseSyncArgs } from './type.js';
import { getBaseEnvConfig as getConfig } from '../../config/base-env-config.js';
import {
  compactSqliteFileIfBloated,
  snapshotSqliteFile,
} from './sqlite-compaction.js';
import { DEFAULT_MEDIA_UPLOAD_SIZE_LIMIT } from './media-config.js';
import {
  VfsCheckpointStore,
  VFS_UPLOAD_SIZE_LIMIT_BYTES,
} from './vfs-checkpoint-store.js';
import { resolveVfsWorkerUrls } from '../../plugins/vfs/vfs-network.js';
import { VfsAuthError, VfsHttpError } from '../../plugins/vfs/vfs-errors.js';
import type { UcanService } from '../../modules/ucan/ucan.service.js';

/**
 * Returns true if the error is permanent (data genuinely unrecoverable),
 * meaning it's safe to create a fresh DB. All other errors are assumed
 * transient and should propagate to prevent data loss.
 */
function isUnrecoverableDownloadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  // Crypto/decryption failures from Rust NAPI layer (hash mismatch, invalid key, corrupt JSON)
  // These mean the encrypted payload is broken — retrying won't help
  const cryptoPatterns = [
    /decrypt/i,
    /hash/i,
    /mismatch/i,
    /base64/i,
    /serde/i,
    /invalid.*key/i,
    /missing field/i,
  ];

  // Matrix-specific permanent errors
  const matrixPatterns = [
    /M_NOT_FOUND/, // media deleted/redacted from Matrix
    /Event not found/, // event no longer exists
    /not a media event/i, // event type mismatch
    /mxcUrl.*does not begin/i, // malformed content.file.url
    /M_FORBIDDEN/, // access permanently denied
  ];

  return [...cryptoPatterns, ...matrixPatterns].some((p) => p.test(message));
}

/**
 * How long after the VFS store is attached "not ready" still means *pending*
 * rather than *absent*. The oracle's UCAN signing key is loaded from its
 * Matrix account room seconds after Matrix init, which itself runs in the
 * background while HTTP is already listening — so a request can arrive
 * before the key lands. Inside this window a restore that needs VFS waits
 * (transient error, the user retries); past it, the oracle simply has no
 * signing key and VFS is skipped so Matrix-backed users still restore.
 */
const VFS_READINESS_GRACE_MS = 5 * 60_000;

const config = getConfig();

/** Configure a SQLite connection with busy timeout for safe concurrent access */
/** Configure a SQLite connection with pragmas for safe concurrent access on VPS */
function configureSqliteConnection(db: DatabaseType): void {
  // Must run before the first page is allocated, so it has to be the very
  // first pragma on the connection: `auto_vacuum` only binds when SQLite
  // creates page 1, which happens on the first write (here, the sessions
  // table CREATE TABLE that follows). On a brand-new file this sets
  // incremental mode immediately; on an existing file it's inert until a
  // VACUUM rebuilds the file (the cron's bloat-triggered compaction) —
  // never a no-op mistaken for "always safe to call late".
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
}
@Injectable()
export class UserMatrixSqliteSyncService implements OnModuleInit {
  private static instance: UserMatrixSqliteSyncService;

  readonly fileEventsDatabase: DatabaseType;
  private constructor() {
    // check if path exists
    const pathExists = fsSync.existsSync(
      path.join(config.getOrThrow('SQLITE_DATABASE_PATH')),
    );

    if (!pathExists) {
      fsSync.mkdirSync(path.join(config.getOrThrow('SQLITE_DATABASE_PATH')), {
        recursive: true,
      });
    }

    this.fileEventsDatabase = new Database(
      path.join(config.getOrThrow('SQLITE_DATABASE_PATH'), 'file_events.db'),
    );
    configureSqliteConnection(this.fileEventsDatabase);
  }

  private readonly filePathCache = new Map<
    string,
    {
      filePath: string;
      lastAccessedAt: number;
    }
  >();

  private readonly dbConnectionCache = new Map<
    string,
    {
      db: DatabaseType;
      /**
       * Cached checkpoint saver bound to `db`. Populated lazily by
       * `getUserCheckpointer` when `CACHE_CHECKPOINTER_SAVER` is on. Lives on
       * the same entry as `db` so it is dropped automatically wherever the
       * connection is closed/evicted — no separate invalidation path.
       */
      saver?: SqliteSaver;
      lastAccessedAt: number;
    }
  >();

  /** Reference-counted active users — supports nested markUserActive/markUserInactive calls */
  private readonly activeUsers = new Map<string, number>();

  private readonly downloadInProgress = new Map<string, Promise<void>>();
  private readonly recoveryInProgress = new Map<
    string,
    Promise<DatabaseType>
  >();

  private readonly lastUploadedChecksum = new Map<string, string>();

  /**
   * Live-file checksums whose compressed snapshot exceeded the homeserver
   * upload cap. Skips re-snapshotting an unchanged doomed file every cron
   * tick; cleared on the next successful upload or file change.
   */
  private readonly oversizedChecksum = new Map<string, string>();

  private uploadSizeLimit: number | undefined;

  /**
   * Users whose SQLite checkpoint has been synced from Matrix at least once
   * in this process lifetime. We're a single-node deployment: after the
   * first sync, the local copy IS the source of truth until shutdown (which
   * uploads back to Matrix). Skipping re-syncs on subsequent requests for
   * the same user is the dominant TTFB win.
   */
  private readonly syncedUsers = new Set<string>();

  /** Prevents overlapping cron executions from interleaving I/O on the same files */
  private cronRunning = false;

  private readonly matrixStore = new MatrixCheckpointStore((key) =>
    this.cachedMediaEvent(key),
  );

  private vfsStore: VfsCheckpointStore | undefined;

  /**
   * The attached UcanService (narrowed to the one method readiness needs),
   * kept so readiness (`vfsReady`) can be re-checked at USE time rather than
   * once at attach time — the signing mnemonic lands well after boot
   * (post-Matrix-init), so `vfsStore` must be built unconditionally and
   * gated per-call instead. Narrowed (rather than `UcanService`) so the
   * test-only `attachBackupStoresForTests` setter can supply a plain object
   * without a cast — `UcanService`'s private fields make it otherwise
   * unconstructible outside the class.
   */
  private ucan: Pick<UcanService, 'hasSigningKey'> | undefined;

  /** When the VFS store was attached — the clock `vfsPending()` measures. */
  private vfsAttachedAt = 0;

  /** Which store holds a storage key's backup, plus the VFS file id once cut over. */
  private readonly backupLocation = new Map<
    string,
    { store: CheckpointStoreKind; vfsFileId?: string }
  >();

  /**
   * Enables VFS backups. Called by the Nest module factory: the service is a
   * singleton, so the DI-provided UcanService is attached rather than
   * injected. Builds `vfsStore` unconditionally — the oracle's UCAN signing
   * mnemonic is only set later (after Matrix init completes), so gating
   * construction on `hasSigningKey()` here would leave `vfsStore` permanently
   * `undefined`. Readiness is instead checked per-call via `vfsReady()`;
   * `available()` (backed by `getServiceDelegation` →
   * `mintSelfSignedInvocation`) already returns `false` without a signing
   * key, so no cutover can happen before the key lands.
   */
  attachUcanService(
    ucan: UcanService,
    opts: { fetchImpl?: typeof fetch } = {},
  ): void {
    if (!ucan) {
      Logger.warn(
        'VFS checkpoint backups disabled — no UcanService was provided',
      );
      return;
    }
    this.ucan = ucan;
    this.vfsAttachedAt = Date.now();
    this.vfsStore = new VfsCheckpointStore({
      minter: ucan,
      urls: resolveVfsWorkerUrls(config.get('NETWORK')),
      oracleEntityDid: config.getOrThrow('ORACLE_ENTITY_DID'),
      knownFileId: (storageKey) =>
        this.backupLocation.get(storageKey)?.vfsFileId,
      fetchImpl: opts.fetchImpl,
    });
  }

  /** Whether the oracle's UCAN signing key has landed yet (set post-Matrix-init). */
  private vfsReady(): boolean {
    return this.ucan?.hasSigningKey() === true;
  }

  /**
   * A VFS store is attached but its signing key hasn't landed *yet* — the
   * boot window, where "not ready" is a wait, not an answer. Callers that
   * would otherwise conclude "no backup" must fail transiently instead.
   */
  private vfsPending(): boolean {
    return (
      !!this.vfsStore &&
      !this.vfsReady() &&
      Date.now() - this.vfsAttachedAt < VFS_READINESS_GRACE_MS
    );
  }

  /**
   * Test-only seam: sets the VFS backup store directly. `attachUcanService`
   * needs a live `UcanService` instance (a class with private fields backed
   * by several NestJS-injected dependencies), which a unit test cannot
   * construct without a cast — this bypasses that requirement.
   * `ready` (default `true`) backs `vfsReady()`, simulating whether the
   * oracle's signing key has landed yet.
   */
  attachBackupStoresForTests(stores: {
    vfs: VfsCheckpointStore;
    ready?: boolean;
  }): void {
    this.vfsStore = stores.vfs;
    this.vfsAttachedAt = Date.now();
    this.ucan = { hasSigningKey: () => stores.ready ?? true };
  }

  public markUserActive(userDid: string): void {
    const count = this.activeUsers.get(userDid) ?? 0;
    this.activeUsers.set(userDid, count + 1);
  }

  public markUserInactive(userDid: string): void {
    const count = this.activeUsers.get(userDid) ?? 0;
    if (count <= 1) {
      this.activeUsers.delete(userDid);
    } else {
      this.activeUsers.set(userDid, count - 1);
    }
  }

  private isUserActive(userDid: string): boolean {
    return (this.activeUsers.get(userDid) ?? 0) > 0;
  }
  static createUserStorageKey(userDid: string): string {
    const key = `checkpoint_${userDid}_${config.getOrThrow('ORACLE_DID')}`;
    return createHash('sha256').update(key).digest('hex').substring(0, 17);
  }

  static getUserCheckpointDbPath(userDid: string): string {
    const dbPath = path.join(
      UserMatrixSqliteSyncService.checkpointsFolder,
      userDid,
      `${UserMatrixSqliteSyncService.createUserStorageKey(userDid)}.db`,
    );
    return dbPath;
  }

  static checkpointsFolder = path.join(
    config.getOrThrow('SQLITE_DATABASE_PATH'),
    'user_dbs',
  );

  public async onModuleInit(): Promise<void> {
    // create checkpoints folder if it doesn't exist
    const exists = await fs
      .access(UserMatrixSqliteSyncService.checkpointsFolder)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      Logger.debug(
        `Creating checkpoints folder at ${UserMatrixSqliteSyncService.checkpointsFolder}`,
      );
      await fs.mkdir(UserMatrixSqliteSyncService.checkpointsFolder, {
        recursive: true,
      });
    }

    this.fileEventsDatabase
      .prepare(
        'CREATE TABLE IF NOT EXISTS file_events (storage_key TEXT PRIMARY KEY, event_id TEXT, event TEXT)',
      )
      .run();

    // Add content_checksum column if it doesn't exist (backward-compatible migration)
    try {
      this.fileEventsDatabase
        .prepare('ALTER TABLE file_events ADD COLUMN content_checksum TEXT')
        .run();
    } catch {
      // Column already exists, ignore
    }

    // Backward-compatible migration: which store holds a storage key's
    // backup, plus the VFS file id / cid once cut over. Same pattern as
    // content_checksum above — each ALTER in its own try/catch.
    try {
      this.fileEventsDatabase
        .prepare(
          "ALTER TABLE file_events ADD COLUMN store TEXT DEFAULT 'matrix'",
        )
        .run();
    } catch {
      // Column already exists, ignore
    }
    try {
      this.fileEventsDatabase
        .prepare('ALTER TABLE file_events ADD COLUMN vfs_file_id TEXT')
        .run();
    } catch {
      // Column already exists, ignore
    }
    try {
      this.fileEventsDatabase
        .prepare('ALTER TABLE file_events ADD COLUMN vfs_cid TEXT')
        .run();
    } catch {
      // Column already exists, ignore
    }

    // Populate in-memory checksum + backup-location caches from DB
    const rows = this.fileEventsDatabase
      .prepare<
        [],
        {
          storage_key: string;
          content_checksum: string | null;
          store: string | null;
          vfs_file_id: string | null;
        }
      >(
        'SELECT storage_key, content_checksum, store, vfs_file_id FROM file_events',
      )
      .all();
    for (const row of rows) {
      if (row.content_checksum) {
        this.lastUploadedChecksum.set(row.storage_key, row.content_checksum);
      }
      // `store` is NULL on rows written before this migration — treat as 'matrix'.
      this.backupLocation.set(row.storage_key, {
        store: row.store === 'vfs' ? 'vfs' : 'matrix',
        vfsFileId: row.vfs_file_id ?? undefined,
      });
    }

    // Seed filePathCache from disk so the upload cron can find checkpoint
    // files that survived a restart (hybrid approach: scan once on startup,
    // then use the cache for subsequent cron ticks).
    try {
      const userFolders = await fs.readdir(
        UserMatrixSqliteSyncService.checkpointsFolder,
      );
      for (const userDid of userFolders) {
        const dbPath =
          UserMatrixSqliteSyncService.getUserCheckpointDbPath(userDid);
        const fileExists = await fs
          .access(dbPath)
          .then(() => true)
          .catch(() => false);
        if (fileExists) {
          this.filePathCache.set(userDid, {
            filePath: dbPath,
            lastAccessedAt: Date.now(),
          });
        }
      }
      if (this.filePathCache.size > 0) {
        Logger.log(
          `Seeded filePathCache with ${this.filePathCache.size} existing checkpoint(s) from disk`,
        );
      }
    } catch {
      // Checkpoints folder might be empty or inaccessible on first run
    }
  }

  /**
   * Get or create database connection for a user.
   * Ensures database exists and is synced from Matrix on the first request
   * per user per process; subsequent calls reuse the local file.
   * Includes automatic corruption recovery.
   */
  public async getUserDatabase(userDid: string): Promise<DatabaseType> {
    if (!this.syncedUsers.has(userDid)) {
      await this.syncLocalStorageFromMatrixStorage({ userDid });
      this.syncedUsers.add(userDid);
    }

    return this.openUserDatabaseFromDisk(userDid);
  }

  /**
   * Same as `getUserDatabase` but never triggers a Matrix → SQLite sync.
   * Used by hot paths that follow an earlier `getUserDatabase` call within
   * the same request (e.g. the fire-and-forget post-message sync).
   */
  public async getUserDatabaseNoSync(userDid: string): Promise<DatabaseType> {
    return this.openUserDatabaseFromDisk(userDid);
  }

  /**
   * Return a checkpoint saver for a user, syncing from Matrix on the first
   * request this process (same contract as `getUserDatabase`).
   *
   * The saver is reused across calls for the same connection, so its one-time
   * `setup()` (schema + prepared statements) runs once per connection instead
   * of once per call — the agent build calls this hook twice per turn.
   */
  public async getUserCheckpointer(userDid: string): Promise<SqliteSaver> {
    const db = await this.getUserDatabase(userDid);
    return this.resolveSaver(userDid, db);
  }

  /**
   * Same as `getUserCheckpointer` but never triggers a Matrix → SQLite sync —
   * for hot paths following an earlier `getUserCheckpointer`/`getUserDatabase`
   * call in the same request.
   */
  public async getUserCheckpointerNoSync(
    userDid: string,
  ): Promise<SqliteSaver> {
    const db = await this.getUserDatabaseNoSync(userDid);
    return this.resolveSaver(userDid, db);
  }

  private resolveSaver(userDid: string, db: DatabaseType): SqliteSaver {
    // `openUserDatabaseFromDisk` always caches the connection, so the entry
    // exists and its `db` is the one we were handed. Guard on identity so a
    // reopened connection never reuses a saver bound to a closed handle.
    const entry = this.dbConnectionCache.get(userDid);
    if (entry && entry.db === db) {
      if (!entry.saver) {
        entry.saver = SqliteSaver.fromDatabase(db);
      }
      return entry.saver;
    }
    return SqliteSaver.fromDatabase(db);
  }

  private async openUserDatabaseFromDisk(
    userDid: string,
  ): Promise<DatabaseType> {
    const dbPath = UserMatrixSqliteSyncService.getUserCheckpointDbPath(userDid);

    // Check cache
    const cached = this.dbConnectionCache.get(userDid);
    if (cached) {
      cached.lastAccessedAt = Date.now();
      return cached.db;
    }

    // Open and validate — recover from corruption if needed
    let db = this.openAndValidateDatabase(dbPath, userDid);
    if (!db) {
      // Deduplicate concurrent recovery attempts for the same user
      const existingRecovery = this.recoveryInProgress.get(userDid);
      if (existingRecovery) {
        // Wait for the in-flight recovery but don't skip init/caching below
        db = await existingRecovery;
      } else {
        const recoveryPromise = this.recoverCorruptDatabase(userDid, dbPath);
        this.recoveryInProgress.set(userDid, recoveryPromise);
        try {
          db = await recoveryPromise;
        } finally {
          this.recoveryInProgress.delete(userDid);
        }
      }
    }

    // Initialize sessions and calls tables if needed
    try {
      this.initializeSessionsAndCallsTables(db);
    } catch (error) {
      // Prevent leaked DB handle if table init fails
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
      throw error;
    }

    // Cache it
    this.dbConnectionCache.set(userDid, {
      db,
      lastAccessedAt: Date.now(),
    });

    return db;
  }

  /**
   * Attempts cascading recovery when a local database is corrupt:
   *   1. Clear local → re-download from Matrix → validate
   *   2. If Matrix copy also corrupt → delete from Matrix → create fresh empty DB
   */
  private async recoverCorruptDatabase(
    userDid: string,
    dbPath: string,
  ): Promise<DatabaseType> {
    Logger.error(
      `[CORRUPTION DETECTED] Local SQLite database is corrupt for user ${userDid} at ${dbPath}. Attempting recovery from Matrix backup...`,
    );

    // Clear local corrupt file and re-download from Matrix
    await this.clearLocalCheckpoint(userDid, dbPath);
    await this.syncLocalStorageFromMatrixStorage({ userDid });

    // Check if Matrix had a backup
    const fileExists = await fs
      .access(dbPath)
      .then(() => true)
      .catch(() => false);

    if (fileExists) {
      const db = this.openAndValidateDatabase(dbPath, userDid);
      if (db) return db;

      // Matrix copy is also corrupt
      Logger.error(
        `[CORRUPTION DETECTED] Matrix backup is ALSO corrupt for user ${userDid}. Deleting corrupt backup and starting fresh. User will lose session history.`,
      );
      await this.clearLocalCheckpoint(userDid, dbPath);
      try {
        await this.deleteUserBackup(userDid);
        Logger.warn(
          `Deleted corrupt Matrix backup for user ${userDid}. Corruption loop broken.`,
        );
      } catch (deleteError) {
        Logger.error(
          `Failed to delete corrupt Matrix backup for user ${userDid}: ${deleteError}`,
        );
      }
    }

    // Create a brand new empty database
    Logger.warn(
      `Creating fresh database for user ${userDid} after corruption recovery. All previous sessions are lost.`,
    );
    const dir = path.dirname(dbPath);
    await fs.mkdir(dir, { recursive: true });
    const db = new Database(dbPath);
    configureSqliteConnection(db);

    // Ensure the fresh DB is tracked so the upload cron (which iterates
    // filePathCache.keys()) will back it up to Matrix.
    this.filePathCache.set(userDid, {
      filePath: dbPath,
      lastAccessedAt: Date.now(),
    });

    return db;
  }

  /**
   * Opens a SQLite database and validates it is not corrupt.
   * Returns the Database instance if valid, or null if corrupt/missing.
   */
  private openAndValidateDatabase(
    dbPath: string,
    userDid: string,
  ): DatabaseType | null {
    try {
      if (!fsSync.existsSync(dbPath)) {
        return null;
      }

      const db = new Database(dbPath);
      configureSqliteConnection(db);

      // Run integrity check — returns 'ok' if database is healthy
      const result = db.pragma('integrity_check') as Array<{
        integrity_check: string;
      }>;
      const isOk = result.length === 1 && result[0]?.integrity_check === 'ok';

      if (!isOk) {
        const details = result.map((r) => r.integrity_check).join('; ');
        Logger.error(
          `[CORRUPTION DETECTED] PRAGMA integrity_check failed for user ${userDid}: ${details}`,
        );
        try {
          db.close();
        } catch {
          // Ignore close errors on corrupt DB
        }
        return null;
      }

      return db;
    } catch (error) {
      Logger.error(
        `[CORRUPTION DETECTED] Failed to open SQLite database for user ${userDid} at ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Deletes local checkpoint file and clears all associated caches for a user.
   */
  private async clearLocalCheckpoint(
    userDid: string,
    dbPath: string,
  ): Promise<void> {
    // Close cached connection if exists
    const cached = this.dbConnectionCache.get(userDid);
    if (cached) {
      try {
        cached.db.close();
      } catch {
        // Ignore close errors
      }
      this.dbConnectionCache.delete(userDid);
    }

    // Clear file path cache, checksum cache, AND the "synced-once" flag.
    // Dropping `syncedUsers` here is critical: without it, the next
    // `getUserDatabase` call after the local file is deleted would skip the
    // Matrix → SQLite re-download (because we'd think we're still synced),
    // landing in the corruption-recovery path instead of a clean sync.
    this.syncedUsers.delete(userDid);
    this.filePathCache.delete(userDid);
    const storageKey =
      UserMatrixSqliteSyncService.createUserStorageKey(userDid);
    try {
      this.fileEventsDatabase
        .prepare(
          'UPDATE file_events SET content_checksum = NULL WHERE storage_key = ?',
        )
        .run(storageKey);
      // Clear in-memory cache AFTER successful DB update to keep them consistent
      this.lastUploadedChecksum.delete(storageKey);
    } catch (error) {
      // Still clear in-memory cache on DB failure — worst case is a redundant upload
      this.lastUploadedChecksum.delete(storageKey);
      Logger.warn(
        `Failed to clear content_checksum for ${storageKey}: ${error instanceof Error ? error.message : error}`,
      );
    }

    // Delete local file + temp files + leftover WAL/SHM/journal files
    for (const suffix of [
      '',
      '.tmp',
      '.raw.tmp',
      '.gz.tmp',
      '.snapshot.tmp',
      '-wal',
      '-shm',
      '-journal',
    ]) {
      try {
        await fs.unlink(dbPath + suffix);
      } catch {
        // File may not exist, that's fine
      }
    }
  }
  private initializeSessionsAndCallsTables(db: DatabaseType): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        title TEXT,
        last_updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        oracle_name TEXT NOT NULL,
        oracle_did TEXT NOT NULL,
        oracle_entity_did TEXT NOT NULL,
        last_processed_count INTEGER,
        user_context TEXT,
        room_id TEXT,
        slack_thread_ts TEXT
      );

      CREATE TABLE IF NOT EXISTS calls (
        call_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(last_updated_at);
      CREATE INDEX IF NOT EXISTS idx_calls_session ON calls(session_id);
    `);
  }

  @Cron(CronExpression.EVERY_HOUR)
  public async localStorageCacheCleanUpTask(): Promise<void> {
    if (this.cronRunning) {
      Logger.debug(
        'Skipping hourly cleanup — another cron task is still running',
      );
      return;
    }
    this.cronRunning = true;
    try {
      const now = Date.now();

      // Close idle database connections
      for (const [
        userDid,
        { db, lastAccessedAt },
      ] of this.dbConnectionCache.entries()) {
        if (this.isUserActive(userDid)) {
          Logger.debug(`Skipping DB cleanup for active user ${userDid}`);
          continue;
        }
        if (now - lastAccessedAt > hours(1)) {
          try {
            // Sync to Matrix before closing. The connection is closed
            // regardless of the returned status — even a 'skipped' upload
            // (oversized file, etc.) still means no request holds the file,
            // so closing the idle connection is safe either way. Only the
            // file-cache loop below treats the status as a delete guard.
            const status = await this.uploadCheckpointToMatrixStorage({
              userDid,
            });
            // Close connection (db is already from the loop iteration)
            db.close();
            this.dbConnectionCache.delete(userDid);
            Logger.log(
              `Closed idle database connection for user ${userDid} (backup: ${status})`,
            );
          } catch (error) {
            Logger.error(
              `Failed to cleanup DB connection for user ${userDid}`,
              error,
            );
          }
        }
      }

      // Clean up file cache
      for (const [
        userDid,
        { lastAccessedAt },
      ] of this.filePathCache.entries()) {
        if (this.isUserActive(userDid)) {
          Logger.debug(
            `Skipping file cache cleanup for active user ${userDid}`,
          );
          continue;
        }
        if (now - lastAccessedAt > hours(1)) {
          let status: 'uploaded' | 'unchanged' | 'skipped';
          try {
            status = await this.uploadCheckpointToMatrixStorage({ userDid });
          } catch (error) {
            Logger.error(
              `Failed to sync checkpoint file to matrix storage for user ${userDid}`,
              error,
            );
            // failed to sync, continue to next user so we can retry next hour
            continue;
          }

          if (status === 'skipped') {
            // A 'skipped' upload means the local file is NOT known to be
            // backed up (missing file aside — the earlier existence check
            // already filtered those out of filePathCache). Deleting the
            // local folder here would destroy the user's only current data
            // (e.g. an oversized checkpoint that can never reach Matrix).
            Logger.warn(
              `Local checkpoint kept for user ${userDid} — backup not current (upload was skipped), refusing to delete local data`,
            );
            continue;
          }

          // sync successful (uploaded or unchanged), delete local cache
          const userFolder = path.join(
            UserMatrixSqliteSyncService.checkpointsFolder,
            userDid,
          );
          const storageKey =
            UserMatrixSqliteSyncService.createUserStorageKey(userDid);
          try {
            await fs.rm(userFolder, { recursive: true });
            Logger.log(
              `Deleted Local Storage checkpoint folder for user ${userDid} and path ${userFolder}`,
            );
          } catch (error) {
            Logger.error(
              `Failed to delete local checkpoint folder for user ${userDid}: ${error instanceof Error ? error.message : error}`,
            );
          }
          // Always clear caches regardless of fs.rm result — stale cache
          // entries are worse than missing ones (next access re-downloads).
          // `syncedUsers` is cleared here for the same reason: the local
          // file is gone, the next request must re-pull from Matrix.
          this.syncedUsers.delete(userDid);
          this.filePathCache.delete(userDid);
          this.lastUploadedChecksum.delete(storageKey);
        }
      }
    } finally {
      this.cronRunning = false;
    }
  }

  /**
   * Get the singleton instance of UserMatrixSqliteSyncService
   * @param maxCacheSize - Maximum number of cached files (default: 100)
   * @returns The singleton instance
   */
  public static getInstance(): UserMatrixSqliteSyncService {
    if (!UserMatrixSqliteSyncService.instance) {
      UserMatrixSqliteSyncService.instance = new UserMatrixSqliteSyncService();
    }
    return UserMatrixSqliteSyncService.instance;
  }

  private async getUploadSizeLimit(): Promise<number> {
    if (this.uploadSizeLimit !== undefined) {
      return this.uploadSizeLimit;
    }

    const fetched = await fetchMediaUploadSizeLimit();
    if (fetched === undefined) {
      // Do NOT cache the fallback: only a successful discovery is memoized.
      // If both config endpoints are unreachable now, a later tick retries
      // discovery instead of being stuck on the 100 MiB default for the
      // rest of the process lifetime.
      Logger.warn(
        `Could not read the homeserver media config — assuming an upload limit of ${bytesToHumanReadable(DEFAULT_MEDIA_UPLOAD_SIZE_LIMIT)}`,
      );
      return DEFAULT_MEDIA_UPLOAD_SIZE_LIMIT;
    }

    this.uploadSizeLimit = fetched;
    return this.uploadSizeLimit;
  }

  /**
   * Load the checkpoint SQLite file for a user.
   * First checks the local cache, then matrix storage if not cached.
   * @param userDid - The user's DID identifier
   * @returns Promise resolving to the SQLite file buffer
   */
  public async syncLocalStorageFromMatrixStorage(
    params: BaseSyncArgs,
  ): Promise<void> {
    const { userDid } = params;

    // If a download is already in progress for this user, await it instead of starting another
    const existingDownload = this.downloadInProgress.get(userDid);
    if (existingDownload) {
      Logger.debug(
        `Download already in progress for user ${userDid}, awaiting existing download`,
      );
      return existingDownload;
    }

    const downloadPromise = this._syncLocalStorageFromBackup(userDid);
    this.downloadInProgress.set(userDid, downloadPromise);

    try {
      await downloadPromise;
    } finally {
      this.downloadInProgress.delete(userDid);
    }
  }

  /**
   * Cached Matrix media event for a storage key, read from `file_events` so
   * a re-download can skip the room lookup entirely. Returns `undefined` on
   * any read failure (corrupt/locked file_events.db, no cached row, or a
   * cached payload that fails to parse) — callers fall back to a full room
   * lookup either way.
   */
  private cachedMediaEvent(storageKey: string): MatrixMediaEvent | undefined {
    try {
      const cachedEventText = this.fileEventsDatabase
        .prepare<
          [string],
          { event: string }
        >('SELECT event FROM file_events WHERE storage_key = ?')
        .get(storageKey);
      return cachedEventText
        ? (JSON.parse(cachedEventText.event) as MatrixMediaEvent)
        : undefined;
    } catch (cacheError) {
      // file_events.db corrupt or locked — skip cache, fall through to direct Matrix lookup
      Logger.warn(
        `Failed to read cached event for storageKey ${storageKey}, falling through to Matrix lookup: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`,
      );
      return undefined;
    }
  }

  private async _syncLocalStorageFromBackup(userDid: string): Promise<void> {
    const storageKey =
      UserMatrixSqliteSyncService.createUserStorageKey(userDid);
    const checkpointPath =
      UserMatrixSqliteSyncService.getUserCheckpointDbPath(userDid);

    Logger.debug(
      `Syncing checkpoint for user ${userDid}, storageKey: ${storageKey}, path: ${checkpointPath}`,
    );

    // Ensure the user's checkpoint directory exists
    const userCheckpointDir = path.dirname(checkpointPath);
    const dirExists = await fs
      .access(userCheckpointDir)
      .then(() => true)
      .catch(() => false);

    if (!dirExists) {
      Logger.debug(
        `Creating checkpoint directory for user ${userDid}: ${userCheckpointDir}`,
      );
      await fs.mkdir(userCheckpointDir, { recursive: true });
    }

    // check if file exists
    const exists = await fs
      .access(checkpointPath)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      Logger.debug(
        `Checkpoint file already exists locally for user ${userDid} at ${checkpointPath}`,
      );
      this.filePathCache.set(userDid, {
        filePath: checkpointPath,
        lastAccessedAt: Date.now(),
      });
      return;
    }

    Logger.debug(
      `Checkpoint file not found locally for user ${userDid}, attempting to download from backup`,
    );

    // Store selection follows `file_events.store`, as three explicit
    // branches (not a candidate loop): a 'vfs' row tries VFS only and any
    // VFS error propagates as transient — a vfs-row user must NEVER
    // silently fall through to "no backup found" (that would create an
    // empty DB and the next cron tick would overwrite the real backup). A
    // 'matrix' row tries Matrix only, unchanged. No row (fresh
    // file_events.db) probes VFS first (the newer copy may live there) —
    // but a probe failure must not block a perfectly good Matrix restore,
    // since the row doesn't pin a store yet, so it's caught and only
    // warned before falling through to Matrix. Skipping that probe is only
    // safe once the signing key is known to be absent rather than pending
    // (`vfsPending`), which is what makes the fresh-pod case safe.
    const location = this.backupLocation.get(storageKey);
    let download: CheckpointDownloadResult | null = null;
    let source: CheckpointBackupStore | undefined;
    try {
      if (location?.store === 'vfs') {
        if (!this.vfsStore || !this.vfsReady()) {
          throw new Error(
            'VFS backup store not ready — cannot restore checkpoint yet',
          );
        }
        download = await this.vfsStore.download({ userDid, storageKey });
        if (download) source = this.vfsStore;
      } else if (location?.store === 'matrix') {
        download = await this.matrixStore.download({ userDid, storageKey });
        if (download) source = this.matrixStore;
      } else {
        if (this.vfsStore && this.vfsReady()) {
          try {
            download = await this.vfsStore.download({ userDid, storageKey });
            if (download) source = this.vfsStore;
          } catch (error) {
            // Expected for every user who hasn't deposited a delegation —
            // the overwhelming majority today — so it's debug, not a warn.
            if (
              error instanceof VfsAuthError &&
              error.kind === 'no-delegation'
            ) {
              Logger.debug(
                `No VFS delegation for user ${userDid}, restoring from Matrix`,
              );
            } else {
              Logger.warn(
                `VFS probe failed for user ${userDid}, falling back to Matrix: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        } else if (this.vfsPending()) {
          // The key is still landing. Probing Matrix now and finding nothing
          // (a cut-over user's Matrix copy is redacted) would look like "no
          // backup" and start a fresh DB that the next cron tick pushes over
          // the real one. Fail transiently — the retry lands after the key.
          throw new Error('VFS backup store not ready — retry shortly');
        } else if (this.vfsStore) {
          Logger.error(
            `VFS backup store has had no UCAN signing key for over ${VFS_READINESS_GRACE_MS / 60_000} minutes — restoring user ${userDid} from Matrix only. Check that the oracle's signing mnemonic loaded from its Matrix account room.`,
          );
        }
        if (!download) {
          download = await this.matrixStore.download({ userDid, storageKey });
          if (download) source = this.matrixStore;
        }
      }
    } catch (error) {
      // VFS has a typed error contract (VfsHttpError / VfsAuthError), and an
      // integrity failure is typed too — none of them need the Matrix/crypto
      // message-regex heuristic below, which would otherwise misclassify an
      // operational VFS error (a worker message that happens to contain
      // "hash") or a sha256 mismatch as "safe to start fresh".
      if (
        error instanceof VfsHttpError ||
        error instanceof VfsAuthError ||
        error instanceof CheckpointIntegrityError
      ) {
        throw error;
      }
      if (isUnrecoverableDownloadError(error)) {
        // Permanent failure — data genuinely unrecoverable, safe to start fresh
        Logger.warn(
          `Unrecoverable download failure for user ${userDid}, will start with fresh database: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      // Transient/unknown error — let it propagate so the request fails with 500
      // and the user retries later. This prevents creating an empty DB that would
      // overwrite the good backup on the next upload cron cycle (and means a
      // revoked VFS delegation, or a not-yet-ready VFS store for a vfs-row
      // user, never triggers a fresh-DB overwrite either).
      throw error;
    }

    if (!download || !source) {
      Logger.debug(
        `No checkpoint found in any backup store for user ${userDid} with storageKey ${storageKey}, this is expected for new users`,
      );
      return;
    }

    Logger.log(
      `Checkpoint for user ${userDid} found in ${source.kind === 'vfs' ? 'VFS' : 'Matrix'}`,
    );

    // Decompress the checkpoint. Streamed end-to-end so the only bytes ever
    // buffered in heap are individual chunks — the decompressed DB can run
    // to hundreds of MB and used to be held in memory here in its entirety.
    const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
    const tmpPath = checkpointPath + '.tmp';
    const rawTmpPath = checkpointPath + '.raw.tmp';
    try {
      try {
        // Tee the raw download stream through a hasher while writing it to
        // disk, so the store-reported content hash (currently only VFS sends
        // one) can be verified without a second read of the file.
        const downloadHasher = createHash('sha256');
        const hashingTee = new Transform({
          transform(chunk, _encoding, callback) {
            downloadHasher.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          download.stream,
          hashingTee,
          fsSync.createWriteStream(rawTmpPath),
        );
        const { size: rawSize } = await fs.stat(rawTmpPath);

        if (download.contentHash) {
          const computedHash = downloadHasher.digest('hex');
          if (computedHash !== download.contentHash) {
            // Transient, never "no backup": the bytes broke in flight but the
            // store's copy is intact and re-fetchable, so the next request
            // retries. Returning here would create a fresh empty DB that the
            // next upload cycle writes over the good backup.
            await removeIfExists(tmpPath);
            await removeIfExists(rawTmpPath);
            throw new CheckpointIntegrityError(
              `Downloaded checkpoint for user ${userDid} from ${source.kind} failed hash verification (expected ${download.contentHash}, computed ${computedHash})`,
            );
          }
        }

        try {
          await pipeline(
            fsSync.createReadStream(rawTmpPath),
            createGunzip(),
            fsSync.createWriteStream(tmpPath),
          );
        } catch (_error) {
          // Decompression failed — check if the raw payload is a valid uncompressed SQLite file
          const rawHeader = await readFileHeader(rawTmpPath, 16);
          if (rawHeader.length >= 16 && rawHeader.equals(SQLITE_MAGIC)) {
            Logger.warn(
              `Checkpoint for user ${userDid} is uncompressed SQLite (legacy format), using as-is`,
            );
            await fs.rename(rawTmpPath, tmpPath);
          } else {
            Logger.error(
              `Checkpoint for user ${userDid} is neither valid gzip nor valid SQLite — skipping download to prevent corruption. Raw bytes (first 16): ${rawHeader.toString('hex')}`,
            );
            await removeIfExists(tmpPath);
            return;
          }
        }

        // Validate the on-disk result is a valid SQLite file
        const header = await readFileHeader(tmpPath, 16);
        if (header.length < 16 || !header.equals(SQLITE_MAGIC)) {
          Logger.error(
            `Decompressed checkpoint for user ${userDid} does not have valid SQLite header — skipping to prevent corruption. Header bytes: ${header.toString('hex')}`,
          );
          await removeIfExists(tmpPath);
          return;
        }

        const { size: decompressedSize } = await fs.stat(tmpPath);
        Logger.log(
          `Decompressed checkpoint for user ${userDid}: ${bytesToHumanReadable(rawSize)} -> ${bytesToHumanReadable(decompressedSize)}`,
        );

        Logger.debug(
          `Saving checkpoint to local cache for user ${userDid} at ${checkpointPath}`,
        );

        // Atomic publish: rename is atomic on POSIX
        await fs.rename(tmpPath, checkpointPath);
      } catch (error) {
        // Clean up orphaned temp file on failure
        await removeIfExists(tmpPath);
        throw error;
      }
    } finally {
      await removeIfExists(rawTmpPath);
    }

    // Update cache AFTER file is successfully written to disk
    this.filePathCache.set(userDid, {
      filePath: checkpointPath,
      lastAccessedAt: Date.now(),
    });

    Logger.debug(
      `Successfully saved checkpoint for user ${userDid} at ${checkpointPath}`,
    );
    return;
  }

  /**
   * VFS once a user is cut over (never back), VFS for new cutovers when the
   * feature is on, the oracle's signing key has landed (`vfsReady()`), and
   * the user's delegation exists, Matrix otherwise.
   *
   * Returns the sentinel `'skip-no-vfs-store'` — rather than silently
   * falling back to Matrix — when a user already cut over to VFS but this
   * process has no VFS store attached, or the store exists but the signing
   * key hasn't landed yet (a normal window right after boot, before Matrix
   * init completes). A `'vfs'`-store user must never fall back to Matrix.
   */
  private async resolveUploadStore(
    userDid: string,
    storageKey: string,
  ): Promise<CheckpointBackupStore | 'skip-no-vfs-store'> {
    const location = this.backupLocation.get(storageKey);
    if (location?.store === 'vfs') {
      if (!this.vfsStore || !this.vfsReady()) {
        return 'skip-no-vfs-store';
      }
      return this.vfsStore;
    }
    if (
      this.vfsStore &&
      this.vfsReady() &&
      config.get('CHECKPOINT_VFS_BACKUP_ENABLED') &&
      (await this.vfsStore.available(userDid))
    ) {
      return this.vfsStore;
    }
    return this.matrixStore;
  }

  /**
   * Sync checkpoint file from local cache to Matrix storage.
   * @param userDid - The user's DID identifier
   * @returns `'uploaded'` when a new snapshot was pushed to Matrix,
   *   `'unchanged'` when the checkpoint was already backed up (checksum
   *   match), or `'skipped'` when no upload was attempted at all (no local
   *   file, an in-flight request holds the file, or the snapshot exceeds the
   *   homeserver upload cap). Callers must treat `'skipped'` as "the local
   *   file is not necessarily backed up" — it is not safe to delete local
   *   state on that result.
   */
  async uploadCheckpointToMatrixStorage(
    params: BaseSyncArgs,
  ): Promise<'uploaded' | 'unchanged' | 'skipped'> {
    const { userDid } = params;

    const storageKey =
      UserMatrixSqliteSyncService.createUserStorageKey(userDid);

    const checkpointPath =
      UserMatrixSqliteSyncService.getUserCheckpointDbPath(userDid);

    Logger.debug(
      `Uploading checkpoint for user ${userDid}, storageKey: ${storageKey}, path: ${checkpointPath}`,
    );

    const exists = await fs
      .access(checkpointPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      Logger.warn(
        `Checkpoint file not found for user ${userDid} at ${checkpointPath}`,
      );
      return 'skipped';
    }

    // Handle open database connections — don't close if user has active request
    const cached = this.dbConnectionCache.get(userDid);
    if (cached) {
      if (this.isUserActive(userDid)) {
        // User has an in-flight request — in DELETE journal mode the DB file may be
        // inconsistent mid-transaction, so skip upload. Next cron cycle will pick it up.
        Logger.debug(
          `Skipping upload for active user ${userDid}, will retry next cycle`,
        );
        return 'skipped';
      } else {
        // No active request — safe to close
        try {
          cached.db.close();
          this.dbConnectionCache.delete(userDid);
          Logger.debug(`Closed cached database connection for user ${userDid}`);
        } catch (error) {
          Logger.warn(
            `Failed to close cached database connection for user ${userDid}: ${error}`,
          );
        }
      }
    }

    // One-time migration for databases created before incremental
    // auto-vacuum: reclaim dead freelist pages while no request holds the
    // file. Newly created databases never trip the thresholds.
    if (!this.isUserActive(userDid)) {
      try {
        const compaction = compactSqliteFileIfBloated(checkpointPath);
        if (compaction.compacted) {
          Logger.log(
            `Compacted checkpoint for user ${userDid}: ${bytesToHumanReadable(compaction.fileBytesBefore)} -> ${bytesToHumanReadable(compaction.fileBytesAfter)} (${bytesToHumanReadable(compaction.freelistBytes)} of dead pages reclaimed)`,
          );
        }
      } catch (error) {
        Logger.warn(
          `Failed to compact checkpoint for user ${userDid}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Compute checksum via streaming to avoid loading the entire DB into
    // memory. The checksum is a change detector only — the uploaded bytes
    // come from a consistent snapshot below, so a torn read here costs at
    // worst one redundant upload.
    const currentChecksum = await computeFileChecksum(checkpointPath);
    const lastChecksum = this.lastUploadedChecksum.get(storageKey);

    if (currentChecksum === lastChecksum) {
      Logger.debug(
        `Skipping upload for user ${userDid} — checkpoint unchanged (checksum: ${currentChecksum.substring(0, 12)}...)`,
      );
      return 'unchanged';
    }

    if (currentChecksum === this.oversizedChecksum.get(storageKey)) {
      Logger.debug(
        `Skipping upload for user ${userDid} — checkpoint unchanged since it last exceeded the homeserver upload limit`,
      );
      return 'skipped';
    }

    // Resolved before the snapshot/gzip work below so the size guard can use
    // the RESOLVED store's own cap (VFS: a fixed 5 GiB; Matrix: the
    // homeserver's discovered `m.upload.size`) instead of always the Matrix
    // limit — a VFS cutover user must not be capped at the Matrix media
    // size just because the guard ran before store selection existed.
    const resolvedStore = await this.resolveUploadStore(userDid, storageKey);
    if (resolvedStore === 'skip-no-vfs-store') {
      Logger.error(
        `VFS backup store not ready for user ${userDid} (no signing key yet) — backup skipped, never falling back to Matrix`,
      );
      return 'skipped';
    }
    const store = resolvedStore;
    const previousLocation = this.backupLocation.get(storageKey);

    // Snapshot via VACUUM INTO: transactionally consistent even if a request
    // starts writing mid-upload, and free of dead freelist pages. Then gzip
    // the snapshot streaming to disk so only the (much smaller) compressed
    // payload is ever buffered in heap. The size guard runs against the
    // on-disk gzip output (fs.stat) — an oversized file never gets uploaded
    // at all. The snapshot temp is always removed below; the gzip temp is
    // removed here too unless the size guard clears, in which case cleanup
    // duty hands off to the upload's own `finally` further down — either
    // way it's removed exactly once, on every exit path.
    const snapshotPath = checkpointPath + '.snapshot.tmp';
    const gzTmpPath = checkpointPath + '.gz.tmp';
    let compressedSize: number;
    // Set once the size guard clears and gzTmpPath's cleanup duty is handed
    // off to the upload's own `finally` below — every other exit from this
    // try (the oversized early `return` or a thrown error) still owns
    // cleaning up gzTmpPath itself, so it's removed exactly once either way.
    let handOffGzTmpToUpload = false;
    try {
      await removeIfExists(snapshotPath);
      snapshotSqliteFile(checkpointPath, snapshotPath);
      const { size: snapshotSize } = await fs.stat(snapshotPath);
      await pipeline(
        fsSync.createReadStream(snapshotPath),
        createGzip(),
        fsSync.createWriteStream(gzTmpPath),
      );

      compressedSize = (await fs.stat(gzTmpPath)).size;
      const { size: originalSize } = await fs.stat(checkpointPath);
      Logger.log(
        `Checkpoint for user ${userDid}: ${bytesToHumanReadable(originalSize)} on disk, ${bytesToHumanReadable(snapshotSize)} live -> ${bytesToHumanReadable(compressedSize)} compressed`,
      );

      const uploadSizeLimit =
        store.kind === 'vfs'
          ? VFS_UPLOAD_SIZE_LIMIT_BYTES
          : await this.getUploadSizeLimit();
      if (compressedSize > uploadSizeLimit) {
        this.oversizedChecksum.set(storageKey, currentChecksum);
        Logger.error(
          `Checkpoint for user ${userDid} exceeds the ${store.kind === 'vfs' ? 'VFS' : 'homeserver'} upload limit (${bytesToHumanReadable(compressedSize)} > ${bytesToHumanReadable(uploadSizeLimit)}) — backup skipped, local file keeps serving. Investigate why this user's live state is so large.`,
        );
        return 'skipped';
      }

      handOffGzTmpToUpload = true;
    } finally {
      await removeIfExists(snapshotPath);
      if (!handOffGzTmpToUpload) {
        await removeIfExists(gzTmpPath);
      }
    }

    let uploaded: CheckpointUploadResult;
    try {
      uploaded = await store.upload({
        userDid,
        storageKey,
        openStream: () => fsSync.createReadStream(gzTmpPath),
        sizeBytes: compressedSize,
      });
    } catch (error) {
      // A VFS failure is a skipped cycle, never a silent fall-back to
      // Matrix — the existing Matrix path (below) keeps its prior
      // behaviour of letting the error propagate to the caller.
      if (store.kind === 'vfs') {
        Logger.error(
          `VFS checkpoint upload failed for user ${userDid} — skipping this cycle (a VFS-store user never falls back to Matrix): ${error instanceof Error ? error.message : String(error)}`,
        );
        return 'skipped';
      }
      throw error;
    } finally {
      await removeIfExists(gzTmpPath);
    }
    await this.saveFileEventToDB({
      eventId: uploaded.pointer,
      storageKey,
      event: uploaded.event,
      contentChecksum: currentChecksum,
      store: store.kind,
      vfsFileId: store.kind === 'vfs' ? uploaded.pointer : undefined,
      vfsCid: uploaded.cid,
    });
    this.oversizedChecksum.delete(storageKey);

    if (store.kind === 'vfs' && previousLocation?.store !== 'vfs') {
      Logger.log(
        `Checkpoint backup for user ${userDid} moved to VFS (${bytesToHumanReadable(compressedSize)}${uploaded.cid ? `, cid ${uploaded.cid}` : ''}); redacting Matrix copy`,
      );
      try {
        await this.matrixStore.delete({ userDid, storageKey });
      } catch (error) {
        Logger.warn(
          `Could not redact the Matrix checkpoint copy for user ${userDid}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    Logger.log(
      `Successfully uploaded checkpoint to ${store.kind === 'vfs' ? 'VFS' : 'Matrix'} for user ${userDid}`,
    );
    return 'uploaded';
  }

  // Run at :10, :20, :30, :40, :50 — skips :00 to avoid overlapping with the hourly cleanup cron
  @Cron('0 10,20,30,40,50 * * * *')
  async uploadCheckpointToMatrixStorageTask(): Promise<void> {
    if (this.cronRunning) {
      Logger.debug('Skipping upload task — another cron task is still running');
      return;
    }
    this.cronRunning = true;
    try {
      Logger.log(`Uploading checkpoint to Matrix storage task started`);
      // Iterate cached file paths instead of scanning the filesystem —
      // only users with known local checkpoints need uploading.
      for (const userDid of this.filePathCache.keys()) {
        try {
          await this.uploadCheckpointToMatrixStorage({ userDid });
        } catch (error) {
          Logger.error(
            `Failed to upload checkpoint to Matrix storage for user ${userDid}`,
            error instanceof Error ? error.message : String(error),
            'File path: ' +
              UserMatrixSqliteSyncService.getUserCheckpointDbPath(userDid),
            'File Size before gzip: ' +
              (await fs
                .stat(
                  UserMatrixSqliteSyncService.getUserCheckpointDbPath(userDid),
                )
                .then((stats) => bytesToHumanReadable(stats.size))
                .catch(() => 'unknown')),
          );
        }
      }
    } finally {
      this.cronRunning = false;
    }
  }

  /**
   * Deletes user storage from whichever store `file_events` names for this
   * key (VFS or Matrix) and cleans up local cache.
   * @param userDid The user DID
   * @param storageKey Optional storage key. If not provided, uses the default user storage key
   * @returns True if deletion was successful, false if not found
   */
  async deleteUserBackup(
    userDid: string,
    storageKey?: string,
  ): Promise<boolean> {
    const key =
      storageKey || UserMatrixSqliteSyncService.createUserStorageKey(userDid);

    const location = this.backupLocation.get(key);
    let store: CheckpointBackupStore;
    if (location?.store === 'vfs') {
      if (!this.vfsStore || !this.vfsReady()) {
        // Without the readiness half, a delete in the boot window reaches the
        // store and throws a mint failure at a caller that expects `false`.
        Logger.error(
          `Cannot delete VFS-backed storage for user ${userDid} — no VFS store is attached, or the oracle's UCAN signing key has not landed`,
        );
        return false;
      }
      store = this.vfsStore;
    } else {
      store = this.matrixStore;
    }

    Logger.debug(
      `Deleting storage for user ${userDid} with storageKey ${key} from ${store.kind}`,
    );

    // Delete from the resolved store
    const deleted = await store.delete({
      userDid,
      storageKey: key,
    });

    if (deleted) {
      // Clean up local cache
      try {
        // Delete from file events database
        this.fileEventsDatabase
          .prepare('DELETE FROM file_events WHERE storage_key = ?')
          .run(key);
        Logger.debug(
          `Deleted file event cache for storageKey ${key} from database`,
        );
      } catch (error) {
        Logger.warn(
          `Failed to delete file event cache for storageKey ${key}:`,
          error,
        );
      }

      // Delete local file if it exists
      try {
        const dbPath =
          UserMatrixSqliteSyncService.getUserCheckpointDbPath(userDid);
        const exists = await fs
          .access(dbPath)
          .then(() => true)
          .catch(() => false);

        if (exists) {
          await fs.unlink(dbPath);
          Logger.debug(`Deleted local checkpoint file at ${dbPath}`);
        }
      } catch (error) {
        Logger.warn(
          `Failed to delete local checkpoint file for user ${userDid}:`,
          error,
        );
      }

      // Clear database connection cache
      const cached = this.dbConnectionCache.get(userDid);
      if (cached) {
        try {
          cached.db.close();
          this.dbConnectionCache.delete(userDid);
          Logger.debug(`Closed and cleared database connection for ${userDid}`);
        } catch (error) {
          Logger.warn(
            `Failed to close database connection for ${userDid}:`,
            error,
          );
        }
      }

      // Clear file path cache, checksum cache, and the store-location cache
      this.filePathCache.delete(userDid);
      this.lastUploadedChecksum.delete(key);
      this.backupLocation.delete(key);
      // Without this, the next request for this user skips the backup
      // re-sync check and lands in corruption recovery on the missing file.
      this.syncedUsers.delete(userDid);

      Logger.log(
        `Successfully deleted storage for user ${userDid} with storageKey ${key}`,
      );
    }

    return deleted;
  }

  private async saveFileEventToDB({
    eventId,
    storageKey,
    event,
    contentChecksum,
    store,
    vfsFileId,
    vfsCid,
  }: {
    eventId: string;
    storageKey: string;
    event: unknown;
    contentChecksum?: string;
    store: CheckpointStoreKind;
    vfsFileId?: string;
    vfsCid?: string;
  }): Promise<void> {
    this.fileEventsDatabase
      .prepare(
        'INSERT OR REPLACE INTO file_events (storage_key, event_id, event, content_checksum, store, vfs_file_id, vfs_cid) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        storageKey,
        eventId,
        JSON.stringify(event) ?? null,
        contentChecksum ?? null,
        store,
        vfsFileId ?? null,
        vfsCid ?? null,
      );

    // Update in-memory caches
    if (contentChecksum) {
      this.lastUploadedChecksum.set(storageKey, contentChecksum);
    }
    this.backupLocation.set(storageKey, { store, vfsFileId });
  }
}

/** Delete a file, ignoring "already gone" and permission noise. */
async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // File may not exist, that's fine
  }
}

/** Read the first `length` bytes of a file without loading the rest. */
async function readFileHeader(
  filePath: string,
  length: number,
): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Compute SHA-256 checksum of a file using streaming reads.
 * Reads in ~64KB chunks to avoid loading the entire file into memory,
 * which matters for large SQLite databases (100MB+).
 */
function computeFileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => {
      stream.destroy();
      reject(err);
    });
  });
}
const bytesToHumanReadable = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, index)).toFixed(2) + ' ' + units[index];
};
