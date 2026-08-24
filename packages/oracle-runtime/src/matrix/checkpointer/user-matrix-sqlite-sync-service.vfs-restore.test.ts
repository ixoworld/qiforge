import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { VfsAuthError } from '../../plugins/vfs/vfs-errors.js';
import type { VfsDelegationMinter } from '../../plugins/vfs/vfs-auth.js';
import { CheckpointIntegrityError } from './checkpoint-backup-store.js';
import type * as MatrixUploadUtils from './matrix-upload-utils.js';
import { UserMatrixSqliteSyncService } from './user-matrix-sqlite-sync-service.service.js';
import { VfsCheckpointStore } from './vfs-checkpoint-store.js';

// A dedicated file for the same reason the cutover and kill-switch files are
// separate: the service is a process-wide singleton whose env-derived paths
// and caches are fixed at module load, so each restore scenario needs its own
// module instance to control `file_events` state and store readiness without
// leaking into the others.
const TMP_DIR = vi.hoisted(() => {
  const dir = `/tmp/user-matrix-sqlite-sync-service-vfs-restore-test-${process.pid}-${Date.now()}`;
  process.env.SQLITE_DATABASE_PATH = dir;
  process.env.MATRIX_ORACLE_ADMIN_USER_ID =
    '@did-ixo-vfsrestoreoracle:matrix.test';
  process.env.ORACLE_ENTITY_DID = 'did:ixo:entity:vfs-restore-oracle';
  // The full Tier-0 base-env schema must parse for the derived config (and
  // `CHECKPOINT_VFS_BACKUP_ENABLED`'s default) to apply — see the cutover file.
  process.env.ORACLE_NAME = 'VfsRestoreTestOracle';
  process.env.NETWORK = 'devnet';
  process.env.MATRIX_RECOVERY_PHRASE = 'word '.repeat(12).trim();
  process.env.MATRIX_ORACLE_ADMIN_PASSWORD = 'pw';
  process.env.MATRIX_ACCOUNT_ROOM_ID = '!room:matrix.test';
  process.env.MATRIX_VALUE_PIN = '1234';
  process.env.ORACLE_DID = 'did:ixo:vfsrestoreoracle';
  return dir;
});

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

// The Matrix store answers "no backup in this room" — the fall-through the
// no-row restore path takes once the VFS probe has run (or been skipped).
vi.mock('./matrix-upload-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MatrixUploadUtils>();
  return {
    ...actual,
    fetchMediaUploadSizeLimit: vi.fn().mockResolvedValue(10_000_000),
    uploadMediaToRoom: vi
      .fn()
      .mockResolvedValue({ eventId: 'evt-1', event: {}, storageKey: '' }),
    getMediaFromRoomByStorageKey: vi.fn().mockResolvedValue(null),
  };
});

import { uploadMediaToRoom } from './matrix-upload-utils.js';

fs.mkdirSync(TMP_DIR, { recursive: true });

function userDbPath(userDid: string): string {
  return UserMatrixSqliteSyncService.getUserCheckpointDbPath(userDid);
}

/** A small, valid checkpoint DB whose gzip output fits the mocked cap. */
function makeSmallCheckpointDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('CREATE TABLE checkpoints (id INTEGER PRIMARY KEY, data BLOB)');
  db.prepare('INSERT INTO checkpoints (data) VALUES (?)').run(
    Buffer.from('hello-checkpoint'),
  );
  db.close();
}

function minter(delegation: 'ok' | 'none'): VfsDelegationMinter {
  return {
    getServiceDelegation: vi.fn(async () =>
      delegation === 'ok'
        ? {
            token: 'CAR',
            with: 'ixo:filesystem/oracle-data/did:ixo:entity:vfs-restore-oracle',
          }
        : { error: 'no-delegation' as const },
    ),
    createInvocationFromDelegation: vi.fn(async () => ({ invocation: 'INV' })),
  };
}

function makeVfsStore(
  fetchImpl: typeof fetch,
  delegation: 'ok' | 'none' = 'ok',
): VfsCheckpointStore {
  return new VfsCheckpointStore({
    minter: minter(delegation),
    urls: { vfs: 'https://vfs.test', store: 'https://store.test' },
    oracleEntityDid: 'did:ixo:entity:vfs-restore-oracle',
    knownFileId: () => undefined,
    timeoutMs: 5000,
    fetchImpl,
  });
}

/** Marks a storage key as already cut over to VFS, the way a restart would. */
async function seedVfsRow(
  service: UserMatrixSqliteSyncService,
  storageKey: string,
): Promise<void> {
  service.fileEventsDatabase
    .prepare(
      "INSERT OR REPLACE INTO file_events (storage_key, event_id, event, store, vfs_file_id) VALUES (?, ?, ?, 'vfs', ?)",
    )
    .run(storageKey, 'evt-existing', JSON.stringify(null), 'existing-file-id');
  // Re-run the boot SELECT so the in-memory backupLocation map picks the row up.
  await service.onModuleInit();
}

