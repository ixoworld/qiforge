/* eslint-disable no-console -- tests print measured footprint/throughput numbers */
/**
 * Runs INSIDE workerd through the Workers vitest pool: real Durable Object
 * storage, real wasm instantiation from a CompiledWasm module, real
 * `nodejs_compat`. See `vitest.config.ts` / `test/wrangler.test.jsonc`.
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  type Checkpoint,
  type CheckpointTuple,
  emptyCheckpoint,
  TASKS,
  uuid6,
} from '@langchain/langgraph-checkpoint';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DoSqliteDatabase } from './database';
import { CHUNK_SIZE, DEFAULT_CACHE_PAGES, VFS_PAGE_SIZE } from './do-vfs';
import {
  LEGACY_CHECKPOINT_IDS,
  LEGACY_DB_BYTE_LENGTH,
  LEGACY_ROOM_ID,
  LEGACY_SESSION_ID,
  LEGACY_THREAD_ID,
  legacyDbBytes,
} from './fixtures/legacy-db';
import { SessionsStore } from './sessions-store';
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

const SQLITE_MAGIC = 'SQLite format 3\0';

function stub(name: string): DurableObjectStub<SqliteTestDO> {
  return env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
}

function headerMagic(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes.subarray(0, 16));
}

function checkpointWithMessages(
  clock: number,
  messages: Array<HumanMessage | AIMessage>,
): Checkpoint {
  return {
    ...emptyCheckpoint(),
    id: uuid6(clock),
    channel_values: { messages },
  };
}

function message(
  kind: 'human' | 'ai',
  id: string,
  content: string,
  timestamp: string,
): HumanMessage | AIMessage {
  const fields = { id, content, additional_kwargs: { timestamp } };
  return kind === 'human' ? new HumanMessage(fields) : new AIMessage(fields);
}

async function collect(
  gen: AsyncGenerator<CheckpointTuple>,
): Promise<CheckpointTuple[]> {
  const out: CheckpointTuple[] = [];
  for await (const tuple of gen) out.push(tuple);
  return out;
}

describe('DoSqliteDatabase over DO storage', () => {
  it('opens a database, creates tables and reads typed rows back', async () => {
    const s = stub('basic');
    const { sqliteVersion } = await s.open('basic.db');
    expect(sqliteVersion).toMatch(/^3\.\d+\.\d+$/);

    await s.run(
      'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL, payload BLOB, big INTEGER, flag INTEGER)',
    );
    await s.run(
      'INSERT INTO t (name, score, payload, big, flag) VALUES (?, ?, ?, ?, ?)',
      ['alpha', 1.5, new Uint8Array([1, 2, 3]), Date.now(), true],
    );
    const rows = await s.exec(
      'SELECT id, name, score, payload, big, flag, typeof(big) AS big_type FROM t',
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.id).toBe(1);
    expect(row?.name).toBe('alpha');
    expect(row?.score).toBe(1.5);
    expect(row?.payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(row?.payload as Uint8Array)).toEqual([1, 2, 3]);
    expect(typeof row?.big).toBe('number');
    expect(row?.big_type).toBe('integer'); // > int32 numbers stay INTEGER, not REAL
    expect(row?.flag).toBe(1);

    const stats = await s.stats();
    expect(stats.fileSize % VFS_PAGE_SIZE).toBe(0);
    expect(stats.storedChunks).toBe(Math.ceil(stats.fileSize / CHUNK_SIZE));
    expect(stats.vfs.dirtyPages).toBe(0);
  });

  it('persists pages: data survives eviction and a fresh DO instance for the same id', async () => {
    const s = stub('persist');
    await s.open('persist.db');
    await s.run('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');
    for (let i = 0; i < 50; i++) {
      await s.run('INSERT INTO kv (k, v) VALUES (?, ?)', [
        `key-${i}`,
        `value-${i}`,
      ]);
    }
    expect(await s.isOpen()).toBe(true);

    // Kill the instance without closing: only what the VFS flushed to storage survives.
    await evictDurableObject(s);

    const fresh = stub('persist');
    expect(await fresh.isOpen()).toBe(false);
    await fresh.open('persist.db');
    const count = await fresh.get('SELECT COUNT(*) AS n FROM kv');
    expect(count?.n).toBe(50);
    const row = await fresh.get('SELECT v FROM kv WHERE k = ?', ['key-42']);
    expect(row?.v).toBe('value-42');
  });

  it('export() yields a SQLite file and import() round-trips it', async () => {
    const s = stub('export');
    await s.open('export.db');
    await s.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    await s.run("INSERT INTO notes (body) VALUES ('one'), ('two'), ('three')");

    const bytes = await s.exportDb();
    expect(headerMagic(bytes)).toBe(SQLITE_MAGIC);
    expect(bytes.byteLength % VFS_PAGE_SIZE).toBe(0);
    // Header page size (big-endian at offset 16) matches the VFS page size.
    expect((bytes[16] ?? 0) * 256 + (bytes[17] ?? 0)).toBe(VFS_PAGE_SIZE);
    const checksumBefore = await s.checksum();
    expect(checksumBefore).toMatch(/^[0-9a-f]{64}$/);

    // Import into a different object → same content, same bytes.
    const t = stub('import');
    await t.open('export.db');
    await t.importDb(bytes);
    const rows = await t.exec('SELECT body FROM notes ORDER BY id');
    expect(rows.map((r) => r.body)).toEqual(['one', 'two', 'three']);
    expect(await t.checksum()).toBe(checksumBefore);

    // Mutating after import works and changes the export.
    await t.run("INSERT INTO notes (body) VALUES ('four')");
    const again = await t.exportDb();
    expect(headerMagic(again)).toBe(SQLITE_MAGIC);
    expect(await t.checksum()).not.toBe(checksumBefore);
  });

  it('handles a 20 MB database without holding it in memory', async () => {
    const s = stub('large');
    await s.open('large.db');
    const rows = 320;
    const bytesPerRow = 64 * 1024; // 320 x 64 KiB = 20 MiB of blob payload
    const fill = await s.fillBlobs(rows, bytesPerRow, 16);
    expect(fill.fileSize).toBeGreaterThan(20 * 1024 * 1024);

    const verify = await s.verifyBlobs();
    expect(verify.rows).toBe(rows);
    expect(verify.totalBytes).toBe(rows * bytesPerRow);

    const stats = await s.stats();
    expect(stats.storedChunks).toBe(Math.ceil(stats.fileSize / CHUNK_SIZE));
    expect(stats.storageBytes).toBeGreaterThan(20 * 1024 * 1024);
    // In-memory footprint is bounded by the LRU cache, not the file: the
    // cache holds at most DEFAULT_CACHE_PAGES (8 MiB) and nothing is dirty at rest.
    expect(stats.vfs.cachedPages).toBeLessThanOrEqual(DEFAULT_CACHE_PAGES);
    expect(stats.vfs.dirtyPages).toBe(0);
    expect(stats.vfs.cachedPages * VFS_PAGE_SIZE).toBeLessThan(
      stats.fileSize / 2,
    );
    console.info(
      `[20MB] file=${(stats.fileSize / 1048576).toFixed(1)}MiB storage=${(stats.storageBytes / 1048576).toFixed(1)}MiB ` +
        `cachedPages=${stats.vfs.cachedPages} wasmHeap=${(stats.wasmHeapBytes / 1048576).toFixed(1)}MiB ` +
        `flushes=${stats.vfs.flushes} insert=${fill.elapsedMs}ms`,
    );

    // A random-access read after eviction hits storage, not the cache.
    await evictDurableObject(s);
    const fresh = stub('large');
    await fresh.open('large.db');
    const mid = await fresh.get(
      'SELECT length(data) AS n FROM blobs WHERE id = ?',
      [rows / 2],
    );
    expect(mid?.n).toBe(bytesPerRow);
  });

  it('rolls back a failed transaction and keeps the file consistent', async () => {
    await runInDurableObject(stub('tx'), async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'tx.db');
      await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
      await db.run("INSERT INTO t (v) VALUES ('kept')");
      await expect(
        db.transaction(async () => {
          await db.run("INSERT INTO t (v) VALUES ('rolled back')");
          await db.run('INSERT INTO t (v) VALUES (NULL)'); // NOT NULL violation
        }),
      ).rejects.toThrow(/NOT NULL/);
      expect(db.inTransaction).toBe(false);
      const rows = await db.exec<{ v: string }>('SELECT v FROM t ORDER BY id');
      expect(rows.map((r) => r.v)).toEqual(['kept']);
      const check = await db.get<{ integrity_check: string }>(
        'PRAGMA integrity_check',
      );
      expect(check?.integrity_check).toBe('ok');
      await db.close();
    });
  });
});

describe('SqliteSaver (LangGraph checkpointer) inside a Durable Object', () => {
  const checkpoint1: Checkpoint = {
    v: 1,
    id: uuid6(-1),
    ts: '2024-04-19T17:19:07.952Z',
    channel_values: { someKey1: 'someValue1' },
    channel_versions: { someKey2: 1 },
    versions_seen: { someKey3: { someKey4: 1 } },
  };
  const checkpoint2: Checkpoint = {
    v: 1,
    id: uuid6(1),
    ts: '2024-04-20T17:19:07.952Z',
    channel_values: { someKey1: 'someValue2' },
    channel_versions: { someKey2: 2 },
    versions_seen: { someKey3: { someKey4: 2 } },
  };

  it('saves and retrieves checkpoints, writes, parents and filtered lists', async () => {
    await runInDurableObject(stub('saver-basic'), async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'cp.db');
      const saver = new SqliteSaver(db);

      expect(
        await saver.getTuple({ configurable: { thread_id: '1' } }),
      ).toBeUndefined();

      const runnableConfig = await saver.put(
        { configurable: { thread_id: '1' } },
        checkpoint1,
        {
          source: 'update',
          step: -1,
          parents: {},
        },
      );
      expect(runnableConfig).toEqual({
        configurable: {
          thread_id: '1',
          checkpoint_ns: '',
          checkpoint_id: checkpoint1.id,
        },
      });

      await saver.putWrites(
        {
          configurable: {
            checkpoint_id: checkpoint1.id,
            checkpoint_ns: '',
            thread_id: '1',
          },
        },
        [['bar', 'baz']],
        'foo',
      );

      const first = await saver.getTuple({ configurable: { thread_id: '1' } });
      expect(first?.config).toEqual({
        configurable: {
          thread_id: '1',
          checkpoint_ns: '',
          checkpoint_id: checkpoint1.id,
        },
      });
      expect(first?.checkpoint).toEqual(checkpoint1);
      expect(first?.parentConfig).toBeUndefined();
      expect(first?.pendingWrites).toEqual([['foo', 'bar', 'baz']]);

      await saver.put(
        {
          configurable: {
            thread_id: '1',
            checkpoint_id: '2024-04-18T17:19:07.952Z',
          },
        },
        checkpoint2,
        { source: 'update', step: -1, parents: { '': checkpoint1.id } },
      );
      const second = await saver.getTuple({ configurable: { thread_id: '1' } });
      expect(second?.parentConfig).toEqual({
        configurable: {
          thread_id: '1',
          checkpoint_ns: '',
          checkpoint_id: '2024-04-18T17:19:07.952Z',
        },
      });

      const filtered = await collect(
        saver.list(
          { configurable: { thread_id: '1' } },
          {
            filter: {
              source: 'update',
              step: -1,
              parents: { '': checkpoint1.id },
            },
          },
        ),
      );
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.checkpoint.ts).toBe('2024-04-20T17:19:07.952Z');

      const bySource = await collect(
        saver.list(
          { configurable: { thread_id: '1' } },
          { filter: { source: 'update' } },
        ),
      );
      expect(bySource).toHaveLength(2);
      const limited = await collect(
        saver.list({ configurable: { thread_id: '1' } }, { limit: 1 }),
      );
      expect(limited).toHaveLength(1);
      expect(limited[0]?.checkpoint.id).toBe(checkpoint2.id);
      const before = await collect(
        saver.list(
          { configurable: { thread_id: '1' } },
          { before: { configurable: { checkpoint_id: checkpoint2.id } } },
        ),
      );
      expect(before.map((t) => t.checkpoint.id)).toEqual([checkpoint1.id]);

      await db.close();
    });
  });

  it('extracts messages into the messages table and lists the full transcript', async () => {
    await runInDurableObject(
      stub('saver-messages'),
      async (_instance, state) => {
        const db = await DoSqliteDatabase.open(state, 'cp.db');
        const saver = new SqliteSaver(db, undefined, {
          maxCheckpointsPerThread: 2,
          oracleName: 'Test Oracle',
        });

        const total = 10;
        for (let i = 0; i < total; i++) {
          const history = Array.from({ length: i + 1 }, (_, j) =>
            message(
              j % 2 === 0 ? 'human' : 'ai',
              `msg-${j}`,
              `turn ${j}`,
              `2024-04-19T17:19:${String(j).padStart(2, '0')}.000Z`,
            ),
          );
          await saver.put(
            { configurable: { thread_id: 'thread-1' } },
            checkpointWithMessages(i, history),
            {
              source: 'loop',
              step: i,
              parents: {},
            },
          );
        }

        // Stored checkpoints no longer carry the messages; the tuple re-attaches them.
        const stored = await db.get<{ checkpoint: Uint8Array }>(
          'SELECT checkpoint FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC LIMIT 1',
          ['thread-1'],
        );
        expect(new TextDecoder().decode(stored?.checkpoint)).not.toContain(
          '"messages"',
        );

        const tuple = await saver.getTuple({
          configurable: { thread_id: 'thread-1' },
        });
        const attached = tuple?.checkpoint.channel_values.messages as
          | HumanMessage[]
          | undefined;
        expect(attached).toHaveLength(total);
        expect(attached?.[0]).toBeInstanceOf(HumanMessage);
        expect(attached?.[1]).toBeInstanceOf(AIMessage);
        expect(attached?.[0]?.additional_kwargs.oracleName).toBe('Test Oracle');
        expect(attached?.[0]?.additional_kwargs.timestamp).toBe(
          '2024-04-19T17:19:00.000Z',
        );

        const light = await saver.getTupleWithoutMessages({
          configurable: { thread_id: 'thread-1' },
        });
        expect(light?.checkpoint.channel_values.messages).toBeUndefined();
        expect(light?.config.configurable?.checkpoint_id).toBe(
          tuple?.config.configurable?.checkpoint_id,
        );

        // Pruning to 2 checkpoints never touches the transcript.
        const transcript = await saver.listThreadMessages('thread-1');
        expect(transcript.map((m) => m.content)).toEqual(
          Array.from({ length: total }, (_, j) => `turn ${j}`),
        );

        // Original message timestamps are preserved across re-puts.
        const row = await db.get<{ created_at: string }>(
          'SELECT created_at FROM messages WHERE message_id = ?',
          ['msg-0'],
        );
        expect(row?.created_at).toBe('2024-04-19T17:19:00.000Z');

        await db.close();
      },
    );
  });

  it('prunes checkpoints and writes past the cap, keeping the latest tuple intact', async () => {
    await runInDurableObject(stub('saver-prune'), async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'cp.db');
      const keep = 3;
      const saver = new SqliteSaver(db, undefined, {
        maxCheckpointsPerThread: keep,
      });

      const total = 12; // > keep + PRUNE_SLACK, so pruning must have fired
      let lastId = '';
      for (let i = 0; i < total; i++) {
        const checkpoint = checkpointWithMessages(i, [
          message(
            'human',
            `msg-${i}`,
            `hello ${i}`,
            `2024-04-19T17:19:0${i % 10}.000Z`,
          ),
        ]);
        lastId = checkpoint.id;
        const config = await saver.put(
          { configurable: { thread_id: 'thread-1' } },
          checkpoint,
          {
            source: 'loop',
            step: i,
            parents: {},
          },
        );
        await saver.putWrites(
          config,
          [['someChannel', `write-${i}`]],
          `task-${i}`,
        );
      }

      const rows = await db.exec<{ checkpoint_id: string }>(
        'SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC',
        ['thread-1'],
      );
      expect(rows.length).toBeLessThanOrEqual(keep + PRUNE_SLACK);
      expect(rows[0]?.checkpoint_id).toBe(lastId);

      const surviving = new Set(rows.map((r) => r.checkpoint_id));
      const writeRows = await db.exec<{ checkpoint_id: string }>(
        'SELECT DISTINCT checkpoint_id FROM writes WHERE thread_id = ?',
        ['thread-1'],
      );
      for (const w of writeRows)
        expect(surviving.has(w.checkpoint_id)).toBe(true);

      const tuple = await saver.getTuple({
        configurable: { thread_id: 'thread-1' },
      });
      expect(tuple?.config.configurable?.checkpoint_id).toBe(lastId);

      // Disabled pruning keeps everything.
      const unbounded = new SqliteSaver(db, undefined, {
        maxCheckpointsPerThread: 0,
      });
      for (let i = 0; i < 10; i++) {
        await unbounded.put(
          { configurable: { thread_id: 'thread-2' } },
          checkpointWithMessages(i, []),
          {
            source: 'loop',
            step: i,
            parents: {},
          },
        );
      }
      const count = await db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?',
        ['thread-2'],
      );
      expect(count?.n).toBe(10);

      await db.close();
    });
  });

  it('deletes a thread (checkpoints, writes, messages) and migrates pending sends', async () => {
    await runInDurableObject(stub('saver-delete'), async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'cp.db');
      const saver = new SqliteSaver(db);

      const withMessage = (id: string): Checkpoint => ({
        ...emptyCheckpoint(),
        id: uuid6(-1),
        channel_values: {
          messages: [new HumanMessage({ id, content: `message ${id}` })],
        },
      });
      await saver.put(
        { configurable: { thread_id: '1' } },
        withMessage('m-1'),
        { source: 'update', step: -1, parents: {} },
      );
      await saver.put(
        { configurable: { thread_id: '2' } },
        withMessage('m-2'),
        { source: 'update', step: -1, parents: {} },
      );

      const countMessages = async (threadId: string): Promise<number> =>
        (
          await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?',
            [threadId],
          )
        )?.n ?? 0;
      expect(await countMessages('1')).toBe(1);
      await saver.deleteThread('1');
      expect(
        await saver.getTuple({ configurable: { thread_id: '1' } }),
      ).toBeUndefined();
      expect(
        await saver.getTuple({ configurable: { thread_id: '2' } }),
      ).toBeDefined();
      expect(await countMessages('1')).toBe(0);
      expect(await countMessages('2')).toBe(1);
      await expect(
        saver.deleteThread('never-existed'),
      ).resolves.toBeUndefined();

      // pending sends migration (v<4 checkpoints)
      let config: RunnableConfig = {
        configurable: { thread_id: 'thread-ps', checkpoint_ns: '' },
      };
      const checkpoint0 = emptyCheckpoint();
      config = await saver.put(config, checkpoint0, {
        source: 'loop',
        parents: {},
        step: 0,
      });
      await saver.putWrites(
        config,
        [
          [TASKS, 'send-1'],
          [TASKS, 'send-2'],
        ],
        'task-1',
      );
      await saver.putWrites(config, [[TASKS, 'send-3']], 'task-2');
      const tuple0 = await saver.getTuple(config);
      expect(tuple0?.checkpoint.channel_values).toEqual({});
      const next: Checkpoint = {
        v: 1,
        id: uuid6(1),
        ts: '2024-04-20T17:19:07.952Z',
        channel_values: {},
        channel_versions: checkpoint0.channel_versions,
        versions_seen: checkpoint0.versions_seen,
      };
      config = await saver.put(config, next, {
        source: 'loop',
        parents: {},
        step: 1,
      });
      const tuple1 = await saver.getTuple(config);
      expect(tuple1?.checkpoint.channel_values).toEqual({
        [TASKS]: ['send-1', 'send-2', 'send-3'],
      });
      expect(tuple1?.checkpoint.channel_versions[TASKS]).toBeDefined();
      const listed = await collect(
        saver.list({ configurable: { thread_id: 'thread-ps' } }),
      );
      expect(listed).toHaveLength(2);
      expect(listed[0]?.checkpoint.channel_values).toEqual({
        [TASKS]: ['send-1', 'send-2', 'send-3'],
      });

      // error paths
      await expect(
        saver.put({}, emptyCheckpoint(), {
          source: 'update',
          step: -1,
          parents: {},
        }),
      ).rejects.toThrow('Empty configuration supplied.');
      await expect(
        saver.put({ configurable: {} }, emptyCheckpoint(), {
          source: 'update',
          step: -1,
          parents: {},
        }),
      ).rejects.toThrow(
        'Missing "thread_id" field in passed "config.configurable".',
      );
      await expect(
        saver.putWrites({}, [['channel', 'value']], 'task-1'),
      ).rejects.toThrow('Empty configuration supplied.');
      await expect(
        saver.putWrites({ configurable: {} }, [['channel', 'value']], 'task-1'),
      ).rejects.toThrow('Missing thread_id field in config.configurable.');
      await expect(
        saver.putWrites(
          { configurable: { thread_id: 'thread-1' } },
          [['channel', 'value']],
          'task-1',
        ),
      ).rejects.toThrow('Missing checkpoint_id field in config.configurable.');

      await db.close();
    });
  });

  it('throughput: 1000 checkpoint puts with a growing message history', async () => {
    await runInDurableObject(
      stub('saver-throughput'),
      async (_instance, state) => {
        const db = await DoSqliteDatabase.open(state, 'cp.db');
        const saver = new SqliteSaver(db);
        const history: Array<HumanMessage | AIMessage> = [];
        const started = Date.now();
        for (let i = 0; i < 1000; i++) {
          history.push(
            message(
              i % 2 === 0 ? 'human' : 'ai',
              `m-${i}`,
              `turn ${i}`,
              new Date(1700000000000 + i * 1000).toISOString(),
            ),
          );
          if (history.length > 30) history.shift(); // like summarization: bounded window
          await saver.put(
            { configurable: { thread_id: 'thread-tp' } },
            checkpointWithMessages(i, [...history]),
            {
              source: 'loop',
              step: i,
              parents: {},
            },
          );
        }
        const elapsedMs = Date.now() - started;
        const stats = db.vfsStats();
        console.info(
          `[throughput] 1000 puts in ${elapsedMs}ms (${(elapsedMs / 1000).toFixed(2)} ms/put), ` +
            `file=${(db.fileSize / 1024).toFixed(0)}KiB flushes=${stats.flushes} storageWrites=${stats.storageWrites} storageReads=${stats.storageReads}`,
        );
        const count = await db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?',
          ['thread-tp'],
        );
        expect(count?.n).toBeLessThanOrEqual(20 + PRUNE_SLACK);
        expect((await saver.listThreadMessages('thread-tp')).length).toBe(1000);
        await db.close();
      },
    );
  });
});

describe('migration from the Node runtime', () => {
  it('loads a legacy .db written by @ixo/sqlite-saver + better-sqlite3', async () => {
    await runInDurableObject(stub('legacy'), async (_instance, state) => {
      const bytes = legacyDbBytes();
      expect(bytes.byteLength).toBe(LEGACY_DB_BYTE_LENGTH);
      expect(headerMagic(bytes)).toBe(SQLITE_MAGIC);

      const db = await DoSqliteDatabase.open(state, 'legacy.db');
      await db.import(bytes);
      expect(
        (await db.get<{ integrity_check: string }>('PRAGMA integrity_check'))
          ?.integrity_check,
      ).toBe('ok');

      const saver = new SqliteSaver(db);
      const tuple = await saver.getTuple({
        configurable: { thread_id: LEGACY_THREAD_ID },
      });
      expect(tuple?.config.configurable?.checkpoint_id).toBe(
        LEGACY_CHECKPOINT_IDS[1],
      );
      expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe(
        LEGACY_CHECKPOINT_IDS[0],
      );
      expect(tuple?.checkpoint.channel_values.loadedPlugins).toEqual([
        'weather',
      ]);
      const messages = tuple?.checkpoint.channel_values.messages as
        | Array<HumanMessage | AIMessage>
        | undefined;
      expect(messages).toHaveLength(2);
      expect(messages?.[0]).toBeInstanceOf(HumanMessage);
      expect(messages?.[0]?.content).toBe('Hello from the Node runtime');
      expect(messages?.[0]?.additional_kwargs.msgFromMatrixRoom).toBe(true);
      expect(messages?.[1]).toBeInstanceOf(AIMessage);
      expect(messages?.[1]?.content).toBe('Hello from the Node runtime, human');
      expect(tuple?.pendingWrites).toEqual([
        ['legacy-task-2', TASKS, 'legacy-send-1'],
      ]);

      const parent = await saver.getTuple({
        configurable: {
          thread_id: LEGACY_THREAD_ID,
          checkpoint_id: LEGACY_CHECKPOINT_IDS[0],
        },
      });
      expect(parent?.pendingWrites).toEqual([
        ['legacy-task-1', 'someChannel', { answer: 42 }],
      ]);

      const transcript = await saver.listThreadMessages(LEGACY_THREAD_ID);
      expect(transcript.map((m) => m.content)).toEqual([
        'Hello from the Node runtime',
        'Hello from the Node runtime, human',
      ]);
      expect(
        (
          await collect(
            saver.list({ configurable: { thread_id: LEGACY_THREAD_ID } }),
          )
        ).length,
      ).toBe(2);

      // schema_migrations already records migration 001 → nothing re-applied.
      const applied = await db.exec<{ version: number }>(
        'SELECT version FROM schema_migrations',
      );
      expect(applied.map((r) => r.version)).toEqual([1]);

      // sessions written by the Node runtime are readable through SessionsStore.
      const sessions = new SessionsStore(db);
      const session = await sessions.getSession(LEGACY_SESSION_ID);
      expect(session?.title).toBe('Legacy conversation');
      expect(session?.roomId).toBe(LEGACY_ROOM_ID);
      expect(session?.lastProcessedCount).toBe(2);
      expect(session?.userContext).toEqual({ name: 'Legacy User' });

      // ...and the port keeps writing to it: a new turn on the legacy thread.
      const next: Checkpoint = {
        ...emptyCheckpoint(),
        id: uuid6(2),
        channel_values: {
          messages: [
            ...(messages ?? []),
            message(
              'human',
              'workers-msg-1',
              'Hello from workerd',
              '2026-02-01T00:00:00.000Z',
            ),
          ],
        },
      };
      await saver.put(tuple?.config ?? {}, next, {
        source: 'loop',
        step: 1,
        parents: {},
      });
      expect((await saver.listThreadMessages(LEGACY_THREAD_ID)).length).toBe(3);

      // Export is still a valid SQLite file after the round trip.
      const exported = await db.export();
      expect(headerMagic(exported)).toBe(SQLITE_MAGIC);
      await db.close();
    });
  });
});

describe('SessionsStore', () => {
  it('hides host task-run sessions from listings when asked (substr, not LIKE)', async () => {
    await runInDurableObject(stub('sessions-exclude'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'sessions-exclude.db');
      const sessions = new SessionsStore(db);
      const base = {
        oracleName: 'Oracle',
        oracleDid: 'did:ixo:oracle',
        oracleEntityDid: 'did:ixo:entity',
      };
      await sessions.createSession({ ...base, sessionId: 'task:abc' });
      await sessions.createSession({ ...base, sessionId: 'chat-1' });
      await sessions.createSession({ ...base, sessionId: 'tasky-not-a-task' });

      const all = await sessions.listSessions();
      expect(all.total).toBe(3);

      const visible = await sessions.listSessions(undefined, 20, 0, 'task:');
      expect(visible.total).toBe(2);
      expect(visible.sessions.map((s) => s.sessionId).sort()).toEqual([
        'chat-1',
        'tasky-not-a-task',
      ]);

      // An empty prefix excludes nothing.
      expect((await sessions.listSessions(undefined, 20, 0, '')).total).toBe(3);
    });
  });

  it('creates, lists, touches, titles and deletes sessions (purging checkpointer rows)', async () => {
    await runInDurableObject(stub('sessions'), async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'sessions.db');
      const sessions = new SessionsStore(db);
      const saver = new SqliteSaver(db);

      const base = {
        oracleName: 'Oracle',
        oracleDid: 'did:ixo:oracle',
        oracleEntityDid: 'did:ixo:entity',
      };
      const a = await sessions.createSession({
        ...base,
        sessionId: 's-a',
        roomId: '!room-1:mx',
      });
      expect(a.title).toBe('Untitled');
      await sessions.createSession({
        ...base,
        sessionId: 's-b',
        roomId: '!room-2:mx',
        title: 'Second',
      });
      await sessions.createSession({
        ...base,
        sessionId: 's-c',
        roomId: '!room-1:mx',
        userContext: { tz: 'UTC' },
      });

      const all = await sessions.listSessions();
      expect(all.total).toBe(3);
      expect(all.sessions.map((s) => s.sessionId)).toEqual([
        's-c',
        's-b',
        's-a',
      ]);
      const room1 = await sessions.listSessions('!room-1:mx', 1, 0);
      expect(room1.total).toBe(2);
      expect(room1.sessions).toHaveLength(1);
      expect(room1.sessions[0]?.userContext).toEqual({ tz: 'UTC' });

      expect(
        await sessions.setTitle('s-a', 'Generated', { onlyIfUntitled: true }),
      ).toBe(true);
      expect(
        await sessions.setTitle('s-a', 'Overwrite', { onlyIfUntitled: true }),
      ).toBe(false);
      expect((await sessions.getSession('s-a'))?.title).toBe('Generated');

      // `last_updated_at` has millisecond resolution and ties break by rowid
      // (newest row first): make sure the touch lands in a later millisecond
      // than EVERY create (`s-c` is the newest), or `s-c` legitimately stays
      // ahead of the touched row.
      const newestCreate = Math.max(
        ...(await sessions.listSessions()).sessions.map((row) =>
          Date.parse(row.lastUpdatedAt),
        ),
      );
      while (Date.now() <= newestCreate)
        await new Promise((r) => setTimeout(r, 1));
      const touched = await sessions.touchSession('s-a', {
        lastProcessedCount: 7,
      });
      expect(touched?.lastProcessedCount).toBe(7);
      expect((await sessions.listSessions()).sessions[0]?.sessionId).toBe(
        's-a',
      );
      expect(await sessions.touchSession('missing')).toBeUndefined();

      // Session id doubles as the LangGraph thread id: deleting purges checkpointer rows too.
      await saver.put(
        { configurable: { thread_id: 's-a' } },
        checkpointWithMessages(0, [
          message('human', 'm', 'hi', '2026-01-01T00:00:00.000Z'),
        ]),
        {
          source: 'input',
          step: -1,
          parents: {},
        },
      );
      expect(await sessions.deleteSession('s-a')).toBe(true);
      expect(await sessions.getSession('s-a')).toBeUndefined();
      expect(
        await saver.getTuple({ configurable: { thread_id: 's-a' } }),
      ).toBeUndefined();
      expect(
        (
          await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?',
            ['s-a'],
          )
        )?.n,
      ).toBe(0);
      expect(await sessions.deleteSession('s-a')).toBe(false);

      await db.close();
    });
  });
});
