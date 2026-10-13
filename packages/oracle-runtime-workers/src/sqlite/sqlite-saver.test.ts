/* eslint-disable no-console -- tests print measured row counts */
/**
 * The checkpointer's write path inside workerd: message rows upserted in
 * place (stable rowids, one gzip per unchanged message object, order kept
 * through edits, removals and summaries), pruning without a per-prune
 * vacuum, the policy-driven reclaim, the index migration with unchanged
 * query plans, and the read side's pruning boundaries and filters.
 */
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  type Checkpoint,
  type CheckpointTuple,
  emptyCheckpoint,
  uuid6,
} from '@langchain/langgraph-checkpoint';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  stripTurnTimeNote,
  TURN_TIME_NOTE_KWARG,
  withTurnTimeNote,
} from '../core/turn-time-note';
import {
  type CarriedToolCall,
  SUMMARY_PREFIX,
  turnCarryKwargs,
  turnCarryOf,
} from '../core/middlewares/turn-boundary';
import { compactStep } from './blob-compactor';
import { DoSqliteDatabase } from './database';
import {
  cleanAdditionalKwargs,
  TURN_CARRY_KWARG,
  TURN_CARRY_MAX_CHARS,
} from './serialization';
import { PRUNE_SLACK, SqliteSaver } from './sqlite-saver';
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

let clockSeq = 0;
function checkpoint(messages: BaseMessage[]): Checkpoint {
  return {
    ...emptyCheckpoint(),
    id: uuid6(++clockSeq),
    channel_values: { messages },
  };
}

function human(id: string, content: string, timestamp?: string): HumanMessage {
  return new HumanMessage({
    id,
    content,
    additional_kwargs: timestamp ? { timestamp } : {},
  });
}

function ai(id: string, content: string, timestamp?: string): AIMessage {
  return new AIMessage({
    id,
    content,
    additional_kwargs: timestamp ? { timestamp } : {},
  });
}

const config = (thread: string) => ({
  configurable: { thread_id: thread, checkpoint_ns: '' },
});

async function put(
  saver: SqliteSaver,
  thread: string,
  messages: BaseMessage[],
  step = 0,
): Promise<string> {
  const cp = checkpoint(messages);
  await saver.put(config(thread), cp, { source: 'loop', step, parents: {} });
  return cp.id;
}

async function stateMessages(
  saver: SqliteSaver,
  thread: string,
): Promise<Array<{ id: string | undefined; content: unknown }>> {
  const tuple = await saver.getTuple(config(thread));
  const value = tuple?.checkpoint.channel_values['messages'];
  const list: unknown[] = Array.isArray(value) ? value : [];
  return list.map((m) => {
    const msg = m instanceof HumanMessage || m instanceof AIMessage ? m : null;
    return { id: msg?.id, content: msg?.content };
  });
}

async function rowids(
  db: DoSqliteDatabase,
  thread: string,
): Promise<Record<string, number>> {
  const rows = await db.exec<{ message_id: string; rowid: number }>(
    'SELECT message_id, rowid FROM messages WHERE thread_id = ?',
    [thread],
  );
  return Object.fromEntries(rows.map((r) => [r.message_id, r.rowid]));
}

async function integrityOk(db: DoSqliteDatabase): Promise<boolean> {
  const row = await db.get<{ integrity_check: string }>(
    'PRAGMA integrity_check',
  );
  return row?.integrity_check === 'ok';
}

/** Count gzip pipelines started while `fn` runs. */
async function countGzips(fn: () => Promise<void>): Promise<number> {
  const Original = CompressionStream;
  let count = 0;
  class Counting extends Original {
    constructor(format: ConstructorParameters<typeof CompressionStream>[0]) {
      count++;
      super(format);
    }
  }
  Reflect.set(globalThis, 'CompressionStream', Counting);
  try {
    await fn();
  } finally {
    Reflect.set(globalThis, 'CompressionStream', Original);
  }
  return count;
}

