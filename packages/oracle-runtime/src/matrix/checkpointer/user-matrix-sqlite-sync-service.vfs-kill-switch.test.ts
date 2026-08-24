import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as MatrixUploadUtils from './matrix-upload-utils.js';
import { UserMatrixSqliteSyncService } from './user-matrix-sqlite-sync-service.service.js';
import { VfsCheckpointStore } from './vfs-checkpoint-store.js';
import type { VfsDelegationMinter } from '../../plugins/vfs/vfs-auth.js';

// A dedicated file (rather than a case inside
// `user-matrix-sqlite-sync-service.vfs-cutover.test.ts`) because
// `CHECKPOINT_VFS_BACKUP_ENABLED` is read once via the module-scoped
// `const config = getConfig()` in the service module, at import time — the
// only way to exercise the kill switch OFF is to set the env var before
// that module is ever imported in this process, i.e. in this file's own
// `vi.hoisted` block. The cutover file needs the switch ON (the schema
// default) for its "first successful upload" case, so the two values can't
// share one module load.
const TMP_DIR = vi.hoisted(() => {
  const dir = `/tmp/user-matrix-sqlite-sync-service-vfs-kill-switch-test-${process.pid}-${Date.now()}`;
  process.env.SQLITE_DATABASE_PATH = dir;
  process.env.MATRIX_ORACLE_ADMIN_USER_ID =
    '@did-ixo-vfskillswitchoracle:matrix.test';
  process.env.ORACLE_ENTITY_DID = 'did:ixo:entity:vfs-kill-switch-oracle';
  process.env.CHECKPOINT_VFS_BACKUP_ENABLED = 'false';
  // The full Tier-0 base-env-schema must parse successfully for the
  // `.enum(['true','false']).transform(...)` above to actually produce a
  // boolean — otherwise `getBaseEnvConfig()` falls back to the raw,
  // untransformed `process.env` string 'false', which is truthy and would
  // make this test pass for the wrong reason (or fail outright). Filling in
  // the rest of `requiredTier0Vars` from `base-env-schema.test.ts` avoids
  // that.
  process.env.ORACLE_NAME = 'VfsKillSwitchTestOracle';
  process.env.NETWORK = 'devnet';
  process.env.MATRIX_RECOVERY_PHRASE = 'word '.repeat(12).trim();
  process.env.MATRIX_ORACLE_ADMIN_PASSWORD = 'pw';
  process.env.MATRIX_ACCOUNT_ROOM_ID = '!room:matrix.test';
  process.env.MATRIX_VALUE_PIN = '1234';
  process.env.ORACLE_DID = 'did:ixo:vfskillswitchoracle';
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

vi.mock('./matrix-upload-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MatrixUploadUtils>();
  return {
    ...actual,
    fetchMediaUploadSizeLimit: vi.fn().mockResolvedValue(10_000_000),
    uploadMediaToRoom: vi
      .fn()
      .mockResolvedValue({ eventId: 'evt-1', event: {}, storageKey: '' }),
  };
});

import { uploadMediaToRoom } from './matrix-upload-utils.js';

fs.mkdirSync(TMP_DIR, { recursive: true });

function userDbPath(userDid: string): string {
  return UserMatrixSqliteSyncService.getUserCheckpointDbPath(userDid);
}

function makeSmallCheckpointDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('CREATE TABLE checkpoints (id INTEGER PRIMARY KEY, data BLOB)');
  db.prepare('INSERT INTO checkpoints (data) VALUES (?)').run(
    Buffer.from('hello-checkpoint'),
  );
  db.close();
}

function fakeMinter(): VfsDelegationMinter {
  return {
    getServiceDelegation: vi.fn(async () => ({
      token: 'CAR',
      with: 'ixo:filesystem/oracle-data/did:ixo:entity:vfs-kill-switch-oracle',
    })),
    createInvocationFromDelegation: vi.fn(async () => ({ invocation: 'INV' })),
  };
}

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('VFS backup store — kill switch', () => {
  const service = UserMatrixSqliteSyncService.getInstance();

  beforeAll(async () => {
    await service.onModuleInit();
  });

  it('kill switch off keeps new users on Matrix', async () => {
    const userDid = 'did:ixo:vfs-kill-switch-user';
    makeSmallCheckpointDb(userDbPath(userDid));

    // A VFS store IS attached (the oracle has a signing key and the user
    // has a valid delegation) — CHECKPOINT_VFS_BACKUP_ENABLED=false must
    // still keep this never-cut-over user on Matrix.
    const fetchImpl = vi.fn(async () => {
      throw new Error('VFS must not be called when the kill switch is off');
    });
    service.attachBackupStoresForTests({
      vfs: new VfsCheckpointStore({
        minter: fakeMinter(),
        urls: { vfs: 'https://vfs.test', store: 'https://store.test' },
        oracleEntityDid: 'did:ixo:entity:vfs-kill-switch-oracle',
        knownFileId: () => undefined,
        timeoutMs: 5000,
        fetchImpl,
      }),
    });

    const status = await service.uploadCheckpointToMatrixStorage({ userDid });
    expect(status).toBe('uploaded');
    expect(uploadMediaToRoom).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
