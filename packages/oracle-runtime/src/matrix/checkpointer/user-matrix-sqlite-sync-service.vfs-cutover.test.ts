import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as MatrixUploadUtils from './matrix-upload-utils.js';
import { UserMatrixSqliteSyncService } from './user-matrix-sqlite-sync-service.service.js';
import { VfsCheckpointStore } from './vfs-checkpoint-store.js';
import type { VfsDelegationMinter } from '../../plugins/vfs/vfs-auth.js';

// This is a SEPARATE test file (not appended to
// `user-matrix-sqlite-sync-service.service.test.ts`) for two concrete
// reasons tied to how the singleton service caches state across the whole
// module — both would silently corrupt these tests if they ran alongside
// the existing file's cases:
//
// 1. That file's `fetchMediaUploadSizeLimit` mock is pinned to 10 bytes
//    specifically so every upload in it hits the oversized-skip path. Once
//    `getUploadSizeLimit()` runs there, `this.uploadSizeLimit` memoizes to
//    10 on the shared singleton for the rest of that file's tests — no real
//    gzip payload can ever fit, so a genuine 'uploaded' status (needed by
//    the cutover test below) is unreachable there.
// 2. `CHECKPOINT_VFS_BACKUP_ENABLED` is read once via the module-scoped
//    `const config = getConfig()` at import time; a fresh module load (a
//    fresh test file) is the only way to control it per describe block —
//    see `user-matrix-sqlite-sync-service.vfs-kill-switch.test.ts`.
const TMP_DIR = vi.hoisted(() => {
  const dir = `/tmp/user-matrix-sqlite-sync-service-vfs-cutover-test-${process.pid}-${Date.now()}`;
  process.env.SQLITE_DATABASE_PATH = dir;
  process.env.MATRIX_ORACLE_ADMIN_USER_ID =
    '@did-ixo-vfscutoveroracle:matrix.test';
  process.env.ORACLE_ENTITY_DID = 'did:ixo:entity:vfs-cutover-oracle';
  // The full Tier-0 base-env-schema must parse successfully — otherwise
  // `getBaseEnvConfig()`'s singleton falls back to raw, untransformed
  // `process.env` strings, and `CHECKPOINT_VFS_BACKUP_ENABLED`'s
  // `.default('true')` never applies (reads as `undefined`, which is
  // falsy — silently forcing every upload onto the Matrix path). Filling
  // in the rest of `requiredTier0Vars` from `base-env-schema.test.ts`
  // avoids that.
  process.env.ORACLE_NAME = 'VfsCutoverTestOracle';
  process.env.NETWORK = 'devnet';
  process.env.MATRIX_RECOVERY_PHRASE = 'word '.repeat(12).trim();
  process.env.MATRIX_ORACLE_ADMIN_PASSWORD = 'pw';
  process.env.MATRIX_ACCOUNT_ROOM_ID = '!room:matrix.test';
  process.env.MATRIX_VALUE_PIN = '1234';
  process.env.ORACLE_DID = 'did:ixo:vfscutoveroracle';
  return dir;
});

// `getOracleRoomIdWithHomeServer` resolves to a real room id (unlike the
// no-room stub in the main service test file) so the cutover test's Matrix
// redaction (`matrixStore.delete`) actually reaches `deleteMediaFromRoom`
// instead of short-circuiting on "no room".
vi.mock('@ixo/matrix', () => ({
  MatrixManager: {
    getInstance: vi.fn(() => ({
      getClient: vi.fn(() => undefined),
      getOracleRoomIdWithHomeServer: vi.fn(async () => ({
        roomId: 'room-1',
      })),
    })),
  },
}));

vi.mock('@ixo/oracles-chain-client', () => ({
  getMatrixHomeServerCroppedForDid: vi.fn(async () => 'home'),
}));

// Partial mock: `fetchMediaUploadSizeLimit` is a realistic cap (unlike the
// main service test file's 10-byte trap) so a small real checkpoint's gzip
// output fits and the upload can actually reach the store. `uploadMediaToRoom`
// and `deleteMediaFromRoom` are fully mocked (not delegated to the real
// implementation) since the real implementation reaches a live Matrix
// client, which the `@ixo/matrix` stub above doesn't provide.
vi.mock('./matrix-upload-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MatrixUploadUtils>();
  return {
    ...actual,
    fetchMediaUploadSizeLimit: vi.fn().mockResolvedValue(10_000_000),
    uploadMediaToRoom: vi.fn(),
    deleteMediaFromRoom: vi.fn().mockResolvedValue(true),
  };
});

import {
  deleteMediaFromRoom,
  uploadMediaToRoom,
} from './matrix-upload-utils.js';

fs.mkdirSync(TMP_DIR, { recursive: true });

function userDbPath(userDid: string): string {
  return UserMatrixSqliteSyncService.getUserCheckpointDbPath(userDid);
}

