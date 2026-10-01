/**
 * Streamed export/import, snapshots under concurrent writes, write
 * generations, the constant-memory rebuild (`compact`) and the configurable
 * chunk cache — all on real Durable Object storage inside workerd.
 */
import { createHash } from 'node:crypto';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DoSqliteDatabase } from './database';
import {
  CHUNK_SIZE,
  IMPORT_FILE_SUFFIX,
  PAGES_PER_CHUNK,
  VACUUM_FILE_SUFFIX,
} from './do-vfs';
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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function drain(
  stream: ReadableStream<Uint8Array>,
): Promise<{ bytes: Uint8Array; chunks: number; largest: number }> {
  const parts: Uint8Array[] = [];
  let largest = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    largest = Math.max(largest, value.byteLength);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes: out, chunks: parts.length, largest };
}

/** `rows` rows of `bytesPerRow` deterministic bytes into `blobs`. */
async function fill(
  db: DoSqliteDatabase,
  rows: number,
  bytesPerRow: number,
  seed = 0,
): Promise<void> {
  await db.run(
    'CREATE TABLE IF NOT EXISTS blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL)',
  );
  for (let start = 0; start < rows; start += 32) {
    await db.transaction(async () => {
      for (let id = start; id < Math.min(rows, start + 32); id++) {
        const data = new Uint8Array(bytesPerRow);
        for (let j = 0; j < data.length; j += 61)
          data[j] = (id * 7 + j + seed) & 0xff;
        await db.run('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)', [
          id,
          data,
        ]);
      }
    });
  }
}

describe('snapshot streams', () => {
  it('streams exactly the bytes export() returns, in bounded windows, without touching the cache', async () => {
    await runInDurableObject(stub('snap-equal'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'snap.db');
      await fill(db, 300, 20_000); // ~6 MB
      const exported = await db.export();
      const cachedBefore = db.vfsStats().cachedPages;
      const snapshot = await db.snapshot();
      try {
        expect(snapshot.size).toBe(exported.byteLength);
        const first = await drain(snapshot.open());
        const second = await drain(snapshot.open());
        expect(sha256(first.bytes)).toBe(sha256(exported));
        expect(sha256(second.bytes)).toBe(sha256(exported));
        expect(first.largest).toBeLessThanOrEqual(16 * CHUNK_SIZE);
        expect(first.chunks).toBeGreaterThan(3);
      } finally {
        snapshot.close();
      }
      expect(db.vfsStats().cachedPages).toBe(cachedBefore);
      expect(await db.checksum()).toBe(sha256(exported));
      await db.close();
    });
  });

  it('keeps the snapshot consistent while SQLite commits underneath it', async () => {
    await runInDurableObject(stub('snap-cow'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'cow.db');
      await fill(db, 400, 16_000); // ~6.5 MB
      const before = await db.export();
      const snapshot = await db.snapshot();
      try {
        const reader = snapshot.open().getReader();
        const head = await reader.read(); // one window consumed …
        expect(head.done).toBe(false);
        // … then rewrite rows all over the file (early AND late chunks),
        // grow it, and commit — the snapshot must not see any of it.
        await fill(db, 400, 16_000, 99);
        await fill(db, 100, 16_000, 5); // ids 0..99 again, different bytes
        await db.run('INSERT INTO blobs (id, data) VALUES (?, ?)', [
          10_000,
          new Uint8Array(200_000),
        ]);
        expect(db.fileSize).toBeGreaterThan(before.byteLength);
        const rest = await drain(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(head.value!);
            },
            async pull(controller) {
              const { done, value } = await reader.read();
              if (done) controller.close();
              else controller.enqueue(value);
            },
          }),
        );
        expect(rest.bytes.byteLength).toBe(before.byteLength);
        expect(sha256(rest.bytes)).toBe(sha256(before));
        // A second stream of the same snapshot still reads the old bytes.
        const again = await drain(snapshot.open());
        expect(sha256(again.bytes)).toBe(sha256(before));
      } finally {
        snapshot.close();
      }
      // The live file moved on.
      expect(await db.checksum()).not.toBe(sha256(before));
      const check = await db.get<{ integrity_check: string }>(
        'PRAGMA integrity_check',
      );
      expect(check?.integrity_check).toBe('ok');
      await db.close();
    });
  });

  it('refuses to delete, import into or replace a file while it is snapshotted', async () => {
    await runInDurableObject(stub('snap-guard'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'guard.db');
      await db.run('CREATE TABLE t (x)');
      const snapshot = await db.snapshot();
      await expect(db.import(await db.export())).rejects.toThrow(/snapshot/);
      snapshot.close();
      await db.import(await db.export());
      await db.close();
    });
  });
});

describe('write generation', () => {
  it('bumps on every flush that wrote, never on reads', async () => {
    await runInDurableObject(stub('gen'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'gen.db');
      await db.run('CREATE TABLE t (x)');
      const g1 = db.writeGeneration;
      expect(g1).toBeGreaterThan(0);
      await db.exec('SELECT * FROM t');
      await db.checksum();
      const snapshot = await db.snapshot();
      await drain(snapshot.open());
      snapshot.close();
      expect(db.writeGeneration).toBe(g1);
      await db.run('INSERT INTO t VALUES (1)');
      expect(db.writeGeneration).toBeGreaterThan(g1);
      await db.close();
      // Persisted: a fresh open reads the same generation back.
      const again = await DoSqliteDatabase.open(state, 'gen.db');
      expect(again.writeGeneration).toBeGreaterThan(g1);
      await again.close();
    });
  });
});

