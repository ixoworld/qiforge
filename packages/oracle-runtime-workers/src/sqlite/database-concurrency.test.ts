/**
 * One SQLite connection shared by every async chain of a Durable Object:
 * statements issued outside `transaction()` must never run inside another
 * chain's open transaction (they would commit or roll back with it), a
 * transaction's own statements must never wait for themselves, and nested
 * transactions are savepoints. Runs inside workerd against real DO storage
 * (and miniflare's R2 for the cold-miss retry).
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DoSqliteDatabase } from './database';
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

function stub(name: string): DurableObjectStub<SqliteTestDO> {
  return env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every pending microtask and a macrotask turn run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function integrityOk(db: DoSqliteDatabase): Promise<boolean> {
  const rows = await db.exec<{ integrity_check: string }>(
    'PRAGMA integrity_check',
  );
  return rows.length === 1 && rows[0]?.integrity_check === 'ok';
}

async function kv(db: DoSqliteDatabase): Promise<Record<string, number>> {
  const rows = await db.exec<{ k: string; v: number }>(
    'SELECT k, v FROM kv ORDER BY k',
  );
  return Object.fromEntries(rows.map((row) => [row.k, row.v]));
}

async function openKv(
  state: DurableObjectState,
  file: string,
): Promise<DoSqliteDatabase> {
  const db = await DoSqliteDatabase.open(state, file);
  await db.run('CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
  await db.run("INSERT INTO kv (k, v) VALUES ('a', 0), ('b', 0)");
  return db;
}

describe('statements outside a transaction', () => {
  it('wait for an open transaction instead of joining it (a rollback cannot take them along)', async () => {
    await runInDurableObject(stub('conc-lost-write'), async (_i, state) => {
      const db = await openKv(state, 'conc.db');
      const entered = deferred<void>();
      const fail = deferred<void>();
      const tx = db
        .transaction(async () => {
          await db.run("UPDATE kv SET v = 1 WHERE k = 'a'");
          entered.resolve();
          await fail.promise;
          throw new Error('turn failed');
        })
        .catch((error: unknown) => error);
      await entered.promise;
      let updated = false;
      const outside = db
        .run("UPDATE kv SET v = 7 WHERE k = 'b'")
        .then((result) => {
          updated = true;
          return result;
        });
      await settle();
      // Still queued behind the transaction: it has not run inside it.
      expect(updated).toBe(false);
      fail.resolve();
      expect(await tx).toBeInstanceOf(Error);
      expect((await outside).changes).toBe(1);
      expect(await kv(db)).toEqual({ a: 0, b: 7 });
      expect(db.inTransaction).toBe(false);
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('issued while a transaction is rolling back run after the rollback, not inside it', async () => {
    await runInDurableObject(stub('conc-rollback-gap'), async (_i, state) => {
      const db = await openKv(state, 'gap.db');
      const thrown = deferred<void>();
      // The outside chain wakes up in the same microtask burst as the
      // transaction's catch handler, i.e. between the body's rejection and
      // the ROLLBACK statement.
      const outside = thrown.promise.then(() =>
        db.run("INSERT INTO kv (k, v) VALUES ('c', 3)"),
      );
      const tx = db
        .transaction(async () => {
          await db.run("UPDATE kv SET v = 1 WHERE k = 'a'");
          thrown.resolve();
          throw new Error('body failed');
        })
        .catch((error: unknown) => error);
      expect(await tx).toBeInstanceOf(Error);
      expect((await outside).changes).toBe(1);
      expect(await kv(db)).toEqual({ a: 0, b: 0, c: 3 });
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('survive a transaction that rolls back to retry a cold miss', async () => {
    const prefix = 'conc-cold-retry';
    const clock = { now: 10_000 };
    await runInDurableObject(stub(prefix), async (_i, state) => {
      const open = () =>
        DoSqliteDatabase.open(state, 'cold.db', {
          tier: {
            bucket: env.TIER_TEST,
            prefix,
            periodMs: 1000,
            evictAfterPeriods: 2,
            now: () => clock.now,
          },
          cachePages: 64,
        });
      let db = await open();
      await db.run(
        'CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL)',
      );
      for (let id = 0; id < 32; id++) {
        await db.run('INSERT INTO blobs (id, data) VALUES (?, ?)', [
          id,
          new Uint8Array(60_000).fill(id),
        ]);
      }
      await db.run('CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
      clock.now += 3000;
      expect((await db.tierFlush()).evictedChunks).toBeGreaterThan(20);
      await db.close();
      db = await open();

      const entered = deferred<void>();
      const go = deferred<void>();
      let attempts = 0;
      const tx = db.transaction(async () => {
        attempts++;
        entered.resolve();
        await go.promise;
        // Cold: the first attempt misses, rolls back and runs again.
        const row = await db.get<{ data: Uint8Array }>(
          'SELECT data FROM blobs WHERE id = 17',
        );
        await db.run("INSERT OR REPLACE INTO kv (k, v) VALUES ('tx', ?)", [
          row?.data[0] ?? -1,
        ]);
      });
      await entered.promise;
      const outside = db.run("INSERT INTO kv (k, v) VALUES ('outside', 1)");
      await settle();
      go.resolve();
      await tx;
      await outside;
      expect(attempts).toBeGreaterThan(1);
      expect(await kv(db)).toEqual({ outside: 1, tx: 17 });
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });
});

describe('transactions', () => {
  it('nest as savepoints: an inner failure rolls back only the inner work', async () => {
    await runInDurableObject(stub('conc-nested'), async (_i, state) => {
      const db = await openKv(state, 'nested.db');
      await db.transaction(async () => {
        await db.run("UPDATE kv SET v = 1 WHERE k = 'a'");
        await db.transaction(async () => {
          await db.run("UPDATE kv SET v = 2 WHERE k = 'b'");
        });
        const inner = await db
          .transaction(async () => {
            await db.run("UPDATE kv SET v = 99 WHERE k = 'a'");
            await db.transaction(async () => {
              await db.run("INSERT INTO kv (k, v) VALUES ('deep', 1)");
            });
            throw new Error('inner failed');
          })
          .catch((error: unknown) => error);
        expect(inner).toBeInstanceOf(Error);
        expect(db.inTransaction).toBe(true);
      });
      expect(await kv(db)).toEqual({ a: 1, b: 2 });
      expect(db.inTransaction).toBe(false);

      // A failing outer transaction takes its committed savepoints along.
      await db
        .transaction(async () => {
          await db.transaction(async () => {
            await db.run("UPDATE kv SET v = 5 WHERE k = 'b'");
          });
          throw new Error('outer failed');
        })
        .catch(() => undefined);
      expect(await kv(db)).toEqual({ a: 1, b: 2 });
      expect(db.inTransaction).toBe(false);
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('a failed COMMIT leaves the transaction state clean for the next one', async () => {
    await runInDurableObject(stub('conc-commit-fail'), async (_i, state) => {
      const db = await openKv(state, 'commit.db');
      await db.run('PRAGMA foreign_keys = ON');
      await db.run(
        'CREATE TABLE child (id INTEGER PRIMARY KEY, k TEXT REFERENCES kv(k) DEFERRABLE INITIALLY DEFERRED)',
      );
      // A deferred foreign key fails at COMMIT, not at the statement.
      const failed = await db
        .transaction(async () => {
          await db.run("INSERT INTO child (id, k) VALUES (1, 'missing')");
        })
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      expect(db.inTransaction).toBe(false);
      await db.transaction(async () => {
        expect(db.inTransaction).toBe(true);
        await db.run("UPDATE kv SET v = 4 WHERE k = 'a'");
      });
      expect(db.inTransaction).toBe(false);
      expect(await kv(db)).toEqual({ a: 4, b: 0 });
      expect(
        await db.get<{ n: number }>('SELECT count(*) AS n FROM child'),
      ).toEqual({ n: 0 });
      await db.close();
    });
  });

  it('statements and transactions inside withoutTransactions() run without waiting for themselves', async () => {
    await runInDurableObject(stub('conc-without-tx'), async (_i, state) => {
      const db = await openKv(state, 'without.db');
      const result = await db.withoutTransactions(async () => {
        await db.run("UPDATE kv SET v = 1 WHERE k = 'a'");
        await db.withoutTransactions(() =>
          db.run("UPDATE kv SET v = 2 WHERE k = 'b'"),
        );
        await db.transaction(async () => {
          await db.run("INSERT INTO kv (k, v) VALUES ('c', 3)");
        });
        return 'done';
      });
      expect(result).toBe('done');
      expect(await kv(db)).toEqual({ a: 1, b: 2, c: 3 });
      await expect(
        db.transaction(() => db.withoutTransactions(async () => 1)),
      ).rejects.toThrow(/cannot run inside a transaction/);
      await db.close();
    });
  });

  it('soak: interleaved autocommit statements and transactions keep every committed write and nothing else', async () => {
    await runInDurableObject(stub('conc-soak'), async (_i, state) => {
      const db = await openKv(state, 'soak.db');
      await db.run('CREATE TABLE log (id INTEGER PRIMARY KEY, src TEXT)');
      let seed = 12345;
      const random = (): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
      };
      // Every chain starts after, and yields for, a random number of
      // macrotask turns, so statements of one chain land at every point of
      // another chain's transaction.
      const turns = async (): Promise<void> => {
        const n = Math.floor(random() * 4);
        for (let k = 0; k < n; k++) await settle();
      };
      const expected = { a: 0, b: 0, log: 0 };
      const work: Array<Promise<unknown>> = [];
      for (let i = 0; i < 200; i++) {
        const kind = random();
        if (kind < 0.35) {
          // Autocommit increments of `a` and of `b`.
          expected.a++;
          expected.b++;
          work.push(
            (async () => {
              await turns();
              await db.run("UPDATE kv SET v = v + 1 WHERE k = 'a'");
              await turns();
              await db.run("UPDATE kv SET v = v + 1 WHERE k = 'b'");
            })(),
          );
        } else if (kind < 0.7) {
          // Read-modify-write in a transaction, yielding between the read
          // and the write: a statement from another chain landing in that
          // gap would be overwritten.
          expected.b++;
          expected.log++;
          work.push(
            (async () => {
              await turns();
              await db.transaction(async () => {
                const row = await db.get<{ v: number }>(
                  "SELECT v FROM kv WHERE k = 'b'",
                );
                await turns();
                await db.run("UPDATE kv SET v = ? WHERE k = 'b'", [
                  (row?.v ?? 0) + 1,
                ]);
                await db.run("INSERT INTO log (src) VALUES ('tx')");
              });
            })(),
          );
        } else {
          // A transaction that writes and then fails: nothing of it stays.
          work.push(
            (async () => {
              await turns();
              await db
                .transaction(async () => {
                  await db.run("UPDATE kv SET v = v + 1000 WHERE k = 'a'");
                  await db.run("INSERT INTO log (src) VALUES ('doomed')");
                  await turns();
                  throw new Error('doomed');
                })
                .catch(() => undefined);
            })(),
          );
        }
      }
      await Promise.all(work);
      expect(await kv(db)).toEqual({ a: expected.a, b: expected.b });
      expect(
        await db.get<{ n: number; doomed: number }>(
          "SELECT count(*) AS n, sum(src = 'doomed') AS doomed FROM log",
        ),
      ).toEqual({ n: expected.log, doomed: 0 });
      expect(db.inTransaction).toBe(false);
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });
});
