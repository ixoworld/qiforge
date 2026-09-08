/**
 * Lossless blob compression: codec round-trips, saver wire format (gzipped
 * blobs on disk, identical values on read), legacy (uncompressed) rows
 * coexisting, SQL-side metadata filtering, and the background compactor
 * shrinking a legacy file without changing a single decoded value.
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  type Checkpoint,
  type CheckpointTuple,
  emptyCheckpoint,
  uuid6,
} from '@langchain/langgraph-checkpoint';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  compressForStorage,
  gunzipBytes,
  gzipBytes,
  hexToBytes,
  isGzip,
  MIN_COMPRESS_BYTES,
  readBlobText,
} from './blob-codec';
import { compactStep, finishCompaction } from './blob-compactor';
import { DoSqliteDatabase } from './database';
import { SqliteSaver } from './sqlite-saver';
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

const encoder = new TextEncoder();

/** Repetitive (highly compressible) content, like real chat/tool JSON. */
function bigText(seed: string, kb: number): string {
  return `${seed}: the quick brown fox jumps over the lazy dog. `.repeat(
    Math.ceil((kb * 1024) / 45),
  );
}

/** Bytes gzip cannot shrink (pseudo-random), ≥ the compression floor. */
function incompressibleBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = 0x12345678;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function checkpointOf(
  clock: number,
  messages: Array<HumanMessage | AIMessage>,
): Checkpoint {
  return {
    ...emptyCheckpoint(),
    id: uuid6(clock),
    channel_values: { messages },
  };
}

function msg(
  kind: 'human' | 'ai',
  id: string,
  content: string,
): HumanMessage | AIMessage {
  const fields = {
    id,
    content,
    additional_kwargs: { timestamp: '2026-01-01T00:00:00.000Z' },
  };
  return kind === 'human' ? new HumanMessage(fields) : new AIMessage(fields);
}

async function collect(
  gen: AsyncGenerator<CheckpointTuple>,
): Promise<CheckpointTuple[]> {
  const out: CheckpointTuple[] = [];
  for await (const tuple of gen) out.push(tuple);
  return out;
}

describe('blob-codec', () => {
  it('gzip round-trips bit-exact', async () => {
    const original = encoder.encode(bigText('roundtrip', 8));
    const compressed = await gzipBytes(original);
    expect(isGzip(compressed)).toBe(true);
    expect(compressed.length).toBeLessThan(original.length);
    expect(await gunzipBytes(compressed)).toEqual(original);
  });

  it('compressForStorage passes small and incompressible values through', async () => {
    const small = encoder.encode('tiny');
    expect(await compressForStorage(small)).toEqual(small);

    const noise = incompressibleBytes(4096);
    expect(await compressForStorage(noise)).toEqual(noise);
  });

  it('readBlobText handles TEXT, plain BLOB, and gzip BLOB rows', async () => {
    const json = `{"v":"${bigText('shapes', 1)}"}`;
    expect(await readBlobText(json)).toBe(json);
    expect(await readBlobText(encoder.encode(json))).toBe(json);
    expect(await readBlobText(await gzipBytes(encoder.encode(json)))).toBe(
      json,
    );
  });

  it('hexToBytes decodes SQLite hex() output', () => {
    expect(hexToBytes('1F8B00')).toEqual(Uint8Array.from([0x1f, 0x8b, 0x00]));
  });
});

describe('SqliteSaver blob compression', () => {
  it('stores gzipped blobs and reads back identical values', async () => {
    await runInDurableObject(stub('bc-saver'), async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'bc-saver.db');
      const saver = new SqliteSaver(db);

      const messages = [
        msg('human', 'm-1', bigText('question', 4)),
        msg('ai', 'm-2', bigText('answer', 6)),
      ];
      const checkpoint = checkpointOf(1, messages);
      // A channel value beyond messages so the stored checkpoint blob is big.
      checkpoint.channel_values.summary = bigText('summary', 4);
      const config = await saver.put(
        { configurable: { thread_id: 't1', checkpoint_ns: '' } },
        checkpoint,
        { source: 'loop', step: 1, parents: {} },
      );
      await saver.putWrites(
        config,
        [['tools', bigText('tool-output', 8)]],
        'task-1',
      );

      // On disk: gzip magic on checkpoint, message, and write blobs...
      const rawCp = await db.get<{ checkpoint: Uint8Array }>(
        'SELECT checkpoint FROM checkpoints LIMIT 1',
      );
      expect(isGzip(rawCp!.checkpoint)).toBe(true);
      const rawMsg = await db.get<{ message: Uint8Array }>(
        'SELECT message FROM messages LIMIT 1',
      );
      expect(isGzip(rawMsg!.message)).toBe(true);
      const rawWrite = await db.get<{ value: Uint8Array }>(
        'SELECT value FROM writes LIMIT 1',
      );
      expect(isGzip(rawWrite!.value)).toBe(true);
      // ...but metadata stays plaintext for SQL-side filtering.
      const rawMeta = await db.get<{ metadata: Uint8Array }>(
        'SELECT metadata FROM checkpoints LIMIT 1',
      );
      expect(isGzip(rawMeta!.metadata)).toBe(false);

      // Read side: everything identical.
      const tuple = await saver.getTuple({
        configurable: { thread_id: 't1', checkpoint_ns: '' },
      });
      expect(tuple).toBeDefined();
      expect(tuple!.checkpoint.channel_values.summary).toBe(
        checkpoint.channel_values.summary,
      );
      const loaded = tuple!.checkpoint.channel_values.messages as Array<{
        id?: string;
        content: unknown;
      }>;
      expect(loaded.map((m) => m.id)).toEqual(['m-1', 'm-2']);
      expect(loaded.map((m) => m.content)).toEqual(
        messages.map((m) => m.content),
      );
      expect(tuple!.pendingWrites).toEqual([
        ['task-1', 'tools', bigText('tool-output', 8)],
      ]);

      // Metadata filter still works SQL-side on compressed-era rows.
      const filtered = await collect(
        saver.list(
          { configurable: { thread_id: 't1' } },
          { filter: { step: 1 } },
        ),
      );
      expect(filtered).toHaveLength(1);
      await db.close();
    });
  });

  it('reads legacy uncompressed rows alongside compressed ones', async () => {
    await runInDurableObject(stub('bc-legacy'), async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'bc-legacy.db');
      const saver = new SqliteSaver(db);
      await saver.setup();

      // A row exactly as the Node runtime writes it: plain JSON bytes.
      const legacyCheckpoint = {
        ...emptyCheckpoint(),
        id: uuid6(2),
        channel_values: { summary: bigText('legacy-summary', 3) },
      };
      await db.run(
        `INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES (?, '', ?, NULL, 'json', ?, ?)`,
        [
          'legacy-thread',
          legacyCheckpoint.id,
          encoder.encode(JSON.stringify(legacyCheckpoint)),
          encoder.encode(
            JSON.stringify({ source: 'loop', step: 7, parents: {} }),
          ),
        ],
      );

      const tuple = await saver.getTuple({
        configurable: { thread_id: 'legacy-thread', checkpoint_ns: '' },
      });
      expect(tuple).toBeDefined();
      expect(tuple!.checkpoint.channel_values.summary).toBe(
        bigText('legacy-summary', 3),
      );
      expect(tuple!.metadata).toEqual({ source: 'loop', step: 7, parents: {} });
      await db.close();
    });
  });
});

