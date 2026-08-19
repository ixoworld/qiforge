import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyCheckpoint, uuid6 } from '@langchain/langgraph-checkpoint';
import { SqliteSaver } from '../index';
import { checkpointWithMessages } from './fixtures';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-saver-vacuum-'));
  return path.join(dir, 'test.db');
}

describe('SqliteSaver page reclamation', () => {
  it('creates new database files in incremental auto-vacuum mode', async () => {
    const saver = SqliteSaver.fromConnString(tmpDbPath());
    await saver.put(
      { configurable: { thread_id: 'thread-1' } },
      checkpointWithMessages(0, []),
      { source: 'input', step: 0, parents: {} },
    );
    const mode: number = saver.db.pragma('auto_vacuum', { simple: true });
    expect(mode).toBe(2);
  });

  it('returns pruned pages to the filesystem', async () => {
    const dbPath = tmpDbPath();
    const keep = 3;
    const saver = SqliteSaver.fromConnString(dbPath, {
      maxCheckpointsPerThread: keep,
    });
    // Bulk must live in a non-message channel: `messages` channel values are
    // extracted into the (never-pruned) messages table, but other channel
    // values stay inside the checkpoint blob that pruning deletes.
    const bigContent = 'x'.repeat(64 * 1024);
    const putStep = async (i: number) =>
      saver.put(
        { configurable: { thread_id: 'thread-1' } },
        {
          ...emptyCheckpoint(),
          id: uuid6(i),
          channel_values: { messages: [], scratch: `${bigContent}${i}` },
        },
        { source: 'loop', step: i, parents: {} },
      );

    // Fill to just below the prune trigger (count must exceed keep + PRUNE_SLACK(5)).
    for (let i = 0; i < 8; i++) {
      await putStep(i);
    }
    const sizeBeforePrune = fs.statSync(dbPath).size;

    // 9th put: count hits 9 > 8, prune drops six ~64KB checkpoint blobs and
    // must hand the pages back — far more than the one blob this put adds.
    await putStep(8);

    const freelist: number = saver.db.pragma('freelist_count', {
      simple: true,
    });
    expect(freelist).toBe(0);
    expect(fs.statSync(dbPath).size).toBeLessThan(sizeBeforePrune);
  });

  it('never VACUUMs a legacy auto_vacuum=NONE file on open', async () => {
    const dbPath = tmpDbPath();
    // Build a legacy-mode file with a large freelist, like a pre-1.1.x DB
    // after pruning: data written, then deleted, pages never reclaimed.
    const legacy = new Database(dbPath);
    legacy.exec('CREATE TABLE junk (payload BLOB)');
    const insert = legacy.prepare('INSERT INTO junk (payload) VALUES (?)');
    for (let i = 0; i < 50; i++) {
      insert.run(Buffer.alloc(64 * 1024, 1));
    }
    legacy.exec('DELETE FROM junk');
    legacy.close();
    const bloatedSize = fs.statSync(dbPath).size;

    const saver = SqliteSaver.fromConnString(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-1' } },
      checkpointWithMessages(0, []),
      { source: 'input', step: 0, parents: {} },
    );

    // The request path must not pay for a migration VACUUM: the file keeps
    // its high-water size (new rows reuse freelist pages).
    expect(fs.statSync(dbPath).size).toBe(bloatedSize);
  });
});