/** A small, valid checkpoint DB whose gzip output comfortably fits the 10MB mocked cap. */
function makeSmallCheckpointDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('CREATE TABLE checkpoints (id INTEGER PRIMARY KEY, data BLOB)');
  db.prepare('INSERT INTO checkpoints (data) VALUES (?)').run(
    Buffer.from('hello-checkpoint'),
  );
  db.close();
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function fakeMinter(): VfsDelegationMinter {
  return {
    getServiceDelegation: vi.fn(async () => ({
      token: 'CAR',
      with: 'ixo:filesystem/oracle-data/did:ixo:entity:vfs-cutover-oracle',
    })),
    createInvocationFromDelegation: vi.fn(async () => ({ invocation: 'INV' })),
  };
}

function makeVfsStore(fetchImpl: typeof fetch): VfsCheckpointStore {
  return new VfsCheckpointStore({
    minter: fakeMinter(),
    urls: { vfs: 'https://vfs.test', store: 'https://store.test' },
    oracleEntityDid: 'did:ixo:entity:vfs-cutover-oracle',
    knownFileId: () => undefined,
    timeoutMs: 5000,
    fetchImpl,
  });
}

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('VFS backup store', () => {
  const service = UserMatrixSqliteSyncService.getInstance();

  beforeAll(async () => {
    // Creates the file_events table (with the store/vfs_file_id/vfs_cid
    // migration columns) and populates the in-memory caches — never called
    // implicitly by these unit tests otherwise.
    await service.onModuleInit();
  });

  it('cuts a user over on the first successful VFS upload and redacts Matrix', async () => {
    const userDid = 'did:ixo:vfs-cutover-user';
    const storageKey =
      UserMatrixSqliteSyncService.createUserStorageKey(userDid);
    makeSmallCheckpointDb(userDbPath(userDid));

    const fetchImpl = vi.fn(async () => json({ id: 'f1', cid: 'c' }, 201));
    service.attachBackupStoresForTests({ vfs: makeVfsStore(fetchImpl) });

    // Pins the crash-safety ordering (`file_events` written before the
    // Matrix copy is redacted): capture what the row says AT THE MOMENT
    // `deleteMediaFromRoom` is invoked. If a future edit ever moved
    // `saveFileEventToDB` after the redaction call, this would observe the
    // pre-cutover `store` value (or no row at all) instead of `'vfs'`.
    let storeAtRedactionTime: string | undefined;
    vi.mocked(deleteMediaFromRoom).mockImplementationOnce((_roomId, key) => {
      const row = service.fileEventsDatabase
        .prepare<
          [string],
          { store: string }
        >('SELECT store FROM file_events WHERE storage_key = ?')
        .get(key);
      storeAtRedactionTime = row?.store;
      return Promise.resolve(true);
    });

    const status = await service.uploadCheckpointToMatrixStorage({ userDid });
    expect(status).toBe('uploaded');

    const row = service.fileEventsDatabase
      .prepare<
        [string],
        { store: string; vfs_file_id: string; vfs_cid: string }
      >('SELECT store, vfs_file_id, vfs_cid FROM file_events WHERE storage_key = ?')
      .get(storageKey);
    expect(row).toMatchObject({
      store: 'vfs',
      vfs_file_id: 'f1',
      vfs_cid: 'c',
    });

    expect(deleteMediaFromRoom).toHaveBeenCalledTimes(1);
    expect(deleteMediaFromRoom).toHaveBeenCalledWith('room-1', storageKey);
    expect(storeAtRedactionTime).toBe('vfs');
  });

  it('a VFS user never falls back to Matrix', async () => {
    const userDid = 'did:ixo:vfs-user-no-fallback';
    const storageKey =
      UserMatrixSqliteSyncService.createUserStorageKey(userDid);
    makeSmallCheckpointDb(userDbPath(userDid));

    // Pre-seed the file_events row as already cut over to VFS, then re-run
    // onModuleInit so its boot SELECT re-populates the in-memory
    // backupLocation map from this row (there is no public setter for that
    // map — this mirrors how a real restart would pick up prior state).
    service.fileEventsDatabase
      .prepare(
        "INSERT OR REPLACE INTO file_events (storage_key, event_id, event, store, vfs_file_id) VALUES (?, ?, ?, 'vfs', ?)",
      )
      .run(
        storageKey,
        'evt-existing',
        JSON.stringify(null),
        'existing-file-id',
      );
    await service.onModuleInit();

    const fetchImpl = vi.fn(
      async () => new Response('server error', { status: 500 }),
    );
    service.attachBackupStoresForTests({ vfs: makeVfsStore(fetchImpl) });

    vi.mocked(uploadMediaToRoom).mockClear();

    const status = await service.uploadCheckpointToMatrixStorage({ userDid });
    expect(status).toBe('skipped');
    expect(uploadMediaToRoom).not.toHaveBeenCalled();
  });
});
