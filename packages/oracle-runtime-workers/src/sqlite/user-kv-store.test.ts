/**
 * Runs INSIDE workerd (Workers vitest pool): `ctx.kv` over a real
 * `DoSqliteDatabase` in Durable Object storage, and the pod-creator plugin
 * driven through its real plugin API across an eviction and across an
 * owner-copy round trip — the two ways a user object loses its memory.
 */
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { makeRuntimeContext } from '../core/test-fixtures';
import {
  USER_KV_MAX_ENTRIES_PER_NAMESPACE,
  USER_KV_MAX_VALUE_BYTES,
  UserKvLimitError,
} from '../core/user-kv';
import type { PluginTool, RuntimeContext } from '../plugin-api/types';
import { PodCreatorPlugin } from '../plugins/pod-creator';
import { DoSqliteDatabase } from './database';
import type { SqliteTestDO } from './test-do';
import { SqliteUserKv } from './user-kv-store';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      SQLITE_TEST: DurableObjectNamespace<SqliteTestDO>;
    }
  }
}

const DB_FILE = 'user.db';

function stub(name: string): DurableObjectStub<SqliteTestDO> {
  return env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
}

function tool(tools: readonly PluginTool[], name: string): PluginTool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

describe('SqliteUserKv (ctx.kv over the user database)', () => {
  it('round-trips JSON values per namespace and deletes', async () => {
    await runInDurableObject(stub('kv-basic'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, DB_FILE);
      const kv = new SqliteUserKv(db);
      await kv.set('ns-a', 'k', { a: [1, 2], b: 'x' });
      expect(await kv.get('ns-a', 'k')).toEqual({ a: [1, 2], b: 'x' });
      expect(await kv.get('ns-b', 'k')).toBeUndefined();
      expect(await kv.update('ns-a', 'k', () => undefined)).toBeUndefined();
      expect(await kv.get('ns-a', 'k')).toBeUndefined();
      await kv.set('ns-a', 'k2', 1);
      await kv.delete('ns-a', 'k2');
      expect(await kv.get('ns-a', 'k2')).toBeUndefined();
      await db.close();
    });
  });

  it('expires an entry idle past its TTL; a read slides the deadline', async () => {
    await runInDurableObject(stub('kv-ttl'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, DB_FILE);
      let t = 1_000;
      const kv = new SqliteUserKv(db, { now: () => t });
      await kv.set('ns', 'k', 'v', { idleTtlMs: 100 });
      t += 60;
      expect(await kv.get('ns', 'k')).toBe('v');
      t += 60;
      expect(await kv.get('ns', 'k')).toBe('v');
      t += 100;
      expect(await kv.get('ns', 'k')).toBeUndefined();
      const rows = await db.exec(
        `SELECT key FROM user_kv WHERE namespace = 'ns'`,
      );
      expect(rows).toEqual([]);
      await db.close();
    });
  });

  it('evicts the least recently used entries of the namespace beyond maxEntries', async () => {
    await runInDurableObject(stub('kv-lru'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, DB_FILE);
      const kv = new SqliteUserKv(db);
      await kv.set('ns', 'a', 1, { maxEntries: 2 });
      await kv.set('ns', 'b', 2, { maxEntries: 2 });
      await kv.set('other', 'z', 0);
      expect(await kv.get('ns', 'a')).toBe(1);
      await kv.set('ns', 'c', 3, { maxEntries: 2 });
      expect(await kv.get('ns', 'b')).toBeUndefined();
      expect(await kv.get('ns', 'a')).toBe(1);
      expect(await kv.get('ns', 'c')).toBe(3);
      expect(await kv.get('other', 'z')).toBe(0);
      await db.close();
    });
  });

  it('serialises concurrent read-modify-writes: no update is lost', async () => {
    await runInDurableObject(stub('kv-atomic'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, DB_FILE);
      const kv = new SqliteUserKv(db);
      await kv.set('ns', 'list', []);
      await Promise.all(
        Array.from({ length: 12 }, (_, n) =>
          kv.update('ns', 'list', (current) =>
            Array.isArray(current) ? [...current, n] : [n],
          ),
        ),
      );
      const list = await kv.get('ns', 'list');
      expect(
        Array.isArray(list) ? [...list].sort((a, b) => a - b) : list,
      ).toEqual(Array.from({ length: 12 }, (_, n) => n));
      await db.close();
    });
  });

  it('rows survive the object being evicted without a close', async () => {
    const s = stub('kv-evict');
    await runInDurableObject(s, async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, DB_FILE);
      await new SqliteUserKv(db).set('ns', 'k', { kept: true });
    });
    await evictDurableObject(s);
    await runInDurableObject(stub('kv-evict'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, DB_FILE);
      expect(await new SqliteUserKv(db).get('ns', 'k')).toEqual({ kept: true });
      await db.close();
    });
  });
});

