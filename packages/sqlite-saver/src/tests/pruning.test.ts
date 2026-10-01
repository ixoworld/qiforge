import { SqliteSaver } from '../index';
import { checkpointWithMessages, message } from './fixtures';

describe('SqliteSaver checkpoint pruning', () => {
  it('drops old checkpoints and their writes past the cap, keeping the latest tuple intact', async () => {
    const keep = 3;
    const saver = SqliteSaver.fromConnString(':memory:', {
      maxCheckpointsPerThread: keep,
    });

    const total = 12; // > keep + PRUNE_SLACK (5), so pruning must have fired
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
        { source: 'loop', step: i, parents: {} },
      );
      await saver.putWrites(
        config,
        [['someChannel', `write-${i}`]],
        `task-${i}`,
      );
    }

    const rows = saver.db
      .prepare(
        `SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC`,
      )
      .all('thread-1') as Array<{ checkpoint_id: string }>;
    expect(rows.length).toBeLessThanOrEqual(keep + 5);
    expect(rows[0]?.checkpoint_id).toBe(lastId);

    const writeRows = saver.db
      .prepare(`SELECT DISTINCT checkpoint_id FROM writes WHERE thread_id = ?`)
      .all('thread-1') as Array<{ checkpoint_id: string }>;
    const surviving = new Set(rows.map((row) => row.checkpoint_id));
    for (const writeRow of writeRows) {
      expect(surviving.has(writeRow.checkpoint_id)).toBe(true);
    }

    // The latest tuple still loads, with its message intact.
    const tuple = await saver.getTuple({
      configurable: { thread_id: 'thread-1' },
    });
    expect(tuple?.config.configurable?.checkpoint_id).toBe(lastId);
  });

  it('never prunes the messages table — the full transcript stays listable', async () => {
    const saver = SqliteSaver.fromConnString(':memory:', {
      maxCheckpointsPerThread: 2,
    });

    const total = 10;
    for (let i = 0; i < total; i++) {
      // Cumulative history like the graph reducer produces: every checkpoint
      // carries all messages so far.
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
        { source: 'loop', step: i, parents: {} },
      );
    }

    const transcript = await saver.listThreadMessages('thread-1');
    expect(transcript.map((m) => m.content)).toEqual(
      Array.from({ length: total }, (_, j) => `turn ${j}`),
    );
  });

  it('preserves original message timestamps across re-puts', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');
    const original = '2024-01-01T00:00:00.000Z';

    await saver.put(
      { configurable: { thread_id: 'thread-1' } },
      checkpointWithMessages(0, [message('human', 'msg-0', 'hi', original)]),
      { source: 'input', step: 0, parents: {} },
    );
    // Same message re-put under a later checkpoint (what every super-step does).
    await saver.put(
      { configurable: { thread_id: 'thread-1' } },
      checkpointWithMessages(1, [message('human', 'msg-0', 'hi', original)]),
      { source: 'loop', step: 1, parents: {} },
    );

    const row = saver.db
      .prepare(`SELECT created_at FROM messages WHERE message_id = ?`)
      .get('msg-0') as { created_at: string };
    expect(row.created_at).toBe(original);
  });

  it('keeps every checkpoint when pruning is disabled', async () => {
    const saver = SqliteSaver.fromConnString(':memory:', {
      maxCheckpointsPerThread: 0,
    });
    for (let i = 0; i < 10; i++) {
      await saver.put(
        { configurable: { thread_id: 'thread-1' } },
        checkpointWithMessages(i, []),
        { source: 'loop', step: i, parents: {} },
      );
    }
    const { count } = saver.db
      .prepare(`SELECT COUNT(*) as count FROM checkpoints WHERE thread_id = ?`)
      .get('thread-1') as { count: number };
    expect(count).toBe(10);
  });
});
