import { MatrixManager } from '@ixo/matrix';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'crypto';

import { Cron, CronExpression } from '@nestjs/schedule';
import { hours } from '@nestjs/throttler';
import { File } from 'node:buffer';
import fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import {
  deleteMediaFromRoom,
  getMediaFromRoom,
  getMediaFromRoomByStorageKey,
  GetMediaFromRoomByStorageKeyResult,
  MatrixMediaEvent,
  uploadMediaToRoom,
} from './matrix-upload-utils';
import { type BaseSyncArgs } from './type';
import { getConfig } from '../config';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

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

const config = getConfig();

/** Configure a SQLite connection with busy timeout for safe concurrent access */
/** Configure a SQLite connection with pragmas for safe concurrent access on VPS */
function configureSqliteConnection(db: DatabaseType): void {
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

  /** Prevents overlapping cron executions from interleaving I/O on the same files */
  private cronRunning = false;

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

    // Populate in-memory checksum cache from DB
    const rows = this.fileEventsDatabase
      .prepare(
        'SELECT storage_key, content_checksum FROM file_events WHERE content_checksum IS NOT NULL',
      )
      .all() as Array<{ storage_key: string; content_checksum: string }>;
    for (const row of rows) {
      this.lastUploadedChecksum.set(row.storage_key, row.content_checksum);
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
   * Ensures database exists and is synced from Matrix.
   * Includes automatic corruption recovery.
   */
  public async getUserDatabase(userDid: string): Promise<DatabaseType> {
    // Ensure database is synced locally first
    await this.syncLocalStorageFromMatrixStorage({ userDid });

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
        await this.deleteUserStorageFromMatrix(userDid);
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
      const isOk = result.length === 1 && result[0].integrity_check === 'ok';

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

    // Clear file path cache and checksum cache (both in-memory and DB)
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
    for (const suffix of ['', '.tmp', '-wal', '-shm', '-journal']) {
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
            // Sync to Matrix before closing
            await this.uploadCheckpointToMatrixStorage({ userDid });
            // Close connection (db is already from the loop iteration)
            db.close();
            this.dbConnectionCache.delete(userDid);
            Logger.log(`Closed idle database connection for user ${userDid}`);
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
          try {
            await this.uploadCheckpointToMatrixStorage({ userDid });
          } catch (error) {
            Logger.error(
              `Failed to sync checkpoint file to matrix storage for user ${userDid}`,
              error,
            );
            // failed to sync, continue to next user so we can retry next hour
            continue;
          }

          // sync successful, delete local cache
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
          // entries are worse than missing ones (next access re-downloads)
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

    const downloadPromise = this._syncLocalStorageFromMatrixStorage(userDid);
    this.downloadInProgress.set(userDid, downloadPromise);

    try {
      await downloadPromise;
    } finally {
      this.downloadInProgress.delete(userDid);
    }
  }

  private async _syncLocalStorageFromMatrixStorage(
    userDid: string,
  ): Promise<void> {
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
      `Checkpoint file not found locally for user ${userDid}, attempting to download from Matrix`,
    );

    let userDB: GetMediaFromRoomByStorageKeyResult | null = null;

    // Step 1: Try cached event lookup (local SQLite — independent concern)
    let cachedEvent: MatrixMediaEvent | undefined;
    try {
      const cachedEventText = this.fileEventsDatabase
        .prepare('SELECT event FROM file_events WHERE storage_key = ?')
        .get(storageKey) as { event: string } | undefined;
      cachedEvent = cachedEventText
        ? (JSON.parse(cachedEventText.event) as MatrixMediaEvent)
        : undefined;
    } catch (cacheError) {
      // file_events.db corrupt or locked — skip cache, fall through to direct Matrix lookup
      Logger.warn(
        `Failed to read cached event for user ${userDid}, falling through to Matrix lookup: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`,
      );
    }

    // Step 2: Download from Matrix
    try {
      if (cachedEvent) {
        const result = await getMediaFromRoom(
          undefined,
          undefined,
          cachedEvent,
        );
        userDB = {
          ...result,
          contentInfo: {
            ...result.contentInfo,
            storageKey,
          },
        };
      } else {
        const mxManager = MatrixManager.getInstance();
        const userHomeServer = await getMatrixHomeServerCroppedForDid(userDid);
        const { roomId } = await mxManager.getOracleRoomIdWithHomeServer({
          userDid,
          oracleEntityDid: config.getOrThrow('ORACLE_ENTITY_DID'),
          userHomeServer,
        });

        if (!roomId) {
          throw new NotFoundException('Room not found or Invalid Session Id');
        }

        Logger.debug(
          `Downloading checkpoint from Matrix room ${roomId} for user ${userDid}`,
        );
        userDB = await getMediaFromRoomByStorageKey(roomId, storageKey);
      }
    } catch (error) {
      if (isUnrecoverableDownloadError(error)) {
        // Permanent failure — data genuinely unrecoverable, safe to start fresh
        Logger.warn(
          `Unrecoverable download failure for user ${userDid}, will start with fresh database: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      // Transient/unknown error — let it propagate so the request fails with 500
      // and the user retries later. This prevents creating an empty DB that would
      // overwrite the good Matrix backup on the next upload cron cycle.
      throw error;
    }

    if (!userDB) {
      Logger.debug(
        `No checkpoint found in Matrix for user ${userDid} with storageKey ${storageKey}, this is expected for new users`,
      );
      return;
    }

    // Decompress the checkpoint
    const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
    let decompressedBuffer: Buffer;
    try {
      decompressedBuffer = await gunzipAsync(userDB.mediaBuffer);
      Logger.log(
        `Decompressed checkpoint for user ${userDid}: ${bytesToHumanReadable(userDB.mediaBuffer.length)} -> ${bytesToHumanReadable(decompressedBuffer.length)}`,
      );
    } catch (_error) {
      // Decompression failed — check if the raw buffer is a valid uncompressed SQLite file
      if (
        userDB.mediaBuffer.length >= 16 &&
        userDB.mediaBuffer.subarray(0, 16).equals(SQLITE_MAGIC)
      ) {
        Logger.warn(
          `Checkpoint for user ${userDid} is uncompressed SQLite (legacy format), using as-is`,
        );
        decompressedBuffer = userDB.mediaBuffer;
      } else {
        Logger.error(
          `Checkpoint for user ${userDid} is neither valid gzip nor valid SQLite — skipping download to prevent corruption. Raw bytes (first 16): ${userDB.mediaBuffer.subarray(0, 16).toString('hex')}`,
        );
        return;
      }
    }

    // Validate decompressed data is a valid SQLite file
    if (
      decompressedBuffer.length < 16 ||
      !decompressedBuffer.subarray(0, 16).equals(SQLITE_MAGIC)
    ) {
      Logger.error(
        `Decompressed checkpoint for user ${userDid} does not have valid SQLite header — skipping to prevent corruption. Header bytes: ${decompressedBuffer.subarray(0, Math.min(16, decompressedBuffer.length)).toString('hex')}`,
      );
      return;
    }

    Logger.debug(
      `Saving checkpoint to local cache for user ${userDid} at ${checkpointPath}`,
    );

    // Atomic write: write to temp file then rename (rename is atomic on POSIX)
    const tmpPath = checkpointPath + '.tmp';
    try {
      await fs.writeFile(tmpPath, decompressedBuffer);
      await fs.rename(tmpPath, checkpointPath);
    } catch (error) {
      // Clean up orphaned temp file on failure
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
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
   * Sync checkpoint file from local cache to S3.
   * @param userDid - The user's DID identifier
   * @returns Promise that resolves when sync is complete
   */
  async uploadCheckpointToMatrixStorage(params: BaseSyncArgs): Promise<void> {
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
      return;
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
        return;
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

    // Compute checksum via streaming to avoid loading the entire DB into memory.
    // Streaming reads ~64KB chunks at a time instead of the full file (which can be 100MB+).
    const currentChecksum = await computeFileChecksum(checkpointPath);
    const lastChecksum = this.lastUploadedChecksum.get(storageKey);

    if (currentChecksum === lastChecksum) {
      Logger.debug(
        `Skipping upload for user ${userDid} — checkpoint unchanged (checksum: ${currentChecksum.substring(0, 12)}...)`,
      );
      return;
    }

    // Only load file into memory when we know the content has changed and needs uploading
    Logger.debug(
      `Reading checkpoint file for user ${userDid} from ${checkpointPath}`,
    );
    const checkpoint = await fs.readFile(checkpointPath);
    const originalSize = checkpoint.length;

    // Compress the database file with gzip before upload
    const compressedCheckpoint = await gzipAsync(checkpoint);
    const compressedSize = compressedCheckpoint.length;
    const compressionRatio = (
      (1 - compressedSize / originalSize) *
      100
    ).toFixed(1);

    Logger.log(
      `Checkpoint for user ${userDid}: ${bytesToHumanReadable(originalSize)} -> ${bytesToHumanReadable(compressedSize)} (${compressionRatio}% reduction)`,
    );

    const mxManager = MatrixManager.getInstance();
    const userHomeServer = await getMatrixHomeServerCroppedForDid(userDid);
    const { roomId } = await mxManager.getOracleRoomIdWithHomeServer({
      userDid,
      oracleEntityDid: config.getOrThrow('ORACLE_ENTITY_DID'),
      userHomeServer,
    });

    if (!roomId) {
      throw new NotFoundException('Room not found or Invalid Session Id');
    }

    Logger.debug(
      `Uploading compressed checkpoint to Matrix room ${roomId} for user ${userDid}`,
    );
    const event = await uploadMediaToRoom(
      roomId,
      new File([compressedCheckpoint], `${storageKey}.db.gz`, {
        type: 'application/gzip',
        lastModified: Date.now(),
      }),
      storageKey,
    );
    await this.saveFileEventToDB({
      eventId: event.eventId,
      storageKey: event.storageKey,
      event: event.event,
      contentChecksum: currentChecksum,
    });

    Logger.log(
      `Successfully uploaded checkpoint to Matrix for user ${userDid}`,
    );
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
            error.message,
            'File path: ' +
              UserMatrixSqliteSyncService.getUserCheckpointDbPath(userDid),
            'File Size before gzip: ' +
              bytesToHumanReadable(
                await fs
                  .stat(
                    UserMatrixSqliteSyncService.getUserCheckpointDbPath(
                      userDid,
                    ),
                  )
                  .then((stats) => stats.size),
              ),
          );
        }
      }
    } finally {
      this.cronRunning = false;
    }
  }

  /**
   * Deletes user storage from Matrix and cleans up local cache
   * @param userDid The user DID
   * @param storageKey Optional storage key. If not provided, uses the default user storage key
   * @returns True if deletion was successful, false if not found
   */
  async deleteUserStorageFromMatrix(
    userDid: string,
    storageKey?: string,
  ): Promise<boolean> {
    const key =
      storageKey || UserMatrixSqliteSyncService.createUserStorageKey(userDid);

    Logger.debug(`Deleting storage for user ${userDid} with storageKey ${key}`);

    // Get the user's Matrix room
    const mxManager = MatrixManager.getInstance();
    const userHomeServer = await getMatrixHomeServerCroppedForDid(userDid);
    const { roomId } = await mxManager.getOracleRoomIdWithHomeServer({
      userDid,
      oracleEntityDid: config.getOrThrow('ORACLE_ENTITY_DID'),
      userHomeServer,
    });

    if (!roomId) {
      Logger.warn(
        `No Matrix room found for user ${userDid}, cannot delete storage`,
      );
      return false;
    }

    // Delete from Matrix
    const deleted = await deleteMediaFromRoom(roomId, key);

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

      // Clear file path cache and checksum cache
      this.filePathCache.delete(userDid);
      this.lastUploadedChecksum.delete(key);

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
  }: {
    eventId: string;
    storageKey: string;
    event: MatrixMediaEvent;
    contentChecksum?: string;
  }): Promise<void> {
    this.fileEventsDatabase
      .prepare(
        'INSERT OR REPLACE INTO file_events (storage_key, event_id, event, content_checksum) VALUES (?, ?, ?, ?)',
      )
      .run(storageKey, eventId, JSON.stringify(event), contentChecksum ?? null);

    // Update in-memory cache
    if (contentChecksum) {
      this.lastUploadedChecksum.set(storageKey, contentChecksum);
    }
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
