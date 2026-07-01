import { HumanMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  type Checkpoint,
  type CheckpointTuple,
  emptyCheckpoint,
  TASKS,
  uuid6,
} from '@langchain/langgraph-checkpoint';
import { SqliteSaver } from '../index';

const checkpoint1: Checkpoint = {
  v: 1,
  id: uuid6(-1),
  ts: '2024-04-19T17:19:07.952Z',
  channel_values: {
    someKey1: 'someValue1',
  },
  channel_versions: {
    someKey2: 1,
  },
  versions_seen: {
    someKey3: {
      someKey4: 1,
    },
  },
};
const checkpoint2: Checkpoint = {
  v: 1,
  id: uuid6(1),
  ts: '2024-04-20T17:19:07.952Z',
  channel_values: {
    someKey1: 'someValue2',
  },
  channel_versions: {
    someKey2: 2,
  },
  versions_seen: {
    someKey3: {
      someKey4: 2,
    },
  },
};

describe('SqliteSaver', () => {
  it('should save and retrieve checkpoints correctly', async () => {
    const sqliteSaver = SqliteSaver.fromConnString(':memory:');

    // get undefined checkpoint
    const undefinedCheckpoint = await sqliteSaver.getTuple({
      configurable: { thread_id: '1' },
    });
    expect(undefinedCheckpoint).toBeUndefined();

    // save first checkpoint
    const runnableConfig = await sqliteSaver.put(
      { configurable: { thread_id: '1' } },
      checkpoint1,
      { source: 'update', step: -1, parents: {} },
    );
    expect(runnableConfig).toEqual({
      configurable: {
        thread_id: '1',
        checkpoint_ns: '',
        checkpoint_id: checkpoint1.id,
      },
    });

    // add some writes
    await sqliteSaver.putWrites(
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

    // get first checkpoint tuple
    const firstCheckpointTuple = await sqliteSaver.getTuple({
      configurable: { thread_id: '1' },
    });
    expect(firstCheckpointTuple?.config).toEqual({
      configurable: {
        thread_id: '1',
        checkpoint_ns: '',
        checkpoint_id: checkpoint1.id,
      },
    });
    expect(firstCheckpointTuple?.checkpoint).toEqual(checkpoint1);
    expect(firstCheckpointTuple?.parentConfig).toBeUndefined();
    expect(firstCheckpointTuple?.pendingWrites).toEqual([
      ['foo', 'bar', 'baz'],
    ]);

    // save second checkpoint
    await sqliteSaver.put(
      {
        configurable: {
          thread_id: '1',
          checkpoint_id: '2024-04-18T17:19:07.952Z',
        },
      },
      checkpoint2,
      {
        source: 'update',
        step: -1,
        parents: { '': checkpoint1.id },
      },
    );

    // verify that parentTs is set and retrieved correctly for second checkpoint
    const secondCheckpointTuple = await sqliteSaver.getTuple({
      configurable: { thread_id: '1' },
    });
    expect(secondCheckpointTuple?.parentConfig).toEqual({
      configurable: {
        thread_id: '1',
        checkpoint_ns: '',
        checkpoint_id: '2024-04-18T17:19:07.952Z',
      },
    });

    // list checkpoints
    const checkpointTupleGenerator = sqliteSaver.list(
      {
        configurable: { thread_id: '1' },
      },
      {
        filter: {
          source: 'update',
          step: -1,
          parents: { '': checkpoint1.id },
        },
      },
    );
    const checkpointTuples: CheckpointTuple[] = [];
    for await (const checkpoint of checkpointTupleGenerator) {
      checkpointTuples.push(checkpoint);
    }
    expect(checkpointTuples.length).toBe(1);

    const checkpointTuple1 = checkpointTuples[0];
    expect(checkpointTuple1?.checkpoint.ts).toBe('2024-04-20T17:19:07.952Z');
  });

  it('should delete thread', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');
    await saver.put({ configurable: { thread_id: '1' } }, emptyCheckpoint(), {
      source: 'update',
      step: -1,
      parents: {},
    });

    await saver.put({ configurable: { thread_id: '2' } }, emptyCheckpoint(), {
      source: 'update',
      step: -1,
      parents: {},
    });

    await saver.deleteThread('1');

    expect(
      await saver.getTuple({ configurable: { thread_id: '1' } }),
    ).toBeUndefined();

    expect(
      await saver.getTuple({ configurable: { thread_id: '2' } }),
    ).toBeDefined();
  });

  it('should delete messages rows when deleting a thread', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');

    const checkpointWithMessages = (id: string): Checkpoint => ({
      ...emptyCheckpoint(),
      id: uuid6(-1),
      channel_values: {
        messages: [new HumanMessage({ id, content: `message ${id}` })],
      },
    });

    await saver.put(
      { configurable: { thread_id: '1' } },
      checkpointWithMessages('msg-thread-1'),
      { source: 'update', step: -1, parents: {} },
    );
    await saver.put(
      { configurable: { thread_id: '2' } },
      checkpointWithMessages('msg-thread-2'),
      { source: 'update', step: -1, parents: {} },
    );

    const countMessages = (threadId: string): number => {
      const row = saver.db
        .prepare<
          [string],
          { count: number }
        >('SELECT COUNT(*) as count FROM messages WHERE thread_id = ?')
        .get(threadId);
      return row?.count ?? 0;
    };

    expect(countMessages('1')).toBe(1);
    expect(countMessages('2')).toBe(1);

    await saver.deleteThread('1');

    expect(countMessages('1')).toBe(0);
    expect(countMessages('2')).toBe(1);
  });

  it('getTupleWithoutMessages omits history but keeps other channel_values', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');

    const checkpoint: Checkpoint = {
      ...emptyCheckpoint(),
      id: uuid6(-1),
      channel_values: {
        messages: [new HumanMessage({ id: 'm1', content: 'hello' })],
        loadedPlugins: ['weather'],
      },
    };

    await saver.put({ configurable: { thread_id: '1' } }, checkpoint, {
      source: 'update',
      step: -1,
      parents: {},
    });

    // Full read attaches the persisted message history.
    const full = await saver.getTuple({ configurable: { thread_id: '1' } });
    expect(
      (full?.checkpoint.channel_values.messages as unknown[])?.length,
    ).toBe(1);
    expect(full?.checkpoint.channel_values.loadedPlugins).toEqual(['weather']);

    // Light read skips the messages join but still returns scalar state.
    const light = await saver.getTupleWithoutMessages({
      configurable: { thread_id: '1' },
    });
    expect(light?.checkpoint.channel_values.messages).toBeUndefined();
    expect(light?.checkpoint.channel_values.loadedPlugins).toEqual(['weather']);
    // Same checkpoint identity + metadata as the full read.
    expect(light?.config.configurable?.checkpoint_id).toBe(checkpoint.id);
    expect(light?.metadata?.source).toBe('update');
  });

  it('should delete thread on a fresh saver without prior reads or writes', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');

    await expect(saver.deleteThread('never-existed')).resolves.toBeUndefined();
  });

  it('pending sends migration', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');

    let config: RunnableConfig = {
      configurable: { thread_id: 'thread-1', checkpoint_ns: '' },
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

    // check that fetching checkpount 0 doesn't attach pending sends
    // (they should be attached to the next checkpoint)
    const tuple0 = await saver.getTuple(config);
    expect(tuple0?.checkpoint.channel_values).toEqual({});
    expect(tuple0?.checkpoint.channel_versions).toEqual({});

    // create second checkpoint
    const checkpoint1: Checkpoint = {
      v: 1,
      id: uuid6(1),
      ts: '2024-04-20T17:19:07.952Z',
      channel_values: {},
      channel_versions: checkpoint0.channel_versions,
      versions_seen: checkpoint0.versions_seen,
    };
    config = await saver.put(config, checkpoint1, {
      source: 'loop',
      parents: {},
      step: 1,
    });

    // check that pending sends are attached to checkpoint1
    const checkpoint1Tuple = await saver.getTuple(config);
    expect(checkpoint1Tuple?.checkpoint.channel_values).toEqual({
      [TASKS]: ['send-1', 'send-2', 'send-3'],
    });
    expect(checkpoint1Tuple?.checkpoint.channel_versions[TASKS]).toBeDefined();

    // check that the list also applies the migration
    const checkpointTupleGenerator = saver.list({
      configurable: { thread_id: 'thread-1' },
    });

    const checkpointTuples: CheckpointTuple[] = [];
    for await (const checkpoint of checkpointTupleGenerator) {
      checkpointTuples.push(checkpoint);
    }
    expect(checkpointTuples.length).toBe(2);
    expect(checkpointTuples[0]?.checkpoint.channel_values).toEqual({
      [TASKS]: ['send-1', 'send-2', 'send-3'],
    });
    expect(
      checkpointTuples[0]?.checkpoint.channel_versions[TASKS],
    ).toBeDefined();
  });

  it('should filter list by checkpoint_ns', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');

    // Create checkpoints in different namespaces
    const checkpoint1 = emptyCheckpoint();
    const checkpoint2 = emptyCheckpoint();
    const checkpoint3 = emptyCheckpoint();

    await saver.put(
      { configurable: { thread_id: 'thread-1', checkpoint_ns: 'ns1' } },
      checkpoint1,
      { source: 'update', step: -1, parents: {} },
    );

    await saver.put(
      { configurable: { thread_id: 'thread-1', checkpoint_ns: 'ns2' } },
      checkpoint2,
      { source: 'update', step: -1, parents: {} },
    );

    await saver.put(
      { configurable: { thread_id: 'thread-1', checkpoint_ns: 'ns1' } },
      checkpoint3,
      { source: 'update', step: -1, parents: {} },
    );

    // List checkpoints in ns1
    const ns1Generator = saver.list({
      configurable: { thread_id: 'thread-1', checkpoint_ns: 'ns1' },
    });

    const ns1Tuples: CheckpointTuple[] = [];
    for await (const checkpoint of ns1Generator) {
      ns1Tuples.push(checkpoint);
    }
    expect(ns1Tuples.length).toBe(2);
    expect(
      ns1Tuples.every((t) => t.config.configurable?.checkpoint_ns === 'ns1'),
    ).toBe(true);

    // List checkpoints in ns2
    const ns2Generator = saver.list({
      configurable: { thread_id: 'thread-1', checkpoint_ns: 'ns2' },
    });

    const ns2Tuples: CheckpointTuple[] = [];
    for await (const checkpoint of ns2Generator) {
      ns2Tuples.push(checkpoint);
    }
    expect(ns2Tuples.length).toBe(1);
    expect(ns2Tuples[0]?.config.configurable?.checkpoint_ns).toBe('ns2');
  });

  it('should paginate list with before cursor', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');

    // Create multiple checkpoints with sequential timestamps
    const checkpoint1: Checkpoint = {
      v: 1,
      id: uuid6(-2),
      ts: '2024-04-19T17:19:07.952Z',
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };
    const checkpoint2: Checkpoint = {
      v: 1,
      id: uuid6(-1),
      ts: '2024-04-20T17:19:07.952Z',
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };
    const checkpoint3: Checkpoint = {
      v: 1,
      id: uuid6(0),
      ts: '2024-04-21T17:19:07.952Z',
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };

    await saver.put({ configurable: { thread_id: 'thread-1' } }, checkpoint1, {
      source: 'update',
      step: -1,
      parents: {},
    });
    await saver.put({ configurable: { thread_id: 'thread-1' } }, checkpoint2, {
      source: 'update',
      step: -1,
      parents: {},
    });
    const config3 = await saver.put(
      { configurable: { thread_id: 'thread-1' } },
      checkpoint3,
      { source: 'update', step: -1, parents: {} },
    );

    // List all checkpoints
    const allGenerator = saver.list({
      configurable: { thread_id: 'thread-1' },
    });
    const allTuples: CheckpointTuple[] = [];
    for await (const checkpoint of allGenerator) {
      allTuples.push(checkpoint);
    }
    expect(allTuples.length).toBe(3);

    // List with before cursor (should return checkpoints before checkpoint3)
    const beforeGenerator = saver.list(
      {
        configurable: { thread_id: 'thread-1' },
      },
      {
        before: {
          configurable: {
            checkpoint_id: config3.configurable?.checkpoint_id,
          },
        },
      },
    );

    const beforeTuples: CheckpointTuple[] = [];
    for await (const checkpoint of beforeGenerator) {
      beforeTuples.push(checkpoint);
    }
    expect(beforeTuples.length).toBe(2);
    expect(
      beforeTuples.every(
        (t) =>
          t.config.configurable?.checkpoint_id !==
          config3.configurable?.checkpoint_id,
      ),
    ).toBe(true);
  });

  it('should limit list results', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');

    // Create 5 checkpoints
    for (let i = 0; i < 5; i++) {
      const checkpoint: Checkpoint = {
        v: 1,
        id: uuid6(i - 3),
        ts: `2024-04-${19 + i}T17:19:07.952Z`,
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      };
      await saver.put({ configurable: { thread_id: 'thread-1' } }, checkpoint, {
        source: 'update',
        step: -1,
        parents: {},
      });
    }

    // List without limit
    const allGenerator = saver.list({
      configurable: { thread_id: 'thread-1' },
    });
    const allTuples: CheckpointTuple[] = [];
    for await (const checkpoint of allGenerator) {
      allTuples.push(checkpoint);
    }
    expect(allTuples.length).toBe(5);

    // List with limit of 2
    const limitedGenerator = saver.list(
      {
        configurable: { thread_id: 'thread-1' },
      },
      { limit: 2 },
    );

    const limitedTuples: CheckpointTuple[] = [];
    for await (const checkpoint of limitedGenerator) {
      limitedTuples.push(checkpoint);
    }
    expect(limitedTuples.length).toBe(2);
  });

  it('should filter list by metadata fields', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');

    const checkpoint1 = emptyCheckpoint();
    const checkpoint2 = emptyCheckpoint();
    const checkpoint3 = emptyCheckpoint();

    await saver.put({ configurable: { thread_id: 'thread-1' } }, checkpoint1, {
      source: 'update',
      step: 1,
      parents: {},
    });

    await saver.put({ configurable: { thread_id: 'thread-1' } }, checkpoint2, {
      source: 'loop',
      step: 2,
      parents: {},
    });

    await saver.put({ configurable: { thread_id: 'thread-1' } }, checkpoint3, {
      source: 'update',
      step: 3,
      parents: {},
    });

    // Filter by source
    const updateGenerator = saver.list(
      {
        configurable: { thread_id: 'thread-1' },
      },
      {
        filter: { source: 'update' },
      },
    );

    const updateTuples: CheckpointTuple[] = [];
    for await (const checkpoint of updateGenerator) {
      updateTuples.push(checkpoint);
    }
    expect(updateTuples.length).toBe(2);
    expect(updateTuples.every((t) => t.metadata?.source === 'update')).toBe(
      true,
    );

    // Filter by step
    const stepGenerator = saver.list(
      {
        configurable: { thread_id: 'thread-1' },
      },
      {
        filter: { step: 2 },
      },
    );

    const stepTuples: CheckpointTuple[] = [];
    for await (const checkpoint of stepGenerator) {
      stepTuples.push(checkpoint);
    }
    expect(stepTuples.length).toBe(1);
    expect(stepTuples[0]?.metadata?.step).toBe(2);
  });

  it('should throw error when put() is called without config.configurable', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');
    const checkpoint = emptyCheckpoint();

    await expect(
      saver.put({} as RunnableConfig, checkpoint, {
        source: 'update',
        step: -1,
        parents: {},
      }),
    ).rejects.toThrow('Empty configuration supplied.');
  });

  it('should throw error when put() is called without thread_id', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');
    const checkpoint = emptyCheckpoint();

    await expect(
      saver.put({ configurable: {} } as RunnableConfig, checkpoint, {
        source: 'update',
        step: -1,
        parents: {},
      }),
    ).rejects.toThrow(
      'Missing "thread_id" field in passed "config.configurable".',
    );
  });

  it('should throw error when putWrites() is called without config.configurable', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');

    await expect(
      saver.putWrites({} as RunnableConfig, [['channel', 'value']], 'task-1'),
    ).rejects.toThrow('Empty configuration supplied.');
  });

  it('should throw error when putWrites() is called without thread_id', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');

    await expect(
      saver.putWrites(
        { configurable: {} } as RunnableConfig,
        [['channel', 'value']],
        'task-1',
      ),
    ).rejects.toThrow('Missing thread_id field in config.configurable.');
  });

  it('should throw error when putWrites() is called without checkpoint_id', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');

    await expect(
      saver.putWrites(
        { configurable: { thread_id: 'thread-1' } } as RunnableConfig,
        [['channel', 'value']],
        'task-1',
      ),
    ).rejects.toThrow('Missing checkpoint_id field in config.configurable.');
  });

  it('should migrate pending sends for v<4 checkpoints in list()', async () => {
    const saver = SqliteSaver.fromConnString(':memory:');

    // Create v<4 checkpoint (v: 1)
    const checkpoint0: Checkpoint = {
      v: 1,
      id: uuid6(-1),
      ts: '2024-04-19T17:19:07.952Z',
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };

    let config = await saver.put(
      { configurable: { thread_id: 'thread-1' } },
      checkpoint0,
      {
        source: 'loop',
        parents: {},
        step: 0,
      },
    );

    // Add pending sends to checkpoint0
    await saver.putWrites(
      config,
      [
        [TASKS, 'send-1'],
        [TASKS, 'send-2'],
      ],
      'task-1',
    );

    // Create v<4 child checkpoint that should inherit pending sends
    const checkpoint1: Checkpoint = {
      v: 1,
      id: uuid6(0),
      ts: '2024-04-20T17:19:07.952Z',
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };

    config = await saver.put(
      {
        configurable: {
          thread_id: 'thread-1',
          checkpoint_id: checkpoint0.id,
        },
      },
      checkpoint1,
      {
        source: 'loop',
        parents: { '': checkpoint0.id },
        step: 1,
      },
    );

    // List should migrate pending sends for v<4 checkpoint
    const listGenerator = saver.list({
      configurable: { thread_id: 'thread-1' },
    });

    const listTuples: CheckpointTuple[] = [];
    for await (const checkpoint of listGenerator) {
      listTuples.push(checkpoint);
    }

    // Find checkpoint1 in the list
    const checkpoint1Tuple = listTuples.find(
      (t) => t.config.configurable?.checkpoint_id === checkpoint1.id,
    );

    expect(checkpoint1Tuple).toBeDefined();
    expect(checkpoint1Tuple?.checkpoint.channel_values[TASKS]).toEqual([
      'send-1',
      'send-2',
    ]);
    expect(checkpoint1Tuple?.checkpoint.channel_versions[TASKS]).toBeDefined();
  });
});
