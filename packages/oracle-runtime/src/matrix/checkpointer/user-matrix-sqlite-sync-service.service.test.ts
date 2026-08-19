import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type * as MatrixUploadUtils from './matrix-upload-utils.js';
import { UserMatrixSqliteSyncService } from './user-matrix-sqlite-sync-service.service.js';

// This service reads env config (`SQLITE_DATABASE_PATH`, the derived
// `ORACLE_DID`) at MODULE-LOAD time — both `const config = getConfig()` and
// the `static checkpointsFolder = ...` class field run once, as soon as the
// module above is first imported. Vitest hoists `vi.hoisted`/`vi.mock` calls
// above every import in this file (including the one above), so the env
// vars below are in place before the service module actually loads. The
// callback runs before this file's own imports are linked, so it can only
// use Node globals (`process`), not the `fs`/`path` bindings imported above
// — the directory itself is created afterwards, once `fs` is safe to use
// (the service's own constructor would create it anyway, but tests below
// need it before that). `/tmp` is used directly rather than `os.tmpdir()`
// (unusable here for the same import-binding reason) or `process.env.TMPDIR`
// (flagged by the turbo undeclared-env-var lint) — fine on both macOS and
// Linux CI.
const TMP_DIR = vi.hoisted(() => {
  const dir = `/tmp/user-matrix-sqlite-sync-service-test-${process.pid}-${Date.now()}`;
  process.env.SQLITE_DATABASE_PATH = dir;
  // `@did-<namespace>-<id>:<host>` is the only format `normalizeDid` accepts
  // — it derives `ORACLE_DID`, which `createUserStorageKey` needs.
  process.env.MATRIX_ORACLE_ADMIN_USER_ID =
    '@did-ixo-synctestoracle:matrix.test';
  return dir;
});

// MatrixManager is never reached by the code paths under test (every case
// here returns 'skipped' before any Matrix call), but `matrix-upload-utils.js`
// imports it at module scope, so it still needs a harmless stub.
vi.mock('@ixo/matrix', () => ({
  MatrixManager: {
    getInstance: vi.fn(() => ({
      getClient: vi.fn(() => undefined),
    })),
  },
}));

// Partial mock: keep every real upload-utils export except
// `fetchMediaUploadSizeLimit`, pinned to a tiny cap so any real (non-empty)
// gzip output trips the oversized-skip path deterministically.
vi.mock('./matrix-upload-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MatrixUploadUtils>();
  return {
    ...actual,
    fetchMediaUploadSizeLimit: vi.fn().mockResolvedValue(10),
  };
});

fs.mkdirSync(TMP_DIR, { recursive: true });

function userDbPath(userDid: string): string {
  return UserMatrixSqliteSyncService.getUserCheckpointDbPath(userDid);
}

/** A small, valid checkpoint DB — nowhere near the 10-byte mocked cap once gzipped, but the point is any real gzip output exceeds it. */
function makeSmallCheckpointDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('CREATE TABLE checkpoints (id INTEGER PRIMARY KEY, data BLOB)');
  db.prepare('INSERT INTO checkpoints (data) VALUES (?)').run(
    Buffer.from('hello-checkpoint'),
  );
  db.close();
}

/**
 * ~12.8MB of freelist (200 x 64KB deleted rows) plus one surviving row,
 * `auto_vacuum` left at the SQLite default (NONE) — mirrors the bloat
 * generator in `sqlite-compaction.test.ts`, comfortably over the compaction
 * thresholds (10MB freelist / 20% ratio).
 */
function makeBloatedCheckpointDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('CREATE TABLE data (id INTEGER PRIMARY KEY, payload BLOB)');
  const insert = db.prepare('INSERT INTO data (payload) VALUES (?)');
  for (let i = 0; i < 200; i++) {
    insert.run(Buffer.alloc(64 * 1024, 1));
  }
  db.exec('DELETE FROM data');
  insert.run(Buffer.from('keeper'));
  db.close();
}

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('UserMatrixSqliteSyncService.uploadCheckpointToMatrixStorage', () => {
  const service = UserMatrixSqliteSyncService.getInstance();

  it('returns "skipped" for an oversized snapshot, memoizes the checksum, and the second call on the unchanged file also skips without touching the local file', async () => {
    const userDid = 'did:ixo:sync-test-oversized';
    const dbPath = userDbPath(userDid);
    makeSmallCheckpointDb(dbPath);

    const first = await service.uploadCheckpointToMatrixStorage({ userDid });
    expect(first).toBe('skipped');
    expect(fs.existsSync(dbPath)).toBe(true);

    const statBefore = fs.statSync(dbPath);
    const second = await service.uploadCheckpointToMatrixStorage({ userDid });
    expect(second).toBe('skipped');

    // The memo (`oversizedChecksum`) short-circuits before any re-snapshot —
    // the local file is untouched (same size, same mtime) by the second call.
    const statAfter = fs.statSync(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it('never compacts a bloated checkpoint for an active user', async () => {
    const userDid = 'did:ixo:sync-test-active';
    const dbPath = userDbPath(userDid);
    makeBloatedCheckpointDb(dbPath);
    const sizeBefore = fs.statSync(dbPath).size;

    service.markUserActive(userDid);
    try {
      const result = await service.uploadCheckpointToMatrixStorage({
        userDid,
      });
      expect(result).toBe('skipped');
    } finally {
      service.markUserInactive(userDid);
    }

    // Compaction (which would VACUUM the file and flip auto_vacuum to
    // INCREMENTAL) must not have run: the file size is unchanged...
    const sizeAfter = fs.statSync(dbPath).size;
    expect(sizeAfter).toBe(sizeBefore);
    // ...and it's still genuinely bloated (auto_vacuum still NONE), so the
    // size match above isn't a coincidence of a no-op compaction.
    const db = new Database(dbPath, { readonly: true });
    const autoVacuum: unknown = db.pragma('auto_vacuum', { simple: true });
    db.close();
    expect(autoVacuum).toBe(0);
  });
});