describe('blob compactor', () => {
  it('compresses a legacy file in batches, losslessly, and VACUUM shrinks it', async () => {
    await runInDurableObject(stub('bc-compact'), async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'bc-compact.db');
      const saver = new SqliteSaver(db);
      await saver.setup();

      // Seed a legacy-shaped file: 30 big plain-JSON message rows, one small
      // row (below the floor), one incompressible row.
      const bigBodies = new Map<string, string>();
      for (let i = 0; i < 30; i++) {
        const body = JSON.stringify({
          id: `L${i}`,
          text: bigText(`legacy-${i}`, 3),
        });
        bigBodies.set(`L${i}`, body);
        await db.run(
          `INSERT INTO messages (thread_id, checkpoint_ns, checkpoint_id, message_id, message_type, message_content, message, created_at)
           VALUES ('lt', '', 'cp', ?, 'human', 'c', ?, '2026-01-01T00:00:00.000Z')`,
          [`L${i}`, encoder.encode(body)],
        );
      }
      const smallBody = '{"tiny":true}';
      await db.run(
        `INSERT INTO messages (thread_id, checkpoint_ns, checkpoint_id, message_id, message_type, message_content, message, created_at)
         VALUES ('lt', '', 'cp', 'small', 'human', 'c', ?, '2026-01-01T00:00:00.000Z')`,
        [encoder.encode(smallBody)],
      );
      const noise = incompressibleBytes(2048);
      await db.run(
        `INSERT INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
         VALUES ('lt', '', 'cp', 'task', 0, 'media', 'json', ?)`,
        [noise],
      );

      const before = db.fileSize;

      // Batched to force multiple passes; cursors carried across calls.
      let cursors = {};
      let totalRewritten = 0;
      let steps = 0;
      for (;;) {
        const step = await compactStep(db, 7, cursors);
        cursors = step.cursors;
        totalRewritten += step.rewritten;
        steps += 1;
        if (step.done) break;
        expect(steps).toBeLessThan(50);
      }
      expect(totalRewritten).toBe(30);

      // Every big row is now gzipped; small + incompressible untouched.
      const rows = await db.exec<{ message_id: string; message: Uint8Array }>(
        'SELECT message_id, message FROM messages',
      );
      const smallRow = rows.find((r) => r.message_id === 'small');
      expect(isGzip(smallRow!.message)).toBe(false);
      expect(smallRow!.message.length).toBeLessThan(MIN_COMPRESS_BYTES);
      const bigRows = rows.filter((r) => r.message_id !== 'small');
      expect(bigRows).toHaveLength(30);
      expect(bigRows.every((r) => isGzip(r.message))).toBe(true);
      const write = await db.get<{ value: Uint8Array }>(
        'SELECT value FROM writes LIMIT 1',
      );
      expect(write!.value).toEqual(noise);

      // Decoded values are bit-identical to what was seeded.
      for (const [id, body] of bigBodies) {
        const row = await db.get<{ message: Uint8Array }>(
          'SELECT message FROM messages WHERE message_id = ?',
          [id],
        );
        expect(await readBlobText(row!.message)).toBe(body);
      }

      // A second sweep finds nothing.
      const idle = await compactStep(db, 100, {});
      expect(idle.done).toBe(true);
      expect(idle.rewritten).toBe(0);

      const { vacuumed } = await finishCompaction(db, {
        fileSize: db.fileSize,
      });
      expect(vacuumed).toBe('full');
      expect(db.fileSize).toBeLessThan(before);
      await db.close();
    });
  });
});
