/**
 * Attachment bytes never reach storage: every write path of the
 * checkpointer (message rows, the checkpoint blob's other channels, pending
 * writes and `Send` packets) stores a human message with inline base64
 * blocks as its placeholder copy, the metadata intact, while the in-memory
 * message keeps its blocks. Runs inside workerd on the real SQLite VFS.
 */
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { Send } from '@langchain/langgraph';
import {
  type Checkpoint,
  emptyCheckpoint,
  TASKS,
  uuid6,
} from '@langchain/langgraph-checkpoint';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_VIEW_SOURCE,
  hasInlinePayload,
  isAttachmentPlaceholderText,
  isAttachmentViewMessage,
} from '../attachments/retention';
import { compressForStorage, readBlobText } from './blob-codec';
import { DoSqliteDatabase } from './database';
import { withoutInlinePayloads } from './inline-payloads';
import { _default, stringify } from './serialization';
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

/** Base64 no stored byte may contain (long enough to be unmistakable). */
const PAYLOAD = 'UEFZTE9BRC1CWVRFUy1ORVZFUi1TVE9SRUQ'.repeat(40);

const META = {
  filename: 'red.png',
  mimetype: 'image/png',
  size: 1234,
  mxcUri: 'mxc://hs/red',
  category: 'image',
};

const IMAGE_BLOCK = {
  type: 'image',
  source_type: 'base64',
  mime_type: 'image/png',
  data: PAYLOAD,
};

function imageTurn(id: string): HumanMessage {
  return new HumanMessage({
    id,
    content: [{ type: 'text', text: 'what colour is this?' }, IMAGE_BLOCK],
    additional_kwargs: {
      timestamp: '2026-11-03T10:00:00.000Z',
      attachment: META,
      attachments: [META],
    },
  });
}

function viewMessage(id: string): HumanMessage {
  return new HumanMessage({
    id,
    content: [{ type: 'text', text: 'Re-attached "red.png"' }, IMAGE_BLOCK],
    additional_kwargs: {
      lc_source: ATTACHMENT_VIEW_SOURCE,
      timestamp: '2026-11-03T10:01:00.000Z',
      attachment: META,
      attachments: [META],
    },
  });
}

let clockSeq = 0;
function checkpoint(channelValues: Record<string, unknown>): Checkpoint {
  return {
    ...emptyCheckpoint(),
    id: uuid6(++clockSeq),
    channel_values: channelValues,
  };
}

const config = (thread: string) => ({
  configurable: { thread_id: thread, checkpoint_ns: '' },
});

async function put(
  saver: SqliteSaver,
  thread: string,
  channelValues: Record<string, unknown>,
  step = 0,
): Promise<string> {
  const cp = checkpoint(channelValues);
  await saver.put(config(thread), cp, { source: 'loop', step, parents: {} });
  return cp.id;
}

/** Every stored byte of the database, decoded, as one string. */
async function storedText(db: DoSqliteDatabase): Promise<string> {
  const parts: string[] = [];
  for (const row of await db.exec<{
    message_content: string;
    message: Uint8Array | string;
  }>('SELECT message_content, message FROM messages'))
    parts.push(row.message_content, await readBlobText(row.message));
  for (const row of await db.exec<{ checkpoint: Uint8Array | string }>(
    'SELECT checkpoint FROM checkpoints',
  ))
    parts.push(await readBlobText(row.checkpoint));
  for (const row of await db.exec<{ value: Uint8Array | string }>(
    'SELECT value FROM writes',
  ))
    parts.push(await readBlobText(row.value));
  return parts.join('\n');
}

function placeholderOf(message: BaseMessage): string | undefined {
  if (!Array.isArray(message.content)) return undefined;
  for (const block of message.content) {
    if (
      typeof block === 'object' &&
      'text' in block &&
      typeof block.text === 'string' &&
      isAttachmentPlaceholderText(block.text)
    )
      return block.text;
  }
  return undefined;
}

