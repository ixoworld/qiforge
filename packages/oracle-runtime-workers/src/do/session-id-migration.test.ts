import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DoSqliteDatabase } from '../sqlite/database';
import { SessionsStore } from '../sqlite/sessions-store';
import { SqliteSaver } from '../sqlite/sqlite-saver';
import type { SqliteTestDO } from '../sqlite/test-do';
import { MatrixTurnLedger } from './matrix-turn-ledger';
import { ResultStore } from './result-store';
import { RunStore } from './run-store';
import { migrateThreadSessionIds } from './session-id-migration';

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

const quiet = { log: () => undefined, warn: () => undefined };

/** Every store's tables, exactly as the user object creates them. */
async function openStores(db: DoSqliteDatabase): Promise<SessionsStore> {
  await new SqliteSaver(db).setup();
  const sessions = new SessionsStore(db);
  await sessions.setup();
  await new MatrixTurnLedger(db).setup();
  await new RunStore(db).setup();
  await new ResultStore(db, { prefix: 'test' }).setup();
  return sessions;
}

/** One row per session-keyed table for `id`, so a rename can be checked everywhere. */
async function seedRows(db: DoSqliteDatabase, id: string): Promise<void> {
  const tag = id.replace(/[^a-z0-9]/gi, '');
  await db.run(
    `INSERT INTO checkpoints (thread_id, checkpoint_id) VALUES (?, ?)`,
    [id, `cp-${tag}`],
  );
  await db.run(
    `INSERT INTO writes (thread_id, checkpoint_id, task_id, idx, channel) VALUES (?, ?, ?, 0, 'messages')`,
    [id, `cp-${tag}`, `task-${tag}`],
  );
  await db.run(
    `INSERT INTO messages (thread_id, checkpoint_id, message_id, message_type, message_content) VALUES (?, ?, ?, 'human', 'hi')`,
    [id, `cp-${tag}`, `msg-${tag}`],
  );
  await db.run(
    `INSERT INTO turn_runs (run_id, session_id, request_id, client, status, started_at, updated_at, request, instance_id)
     VALUES (?, ?, ?, 'matrix', 'done', 't', 't', '{}', 'i')`,
    [`run-${tag}`, id, `req-${tag}`],
  );
  await db.run(
    `INSERT INTO matrix_turns (event_id, session_id, request_id, started_at) VALUES (?, ?, ?, 't')`,
    [`$ev-${tag}`, id, `req-${tag}`],
  );
  await db.run(
    `INSERT INTO tool_results (id, session_id, tool_name, size, tier, created_at, expires_at)
     VALUES (?, ?, 'weather', 1, 'sqlite', 't', 9999999999999)`,
    [`res-${tag}`, id],
  );
}

async function idsIn(
  db: DoSqliteDatabase,
  table: string,
  column: string,
): Promise<string[]> {
  const rows = await db.exec<{ id: string }>(
    `SELECT ${column} AS id FROM ${table} ORDER BY ${column}`,
  );
  return rows.map((r) => r.id);
}

describe('migrateThreadSessionIds', () => {
  it('renames thread:<root> sessions to <root> across every session-keyed table, keeps a clash, and is idempotent', async () => {
    await runInDurableObject(stub('thread-ids'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'thread-ids.db');
      const sessions = await openStores(db);
      const base = {
        oracleName: 'Oracle',
        oracleDid: 'did:ixo:oracle',
        oracleEntityDid: 'did:ixo:entity',
        roomId: '!main:mx',
      };
      // A thread opened from a room message (renamed), a thread whose root
      // is an existing Portal session (kept), a main-timeline session of the
      // old build (untouched) and a Portal session (untouched).
      await sessions.createSession({ ...base, sessionId: 'thread:$a' });
      await sessions.createSession({ ...base, sessionId: '$b' });
      await sessions.createSession({ ...base, sessionId: 'thread:$b' });
      await sessions.createSession({ ...base, sessionId: 'matrix:!main:mx' });
      await sessions.createSession({ ...base, sessionId: '$c' });
      for (const id of [
        'thread:$a',
        '$b',
        'thread:$b',
        'matrix:!main:mx',
        '$c',
      ])
        await seedRows(db, id);

      expect(await migrateThreadSessionIds(db, quiet)).toEqual({
        renamed: 1,
        skipped: 1,
      });

      const expected = ['$a', '$b', '$c', 'matrix:!main:mx', 'thread:$b'];
      expect(await idsIn(db, 'sessions', 'session_id')).toEqual(expected);
      expect(await idsIn(db, 'checkpoints', 'thread_id')).toEqual(expected);
      expect(await idsIn(db, 'writes', 'thread_id')).toEqual(expected);
      expect(await idsIn(db, 'messages', 'thread_id')).toEqual(expected);
      expect(await idsIn(db, 'turn_runs', 'session_id')).toEqual(expected);
      expect(await idsIn(db, 'matrix_turns', 'session_id')).toEqual(expected);
      expect(await idsIn(db, 'tool_results', 'session_id')).toEqual(expected);
      // The renamed session keeps its row otherwise.
      expect((await sessions.getSession('$a'))?.roomId).toBe('!main:mx');
      expect(await sessions.getSession('thread:$a')).toBeUndefined();

      // A second boot finds nothing to rename.
      expect(await migrateThreadSessionIds(db, quiet)).toEqual({
        renamed: 0,
        skipped: 1,
      });
      expect(await idsIn(db, 'sessions', 'session_id')).toEqual(expected);
    });
  });

  it('is a no-op on a file without legacy ids', async () => {
    await runInDurableObject(stub('thread-ids-clean'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'clean.db');
      const sessions = await openStores(db);
      await sessions.createSession({
        oracleName: 'Oracle',
        oracleDid: 'did:ixo:oracle',
        oracleEntityDid: 'did:ixo:entity',
        sessionId: '$only',
      });
      expect(await migrateThreadSessionIds(db, quiet)).toEqual({
        renamed: 0,
        skipped: 0,
      });
      expect(await idsIn(db, 'sessions', 'session_id')).toEqual(['$only']);
    });
  });
});
