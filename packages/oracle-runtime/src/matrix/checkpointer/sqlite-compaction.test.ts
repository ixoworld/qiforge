import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compactSqliteFileIfBloated,
  snapshotSqliteFile,
} from './sqlite-compaction.js';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compaction-'));
  return path.join(dir, 'test.db');
}

/** ~12.8MB of freelist (200 x 64KB deleted rows) plus one surviving row. */
function makeBloatedDb(dbPath: string): void {
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

describe('compactSqliteFileIfBloated', () => {
  it('vacuums a bloated file, flips it to incremental mode, and keeps the data', () => {
    const dbPath = tmpDbPath();
    makeBloatedDb(dbPath);
    const bloatedSize = fs.statSync(dbPath).size;

    const result = compactSqliteFileIfBloated(dbPath);

    expect(result.compacted).toBe(true);
    expect(result.fileBytesBefore).toBeGreaterThan(result.fileBytesAfter);
    expect(fs.statSync(dbPath).size).toBeLessThan(bloatedSize);

    const db = new Database(dbPath, { readonly: true });
    expect(db.pragma('auto_vacuum', { simple: true })).toBe(2);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM data').pluck().get();
    db.close();
    expect(rows).toBe(1);
  });

  it('leaves a compact file alone', () => {
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    db.exec('CREATE TABLE data (id INTEGER PRIMARY KEY, payload BLOB)');
    db.prepare('INSERT INTO data (payload) VALUES (?)').run(
      Buffer.from('keeper'),
    );
    db.close();
    const sizeBefore = fs.statSync(dbPath).size;

    const result = compactSqliteFileIfBloated(dbPath);

    expect(result.compacted).toBe(false);
    expect(fs.statSync(dbPath).size).toBe(sizeBefore);
  });
});

describe('snapshotSqliteFile', () => {
  it('produces a compact, valid copy and leaves the source untouched', () => {
    const dbPath = tmpDbPath();
    makeBloatedDb(dbPath);
    const sourceSize = fs.statSync(dbPath).size;
    const snapshotPath = dbPath + '.snapshot.tmp';

    snapshotSqliteFile(dbPath, snapshotPath);

    // Source untouched, snapshot free of the ~12MB freelist.
    expect(fs.statSync(dbPath).size).toBe(sourceSize);
    expect(fs.statSync(snapshotPath).size).toBeLessThan(sourceSize / 4);

    const snapshot = new Database(snapshotPath, { readonly: true });
    const rows = snapshot
      .prepare('SELECT COUNT(*) AS n FROM data')
      .pluck()
      .get();
    snapshot.close();
    expect(rows).toBe(1);
  });
});
