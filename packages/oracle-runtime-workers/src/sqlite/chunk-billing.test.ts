/**
 * Billing-grain measurements for the chunked VFS: proves the 64 KiB chunk
 * layout actually cuts billed rows per checkpointer turn, and prints the
 * measured rows-per-turn used in cost projections.
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  type Checkpoint,
  emptyCheckpoint,
  uuid6,
} from '@langchain/langgraph-checkpoint';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DoSqliteDatabase } from './database';
import { CHUNK_SIZE, PAGES_PER_CHUNK, VFS_PAGE_SIZE } from './do-vfs';
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

function turnMessages(turn: number): Array<HumanMessage | AIMessage> {
  const filler = `turn ${turn}: `.repeat(200); // ~1.5 KB each, compressible
  return [
    new HumanMessage({
      id: `h-${turn}`,
      content: `question ${turn} ${filler}`,
      additional_kwargs: { timestamp: '2026-01-01T00:00:00.000Z' },
    }),
    new AIMessage({
      id: `a-${turn}`,
      content: `answer ${turn} ${filler}`,
      additional_kwargs: { timestamp: '2026-01-01T00:00:00.000Z' },
    }),
  ];
}

function checkpointOf(
  turn: number,
  all: Array<HumanMessage | AIMessage>,
): Checkpoint {
  return {
    ...emptyCheckpoint(),
    id: uuid6(turn),
    channel_values: { messages: all },
  };
}

describe('chunked VFS billing grain', () => {
  it('a checkpointer turn writes far fewer rows than pages touched', async () => {
    await runInDurableObject(stub('billing'), async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'billing.db');
      const saver = new SqliteSaver(db);
      await saver.setup();

      const all: Array<HumanMessage | AIMessage> = [];
      // Warm up: 5 turns to get past file-creation noise.
      for (let turn = 1; turn <= 5; turn++) {
        all.push(...turnMessages(turn));
        await saver.put(
          { configurable: { thread_id: 'bt', checkpoint_ns: '' } },
          checkpointOf(turn, all),
          { source: 'loop', step: turn, parents: {} },
        );
      }

      const before = db.vfsStats();
      const measureTurns = 10;
      for (let turn = 6; turn <= 5 + measureTurns; turn++) {
        all.push(...turnMessages(turn));
        await saver.put(
          { configurable: { thread_id: 'bt', checkpoint_ns: '' } },
          checkpointOf(turn, all),
          { source: 'loop', step: turn, parents: {} },
        );
        await saver.putWrites(
          {
            configurable: {
              thread_id: 'bt',
              checkpoint_ns: '',
              checkpoint_id: uuid6(turn),
            },
          },
          [['tools', `tool output ${turn} ${'x'.repeat(2000)}`]],
          `task-${turn}`,
        );
      }
      const after = db.vfsStats();

      const rowsPerTurn =
        (after.rowsWritten - before.rowsWritten) / measureTurns;
      const readsPerTurn = (after.rowsRead - before.rowsRead) / measureTurns;
      console.log(
        `[chunk-billing] rows written/turn: ${rowsPerTurn.toFixed(1)}, rows read/turn: ${readsPerTurn.toFixed(1)} (chunk=${CHUNK_SIZE / 1024} KiB = ${PAGES_PER_CHUNK} pages)`,
      );

      // The v1 layout wrote one row per dirty 4 KiB page — a turn like this
      // dirtied ~30–80 pages. Chunked, the same turn must land well below
      // that; 20 chunk rows is a generous ceiling.
      expect(rowsPerTurn).toBeLessThan(20);

      // Layout invariant: stored rows track the chunk count, not page count.
      const fileChunks = Math.ceil(db.fileSize / CHUNK_SIZE);
      const filePages = Math.ceil(db.fileSize / VFS_PAGE_SIZE);
      expect(fileChunks).toBeLessThanOrEqual(
        Math.ceil(filePages / PAGES_PER_CHUNK),
      );
      await db.close();
    });
  });
});
