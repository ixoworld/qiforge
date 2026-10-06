/**
 * The chunk VFS below SQLite, on real Durable Object storage: byte and page
 * math at chunk boundaries, truncation into a chunk, flush atomicity when a
 * storage statement fails part-way, a clean cache far smaller than the
 * working set, journal spills rolled back, and import/export round trips at
 * the size edges (empty, one page, whole chunks, a truncated gzip, a WAL
 * header).
 */
import { createHash } from 'node:crypto';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  SQLITE_IOERR_FSYNC,
  SQLITE_IOERR_SHORT_READ,
  SQLITE_OK,
  SQLITE_OPEN_CREATE,
  SQLITE_OPEN_MAIN_DB,
  SQLITE_OPEN_READWRITE,
} from 'wa-sqlite';
import { DoSqliteDatabase } from './database';
import { CHUNK_SIZE, DoVfs, VFS_PAGE_SIZE } from './do-vfs';
import type { SqliteTestDO } from './test-do';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      SQLITE_TEST: DurableObjectNamespace<SqliteTestDO>;
    }
  }
}

function stub(name: string): DurableObjectStub<SqliteTestDO> {
  return env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
}

const MAIN = SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE;

function openRaw(vfs: DoVfs, name: string, fileId: number): void {
  expect(vfs.xOpen(name, fileId, MAIN, new DataView(new ArrayBuffer(4)))).toBe(
    SQLITE_OK,
  );
}

function pattern(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 7 + 1) & 0xff;
  return out;
}

function read(
  vfs: DoVfs,
  fileId: number,
  offset: number,
  length: number,
): { rc: number; bytes: Uint8Array } {
  const bytes = new Uint8Array(length).fill(0xaa);
  return { rc: vfs.xRead(fileId, bytes, offset), bytes };
}

