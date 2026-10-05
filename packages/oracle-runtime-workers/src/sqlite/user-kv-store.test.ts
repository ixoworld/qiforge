/**
 * Runs INSIDE workerd (Workers vitest pool): `ctx.kv` over a real
 * `DoSqliteDatabase` in Durable Object storage, and the pod-creator plugin
 * driven through its real plugin API across an eviction and across an
 * owner-copy round trip — the two ways a user object loses its memory.
 */
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { makeRuntimeContext } from '../core/test-fixtures';
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