function messagesOf(value: unknown): BaseMessage[] {
  return Array.isArray(value)
    ? value.filter(
        (m): m is BaseMessage =>
          m instanceof HumanMessage || m instanceof AIMessage,
      )
    : [];
}

describe('attachment bytes are never stored', () => {
  it('message rows hold the placeholder with the metadata intact; the in-memory message keeps its block', async () => {
    await runInDurableObject(stub('inline-rows'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'rows.db');
      const saver = new SqliteSaver(db);
      const turn = imageTurn('h-1');
      const reply = new AIMessage({ id: 'a-1', content: 'It is red.' });
      const view = viewMessage('v-1');
      await put(saver, 't', { messages: [turn, reply, view] });

      expect(hasInlinePayload(turn)).toBe(true);
      expect(hasInlinePayload(view)).toBe(true);
      expect(await storedText(db)).not.toContain(PAYLOAD);

      const tuple = await saver.getTuple(config('t'));
      const loaded = messagesOf(tuple?.checkpoint.channel_values['messages']);
      expect(loaded.map((m) => m.id)).toEqual(['h-1', 'a-1', 'v-1']);
      const [human, ai, viewed] = loaded;
      expect(hasInlinePayload(human!)).toBe(false);
      expect(placeholderOf(human!)).toContain('ref: mxc://hs/red');
      expect(human!.content).toEqual([
        { type: 'text', text: 'what colour is this?' },
        { type: 'text', text: placeholderOf(human!) },
      ]);
      expect(human!.additional_kwargs.attachments).toEqual([META]);
      expect(human!.additional_kwargs.attachment).toEqual(META);
      // A message without an inline block is stored exactly as it was.
      expect(ai!.content).toBe('It is red.');
      // The re-attachment message keeps its marker (transcripts hide it).
      expect(isAttachmentViewMessage(viewed!)).toBe(true);
      expect(hasInlinePayload(viewed!)).toBe(false);
      expect(placeholderOf(viewed!)).toContain('"red.png"');

      // The transcript read sees the same stored form.
      const listed = await saver.listThreadMessages('t');
      expect(listed.some((m) => hasInlinePayload(m))).toBe(false);
      await db.close();
    });
  });

  it('a later put of the same message reuses its stored form', async () => {
    await runInDurableObject(stub('inline-reuse'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'reuse.db');
      const saver = new SqliteSaver(db);
      const turn = imageTurn('h-1');
      await put(saver, 't', { messages: [turn] }, 0);
      const first = await db.get<{ message_content: string }>(
        "SELECT message_content FROM messages WHERE message_id = 'h-1'",
      );
      await put(
        saver,
        't',
        {
          messages: [turn, new AIMessage({ id: 'a-1', content: 'red' })],
        },
        1,
      );
      const second = await db.get<{ message_content: string }>(
        "SELECT message_content FROM messages WHERE message_id = 'h-1'",
      );
      expect(second?.message_content).toBe(first?.message_content);
      expect(second?.message_content).not.toContain(PAYLOAD);
      expect(await storedText(db)).not.toContain(PAYLOAD);
      await db.close();
    });
  });

  it('pending writes and Send packets store the placeholder; a resumed run reads it back', async () => {
    await runInDurableObject(stub('inline-writes'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'writes.db');
      const saver = new SqliteSaver(db);
      const turn = imageTurn('h-1');
      const id = await put(saver, 't', { messages: [] });
      const writeConfig = {
        configurable: { thread_id: 't', checkpoint_ns: '', checkpoint_id: id },
      };
      const send = new Send('tools', {
        messages: [turn],
        lg_tool_call: { name: 'view_attachment', args: {}, id: 'c-1' },
      });
      await saver.putWrites(
        writeConfig,
        [
          ['messages', [viewMessage('v-1')]],
          [TASKS, send],
        ],
        'task-1',
      );
      expect(hasInlinePayload(turn)).toBe(true);
      expect(await storedText(db)).not.toContain(PAYLOAD);

      const tuple = await saver.getTuple(config('t'));
      const writes = tuple?.pendingWrites ?? [];
      expect(writes.map(([task, channel]) => [task, channel])).toEqual([
        ['task-1', 'messages'],
        ['task-1', TASKS],
      ]);
      const [viewed] = messagesOf(writes[0]?.[2]);
      expect(isAttachmentViewMessage(viewed!)).toBe(true);
      expect(placeholderOf(viewed!)).toContain('ref: mxc://hs/red');
      const packet: unknown = writes[1]?.[2];
      expect(packet).toMatchObject({ node: 'tools' });
      const args: unknown =
        typeof packet === 'object' && packet !== null
          ? Reflect.get(packet, 'args')
          : undefined;
      const sent =
        typeof args === 'object' && args !== null
          ? messagesOf(Reflect.get(args, 'messages'))
          : [];
      expect(sent).toHaveLength(1);
      expect(hasInlinePayload(sent[0]!)).toBe(false);
      expect(sent[0]!.additional_kwargs.attachments).toEqual([META]);
      await db.close();
    });
  });

  it('other channel values of the checkpoint blob store the placeholder', async () => {
    await runInDurableObject(stub('inline-channels'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'channels.db');
      const saver = new SqliteSaver(db);
      const turn = imageTurn('h-1');
      const channels = {
        messages: [turn],
        carried: { nested: [turn] },
        loadedPlugins: ['memory'],
      };
      await put(saver, 't', channels);
      expect(hasInlinePayload(turn)).toBe(true);
      expect(channels.carried.nested[0]).toBe(turn);
      expect(await storedText(db)).not.toContain(PAYLOAD);
      const tuple = await saver.getTuple(config('t'));
      const carried: unknown = tuple?.checkpoint.channel_values['carried'];
      const nested =
        typeof carried === 'object' && carried !== null
          ? messagesOf(Reflect.get(carried, 'nested'))
          : [];
      expect(nested).toHaveLength(1);
      expect(placeholderOf(nested[0]!)).toBeDefined();
      expect(tuple?.checkpoint.channel_values['loadedPlugins']).toEqual([
        'memory',
      ]);
      await db.close();
    });
  });

  it('a row written with the bytes before this change is stored as its placeholder on the next put', async () => {
    await runInDurableObject(stub('inline-legacy'), async (_i, state) => {
      const db = await DoSqliteDatabase.open(state, 'legacy.db');
      const writer = new SqliteSaver(db);
      const turn = imageTurn('h-1');
      await put(writer, 't', { messages: [turn] }, 0);
      // What the saver used to store: the message with its inline block.
      await db.run("UPDATE messages SET message = ? WHERE message_id = 'h-1'", [
        await compressForStorage(
          stringify(turn, (_key, value) => _default(value)),
        ),
      ]);
      const reader = new SqliteSaver(db);
      const tuple = await reader.getTuple(config('t'));
      const loaded = messagesOf(tuple?.checkpoint.channel_values['messages']);
      expect(hasInlinePayload(loaded[0]!)).toBe(true);
      await put(reader, 't', { messages: loaded }, 1);
      expect(await storedText(db)).not.toContain(PAYLOAD);
      await db.close();
    });
  });
});

describe('withoutInlinePayloads', () => {
  it('returns a value without inline payloads as the same object', () => {
    const value = {
      messages: [new HumanMessage({ id: 'h', content: 'plain' })],
      other: [1, 'two', { three: 3 }],
    };
    expect(withoutInlinePayloads(value)).toBe(value);
    const send = new Send('tools', { messages: value.messages });
    expect(withoutInlinePayloads(send)).toBe(send);
  });

  it('leaves a non-human message with an inline block alone', () => {
    const tool = new AIMessage({
      id: 'a',
      content: [{ type: 'text', text: 'x' }, IMAGE_BLOCK],
    });
    const list = [tool];
    expect(withoutInlinePayloads(list)).toBe(list);
  });
});