/** The rejection of `promise`, which must be a `UserKvLimitError`. */
async function limitError(
  promise: Promise<unknown>,
): Promise<UserKvLimitError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof UserKvLimitError)) {
    throw new Error(`expected a UserKvLimitError, got ${String(error)}`);
  }
  return error;
}

/** A JSON string value whose stored form is exactly `bytes` long. */
const jsonOfBytes = (bytes: number): string => 'x'.repeat(bytes - 2);

type Row = { namespace: string; key: string; value: string; bytes: number };

const rowsOf = (db: DoSqliteDatabase): Promise<Row[]> =>
  db.exec<Row>(
    `SELECT namespace, key, value, bytes FROM user_kv ORDER BY namespace, key`,
  );

/** Open a fresh database in its own object, run `body`, close it. */
async function withKvDb(
  name: string,
  body: (db: DoSqliteDatabase) => Promise<void>,
): Promise<void> {
  await runInDurableObject(stub(name), async (_i, state) => {
    const db = await DoSqliteDatabase.open(state, DB_FILE);
    try {
      await body(db);
    } finally {
      await db.close();
    }
  });
}

describe('SqliteUserKv hard caps', () => {
  it("refuses a value above the byte cap and records each row's UTF-8 size", async () => {
    await withKvDb('kv-cap-value', async (db) => {
      const kv = new SqliteUserKv(db);
      await kv.set('ns', 'at-cap', jsonOfBytes(USER_KV_MAX_VALUE_BYTES));
      await kv.set('ns', 'wide', 'é');
      const error = await limitError(
        kv.set('ns', 'over', jsonOfBytes(USER_KV_MAX_VALUE_BYTES + 1)),
      );
      expect(error).toMatchObject({
        name: 'UserKvLimitError',
        limit: 'value',
        namespace: 'ns',
        max: USER_KV_MAX_VALUE_BYTES,
        actual: USER_KV_MAX_VALUE_BYTES + 1,
      });
      expect(error.message).toContain('"ns"');
      // Row bytes: namespace + key + value JSON ('"é"' is 4 bytes).
      expect((await rowsOf(db)).map((r) => [r.key, Number(r.bytes)])).toEqual([
        ['at-cap', 2 + 6 + USER_KV_MAX_VALUE_BYTES],
        ['wide', 2 + 4 + 4],
      ]);
    });
  });

  it('rejects a maxEntries above the per-namespace cap instead of clamping it', async () => {
    await withKvDb('kv-cap-max-entries', async (db) => {
      const kv = new SqliteUserKv(db);
      await kv.set('ns', 'k', 1, {
        maxEntries: USER_KV_MAX_ENTRIES_PER_NAMESPACE,
      });
      await expect(
        kv.update('ns', 'k', () => 2, {
          maxEntries: USER_KV_MAX_ENTRIES_PER_NAMESPACE + 1,
        }),
      ).rejects.toThrow(RangeError);
      expect(await kv.get('ns', 'k')).toBe(1);
    });
  });

  it('refuses a new key beyond the namespace cap; replacing a key at the cap succeeds', async () => {
    await withKvDb('kv-cap-namespace', async (db) => {
      const kv = new SqliteUserKv(db, {
        limits: { maxEntriesPerNamespace: 3 },
      });
      for (const key of ['a', 'b', 'c']) await kv.set('ns', key, key);
      const error = await limitError(kv.set('ns', 'd', 'd'));
      expect(error).toMatchObject({
        limit: 'namespace-entries',
        namespace: 'ns',
        max: 3,
        actual: 4,
      });
      await kv.set('ns', 'a', 'replaced');
      await kv.set('other', 'd', 'd');
      expect((await rowsOf(db)).map((r) => [r.namespace, r.key])).toEqual([
        ['ns', 'a'],
        ['ns', 'b'],
        ['ns', 'c'],
        ['other', 'd'],
      ]);
      // A write whose own maxEntries trim makes room is not refused.
      await kv.set('ns', 'd', 'd', { maxEntries: 3 });
      expect(await kv.get('ns', 'd')).toBe('d');
      expect(await kv.get('ns', 'b')).toBeUndefined();
    });
  });

  it('refuses a new key beyond the total-entries cap across namespaces', async () => {
    await withKvDb('kv-cap-entries', async (db) => {
      const kv = new SqliteUserKv(db, { limits: { maxTotalEntries: 3 } });
      await kv.set('ns-a', 'a1', 1);
      await kv.set('ns-a', 'a2', 2);
      await kv.set('ns-b', 'b1', 3);
      const error = await limitError(kv.update('ns-b', 'b2', () => 4));
      expect(error).toMatchObject({
        limit: 'entries',
        namespace: 'ns-b',
        max: 3,
        actual: 4,
      });
      expect(await rowsOf(db)).toHaveLength(3);
      await kv.delete('ns-a', 'a1');
      await kv.set('ns-b', 'b2', 4);
      expect(await kv.get('ns-b', 'b2')).toBe(4);
    });
  });

  it('counts only the size difference when a key is replaced', async () => {
    await withKvDb('kv-cap-bytes', async (db) => {
      // A row counts namespace + key + value JSON: each row below carries 5
      // bytes of names ('ns-a' + 'a'), and every value is a JSON string (two
      // quote bytes plus its letters).
      const kv = new SqliteUserKv(db, { limits: { maxTotalBytes: 30 } });
      await kv.set('ns-a', 'a', 'aaaaaaaa'); // 5 + 10 = 15 bytes
      await kv.set('ns-b', 'b', 'bbbbbbbb'); // 15 bytes, total 30
      await kv.set('ns-a', 'a', 'AAAAAAAA'); // same size: 30
      await kv.set('ns-a', 'a', 'aa'); // shrinks: 24
      await kv.set('ns-b', 'b', 'bbbbbbbbbbbbbb'); // grows by 6: 30
      const error = await limitError(kv.set('ns-a', 'a', 'aaa'));
      expect(error).toMatchObject({
        limit: 'bytes',
        namespace: 'ns-a',
        max: 30,
        actual: 31,
      });
      expect(await kv.get('ns-a', 'a')).toBe('aa');
    });
  });

  it('sweeps expired rows of every namespace before refusing', async () => {
    await withKvDb('kv-cap-sweep', async (db) => {
      let t = 1_000;
      const kv = new SqliteUserKv(db, {
        now: () => t,
        limits: { maxTotalEntries: 2 },
      });
      await kv.set('ns-a', 'a1', 1, { idleTtlMs: 100 });
      await kv.set('ns-a', 'a2', 2, { idleTtlMs: 100 });
      await expect(kv.set('ns-b', 'b1', 3)).rejects.toThrow(UserKvLimitError);
      t += 100;
      // Both rows are still in the table, expired: the store is "full".
      expect(await rowsOf(db)).toHaveLength(2);
      await kv.set('ns-b', 'b1', 3);
      await kv.set('ns-b', 'b2', 4);
      expect((await rowsOf(db)).map((r) => [r.namespace, r.key])).toEqual([
        ['ns-b', 'b1'],
        ['ns-b', 'b2'],
      ]);
    });
  });

  it('a refused write changes nothing: the previous value stays and its trim is rolled back', async () => {
    await withKvDb('kv-cap-rollback', async (db) => {
      const kv = new SqliteUserKv(db, { limits: { maxTotalBytes: 30 } });
      await kv.set('ns', 'a', 'aaaaaaaa', { maxEntries: 2 }); // 3 + 10 bytes
      await kv.set('ns', 'b', 'bbbbbbbb', { maxEntries: 2 }); // 3 + 10 bytes
      const before = await rowsOf(db);
      // The write's trim would evict `a`, but 13 + (3 + 25) bytes is still over.
      const big = jsonOfBytes(25);
      await expect(kv.set('ns', 'c', big, { maxEntries: 2 })).rejects.toThrow(
        UserKvLimitError,
      );
      await expect(kv.update('ns', 'b', () => big)).rejects.toThrow(
        UserKvLimitError,
      );
      expect(await rowsOf(db)).toEqual(before);
    });
  });

  it('a store already above a cap can still shrink, replace in place and delete', async () => {
    await withKvDb('kv-cap-over', async (db) => {
      await new SqliteUserKv(db).set('ns', 'a', 'aaaaaaaa');
      await new SqliteUserKv(db).set('ns', 'b', 'bbbbbbbb');
      // The same file under tighter caps than it was written with.
      const kv = new SqliteUserKv(db, {
        limits: { maxEntriesPerNamespace: 1, maxTotalBytes: 5 },
      });
      await kv.set('ns', 'a', 'a');
      await kv.set('ns', 'a', 'z');
      await expect(kv.set('ns', 'b', 'bbbbbbbbb')).rejects.toThrow(
        UserKvLimitError,
      );
      await expect(kv.set('ns', 'c', 'c')).rejects.toThrow(UserKvLimitError);
      expect(await kv.update('ns', 'b', () => undefined)).toBeUndefined();
      expect(await kv.get('ns', 'a')).toBe('z');
    });
  });

  it('counts namespace and key bytes toward the store-wide byte cap', async () => {
    await withKvDb('kv-cap-names', async (db) => {
      const kv = new SqliteUserKv(db, { limits: { maxTotalBytes: 50 } });
      await kv.set('ns', 'k', 1); // 2 + 1 + 1 = 4 bytes
      // A 1-byte value under a 100-character key: 2 + 100 + 1 bytes.
      const longKey = 'k'.repeat(100);
      const error = await limitError(kv.set('ns', longKey, 1));
      expect(error).toMatchObject({
        limit: 'bytes',
        namespace: 'ns',
        max: 50,
        actual: 4 + 103,
      });
      expect(error.message).toContain('namespace, key and value');
      expect((await rowsOf(db)).map((r) => [r.key, Number(r.bytes)])).toEqual([
        ['k', 4],
      ]);
    });
  });

  it('measures and sweeps through indexes: covering bytes, namespace recency, expiry', async () => {
    await withKvDb('kv-cap-plan', async (db) => {
      await new SqliteUserKv(db).set('ns', 'k', 1);
      const plan = await db.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM user_kv`,
      );
      expect(plan.map((row) => row.detail).join('\n')).toContain(
        'COVERING INDEX idx_user_kv_bytes',
      );
      const namespacePlan = await db.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM user_kv WHERE namespace = ?`,
        ['ns'],
      );
      expect(namespacePlan.map((row) => row.detail).join('\n')).toContain(
        'COVERING INDEX idx_user_kv_recency',
      );
      const sweepPlan = await db.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN DELETE FROM user_kv WHERE expires_at IS NOT NULL AND expires_at <= ?`,
        [0],
      );
      expect(sweepPlan.map((row) => row.detail).join('\n')).toContain(
        'INDEX idx_user_kv_expiry',
      );
    });
  });
});

describe('SqliteUserKv on a table from an older build', () => {
  /** `user_kv` as builds before the hard caps created it. */
  const OLD_SHAPE = `CREATE TABLE user_kv (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    idle_ttl_ms INTEGER,
    expires_at INTEGER,
    touched_seq INTEGER NOT NULL,
    PRIMARY KEY (namespace, key)
  )`;

  it('adds and backfills the bytes column, creates the indexes, and enforces the caps on the old rows', async () => {
    await withKvDb('kv-old-shape', async (db) => {
      await db.run(OLD_SHAPE);
      await db.run(
        `CREATE INDEX idx_user_kv_recency ON user_kv(namespace, touched_seq)`,
      );
      await db.run(
        `INSERT INTO user_kv (namespace, key, value, idle_ttl_ms, expires_at, touched_seq)
         VALUES ('ns', 'a', '"aaaaaaaa"', NULL, NULL, 1),
                ('ns', 'ü', '"é"', NULL, NULL, 2)`,
      );
      const kv = new SqliteUserKv(db, { limits: { maxTotalBytes: 30 } });
      // The old rows read back unchanged through the upgraded table.
      expect(await kv.get('ns', 'a')).toBe('aaaaaaaa');
      const columns = (
        await db.exec<{ name: string }>(`PRAGMA table_info(user_kv)`)
      ).map((c) => c.name);
      expect(columns).toContain('bytes');
      const indexes = (
        await db.exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_kv' ORDER BY name`,
        )
      ).map((i) => i.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_user_kv_bytes',
          'idx_user_kv_expiry',
          'idx_user_kv_recency',
          'idx_user_kv_seq',
        ]),
      );
      // Backfilled row bytes: namespace + key + value, all UTF-8 ('ü' and
      // 'é' are 2 bytes each).
      expect((await rowsOf(db)).map((r) => [r.key, Number(r.bytes)])).toEqual([
        ['a', 2 + 1 + 10],
        ['ü', 2 + 2 + 4],
      ]);
      // 21 bytes backfilled: a 9-byte row fits, an 11-byte one does not.
      await expect(kv.set('ns', 'c', 'cccccc')).rejects.toThrow(
        UserKvLimitError,
      );
      await kv.set('ns', 'c', 'cccc');
      // Setup is idempotent: a second store over the same file is a no-op.
      const again = new SqliteUserKv(db);
      expect(await again.get('ns', 'c')).toBe('cccc');
      expect((await rowsOf(db)).map((r) => [r.key, Number(r.bytes)])).toEqual([
        ['a', 13],
        ['c', 9],
        ['ü', 8],
      ]);
    });
  });
});