describe('SqliteSaver message rows', () => {
  it('N puts of an unchanged thread gzip each message once, keep every rowid and rewrite far fewer rows', async () => {
    await runInDurableObject(stub('saver-upsert'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'upsert.db');
      const saver = new SqliteSaver(db);
      await saver.setup();
      const M = 200;
      const N = 6;
      const thread: BaseMessage[] = [];
      for (let i = 0; i < M; i++) {
        const body = `turn ${i}: ${'tool output and reply text '.repeat(150)}`;
        thread.push(i % 2 ? ai(`a-${i}`, body) : human(`h-${i}`, body));
      }
      // Baseline: gzips of N puts of an empty thread (the checkpoint blobs).
      const empty = await countGzips(async () => {
        for (let n = 0; n < N; n++) await put(saver, 'control', [], n);
      });
      let first = 0;
      const all = await countGzips(async () => {
        first = await countGzips(async () => {
          await put(saver, 'big', thread, 0);
        });
        for (let n = 1; n < N; n++) await put(saver, 'big', thread, n);
      });
      expect(first).toBeGreaterThanOrEqual(M);
      expect(all - empty).toBe(M);

      const before = await rowids(db, 'big');
      const w0 = db.vfsStats().rowsWritten;
      await put(saver, 'big', thread, N);
      const perPut = db.vfsStats().rowsWritten - w0;
      expect(await rowids(db, 'big')).toEqual(before);

      // What one put cost when every message row was INSERT OR REPLACEd.
      const stored = await db.exec<Record<string, string | Uint8Array>>(
        "SELECT thread_id, checkpoint_ns, message_id, message_type, message_content, message, created_at FROM messages WHERE thread_id = 'big' ORDER BY rowid",
      );
      const w1 = db.vfsStats().rowsWritten;
      await db.transaction(async () => {
        for (const row of stored) {
          await db.run(
            `INSERT OR REPLACE INTO messages (thread_id, checkpoint_ns, checkpoint_id, message_id, message_type, message_content, message, created_at)
             VALUES (?, ?, 'replaced', ?, ?, ?, ?, ?)`,
            [
              row['thread_id'],
              row['checkpoint_ns'],
              row['message_id'],
              row['message_type'],
              row['message_content'],
              row['message'],
              row['created_at'],
            ],
          );
        }
      });
      const perReplace = db.vfsStats().rowsWritten - w1;
      console.log(
        `[saver] chunk rows written: in-place put ${perPut}, REPLACE of the same ${M} messages ${perReplace}`,
      );
      expect(perPut).toBeLessThanOrEqual(perReplace);
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('persists a changed message object again (in-place edits are never served from the cache)', async () => {
    await runInDurableObject(stub('saver-mutated'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'mut.db');
      const saver = new SqliteSaver(db);
      const m = human('m-1', `original ${'x'.repeat(400)}`);
      await put(saver, 't', [m]);
      m.content = `changed ${'y'.repeat(400)}`;
      await put(saver, 't', [m]);
      expect(await stateMessages(saver, 't')).toEqual([
        { id: 'm-1', content: m.content },
      ]);
      const listed = await saver.listThreadMessages('t');
      expect(listed.map((x) => x.content)).toEqual([m.content]);
      await db.close();
    });
  });

  it('a reused message id with new content replaces the row in place', async () => {
    await runInDurableObject(stub('saver-id-reuse'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'reuse.db');
      const saver = new SqliteSaver(db);
      await put(saver, 't', [human('h', 'q'), ai('a', 'first answer')]);
      const before = await rowids(db, 't');
      await put(saver, 't', [human('h', 'q'), ai('a', 'second answer')]);
      expect(await stateMessages(saver, 't')).toEqual([
        { id: 'h', content: 'q' },
        { id: 'a', content: 'second answer' },
      ]);
      expect(await rowids(db, 't')).toEqual(before);
      const content = await db.get<{ message_content: string }>(
        "SELECT message_content FROM messages WHERE message_id = 'a'",
      );
      expect(content?.message_content).toBe('second answer');
      await db.close();
    });
  });

  it('a removed message leaves the checkpoint state but stays in the transcript', async () => {
    await runInDurableObject(stub('saver-remove'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'remove.db');
      const saver = new SqliteSaver(db);
      const m1 = human('m1', 'one', '2026-01-01T00:00:01.000Z');
      const m2 = ai('m2', 'two', '2026-01-01T00:00:02.000Z');
      const m3 = human('m3', 'three', '2026-01-01T00:00:03.000Z');
      await put(saver, 't', [m1, m2, m3]);
      // The messages reducer applied a RemoveMessage for m2.
      await put(saver, 't', [m1, m3]);
      expect(await stateMessages(saver, 't')).toEqual([
        { id: 'm1', content: 'one' },
        { id: 'm3', content: 'three' },
      ]);
      expect(
        (await saver.listThreadMessages('t')).map((m) => m.content),
      ).toEqual(['one', 'two', 'three']);
      await db.close();
    });
  });

  it('a summary placed before the history it kept is read back first, and order holds afterwards', async () => {
    await runInDurableObject(stub('saver-summary'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'summary.db');
      const saver = new SqliteSaver(db);
      const h1 = human('h1', 'q1', '2026-01-01T00:00:01.000Z');
      const a1 = ai('a1', 'r1', '2026-01-01T00:00:02.000Z');
      const h2 = human('h2', 'q2', '2026-01-01T00:00:03.000Z');
      const a2 = ai('a2', 'r2', '2026-01-01T00:00:04.000Z');
      await put(saver, 't', [h1, a1, h2, a2]);
      const summary = human(
        's',
        'summary of q1/r1',
        '2026-01-01T00:00:05.000Z',
      );
      await put(saver, 't', [summary, h2, a2]);
      expect((await stateMessages(saver, 't')).map((m) => m.id)).toEqual([
        's',
        'h2',
        'a2',
      ]);
      const h3 = human('h3', 'q3', '2026-01-01T00:00:06.000Z');
      await put(saver, 't', [summary, h2, a2, h3]);
      expect((await stateMessages(saver, 't')).map((m) => m.id)).toEqual([
        's',
        'h2',
        'a2',
        'h3',
      ]);
      const ids = await rowids(db, 't');
      expect(ids['s']! < ids['h2']! && ids['h2']! < ids['a2']!).toBe(true);
      expect(ids['a2']! < ids['h3']!).toBe(true);
      // The transcript keeps everything, in time order.
      expect((await saver.listThreadMessages('t')).map((m) => m.id)).toEqual([
        'h1',
        'a1',
        'h2',
        'a2',
        's',
        'h3',
      ]);
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });
});

describe('SqliteSaver pruning', () => {
  it('prunes exactly when the cap plus slack is exceeded, never the newest', async () => {
    await runInDurableObject(stub('saver-prune-edge'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'edge.db');
      const keep = 3;
      const saver = new SqliteSaver(db, undefined, {
        maxCheckpointsPerThread: keep,
      });
      const ids: string[] = [];
      const count = async () =>
        (
          await db.get<{ n: number }>(
            "SELECT count(*) AS n FROM checkpoints WHERE thread_id = 'e'",
          )
        )?.n;
      for (let n = 0; n < keep + PRUNE_SLACK; n++)
        ids.push(await put(saver, 'e', [], n));
      expect(await count()).toBe(keep + PRUNE_SLACK);
      ids.push(await put(saver, 'e', [], 99));
      expect(await count()).toBe(keep);
      const kept = await db.exec<{ checkpoint_id: string }>(
        "SELECT checkpoint_id FROM checkpoints WHERE thread_id = 'e' ORDER BY checkpoint_id",
      );
      expect(kept.map((r) => r.checkpoint_id)).toEqual(ids.slice(-keep));
      await db.close();
    });
  });
});