function chunkRows(state: DurableObjectState, file: string): number[] {
  return state.storage.sql
    .exec<{
      chunkno: number;
    }>('SELECT chunkno FROM vfs2_chunks WHERE file = ? ORDER BY chunkno', file)
    .toArray()
    .map((row) => row.chunkno);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function streamOf(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

async function bytesOf(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function integrityOk(db: DoSqliteDatabase): Promise<boolean> {
  const row = await db.get<{ integrity_check: string }>(
    'PRAGMA integrity_check',
  );
  return row?.integrity_check === 'ok';
}

describe('chunk math', () => {
  it('writes at the first and last page of a chunk and across a chunk boundary read back after a reopen', async () => {
    await runInDurableObject(stub('vfs-boundaries'), async (_i, state) => {
      const vfs = new DoVfs('raw-boundaries', state.storage);
      openRaw(vfs, 'b.db', 1);
      const firstPage = pattern(VFS_PAGE_SIZE, 1);
      const lastPage = pattern(VFS_PAGE_SIZE, 2);
      const straddle = pattern(10, 3);
      expect(vfs.xWrite(1, firstPage, CHUNK_SIZE)).toBe(SQLITE_OK);
      expect(vfs.xWrite(1, lastPage, 2 * CHUNK_SIZE - VFS_PAGE_SIZE)).toBe(
        SQLITE_OK,
      );
      expect(vfs.xWrite(1, straddle, 3 * CHUNK_SIZE - 5)).toBe(SQLITE_OK);
      expect(vfs.xSync(1, 0)).toBe(SQLITE_OK);
      expect(vfs.xClose(1)).toBe(SQLITE_OK);
      // Chunk 0 was never written: no row for it.
      expect(chunkRows(state, 'b.db')).toEqual([1, 2, 3]);

      const again = new DoVfs('raw-boundaries-2', state.storage);
      openRaw(again, 'b.db', 7);
      expect(again.fileSize('b.db')).toBe(3 * CHUNK_SIZE + 5);
      expect(read(again, 7, CHUNK_SIZE, VFS_PAGE_SIZE).bytes).toEqual(
        firstPage,
      );
      expect(
        read(again, 7, 2 * CHUNK_SIZE - VFS_PAGE_SIZE, VFS_PAGE_SIZE).bytes,
      ).toEqual(lastPage);
      expect(read(again, 7, 3 * CHUNK_SIZE - 5, 10).bytes).toEqual(straddle);
      // A read spanning the chunk 1/2 boundary stitches both chunks.
      const across = read(again, 7, 2 * CHUNK_SIZE - 8, 16).bytes;
      expect(across.subarray(0, 8)).toEqual(lastPage.subarray(-8));
      expect(across.subarray(8)).toEqual(new Uint8Array(8));
      // The never-written chunk reads as zeros.
      expect(read(again, 7, 100, 64).bytes).toEqual(new Uint8Array(64));
      // Past the end: a short read, zero-filled.
      const tail = read(again, 7, 3 * CHUNK_SIZE, 16);
      expect(tail.rc).toBe(SQLITE_IOERR_SHORT_READ);
      expect(tail.bytes.subarray(0, 5)).toEqual(straddle.subarray(5));
      expect(tail.bytes.subarray(5)).toEqual(new Uint8Array(11));
      expect(again.xClose(7)).toBe(SQLITE_OK);
    });
  });

  it('a truncate into the middle of a chunk drops later rows and zeroes the tail, so a regrow reads no stale bytes', async () => {
    await runInDurableObject(stub('vfs-truncate'), async (_i, state) => {
      const vfs = new DoVfs('raw-truncate', state.storage);
      openRaw(vfs, 't.db', 1);
      const whole = pattern(3 * CHUNK_SIZE, 4);
      expect(vfs.xWrite(1, whole, 0)).toBe(SQLITE_OK);
      expect(vfs.xSync(1, 0)).toBe(SQLITE_OK);
      const keep = CHUNK_SIZE + 3 * VFS_PAGE_SIZE;
      expect(vfs.xTruncate(1, keep)).toBe(SQLITE_OK);
      expect(vfs.xSync(1, 0)).toBe(SQLITE_OK);
      expect(chunkRows(state, 't.db')).toEqual([0, 1]);
      // Regrow past the old end with one page in chunk 2.
      const page = pattern(VFS_PAGE_SIZE, 5);
      expect(vfs.xWrite(1, page, 2 * CHUNK_SIZE)).toBe(SQLITE_OK);
      expect(vfs.xSync(1, 0)).toBe(SQLITE_OK);
      expect(vfs.xClose(1)).toBe(SQLITE_OK);

      const again = new DoVfs('raw-truncate-2', state.storage);
      openRaw(again, 't.db', 2);
      expect(again.fileSize('t.db')).toBe(2 * CHUNK_SIZE + VFS_PAGE_SIZE);
      expect(read(again, 2, 0, keep).bytes).toEqual(whole.subarray(0, keep));
      expect(read(again, 2, keep, 2 * CHUNK_SIZE - keep).bytes).toEqual(
        new Uint8Array(2 * CHUNK_SIZE - keep),
      );
      expect(read(again, 2, 2 * CHUNK_SIZE, VFS_PAGE_SIZE).bytes).toEqual(page);
      expect(again.xClose(2)).toBe(SQLITE_OK);
    });
  });
});

describe('flush atomicity', () => {
  it('a storage failure between two chunk statements of one flush writes nothing; the retry writes everything', async () => {
    await runInDurableObject(stub('vfs-flush-fail'), async (_i, state) => {
      let failNext = false;
      let chunkStatements = 0;
      const sql = new Proxy(state.storage.sql, {
        get(target, prop) {
          if (prop === 'exec') {
            return (query: string, ...bindings: SqlStorageValue[]) => {
              if (query.startsWith('INSERT OR REPLACE INTO vfs2_chunks')) {
                chunkStatements++;
                if (failNext && chunkStatements === 2)
                  throw new Error('injected storage failure');
              }
              return target.exec(query, ...bindings);
            };
          }
          const value: unknown = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const storage = new Proxy(state.storage, {
        get(target, prop) {
          if (prop === 'sql') return sql;
          const value: unknown = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const vfs = new DoVfs('raw-flush-fail', storage);
      openRaw(vfs, 'f.db', 1);
      const first = pattern(2 * CHUNK_SIZE, 6);
      expect(vfs.xWrite(1, first, 0)).toBe(SQLITE_OK);
      expect(vfs.xSync(1, 0)).toBe(SQLITE_OK);
      const genBefore = vfs.writeGeneration('f.db');

      // 20 dirty chunks = two chunk statements (16 rows each at most).
      const second = pattern(20 * CHUNK_SIZE, 7);
      expect(vfs.xWrite(1, second, 0)).toBe(SQLITE_OK);
      failNext = true;
      chunkStatements = 0;
      expect(vfs.xSync(1, 0)).toBe(SQLITE_IOERR_FSYNC);
      expect(chunkStatements).toBe(2);
      expect(vfs.lastFlushError).toBeInstanceOf(Error);
      vfs.lastFlushError = undefined;
      // Storage still holds exactly the first flush.
      expect(chunkRows(state, 'f.db')).toEqual([0, 1]);
      const stored = state.storage.sql
        .exec<{
          size: number;
          gen: number;
        }>('SELECT size, gen FROM vfs2_files WHERE file = ?', 'f.db')
        .one();
      expect(stored).toEqual({ size: 2 * CHUNK_SIZE, gen: genBefore });

      failNext = false;
      expect(vfs.xSync(1, 0)).toBe(SQLITE_OK);
      expect(vfs.xClose(1)).toBe(SQLITE_OK);
      const again = new DoVfs('raw-flush-fail-2', state.storage);
      openRaw(again, 'f.db', 2);
      expect(sha256(read(again, 2, 0, 20 * CHUNK_SIZE).bytes)).toBe(
        sha256(second),
      );
      expect(again.xClose(2)).toBe(SQLITE_OK);
    });
  });
});

describe('through SQLite', () => {
  it('a one-chunk clean cache serves a working set many times its size', async () => {
    await runInDurableObject(stub('vfs-tiny-cache'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'tiny.db', {
        cachePages: 16,
      });
      await db.run('PRAGMA cache_size = 8');
      await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB)');
      for (let id = 0; id < 48; id++)
        await db.run('INSERT INTO t VALUES (?, ?)', [id, pattern(30_000, id)]);
      const stats0 = db.vfsStats();
      expect(stats0.cacheCapacityChunks).toBe(1);
      for (let id = 47; id >= 0; id--) {
        const row = await db.get<{ data: Uint8Array }>(
          'SELECT data FROM t WHERE id = ?',
          [id],
        );
        expect(sha256(row!.data)).toBe(sha256(pattern(30_000, id)));
      }
      const stats1 = db.vfsStats();
      expect(stats1.cachedPages).toBeLessThanOrEqual(16);
      expect(stats1.cacheMisses).toBeGreaterThan(stats0.cacheMisses);
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('a transaction that spills pages before COMMIT and then rolls back leaves storage as it was; journals never reach storage', async () => {
    await runInDurableObject(stub('vfs-spill-rollback'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'spill.db');
      await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB)');
      for (let id = 0; id < 20; id++)
        await db.run('INSERT INTO t VALUES (?, ?)', [id, pattern(20_000, id)]);
      // A page cache this small makes SQLite write dirty pages to the
      // database file mid-transaction (a spill), journal in memory.
      await db.run('PRAGMA cache_size = 10');
      const before = await db.checksum();
      const generation = db.writeGeneration;
      const err = await db
        .transaction(async () => {
          for (let id = 0; id < 20; id++)
            await db.run('UPDATE t SET data = ? WHERE id = ?', [
              pattern(20_000, id + 100),
              id,
            ]);
          await db.run('DELETE FROM t WHERE id < 5');
          throw new Error('abort');
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(await db.checksum()).toBe(before);
      for (const id of [0, 7, 19]) {
        const row = await db.get<{ data: Uint8Array }>(
          'SELECT data FROM t WHERE id = ?',
          [id],
        );
        expect(sha256(row!.data)).toBe(sha256(pattern(20_000, id)));
      }
      expect(db.writeGeneration).toBeGreaterThanOrEqual(generation);
      const files = state.storage.sql
        .exec<{ file: string }>('SELECT file FROM vfs2_files ORDER BY file')
        .toArray()
        .map((r) => r.file);
      expect(files).toEqual(['spill.db']);
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });
});

describe('import / export round trips', () => {
  it('an empty stream imports as an empty file that SQLite then initialises', async () => {
    await runInDurableObject(stub('vfs-empty'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'empty.db');
      await db.run('CREATE TABLE gone (x)');
      expect(await db.importFromStream(streamOf())).toBe(0);
      expect(db.fileSize).toBe(0);
      expect(chunkRows(state, 'empty.db')).toEqual([]);
      const snapshot = await db.snapshot();
      try {
        expect((await bytesOf(snapshot.open())).byteLength).toBe(0);
      } finally {
        snapshot.close();
      }
      await db.run('CREATE TABLE fresh (x)');
      expect(
        await db.get("SELECT name FROM sqlite_master WHERE name = 'gone'"),
      ).toBeUndefined();
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('a one-page database exports as exactly one page and round-trips', async () => {
    await runInDurableObject(stub('vfs-one-page'), async (_i, state) => {
      const src = await DoSqliteDatabase.open(state, 'one.db');
      await src.run('PRAGMA user_version = 7');
      const bytes = await src.export();
      expect(bytes.byteLength).toBe(VFS_PAGE_SIZE);
      const dst = await DoSqliteDatabase.open(state, 'one-copy.db');
      expect(await dst.importFromStream(streamOf(bytes))).toBe(VFS_PAGE_SIZE);
      expect(await dst.checksum()).toBe(sha256(bytes));
      expect(await dst.get('PRAGMA user_version')).toEqual({
        user_version: 7,
      });
      await src.close();
      await dst.close();
    });
  });

  it('exactly N chunks, and N chunks plus one byte, stream back byte for byte', async () => {
    await runInDurableObject(stub('vfs-whole-chunks'), async (_i, state) => {
      const vfs = new DoVfs('raw-whole-chunks', state.storage);
      for (const [name, length] of [
        ['exact.db', 2 * CHUNK_SIZE],
        ['plus-one.db', 2 * CHUNK_SIZE + 1],
      ] as const) {
        const bytes = pattern(length, length);
        bytes.set(new TextEncoder().encode('SQLite format 3\0'));
        // Delivered in pieces that do not line up with chunks.
        const parts = [
          bytes.subarray(0, 1000),
          bytes.subarray(1000, CHUNK_SIZE + 3),
          bytes.subarray(CHUNK_SIZE + 3),
        ];
        expect(await vfs.importFromStream(name, streamOf(...parts))).toBe(
          length,
        );
        expect(chunkRows(state, name)).toHaveLength(
          Math.ceil(length / CHUNK_SIZE),
        );
        const snapshot = vfs.openSnapshot(name);
        try {
          expect(sha256(await bytesOf(snapshot.open()))).toBe(sha256(bytes));
        } finally {
          snapshot.close();
        }
        expect(await vfs.fileChecksum(name)).toBe(sha256(bytes));
      }
    });
  });

  it('a truncated gzip fails the import and leaves the existing file untouched', async () => {
    await runInDurableObject(stub('vfs-truncated-gzip'), async (_i, state) => {
      const src = await DoSqliteDatabase.open(state, 'src.db');
      await src.run('CREATE TABLE t (x BLOB)');
      for (let i = 0; i < 10; i++)
        await src.run('INSERT INTO t VALUES (?)', [pattern(50_000, i)]);
      const image = await src.export();
      const gz = await bytesOf(
        streamOf(image).pipeThrough(new CompressionStream('gzip')),
      );
      const cut = gz.subarray(0, gz.byteLength - 20);
      const dst = await DoSqliteDatabase.open(state, 'dst.db');
      await dst.run('CREATE TABLE keep (x)');
      await dst.run("INSERT INTO keep VALUES ('still here')");
      const before = await dst.checksum();
      await expect(
        dst.importFromStream(
          streamOf(cut).pipeThrough(new DecompressionStream('gzip')),
        ),
      ).rejects.toThrow();
      expect(await dst.checksum()).toBe(before);
      expect(await dst.get('SELECT x FROM keep')).toEqual({ x: 'still here' });
      expect(
        state.storage.sql
          .exec<{
            n: number;
          }>(
            "SELECT count(*) AS n FROM vfs2_files WHERE file LIKE '%.importing'",
          )
          .one().n,
      ).toBe(0);
      await src.close();
      await dst.close();
    });
  });

  it('a file whose header says WAL imports in rollback-journal mode and opens', async () => {
    await runInDurableObject(stub('vfs-wal-header'), async (_i, state) => {
      const src = await DoSqliteDatabase.open(state, 'wal-src.db');
      await src.run('CREATE TABLE t (x)');
      await src.run("INSERT INTO t VALUES ('from a WAL file')");
      const image = (await src.export()).slice();
      image[18] = 2;
      image[19] = 2;
      for (const [name, load] of [
        [
          'wal-stream.db',
          (db: DoSqliteDatabase) => db.importFromStream(streamOf(image)),
        ],
        ['wal-bytes.db', (db: DoSqliteDatabase) => db.import(image)],
      ] as const) {
        const db = await DoSqliteDatabase.open(state, name);
        await load(db);
        const header = (await db.export()).subarray(18, 20);
        expect(Array.from(header)).toEqual([1, 1]);
        expect(await db.get('SELECT x FROM t')).toEqual({
          x: 'from a WAL file',
        });
        expect(await integrityOk(db)).toBe(true);
        await db.close();
      }
      await src.close();
    });
  });
});
