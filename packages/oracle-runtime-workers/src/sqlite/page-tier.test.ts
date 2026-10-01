/* eslint-disable no-console -- tests print measured numbers */
/**
 * The R2 page tier, exercised INSIDE workerd against a real Durable Object
 * and miniflare's R2 (`TIER_TEST` in test/wrangler.test.jsonc): eviction to
 * segments, cold reads resolved through statement and transaction retries,
 * writes over cold chunks (partial rows, free-list reuse), snapshots taken
 * across an eviction, truncation, import/wipe cleanup, orphan sweeps, and
 * the billing grain.
 */
import { createHash } from 'node:crypto';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  type Checkpoint,
  emptyCheckpoint,
  uuid6,
} from '@langchain/langgraph-checkpoint';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DoSqliteDatabase } from './database';
import { CHUNK_SIZE } from './do-vfs';
import {
  FULL_MASK,
  PageTierError,
  SEGMENT_BYTES,
  SEGMENT_CHUNKS,
  type PageTierOptions,
} from './page-tier';
import { SqliteSaver } from './sqlite-saver';
import type { SqliteTestDO } from './test-do';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      SQLITE_TEST: DurableObjectNamespace<SqliteTestDO>;
      TIER_TEST: R2Bucket;
    }
  }
}

const PERIOD_MS = 1000;

function stub(name: string): DurableObjectStub<SqliteTestDO> {
  return env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
}

interface Clock {
  now: number;
}

function tierOptions(prefix: string, clock: Clock): PageTierOptions {
  return {
    bucket: env.TIER_TEST,
    prefix,
    periodMs: PERIOD_MS,
    evictAfterPeriods: 2,
    now: () => clock.now,
  };
}

/**
 * Open with a tier and a deliberately tiny clean cache (4 chunks): the
 * default 4 MiB would keep these small files entirely in memory after an
 * eviction, and the point is to exercise the cold path.
 */
async function openTiered(
  state: DurableObjectState,
  prefix: string,
  clock: Clock,
  file = 'tier.db',
): Promise<DoSqliteDatabase> {
  return DoSqliteDatabase.open(state, file, {
    tier: tierOptions(prefix, clock),
    cachePages: 64,
  });
}

/** First chunk whose bytes differ between two whole-file images, with a note. */
function firstDifferingChunk(a: Uint8Array, b: Uint8Array): string | null {
  if (a.byteLength !== b.byteLength)
    return `length ${a.byteLength} vs ${b.byteLength}`;
  const chunks = Math.ceil(a.byteLength / CHUNK_SIZE);
  for (let c = 0; c < chunks; c++) {
    const from = c * CHUNK_SIZE;
    const to = Math.min(a.byteLength, from + CHUNK_SIZE);
    for (let i = from; i < to; i++) {
      if (a[i] !== b[i]) {
        const page = Math.floor((i - from) / 4096);
        let zerosB = 0;
        for (let j = from; j < to; j++) if (b[j] === 0) zerosB++;
        return `chunk ${c} (segment ${Math.floor(c / SEGMENT_CHUNKS)} slot ${c % SEGMENT_CHUNKS}) page ${page} byte ${i - from}; after-image zero bytes in chunk: ${zerosB}/${to - from}`;
      }
    }
  }
  return null;
}

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.TIER_TEST.list({
      prefix: `${prefix}/`,
      ...(cursor !== undefined && { cursor }),
    });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}

/** A row's blob: a cheap per-row pattern so every page differs. */
function rowBytes(id: number, size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let j = 0; j < size; j += 32) data[j] = (id * 7 + j) & 0xff;
  data[size - 1] = id & 0xff;
  return data;
}

async function fill(
  db: DoSqliteDatabase,
  from: number,
  to: number,
  size: number,
): Promise<void> {
  await db.run(
    'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, data BLOB NOT NULL)',
  );
  for (let start = from; start < to; start += 16) {
    await db.transaction(async () => {
      for (let id = start; id < Math.min(to, start + 16); id++) {
        await db.run('INSERT INTO t (id, data) VALUES (?, ?)', [
          id,
          rowBytes(id, size),
        ]);
      }
    });
  }
}

async function hotRows(
  state: DurableObjectState,
  file: string,
): Promise<number> {
  return state.storage.sql
    .exec<{
      n: number;
    }>('SELECT count(*) AS n FROM vfs2_chunks WHERE file = ?', file)
    .one().n;
}