describe('SqliteSaver reads', () => {
  it('getTuple by id and list() with limit, before and metadata filters', async () => {
    await runInDurableObject(stub('saver-list'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'list.db');
      const saver = new SqliteSaver(db, undefined, {
        maxCheckpointsPerThread: 0,
      });
      const ids: string[] = [];
      for (let n = 0; n < 5; n++) {
        const cp = checkpoint([human(`h${n}`, `q${n}`)]);
        ids.push(cp.id);
        await saver.put(config('l'), cp, {
          source: n % 2 ? 'input' : 'loop',
          step: n,
          parents: {},
        });
      }
      await put(saver, 'other', [human('o', 'other thread')]);
      const collect = async (gen: AsyncGenerator<CheckpointTuple>) => {
        const out: string[] = [];
        for await (const t of gen) out.push(t.checkpoint.id);
        return out;
      };
      expect(await collect(saver.list(config('l')))).toEqual(
        [...ids].reverse(),
      );
      expect(await collect(saver.list(config('l'), { limit: 2 }))).toEqual([
        ids[4],
        ids[3],
      ]);
      expect(
        await collect(
          saver.list(config('l'), {
            before: { configurable: { checkpoint_id: ids[2] } },
          }),
        ),
      ).toEqual([ids[1], ids[0]]);
      expect(
        await collect(saver.list(config('l'), { filter: { source: 'input' } })),
      ).toEqual([ids[3], ids[1]]);
      expect(
        await collect(saver.list(config('l'), { filter: { step: 2 } })),
      ).toEqual([ids[2]]);
      // Unknown filter keys are ignored, not injected.
      expect(
        await collect(
          saver.list(config('l'), { filter: { "x') OR 1=1 --": 'y' } }),
        ),
      ).toHaveLength(5);
      // A specific checkpoint carries its own messages and parent link.
      const tuple = await saver.getTuple({
        configurable: {
          thread_id: 'l',
          checkpoint_ns: '',
          checkpoint_id: ids[1],
        },
      });
      expect(tuple?.checkpoint.id).toBe(ids[1]);
      const messages = tuple?.checkpoint.channel_values['messages'];
      expect(Array.isArray(messages) ? messages.length : -1).toBe(1);
      expect(
        await saver.getTuple({
          configurable: {
            thread_id: 'l',
            checkpoint_ns: '',
            checkpoint_id: 'nope',
          },
        }),
      ).toBeUndefined();
      expect(await saver.getTuple(config('missing'))).toBeUndefined();
      await db.close();
    });
  });
});

