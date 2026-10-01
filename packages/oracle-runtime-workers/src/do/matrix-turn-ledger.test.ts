/**
 * The user object's room-turn ledger over a REAL `DoSqliteDatabase` inside
 * workerd, plus the decision it feeds.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DoSqliteDatabase } from '../sqlite/database';
import type { SqliteTestDO } from '../sqlite/test-do';
import {
  decideMatrixTurn,
  MatrixTurnLedger,
  RETENTION_MS,
} from './matrix-turn-ledger';

function stub(name: string): DurableObjectStub<SqliteTestDO> {
  return env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
}

describe('decideMatrixTurn', () => {
  const base = {
    eventId: '$e',
    sessionId: 'matrix:!r',
    requestId: 'r1',
    startedAt: '2026-09-11T00:00:00.000Z',
  };
  it('runs an unknown event once', () => {
    expect(decideMatrixTurn(undefined)).toBe('run');
  });
  it('returns the stored reply for an answered event', () => {
    expect(
      decideMatrixTurn({
        ...base,
        answeredAt: base.startedAt,
        replyText: 'hi',
      }),
    ).toBe('answered');
    // An empty reply is still an answer (nothing to send, never re-run).
    expect(
      decideMatrixTurn({ ...base, answeredAt: base.startedAt, replyText: '' }),
    ).toBe('answered');
  });
  it('refuses an event that was started but never answered (lost in a reset of the object)', () => {
    expect(
      decideMatrixTurn({ ...base, answeredAt: null, replyText: null }),
    ).toBe('interrupted');
  });
});

describe('MatrixTurnLedger (SQLite)', () => {
  it('start → answer → get, start is idempotent, and rows outlive a reopen', async () => {
    await runInDurableObject(stub('ledger-1'), async (_instance, state) => {
      let now = 1_700_000_000_000;
      const db = await DoSqliteDatabase.open(state, 'ledger.db');
      const ledger = new MatrixTurnLedger(db, () => now);
      await ledger.setup();

      expect(await ledger.get('$e1')).toBeUndefined();
      await ledger.start('$e1', 'matrix:!r', 'req-1');
      const started = await ledger.get('$e1');
      expect(started).toEqual({
        eventId: '$e1',
        sessionId: 'matrix:!r',
        requestId: 'req-1',
        startedAt: new Date(now).toISOString(),
        answeredAt: null,
        replyText: null,
      });
      expect(decideMatrixTurn(started)).toBe('interrupted');

      // A second start (a replay racing the first) never resets the row.
      now += 1_000;
      await ledger.start('$e1', 'matrix:!r', 'req-2');
      expect((await ledger.get('$e1'))?.requestId).toBe('req-1');

      now += 1_000;
      await ledger.answer('$e1', 'the reply');
      const answered = await ledger.get('$e1');
      expect(answered?.replyText).toBe('the reply');
      expect(answered?.answeredAt).toBe(new Date(now).toISOString());
      expect(decideMatrixTurn(answered)).toBe('answered');

      // Same database, fresh ledger instance: the row is durable.
      const again = new MatrixTurnLedger(db, () => now);
      expect((await again.get('$e1'))?.replyText).toBe('the reply');
      await db.close();
    });
  });

  it('prunes rows older than the retention window at setup', async () => {
    await runInDurableObject(stub('ledger-2'), async (_instance, state) => {
      let now = 1_700_000_000_000;
      const db = await DoSqliteDatabase.open(state, 'ledger.db');
      const first = new MatrixTurnLedger(db, () => now);
      await first.start('$old', 'matrix:!r', 'req-old');
      await first.answer('$old', 'old reply');
      now += RETENTION_MS - 60_000;
      await first.start('$recent', 'matrix:!r', 'req-recent');

      now += 120_000; // $old is now past retention, $recent is not
      const later = new MatrixTurnLedger(db, () => now);
      await later.setup();
      expect(await later.get('$old')).toBeUndefined();
      expect((await later.get('$recent'))?.requestId).toBe('req-recent');
      await db.close();
    });
  });
});