async function partialRows(
  state: DurableObjectState,
  file: string,
): Promise<number> {
  return state.storage.sql
    .exec<{
      n: number;
    }>(
      'SELECT count(*) AS n FROM vfs2_chunks WHERE file = ? AND mask != ?',
      file,
      FULL_MASK,
    )
    .one().n;
}

async function integrityOk(db: DoSqliteDatabase): Promise<boolean> {
  const rows = await db.exec<{ integrity_check: string }>(
    'PRAGMA integrity_check',
  );
  const ok = rows.length === 1 && rows[0]?.integrity_check === 'ok';
  if (!ok)
    console.log(
      `[page-tier] integrity_check: ${rows
        .slice(0, 6)
        .map((r) => r.integrity_check)
        .join(' | ')}`,
    );
  return ok;
}

async function sha256(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash('sha256');
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest('hex');
}

/** Age everything: the clock jumps past the eviction horizon. */
function age(clock: Clock): void {
  clock.now += 3 * PERIOD_MS;
}

describe('R2 page tier', () => {
  it('without a tier every row is full and nothing is written to R2', async () => {
    await runInDurableObject(stub('tier-off'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'off.db');
      await fill(db, 0, 32, 40_000);
      expect(db.tierEnabled).toBe(false);
      expect(await partialRows(state, 'off.db')).toBe(0);
      const status = db.tierStatus();
      expect(status.enabled).toBe(false);
      expect(status.coldSegments).toBe(0);
      expect(await db.tierFlush()).toMatchObject({ skipped: 'no-tier' });
      await db.close();
    });
    expect(await listKeys('tier-off')).toEqual([]);
  });

  it('evicts untouched chunks into segments and serves them back through SQL', async () => {
    const clock: Clock = { now: 10 * PERIOD_MS };
    const prefix = 'tier-evict';
    await runInDurableObject(stub(prefix), async (_i, state) => {
      const db = await openTiered(state, prefix, clock);
      await fill(db, 0, 64, 60_000); // ≈ 4 MB → ~64 chunks → 4+ segments
      const before = await db.checksum();
      const hotBefore = await hotRows(state, 'tier.db');
      expect(hotBefore).toBeGreaterThan(50);

      // Nothing is old yet: the pass evicts nothing.
      db.recordAccess();
      const early = await db.tierFlush();
      expect(early.evictedChunks).toBe(0);

      age(clock);
      const pass = await db.tierFlush();
      expect(pass.skipped).toBeUndefined();
      expect(pass.evictedChunks).toBeGreaterThan(40);
      expect(pass.segmentsRewritten).toBeGreaterThan(3);
      const hotAfter = await hotRows(state, 'tier.db');
      expect(hotAfter).toBeLessThan(hotBefore - 40);

      const keys = await listKeys(prefix);
      expect(keys.length).toBe(pass.segmentsRewritten);
      for (const key of keys) {
        const object = await env.TIER_TEST.head(key);
        expect(object?.size).toBe(SEGMENT_BYTES);
      }

      // The file is byte-identical through the async window path…
      expect(await db.checksum()).toBe(before);

      // …and readable through SQL: cold pages miss, resolve, and retry.
      const status0 = db.tierStatus();
      const sum = await db.get<{ n: number; total: number }>(
        'SELECT count(*) AS n, sum(length(data)) AS total FROM t',
      );
      expect(sum).toEqual({ n: 64, total: 64 * 60_000 });
      const row = await db.get<{ data: Uint8Array }>(
        'SELECT data FROM t WHERE id = 37',
      );
      expect(row?.data).toEqual(rowBytes(37, 60_000));
      const status1 = db.tierStatus();
      expect(status1.coldMisses).toBeGreaterThan(status0.coldMisses);
      expect(status1.missResolutions).toBeGreaterThan(status0.missResolutions);
      expect(status1.retries).toBeGreaterThan(status0.retries);
      expect(status1.r2Gets).toBeGreaterThan(0);
      console.log(
        `[page-tier] evicted ${pass.evictedChunks} chunks into ${pass.segmentsRewritten} segments; full scan cost ${status1.coldMisses - status0.coldMisses} misses, ${status1.retries - status0.retries} retries, ${status1.r2Gets - status0.r2Gets} GETs`,
      );
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('a transaction that touches cold chunks rolls back, resolves and commits', async () => {
    const clock: Clock = { now: 10 * PERIOD_MS };
    const prefix = 'tier-tx';
    await runInDurableObject(stub(prefix), async (_i, state) => {
      let db = await openTiered(state, prefix, clock);
      await fill(db, 0, 48, 60_000);
      age(clock);
      expect((await db.tierFlush()).evictedChunks).toBeGreaterThan(30);
      // SQLite's own page cache still holds the file: reopen so the reads
      // below go through the VFS.
      await db.close();
      db = await openTiered(state, prefix, clock);
      const retriesBefore = db.tierStatus().retries;
      let runs = 0;
      await db.transaction(async () => {
        runs++;
        // Reads a cold row, then writes it: the first attempt misses.
        const row = await db.get<{ data: Uint8Array }>(
          'SELECT data FROM t WHERE id = 20',
        );
        const updated = row!.data.slice();
        updated[0] = 0xee;
        await db.run('UPDATE t SET data = ? WHERE id = 20', [updated]);
        await db.run('DELETE FROM t WHERE id = 21');
      });
      expect(runs).toBeGreaterThan(1);
      expect(db.tierStatus().retries).toBeGreaterThan(retriesBefore);
      const after = await db.get<{ data: Uint8Array }>(
        'SELECT data FROM t WHERE id = 20',
      );
      expect(after?.data[0]).toBe(0xee);
      expect(await db.get('SELECT id FROM t WHERE id = 21')).toBeUndefined();
      expect(db.inTransaction).toBe(false);
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('writes over cold chunks never miss: free-list reuse lands as partial rows that merge on the next pass', async () => {
    const clock: Clock = { now: 10 * PERIOD_MS };
    const prefix = 'tier-partial';
    await runInDurableObject(stub(prefix), async (_i, state) => {
      const db = await openTiered(state, prefix, clock);
      await fill(db, 0, 64, 60_000);
      // Free half the pages, then make everything cold.
      await db.run('DELETE FROM t WHERE id % 2 = 0');
      age(clock);
      const pass1 = await db.tierFlush();
      expect(pass1.evictedChunks).toBeGreaterThan(30);
      const misses0 = db.tierStatus().coldMisses;
      // New rows reuse free-list pages: SQLite writes them without reading.
      await fill(db, 100, 132, 60_000);
      const partial = await partialRows(state, 'tier.db');
      console.log(
        `[page-tier] free-list reuse produced ${partial} partial rows, ${db.tierStatus().coldMisses - misses0} cold misses`,
      );
      expect(partial).toBeGreaterThan(0);
      const checksum = await db.checksum();
      // Everything still reads correctly, old and new.
      for (const id of [1, 33, 63, 100, 131]) {
        const row = await db.get<{ data: Uint8Array }>(
          'SELECT data FROM t WHERE id = ?',
          [id],
        );
        expect(row?.data).toEqual(rowBytes(id, 60_000));
      }
      expect(await integrityOk(db)).toBe(true);
      // The next pass merges the partial rows into their segments.
      age(clock);
      const pass2 = await db.tierFlush({ force: true });
      expect(pass2.evictedChunks).toBeGreaterThan(0);
      expect(await partialRows(state, 'tier.db')).toBe(0);
      expect(await db.checksum()).toBe(checksum);
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('a snapshot opened before writes still reads the pre-image, cold pages included', async () => {
    const clock: Clock = { now: 10 * PERIOD_MS };
    const prefix = 'tier-snapshot';
    await runInDurableObject(stub(prefix), async (_i, state) => {
      const db = await openTiered(state, prefix, clock);
      await fill(db, 0, 48, 60_000);
      age(clock);
      expect((await db.tierFlush()).evictedChunks).toBeGreaterThan(30);
      const before = await db.checksum();
      const snapshot = await db.snapshot();
      try {
        // No eviction while a snapshot is open.
        expect(await db.tierFlush({ force: true })).toMatchObject({
          skipped: 'snapshot-open',
        });
        // Overwrite cold rows (partial writes over cold bases) and delete some.
        for (let id = 0; id < 48; id += 3) {
          await db.run('UPDATE t SET data = ? WHERE id = ?', [
            rowBytes(id + 1000, 60_000),
            id,
          ]);
        }
        await db.run('DELETE FROM t WHERE id % 5 = 0');
        expect(await sha256(snapshot.open())).toBe(before);
        expect(await sha256(snapshot.open())).toBe(before);
      } finally {
        snapshot.close();
      }
      expect(await db.checksum()).not.toBe(before);
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('truncation invalidates R2 slots so a regrown file never reads stale bytes', async () => {
    const clock: Clock = { now: 10 * PERIOD_MS };
    const prefix = 'tier-truncate';
    await runInDurableObject(stub(prefix), async (_i, state) => {
      const db = await openTiered(state, prefix, clock);
      // auto_vacuum=FULL makes DELETE truncate the file at commit.
      await db.run('PRAGMA auto_vacuum = FULL');
      await fill(db, 0, 64, 60_000);
      age(clock);
      expect((await db.tierFlush()).evictedChunks).toBeGreaterThan(40);
      const sizeBefore = db.fileSize;
      await db.run('DELETE FROM t WHERE id >= 8');
      expect(db.fileSize).toBeLessThan(sizeBefore / 2);
      const status = db.tierStatus();
      expect(status.coldChunks).toBeLessThan(
        Math.ceil(sizeBefore / CHUNK_SIZE),
      );
      // Regrow with different content over the truncated range.
      await fill(db, 200, 264, 60_000);
      for (const id of [3, 200, 263]) {
        const row = await db.get<{ data: Uint8Array }>(
          'SELECT data FROM t WHERE id = ?',
          [id],
        );
        expect(row?.data).toEqual(rowBytes(id, 60_000));
      }
      expect(await integrityOk(db)).toBe(true);
      age(clock);
      await db.tierFlush();
      expect(await integrityOk(db)).toBe(true);
      const sum = await db.get<{ n: number }>('SELECT count(*) AS n FROM t');
      expect(sum?.n).toBe(8 + 64);
      await db.close();
    });
  });

  it('a snapshot still reads truncated-away cold chunks from the generation it opened on', async () => {
    const clock: Clock = { now: 10 * PERIOD_MS };
    const prefix = 'tier-truncate-snap';
    await runInDurableObject(stub(prefix), async (_i, state) => {
      const db = await openTiered(state, prefix, clock);
      await db.run('PRAGMA auto_vacuum = FULL');
      await fill(db, 0, 48, 60_000);
      age(clock);
      await db.tierFlush();
      const before = await db.checksum();
      const snapshot = await db.snapshot();
      try {
        await db.run('DELETE FROM t WHERE id >= 4');
        expect(await sha256(snapshot.open())).toBe(before);
      } finally {
        snapshot.close();
      }
      // The deleted segments are only removed after the snapshot closed.
      const status = db.tierStatus();
      expect(status.pendingDeletes).toBeGreaterThan(0);
      await db.tierMaintenance();
      expect(db.tierStatus().pendingDeletes).toBe(0);
      await db.close();
    });
  });

  it('import over a tiered file drops the map, wipe removes the objects', async () => {
    const clock: Clock = { now: 10 * PERIOD_MS };
    const prefix = 'tier-import';
    let fresh: Uint8Array;
    await runInDurableObject(stub(`${prefix}-src`), async (_i, state) => {
      const src = await DoSqliteDatabase.open(state, 'src.db');
      await fill(src, 0, 4, 1000);
      fresh = await src.export();
      await src.close();
    });
    await runInDurableObject(stub(prefix), async (_i, state) => {
      const db = await openTiered(state, prefix, clock);
      await fill(db, 0, 32, 60_000);
      age(clock);
      expect((await db.tierFlush()).evictedChunks).toBeGreaterThan(20);
      expect((await listKeys(prefix)).length).toBeGreaterThan(0);
      await db.import(fresh!);
      expect(db.tierStatus().coldSegments).toBe(0);
      const n = await db.get<{ n: number }>('SELECT count(*) AS n FROM t');
      expect(n?.n).toBe(4);
      await db.tierMaintenance();
      expect(await listKeys(prefix)).toEqual([]);
      // Tier again, then wipe.
      await fill(db, 10, 42, 60_000);
      age(clock);
      await db.tierFlush();
      expect((await listKeys(prefix)).length).toBeGreaterThan(0);
      await db.close();
      await DoSqliteDatabase.wipe(state, 'tier.db', {
        tier: tierOptions(prefix, clock),
      });
      expect(await listKeys(prefix)).toEqual([]);
    });
  });

  it('the orphan sweep removes objects the map does not reference and keeps the ones it does', async () => {
    const clock: Clock = { now: 10 * PERIOD_MS };
    const prefix = 'tier-orphans';
    await runInDurableObject(stub(prefix), async (_i, state) => {
      const db = await openTiered(state, prefix, clock);
      await fill(db, 0, 32, 60_000);
      age(clock);
      await db.tierFlush();
      const referenced = await listKeys(prefix);
      expect(referenced.length).toBeGreaterThan(0);
      // A crash between a put and its map update leaves an orphan.
      await env.TIER_TEST.put(`${prefix}/tier.db/999.7`, new Uint8Array(16));
      await env.TIER_TEST.put(`${prefix}/tier.db/0.999`, new Uint8Array(16));
      const swept = await db.tierMaintenance({ sweep: true });
      expect(swept.deleted).toBe(2);
      expect((await listKeys(prefix)).sort()).toEqual(referenced.sort());
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('a segment missing from R2 surfaces as a PageTierError, not silent zeros', async () => {
    const clock: Clock = { now: 10 * PERIOD_MS };
    const prefix = 'tier-missing';
    await runInDurableObject(stub(prefix), async (_i, state) => {
      let db = await openTiered(state, prefix, clock);
      await fill(db, 0, 32, 60_000);
      age(clock);
      await db.tierFlush();
      const keys = await listKeys(prefix);
      await env.TIER_TEST.delete(keys);
      // Reopen: SQLite's page cache would otherwise still serve the rows.
      await db.close();
      db = await openTiered(state, prefix, clock);
      await expect(
        db.exec('SELECT sum(length(data)) FROM t'),
      ).rejects.toBeInstanceOf(PageTierError);
      await db.close();
    });
  });

  it('chunks touched within the horizon stay hot; recordAccess persists touches across a reopen', async () => {
    const clock: Clock = { now: 10 * PERIOD_MS };
    const prefix = 'tier-recent';
    await runInDurableObject(stub(prefix), async (_i, state) => {
      let db = await openTiered(state, prefix, clock);
      await fill(db, 0, 64, 60_000);
      age(clock);
      // Touch a few rows now, persist the touches, reopen (memory gone), then evict.
      for (const id of [5, 6, 7])
        await db.get('SELECT data FROM t WHERE id = ?', [id]);
      db.recordAccess();
      await db.close();
      db = await openTiered(state, prefix, clock);
      clock.now += PERIOD_MS; // still inside evictAfterPeriods = 2
      const pass = await db.tierFlush();
      expect(pass.evictedChunks).toBeGreaterThan(0);
      const misses0 = db.tierStatus().coldMisses;
      for (const id of [5, 6, 7])
        await db.get('SELECT data FROM t WHERE id = ?', [id]);
      // The touched rows' chunks were kept hot: no miss serving them.
      expect(db.tierStatus().coldMisses).toBe(misses0);
      await db.close();
    });
  });

  it('materialize pulls everything home (VACUUM path) and compact keeps the data', async () => {
    const clock: Clock = { now: 10 * PERIOD_MS };
    const prefix = 'tier-materialize';
    await runInDurableObject(stub(prefix), async (_i, state) => {
      const db = await openTiered(state, prefix, clock);
      await fill(db, 0, 64, 60_000);
      await db.run('DELETE FROM t WHERE id % 2 = 1');
      age(clock);
      await db.tierFlush();
      const checksum = await db.checksum();
      const { chunks } = await db.materializeTier();
      expect(chunks).toBeGreaterThan(20);
      expect(db.tierStatus().coldSegments).toBe(0);
      expect(await db.checksum()).toBe(checksum);
      // compact() materializes on its own before VACUUM.
      age(clock);
      await db.tierFlush();
      const { beforeBytes, afterBytes } = await db.compact();
      expect(afterBytes).toBeLessThan(beforeBytes);
      expect(db.tierStatus().coldSegments).toBe(0);
      const n = await db.get<{ n: number }>('SELECT count(*) AS n FROM t');
      expect(n?.n).toBe(32);
      expect(await integrityOk(db)).toBe(true);
      await db.tierMaintenance({ sweep: true });
      expect(await listKeys(prefix)).toEqual([]);
      await db.close();
    });
  });

  it('a 24 MB file: eviction, random cold reads, and the whole-file export match', async () => {
    const clock: Clock = { now: 10 * PERIOD_MS };
    const prefix = 'tier-large';
    await runInDurableObject(stub(prefix), async (_i, state) => {
      const db = await openTiered(state, prefix, clock);
      const rows = 400;
      await fill(db, 0, rows, 60_000);
      const checksum = await db.checksum();
      const imageBefore = await db.export();
      age(clock);
      let evicted = 0;
      let passes = 0;
      for (;;) {
        const pass = await db.tierFlush();
        evicted += pass.evictedChunks;
        passes++;
        if (pass.remaining === 0) break;
      }
      const status = db.tierStatus();
      console.log(
        `[page-tier] 24 MB: ${evicted} chunks evicted in ${passes} pass(es); hot ${status.hotRows} rows, cold ${status.coldSegments} segments`,
      );
      expect(status.hotRows).toBeLessThan(40);
      expect(status.coldSegments).toBeGreaterThan(20);
      const t0 = Date.now();
      let misses = 0;
      for (let i = 0; i < 20; i++) {
        const id = (i * 7919) % rows;
        const m0 = db.tierStatus().coldMisses;
        const row = await db.get<{ data: Uint8Array }>(
          'SELECT data FROM t WHERE id = ?',
          [id],
        );
        expect(row?.data).toEqual(rowBytes(id, 60_000));
        if (db.tierStatus().coldMisses > m0) misses++;
      }
      console.log(
        `[page-tier] 20 random cold reads in ${Date.now() - t0} ms (${misses} needed a fetch)`,
      );
      const imageAfter = await db.export();
      const diff = firstDifferingChunk(imageBefore, imageAfter);
      if (diff !== null)
        console.log(`[page-tier] 24 MB image differs: ${diff}`);
      expect(diff).toBeNull();
      expect(await db.checksum()).toBe(checksum);
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('billing grain: a checkpointer turn costs the same rows with the tier on (plus one access row)', async () => {
    const clock: Clock = { now: 10 * PERIOD_MS };
    const prefix = 'tier-billing';
    await runInDurableObject(stub(prefix), async (_i, state) => {
      const db = await openTiered(state, prefix, clock, 'billing.db');
      const saver = new SqliteSaver(db);
      await saver.setup();
      const all: Array<HumanMessage | AIMessage> = [];
      const turn = async (n: number): Promise<void> => {
        const filler = `turn ${n}: `.repeat(200);
        all.push(
          new HumanMessage({ id: `h-${n}`, content: `q ${n} ${filler}` }),
          new AIMessage({ id: `a-${n}`, content: `a ${n} ${filler}` }),
        );
        const checkpoint: Checkpoint = {
          ...emptyCheckpoint(),
          id: uuid6(n),
          channel_values: { messages: all },
        };
        await saver.put(
          { configurable: { thread_id: 'bt', checkpoint_ns: '' } },
          checkpoint,
          { source: 'loop', step: n, parents: {} },
        );
        await saver.putWrites(
          {
            configurable: {
              thread_id: 'bt',
              checkpoint_ns: '',
              checkpoint_id: uuid6(n),
            },
          },
          [['tools', `tool output ${n} ${'x'.repeat(2000)}`]],
          `task-${n}`,
        );
        db.recordAccess();
      };
      for (let n = 1; n <= 5; n++) await turn(n);
      const before = db.vfsStats();
      for (let n = 6; n <= 15; n++) await turn(n);
      const after = db.vfsStats();
      const rowsPerTurn = (after.rowsWritten - before.rowsWritten) / 10;
      console.log(
        `[page-tier] rows written/turn with the tier on: ${rowsPerTurn.toFixed(1)}`,
      );
      expect(rowsPerTurn).toBeLessThan(21);
      // Evict the older checkpoints, then keep chatting: the working set stays hot.
      age(clock);
      const pass = await db.tierFlush();
      const missesBefore = db.tierStatus().coldMisses;
      for (let n = 16; n <= 20; n++) await turn(n);
      const missesDuring = db.tierStatus().coldMisses - missesBefore;
      console.log(
        `[page-tier] after evicting ${pass.evictedChunks} chunks, 5 more turns caused ${missesDuring} cold misses`,
      );
      const tuple = await saver.getTuple({
        configurable: { thread_id: 'bt', checkpoint_ns: '' },
      });
      const messages = tuple?.checkpoint.channel_values['messages'];
      expect(Array.isArray(messages) ? messages.length : 0).toBe(40);
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('segments are chunk-aligned 1 MiB objects keyed by generation', () => {
    expect(SEGMENT_CHUNKS * CHUNK_SIZE).toBe(SEGMENT_BYTES);
    expect(SEGMENT_BYTES).toBe(1024 * 1024);
  });
});