describe('pod-creator design state across a reset (plugin API over ctx.kv)', () => {
  /** A request context of the default test user/thread over `db`. */
  const ctxOver = (db: DoSqliteDatabase): RuntimeContext =>
    makeRuntimeContext({}, { ambient: { kv: new SqliteUserKv(db) } });

  /**
   * Start a design and let the qualify specialist submit its section, all
   * through the plugin's own tools and sub-agents.
   */
  async function designThroughQualify(db: DoSqliteDatabase): Promise<void> {
    const plugin = new PodCreatorPlugin();
    await tool(plugin.getTools(), 'start_pod_design').handler(
      { brief: 'Community solar monitoring' },
      ctxOver(db),
    );
    const [scorer] = await plugin.getRequestSubAgents(ctxOver(db));
    expect(scorer?.name).toBe('service_intent_scorer');
    const scorerTools = Array.isArray(scorer?.tools) ? scorer.tools : [];
    await tool(scorerTools, 'submit_section').handler(
      { content: { score: 0.82, fit: 'strong' } },
      ctxOver(db),
    );
  }

  /** What a brand-new plugin instance sees for the default thread. */
  async function readBack(db: DoSqliteDatabase): Promise<{
    blueprint: unknown;
    specialists: string[];
  }> {
    const plugin = new PodCreatorPlugin();
    const blueprint = await tool(plugin.getTools(), 'get_blueprint').handler(
      { roles: ['service_intent_scorer'] },
      ctxOver(db),
    );
    const subs = await plugin.getRequestSubAgents(ctxOver(db));
    return { blueprint, specialists: subs.map((s) => s.name).sort() };
  }

  const expected = {
    blueprint: {
      started: true,
      brief: 'Community solar monitoring',
      readiness: { stage: 'architect', completedStages: ['qualify'] },
      content: { service_intent_scorer: { score: 0.82, fit: 'strong' } },
    },
    specialists: [
      'claims_architect',
      'service_architect',
      'ucan_rights_architect',
    ],
  };

  it('survives the user object being evicted (fresh instance, fresh plugin)', async () => {
    const s = stub('pod-evict');
    await runInDurableObject(s, async (_i, state) => {
      await designThroughQualify(await DoSqliteDatabase.open(state, DB_FILE));
    });
    await evictDurableObject(s);
    const after = await runInDurableObject(
      stub('pod-evict'),
      async (_i, state) => {
        const db = await DoSqliteDatabase.open(state, DB_FILE);
        const out = await readBack(db);
        await db.close();
        return out;
      },
    );
    expect(after).toMatchObject(expected);
  });

  it('survives an owner-copy round trip (working copy wiped, file re-imported)', async () => {
    const s = stub('pod-owner-copy');
    const ownerCopy = await runInDurableObject(s, async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, DB_FILE);
      await designThroughQualify(db);
      const bytes = await db.export();
      await db.close();
      await DoSqliteDatabase.wipe(state, DB_FILE);
      return bytes;
    });
    await evictDurableObject(s);
    const after = await runInDurableObject(
      stub('pod-owner-copy'),
      async (_i, state) => {
        const db = await DoSqliteDatabase.open(state, DB_FILE);
        // The wiped working copy holds no design any more…
        expect(await readBack(db)).toMatchObject({
          blueprint: { started: false },
          specialists: [],
        });
        // …until the owner copy is imported, as a cold start does.
        await db.import(ownerCopy);
        const out = await readBack(db);
        await db.close();
        return out;
      },
    );
    expect(after).toMatchObject(expected);
  });
});