describe('importFromStream', () => {
  it('round-trips a 12 MiB file through 64 KiB chunks and keeps the old file until the swap', async () => {
    await runInDurableObject(stub('import-stream'), async (_i, state) => {
      const source = await DoSqliteDatabase.open(state, 'src.db');
      await fill(source, 640, 20_000); // ~12.8 MB
      const exported = await source.export();
      expect(exported.byteLength).toBeGreaterThan(12 * 1024 * 1024);
      const expectedHash = sha256(exported);
      await source.close();

      const target = await DoSqliteDatabase.open(state, 'dst.db');
      await target.run('CREATE TABLE marker (v)');
      const writesBefore = target.vfsStats().storageWrites;
      // Feed the bytes in awkward slices (never chunk-aligned) so the
      // reassembly is exercised, not just the happy 64 KiB path.
      const slices = new ReadableStream<Uint8Array>({
        start(controller) {
          let offset = 0;
          let n = 1;
          while (offset < exported.byteLength) {
            const len = Math.min(3_001 * n, exported.byteLength - offset);
            controller.enqueue(exported.subarray(offset, offset + len));
            offset += len;
            n = (n % 40) + 1;
          }
          controller.close();
        },
      });
      const imported = await target.importFromStream(slices);
      expect(imported).toBe(exported.byteLength);
      expect(target.fileSize).toBe(exported.byteLength);
      expect(await target.checksum()).toBe(expectedHash);
      // Batched writes: many storage transactions, not one giant one.
      expect(target.vfsStats().storageWrites - writesBefore).toBeGreaterThan(5);
      const row = await target.get<{ n: number; total: number }>(
        'SELECT COUNT(*) AS n, SUM(length(data)) AS total FROM blobs',
      );
      expect(row).toEqual({ n: 640, total: 640 * 20_000 });
      expect(target.vfs.fileExists(`dst.db${IMPORT_FILE_SUFFIX}`)).toBe(false);
      await target.close();
    });
  });

  it('rejects a non-SQLite stream and leaves the existing file untouched', async () => {
    await runInDurableObject(stub('import-bad'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'bad.db');
      await db.run('CREATE TABLE keep (v)');
      await db.run('INSERT INTO keep VALUES (42)');
      const before = await db.checksum();
      const junk = new Uint8Array(200_000).fill(7);
      await expect(
        db.importFromStream(new Blob([junk]).stream()),
      ).rejects.toThrow(/not a SQLite 3 database/);
      expect(await db.checksum()).toBe(before);
      expect(db.vfs.fileExists(`bad.db${IMPORT_FILE_SUFFIX}`)).toBe(false);
      const row = await db.get<{ v: number }>('SELECT v FROM keep');
      expect(row?.v).toBe(42);
      await db.close();
    });
  });
});

describe('compact (VACUUM INTO + swap)', () => {
  it('reclaims free pages with bounded dirty memory and keeps the data', async () => {
    await runInDurableObject(stub('compact'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'vac.db');
      await fill(db, 400, 20_000); // ~8 MB
      await db.run('DELETE FROM blobs WHERE id % 2 = 0');
      const usage = await db.pageUsage();
      expect(usage.freelistCount / usage.pageCount).toBeGreaterThan(0.3);
      const before = db.fileSize;
      const genBefore = db.writeGeneration;
      const heapBefore = db.wasmHeapBytes;

      const result = await db.compact();
      expect(result.beforeBytes).toBe(before);
      expect(result.afterBytes).toBeLessThan(before * 0.7);
      expect(db.fileSize).toBe(result.afterBytes);
      expect(db.writeGeneration).toBeGreaterThan(genBefore);
      expect(db.vfs.fileExists(`vac.db${VACUUM_FILE_SUFFIX}`)).toBe(false);
      // The rebuild went through the spill path: no whole-file dirty set,
      // and the wasm heap did not have to grow by the file size.
      expect(db.vfsStats().dirtyPages).toBe(0);
      expect(db.wasmHeapBytes - heapBefore).toBeLessThan(before / 2);

      const row = await db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM blobs',
      );
      expect(row?.n).toBe(200);
      const check = await db.get<{ integrity_check: string }>(
        'PRAGMA integrity_check',
      );
      expect(check?.integrity_check).toBe('ok');
      const after = await db.pageUsage();
      expect(after.freelistCount).toBe(0);
      await db.close();
    });
  });
});

describe('chunk cache budget', () => {
  it('applies cachePages on every open and counts hits/misses', async () => {
    await runInDurableObject(stub('cache-cfg'), async (_i, state) => {
      const small = await DoSqliteDatabase.open(state, 'cache.db', {
        cachePages: 2 * PAGES_PER_CHUNK,
      });
      expect(small.vfsStats().cacheCapacityChunks).toBe(2);
      expect(small.vfsStats().cacheBudgetBytes).toBe(2 * CHUNK_SIZE);
      // ~4.5 MB: past SQLite's own page cache (~2 MB), so scans reach the VFS.
      await fill(small, 450, 10_000);
      const s1 = small.vfsStats();
      await small.exec('SELECT SUM(length(data)) FROM blobs');
      const s2 = small.vfsStats();
      expect(s2.cacheMisses).toBeGreaterThan(s1.cacheMisses);
      expect(s2.cachedPages).toBeLessThanOrEqual(2 * PAGES_PER_CHUNK);
      await small.close();

      const large = await DoSqliteDatabase.open(state, 'cache.db', {
        cachePages: 128 * PAGES_PER_CHUNK,
      });
      expect(large.vfsStats().cacheCapacityChunks).toBe(128);
      await large.exec('SELECT SUM(length(data)) FROM blobs');
      const h1 = large.vfsStats().cacheHits;
      await large.exec('SELECT SUM(length(data)) FROM blobs');
      expect(large.vfsStats().cacheHits).toBeGreaterThan(h1);
      await large.close();
    });
  });
});
