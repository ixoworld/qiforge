import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DoSqliteDatabase } from '../sqlite/database';
import { SqliteHarnessStore } from './harness-store';

describe('durable harness storage', () => {
  it('retains uncertain operations across reopen and isolates result access by session', async () => {
    const stub = env.SQLITE_TEST.get(
      env.SQLITE_TEST.idFromName('harness-store'),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      let db = await DoSqliteDatabase.open(state, 'harness.db');
      let store = new SqliteHarnessStore(db);
      expect(
        await store.startOperation('s1', 'send-fingerprint', 'operation'),
      ).toBe(true);
      const id = await store.putResult('s1', 'x'.repeat(5000));
      expect(await store.putResult('s1', 'x'.repeat(5000))).toBe(id);
      await db.close();
      db = await DoSqliteDatabase.open(state, 'harness.db');
      store = new SqliteHarnessStore(db);
      expect(
        await store.startOperation('s2', 'send-fingerprint', 'retry'),
      ).toBe(false);
      expect(await store.readResult('s2', id, 0)).toBeNull();
      expect(await store.readResult('s1', id, 4000)).toHaveLength(1000);
      await store.completeOperation('operation');
      expect(await store.startOperation('s1', 'send-fingerprint', 'new')).toBe(
        true,
      );
      await db.close();
    });
  });
});