describe('migration 002 (unused message indexes)', () => {
  const PLANS: Array<[string, unknown[]]> = [
    [
      'SELECT message FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC',
      ['t'],
    ],
    [
      'SELECT created_at, rowid FROM messages WHERE thread_id = ? AND message_id = ?',
      ['t', 'm'],
    ],
    [
      'SELECT message, message_id, created_at, rowid FROM messages WHERE thread_id = ? AND (created_at < ? OR (created_at = ? AND rowid < ?)) ORDER BY created_at DESC, rowid DESC LIMIT ?',
      ['t', 'x', 'x', 1, 5],
    ],
    [
      'SELECT message, message_id, created_at, rowid FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?',
      ['t', 5],
    ],
    [
      "SELECT message FROM messages WHERE thread_id = ? AND message_type = ? AND message_content LIKE ? ESCAPE '\\' ORDER BY created_at ASC, rowid ASC",
      ['t', 'human', '%x%'],
    ],
    [
      "SELECT 1 AS found FROM messages WHERE thread_id = ? AND message_content LIKE ? ESCAPE '\\' LIMIT 1",
      ['t', '%x%'],
    ],
    [
      'SELECT message FROM messages WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?',
      ['t', '', 'c'],
    ],
    [
      'UPDATE messages SET message_type = ?, message_content = ?, message = ? WHERE thread_id = ? AND message_id = ?',
      ['human', 'c', 'b', 't', 'm'],
    ],
  ];

  async function plans(db: DoSqliteDatabase): Promise<string[]> {
    const out: string[] = [];
    for (const [sql, params] of PLANS) {
      const rows = await db.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${sql}`,
        params.map((p) => (typeof p === 'number' ? p : String(p))),
      );
      out.push(rows.map((r) => r.detail).join(' | '));
    }
    return out;
  }

  /**
   * Every plan is unchanged, except one that used a dropped index: that
   * one now runs the same `thread_id = ?` range search on a remaining
   * index, with no sort added. `idx_messages_checkpoint_id` is used by no
   * plan at all.
   */
  function expectSamePlansBarDroppedIndex(
    before: string[],
    after: string[],
  ): void {
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(before[i]).not.toMatch(/idx_messages_checkpoint_id/);
      if (before[i] === after[i]) continue;
      expect(`${PLANS[i]?.[0]} → ${before[i]}`).toMatch(
        /USING INDEX idx_messages_thread_id \(thread_id=\?\)/,
      );
      expect(after[i]).toMatch(
        /^SEARCH messages USING INDEX idx_messages_(thread_created|lookup) \(thread_id=\?\)/,
      );
      expect(after[i]).not.toMatch(/TEMP B-TREE/);
    }
  }

  /** A `messages` table as an earlier release left it, indexes in `order`. */
  async function legacyMessages(
    db: DoSqliteDatabase,
    order: readonly string[],
  ): Promise<void> {
    await db.run(`CREATE TABLE messages (
      thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '',
      checkpoint_id TEXT NOT NULL, message_id TEXT NOT NULL,
      message_type TEXT NOT NULL, message_content TEXT NOT NULL,
      message BLOB, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id))`);
    await db.run(
      'CREATE TABLE schema_migrations (version INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    );
    await db.run(
      "INSERT INTO schema_migrations (version, name) VALUES (1, 'add_created_at_to_messages')",
    );
    const ddl: Record<string, string> = {
      thread_id: 'CREATE INDEX idx_messages_thread_id ON messages(thread_id)',
      checkpoint_id:
        'CREATE INDEX idx_messages_checkpoint_id ON messages(checkpoint_id)',
      lookup:
        'CREATE INDEX idx_messages_lookup ON messages(thread_id, checkpoint_ns, checkpoint_id)',
      thread_created:
        'CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at)',
    };
    for (const name of order) await db.run(ddl[name]!);
  }

  const indexes = async (db: DoSqliteDatabase) =>
    (
      await db.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND name LIKE 'idx_%' ORDER BY name",
      )
    ).map((r) => r.name);

  it('drops both indexes once, idempotently; every message query keeps its plan or the same thread_id range search', async () => {
    await runInDurableObject(stub('saver-migration-002'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'mig.db');
      // The order every Workers file and every Node file since migration
      // 001 has: the migration creates idx_messages_thread_created before
      // setup creates the other three.
      await legacyMessages(db, [
        'thread_created',
        'thread_id',
        'checkpoint_id',
        'lookup',
      ]);
      const before = await plans(db);

      await new SqliteSaver(db).setup();
      expect(await indexes(db)).toEqual([
        'idx_messages_lookup',
        'idx_messages_thread_created',
      ]);
      const after = await plans(db);
      expectSamePlansBarDroppedIndex(before, after);
      // Only the narrowest-index pick of the LIKE probe moved.
      expect(
        before.filter((plan, i) => plan !== after[i]).length,
      ).toBeLessThanOrEqual(1);
      // Reading a checkpoint's messages in rowid order needs no sort.
      const ordered = await db.exec<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT message FROM messages WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY rowid',
        ['t', '', 'c'],
      );
      expect(ordered.map((r) => r.detail).join(' | ')).toBe(before[6]);

      // A second setup (new saver instance) finds nothing to do.
      await new SqliteSaver(db).setup();
      expect(await indexes(db)).toEqual([
        'idx_messages_lookup',
        'idx_messages_thread_created',
      ]);
      const versions = await db.exec<{ version: number }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
      expect(await integrityOk(db)).toBe(true);
      await db.close();
    });
  });

  it('on a file older than migration 001 (thread_id index first) the plans hold the same way', async () => {
    await runInDurableObject(
      stub('saver-migration-002-old'),
      async (_i, state) => {
        const db = await DoSqliteDatabase.open(state, 'old.db');
        await legacyMessages(db, [
          'thread_id',
          'checkpoint_id',
          'lookup',
          'thread_created',
        ]);
        const before = await plans(db);
        await new SqliteSaver(db).setup();
        expectSamePlansBarDroppedIndex(before, await plans(db));
        expect(await integrityOk(db)).toBe(true);
        await db.close();
      },
    );
  });
});

describe('the turn time note kwarg', () => {
  const NOTE = 'Current time: 2026-10-03T09:00:00Z (Friday)';

  function noted(
    id: string,
    content: string | Array<{ type: 'text'; text: string }>,
  ): HumanMessage {
    return new HumanMessage({
      id,
      content: withTurnTimeNote(content, NOTE),
      additional_kwargs: { [TURN_TIME_NOTE_KWARG]: NOTE },
    });
  }

  function expectNoted(message: BaseMessage | undefined, sent: unknown): void {
    expect(message?.additional_kwargs[TURN_TIME_NOTE_KWARG]).toBe(NOTE);
    expect(
      stripTurnTimeNote(
        message?.content ?? '',
        message?.additional_kwargs[TURN_TIME_NOTE_KWARG],
      ),
    ).toEqual(sent);
  }

  it('survives put → getTuple, the transcript reads, a compaction rewrite and export/import (string and block content)', async () => {
    await runInDurableObject(stub('saver-time-note'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'note.db');
      const saver = new SqliteSaver(db);
      const blocks = [{ type: 'text' as const, text: 'with blocks' }];
      await put(saver, 'n', [
        noted('h-str', 'hello there'),
        ai('a-1', 'answer'),
        noted('h-blk', blocks),
      ]);
      const check = async (target: SqliteSaver) => {
        const tuple = await target.getTuple(config('n'));
        const value = tuple?.checkpoint.channel_values['messages'];
        const state = Array.isArray(value) ? value : [];
        const byId = (list: unknown[], id: string) =>
          list.find(
            (m): m is BaseMessage => m instanceof HumanMessage && m.id === id,
          );
        expectNoted(byId(state, 'h-str'), 'hello there');
        expectNoted(byId(state, 'h-blk'), blocks);
        const listed = await target.listThreadMessages('n');
        expectNoted(byId(listed, 'h-str'), 'hello there');
        expectNoted(byId(listed, 'h-blk'), blocks);
        const paged = await target.listThreadMessageRows('n', {
          direction: 'newer',
          limit: 10,
        });
        expectNoted(
          paged.find((r) => r.messageId === 'h-blk')?.message,
          blocks,
        );
      };
      await check(saver);

      // A legacy (uncompressed) copy of the rows, rewritten by the compactor.
      const rows = await db.exec<{ message_id: string; message: Uint8Array }>(
        "SELECT message_id, message FROM messages WHERE thread_id = 'n'",
      );
      expect(rows.map((row) => row.message_id).sort()).toEqual([
        'a-1',
        'h-blk',
        'h-str',
      ]);
      const { gunzipBytes, isGzip } = await import('./blob-codec');
      for (const row of rows) {
        if (!isGzip(row.message)) continue;
        await db.run('UPDATE messages SET message = ? WHERE message_id = ?', [
          await gunzipBytes(row.message),
          row.message_id,
        ]);
      }
      for (let step = await compactStep(db, 300); !step.done; )
        step = await compactStep(db, 300, step.cursors);
      await check(saver);

      // The exported file, imported elsewhere.
      const image = await db.export();
      const copy = await DoSqliteDatabase.open(state, 'note-copy.db');
      await copy.import(image);
      await check(new SqliteSaver(copy));
      await copy.close();
      await db.close();
    });
  });

  it('drops a non-string value under the key and leaves every other kwarg as before', () => {
    const base = { timestamp: '2026-01-01T00:00:00.000Z', lc_source: 'x' };
    expect(
      cleanAdditionalKwargs(
        { ...base, [TURN_TIME_NOTE_KWARG]: 42 },
        false,
        'O',
      ),
    ).toEqual({ msgFromMatrixRoom: false, oracleName: 'O', ...base });
    expect(
      cleanAdditionalKwargs(
        { ...base, [TURN_TIME_NOTE_KWARG]: NOTE },
        false,
        'O',
      ),
    ).toEqual({
      msgFromMatrixRoom: false,
      oracleName: 'O',
      ...base,
      [TURN_TIME_NOTE_KWARG]: NOTE,
    });
    // Unknown keys are still dropped.
    expect(
      cleanAdditionalKwargs({ ...base, other: 'nope' }, true, 'O'),
    ).toEqual({ msgFromMatrixRoom: true, oracleName: 'O', ...base });
  });
});

describe('the turn carry of a mid-turn summary', () => {
  function summaryCarrying(id: string, calls: CarriedToolCall[]): HumanMessage {
    return new HumanMessage({
      id,
      content: `${SUMMARY_PREFIX} the turn so far`,
      additional_kwargs: {
        lc_source: 'summarization',
        ...turnCarryKwargs(calls),
      },
    });
  }

  const call = (n: number, argBytes = 10): CarriedToolCall => ({
    name: 'write_file',
    args: { path: `/notes/${n}.md`, body: 'x'.repeat(argBytes) },
    status: n % 3 === 0 ? 'error' : 'success',
    result: `wrote ${n}`,
  });

  it('is stored under the key the summarizer writes', () => {
    expect(Object.keys(turnCarryKwargs([]))).toEqual([TURN_CARRY_KWARG]);
  });

  it('survives put → getTuple and the transcript read', async () => {
    await runInDurableObject(stub('saver-turn-carry'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'carry.db');
      const saver = new SqliteSaver(db);
      const calls = [call(1), call(2), call(3)];
      await put(saver, 'c', [
        summaryCarrying('s', calls),
        ai('a', 'continuing'),
      ]);
      const tuple = await saver.getTuple(config('c'));
      const value = tuple?.checkpoint.channel_values['messages'];
      const summary = (Array.isArray(value) ? value : []).find(
        (m): m is HumanMessage => m instanceof HumanMessage && m.id === 's',
      );
      expect(summary && turnCarryOf(summary)).toEqual(calls);
      const listed = (await saver.listThreadMessages('c')).find(
        (m) => m.id === 's',
      );
      expect(listed && turnCarryOf(listed)).toEqual(calls);
      await db.close();
    });
  });

  it('keeps the newest calls that fit the cap and drops a value that is not a list', () => {
    const base = { timestamp: '2026-01-01T00:00:00.000Z' };
    const many = Array.from({ length: 200 }, (_, n) => call(n, 1000));
    const kept = cleanAdditionalKwargs(
      { ...base, ...turnCarryKwargs(many) },
      false,
      'O',
    )[TURN_CARRY_KWARG];
    expect(Array.isArray(kept)).toBe(true);
    const list = Array.isArray(kept) ? kept : [];
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThan(many.length);
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(
      TURN_CARRY_MAX_CHARS,
    );
    expect(list).toEqual(many.slice(-list.length));
    expect(
      cleanAdditionalKwargs(
        { ...base, [TURN_CARRY_KWARG]: 'not a list' },
        false,
        'O',
      ),
    ).not.toHaveProperty(TURN_CARRY_KWARG);
  });
});