/** Every artefact the restore path could leave behind for a user. */
function leftovers(userDid: string): string[] {
  const dbPath = userDbPath(userDid);
  return ['', '.tmp', '.raw.tmp']
    .map((suffix) => dbPath + suffix)
    .filter((file) => fs.existsSync(file));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('VFS backup store — restore', () => {
  const service = UserMatrixSqliteSyncService.getInstance();

  beforeAll(async () => {
    await service.onModuleInit();
  });

  it('fails the request (no fresh DB) when a cut-over user has lost their delegation', async () => {
    const userDid = 'did:ixo:vfs-restore-no-delegation';
    const storageKey =
      UserMatrixSqliteSyncService.createUserStorageKey(userDid);
    await seedVfsRow(service, storageKey);

    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    service.attachBackupStoresForTests({
      vfs: makeVfsStore(fetchImpl, 'none'),
    });

    const error = await rejection(service.getUserDatabase(userDid));

    expect(error).toBeInstanceOf(VfsAuthError);
    if (!(error instanceof VfsAuthError)) throw new Error('expected a throw');
    expect(error.kind).toBe('no-delegation');
    // The auth failure is raised before any HTTP round-trip.
    expect(fetchImpl).not.toHaveBeenCalled();
    // The whole point: no empty database was created to overwrite the backup
    // with, and no half-written temp was left behind.
    expect(leftovers(userDid)).toEqual([]);
    // The row still names VFS, so the next attempt goes back to the same store.
    expect(
      service.fileEventsDatabase
        .prepare<
          [string],
          { store: string }
        >('SELECT store FROM file_events WHERE storage_key = ?')
        .get(storageKey)?.store,
    ).toBe('vfs');
  });

  it('fails the request (no fresh DB) when the downloaded bytes fail hash verification', async () => {
    const userDid = 'did:ixo:vfs-restore-bad-hash';
    const storageKey =
      UserMatrixSqliteSyncService.createUserStorageKey(userDid);
    await seedVfsRow(service, storageKey);

    const fetchImpl = vi.fn(
      async () =>
        new Response(Buffer.from('these-bytes-hash-to-something-else'), {
          status: 200,
          headers: { 'x-vfs-content-hash': 'deadbeef' },
        }),
    );
    service.attachBackupStoresForTests({ vfs: makeVfsStore(fetchImpl) });

    const error = await rejection(service.getUserDatabase(userDid));

    expect(error).toBeInstanceOf(CheckpointIntegrityError);
    // A mismatch is transient — the store copy is re-fetchable — so nothing
    // is published to disk and no fresh DB takes the backup's place.
    expect(leftovers(userDid)).toEqual([]);
  });

  it('fails the request while the signing key is still landing, and restores once it lands', async () => {
    const userDid = 'did:ixo:vfs-restore-pending';
    // No file_events row: a fresh pod that lost its volume. Skipping the VFS
    // probe here would read a cut-over user's redacted Matrix media as "no
    // backup" and start fresh.
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    service.attachBackupStoresForTests({
      vfs: makeVfsStore(fetchImpl),
      ready: false,
    });

    const error = await rejection(service.getUserDatabase(userDid));

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('expected a throw');
    expect(error.message).toMatch(/not ready/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(leftovers(userDid)).toEqual([]);

    // The key lands: the probe runs, VFS has nothing, Matrix has nothing, and
    // the user legitimately starts fresh.
    service.attachBackupStoresForTests({ vfs: makeVfsStore(fetchImpl) });
    const db = await service.getUserDatabase(userDid);
    db.close();

    expect(fetchImpl).toHaveBeenCalled();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/content?path=');
    expect(fs.existsSync(userDbPath(userDid))).toBe(true);
  });

  it('skips the upload (never Matrix) for a cut-over user while the signing key is still landing', async () => {
    const userDid = 'did:ixo:vfs-restore-upload-not-ready';
    const storageKey =
      UserMatrixSqliteSyncService.createUserStorageKey(userDid);
    await seedVfsRow(service, storageKey);
    makeSmallCheckpointDb(userDbPath(userDid));

    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    service.attachBackupStoresForTests({
      vfs: makeVfsStore(fetchImpl),
      ready: false,
    });
    vi.mocked(uploadMediaToRoom).mockClear();

    await expect(
      service.uploadCheckpointToMatrixStorage({ userDid }),
    ).resolves.toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(uploadMediaToRoom).not.toHaveBeenCalled();
  });
});
