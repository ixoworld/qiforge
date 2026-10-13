/**
 * Content tools over an in-memory document (no Matrix): the locked-block
 * policy on delete/move, the one-session-per-run document source, and the
 * `call_editor_agent` lifecycle (one open, always closed, honours the turn's
 * abort signal) driven by a scripted model.
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { createClient } from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { MatrixAdapter } from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { PluginTool, RoomStateSnapshot } from '../../plugin-api/types';
import { markdownToBlockContainers } from './blocknote-bridge';
import {
  sharedDocumentSource,
  type DocumentOpener,
  type DocumentSession,
} from './content-session';
import { createContentTools } from './content-tools';
import {
  appendBlocks,
  DOCUMENT_FRAGMENT_NAME,
  ensureRootGroup,
  locateBlock,
  readBlockById,
  readDocumentBlocks,
} from './document-model';
import { buildBlocknoteToolsConfig } from './editor-config';
import { createStandaloneEditorTool } from './standalone-editor-tool';

const ROOM = '!doc:test.example';

async function docFromMarkdown(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const containers = await markdownToBlockContainers(markdown);
  doc.transact(() => appendBlocks(doc, containers));
  return doc;
}

/** A content-less custom block, appended at the root or nested under `parentId`. */
function addCustomBlock(
  doc: Y.Doc,
  id: string,
  type: string,
  props: Record<string, string>,
  parentId?: string,
): void {
  doc.transact(() => {
    const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME);
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', id);
    const content = new Y.XmlElement(type);
    for (const [key, value] of Object.entries(props)) {
      content.setAttribute(key, value);
    }
    container.insert(0, [content]);
    if (!parentId) {
      const group = ensureRootGroup(fragment);
      group.insert(group.length, [container]);
      return;
    }
    const parent = locateBlock(fragment, parentId);
    if (!parent) throw new Error(`missing parent ${parentId}`);
    const group = new Y.XmlElement('blockGroup');
    group.insert(0, [container]);
    parent.container.insert(parent.container.length, [group]);
  });
}

function sessionFor(doc: Y.Doc): DocumentSession {
  return {
    doc,
    writer: { writeFailure: undefined, flush: async () => undefined },
    matrixClient: { getUserId: () => null, getStateEvent: async () => ({}) },
    roomId: ROOM,
    alias: undefined,
    isFlow: false,
  };
}

interface CountingOpener {
  open: DocumentOpener;
  opens: number;
  disposes: number;
}

/** An opener over a fixed doc that counts opens and disposals. */
function countingOpener(doc: Y.Doc): CountingOpener {
  const counter: CountingOpener = {
    opens: 0,
    disposes: 0,
    open: async () => {
      counter.opens += 1;
      return {
        session: sessionFor(doc),
        dispose: async () => {
          counter.disposes += 1;
        },
      };
    },
  };
  return counter;
}

const PARAMS = {
  matrixClient: createClient({ baseUrl: 'https://mx.test.example' }),
  appConfig: {
    ...buildBlocknoteToolsConfig({
      baseUrl: 'https://mx.test.example',
      accessToken: 't',
      userId: '@oracle:test.example',
    }),
    matrix: {
      baseUrl: 'https://mx.test.example',
      accessToken: 't',
      userId: '@oracle:test.example',
      initialSyncTimeoutMs: 1000,
      room: { type: 'id' as const, value: ROOM },
    },
  },
};

function toolsOver(doc: Y.Doc): Record<string, PluginTool> {
  const documents = sharedDocumentSource(PARAMS, countingOpener(doc).open);
  return Object.fromEntries(
    createContentTools({ documents }).map((t) => [t.name, t]),
  );
}

async function call(
  tool: PluginTool | undefined,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!tool) throw new Error('tool missing');
  return JSON.parse(String(await tool.handler(args, makeRuntimeContext())));
}

describe('locked blocks survive delete_block and move_block', () => {
  it('delete_block refuses a secrets block and leaves it in the document', async () => {
    const doc = await docFromMarkdown('intro');
    addCustomBlock(doc, 'sec-1', 'secrets', { apiKey: 'hunter2' });
    const tools = toolsOver(doc);

    const result = await call(tools.delete_block, { block_id: 'sec-1' });

    expect(result).toMatchObject({ ok: false, code: 'prop_not_editable' });
    expect(readBlockById(doc, 'sec-1')?.type).toBe('secrets');
  });

  it('delete_block refuses a prose block whose subtree holds a skills block', async () => {
    const doc = await docFromMarkdown('- parent');
    const parentId = readDocumentBlocks(doc)[0]?.id ?? '';
    addCustomBlock(doc, 'skills-1', 'skills', {}, parentId);
    const tools = toolsOver(doc);

    const result = await call(tools.delete_block, { block_id: parentId });

    expect(result).toMatchObject({ ok: false, code: 'prop_not_editable' });
    expect(JSON.stringify(result)).toContain('skills-1');
    expect(readBlockById(doc, 'skills-1')).not.toBeNull();
  });

  it('move_block refuses to move a secrets block', async () => {
    const doc = await docFromMarkdown('first');
    const firstId = readDocumentBlocks(doc)[0]?.id ?? '';
    addCustomBlock(doc, 'sec-2', 'secrets', { token: 'x' });
    const tools = toolsOver(doc);

    const result = await call(tools.move_block, {
      block_id: 'sec-2',
      reference_block_id: firstId,
      placement: 'before',
    });

    expect(result).toMatchObject({ ok: false, code: 'prop_not_editable' });
    expect(readDocumentBlocks(doc).map((b) => b.id)).toEqual([
      firstId,
      'sec-2',
    ]);
  });

  it('still deletes prose and custom IXO blocks', async () => {
    const doc = await docFromMarkdown('gone');
    const proseId = readDocumentBlocks(doc)[0]?.id ?? '';
    addCustomBlock(doc, 'chk-1', 'checkbox', { title: 'x' });
    const tools = toolsOver(doc);

    expect(await call(tools.delete_block, { block_id: proseId })).toMatchObject(
      {
        ok: true,
      },
    );
    expect(await call(tools.delete_block, { block_id: 'chk-1' })).toMatchObject(
      {
        ok: true,
      },
    );
    expect(readDocumentBlocks(doc)).toEqual([]);
  });
});

describe('sharedDocumentSource', () => {
  it('opens once for many calls and disposes once on close', async () => {
    const doc = await docFromMarkdown('hello world');
    const opener = countingOpener(doc);
    const documents = sharedDocumentSource(PARAMS, opener.open);
    const tools = Object.fromEntries(
      createContentTools({ documents }).map((t) => [t.name, t]),
    );
    const id = readDocumentBlocks(doc)[0]?.id ?? '';

    await call(tools.read_document, {});
    await call(tools.search_document, { query: 'hello' });
    await call(tools.edit_block, { edits: [{ block_id: id, text: 'bye' }] });
    expect(await call(tools.read_block, { block_id: id })).toMatchObject({
      ok: true,
      block: { text: 'bye' },
    });
    expect(opener.opens).toBe(1);

    await documents.close();
    expect(opener.disposes).toBe(1);
    expect(await call(tools.read_document, {})).toMatchObject({ ok: false });
    expect(opener.opens).toBe(1);
  });

  it('never opens when no call is made, and close is then a no-op', async () => {
    const opener = countingOpener(new Y.Doc());
    await sharedDocumentSource(PARAMS, opener.open).close();
    expect(opener).toMatchObject({ opens: 0, disposes: 0 });
  });

  it('retries an open that failed instead of remembering the failure', async () => {
    const doc = new Y.Doc();
    let attempts = 0;
    const documents = sharedDocumentSource(PARAMS, async () => {
      attempts += 1;
      if (attempts === 1) {
        return { ok: false, code: 'error', message: 'transient' };
      }
      return { session: sessionFor(doc), dispose: async () => undefined };
    });
    expect(await documents.use(async () => 'x')).toMatchObject({ ok: false });
    expect(await documents.use(async () => 'y')).toBe('y');
    expect(attempts).toBe(2);
  });

  it('close waits for a call still running before disposing', async () => {
    const opener = countingOpener(new Y.Doc());
    const documents = sharedDocumentSource(PARAMS, opener.open);
    let release = (): void => undefined;
    const running = documents.use(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('done');
        }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const closing = documents.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(opener.disposes).toBe(0);
    release();
    expect(await running).toBe('done');
    await closing;
    expect(opener.disposes).toBe(1);
  });
});

// ── call_editor_agent lifecycle ────────────────────────────────────────

type Step = AIMessage | Error;

/** A chat model that replays a fixed script of replies and counts its calls. */
class ScriptedModel extends BaseChatModel {
  calls = 0;

  constructor(private readonly script: Step[]) {
    super({});
  }

  _llmType(): string {
    return 'scripted';
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const next = this.script[this.calls] ?? new AIMessage('done');
    this.calls += 1;
    if (next instanceof Error) throw next;
    return { generations: [{ text: '', message: next }] };
  }

  override bindTools(): this {
    return this;
  }
}

function toolCalls(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: calls.map((c, i) => ({
      ...c,
      id: `call-${c.name}-${i}`,
      type: 'tool_call' as const,
    })),
  });
}

function matrixWithMember(userId: string): MatrixAdapter {
  const state: RoomStateSnapshot = {
    roomId: ROOM,
    state: [
      {
        type: 'm.room.member',
        state_key: userId,
        content: { membership: 'join' },
        sender: userId,
        event_id: '$m',
      },
    ],
  };
  return {
    postToRoom: () => Promise.reject(new Error('unexpected')),
    postEvent: () => Promise.reject(new Error('unexpected')),
    getRoomState: () => Promise.resolve(state),
    getEventById: () => Promise.reject(new Error('unexpected')),
    botCredentials: () => Promise.reject(new Error('unexpected')),
  };
}

async function runEditor(
  model: ScriptedModel,
  doc: Y.Doc,
  signal: AbortSignal = new AbortController().signal,
) {
  const opener = countingOpener(doc);
  const tool = createStandaloneEditorTool({
    toolsConfig: {
      ...buildBlocknoteToolsConfig({
        baseUrl: 'https://mx.test.example',
        accessToken: 't',
        userId: '@oracle:test.example',
      }),
      matrixClient: PARAMS.matrixClient,
    },
    pluginName: 'editor',
    openDocument: opener.open,
  });
  const ctx = makeRuntimeContext(
    { abortSignal: signal },
    {
      ambient: {
        matrix: matrixWithMember('@did-ixo-user1:ixo.world'),
        llm: { get: () => model },
      },
    },
  );
  const outcome = await Promise.resolve()
    .then(() => tool.handler({ room_id: ROOM, task: 'tidy it' }, ctx))
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  return { opener, outcome };
}

describe('call_editor_agent', () => {
  it('opens the document once for a multi-step task and closes it', async () => {
    const doc = await docFromMarkdown('hello world');
    const id = readDocumentBlocks(doc)[0]?.id ?? '';
    const model = new ScriptedModel([
      toolCalls([
        { name: 'read_document', args: {} },
        { name: 'search_document', args: { query: 'hello' } },
      ]),
      toolCalls([
        {
          name: 'edit_block',
          args: { edits: [{ block_id: id, text: 'bye' }] },
        },
      ]),
      toolCalls([{ name: 'read_block', args: { block_id: id } }]),
      new AIMessage('Changed the paragraph to "bye".'),
    ]);

    const { opener, outcome } = await runEditor(model, doc);

    expect(outcome).toEqual({ value: 'Changed the paragraph to "bye".' });
    expect(model.calls).toBe(4);
    expect(opener).toMatchObject({ opens: 1, disposes: 1 });
    expect(readDocumentBlocks(doc)[0]?.text).toBe('bye');
  });

  it('closes the document when the inner agent fails', async () => {
    const doc = await docFromMarkdown('hello');
    const model = new ScriptedModel([
      toolCalls([{ name: 'read_document', args: {} }]),
      new Error('model exploded'),
    ]);

    const { opener, outcome } = await runEditor(model, doc);

    expect(outcome).toMatchObject({
      value: expect.stringContaining('model exploded'),
    });
    expect(opener).toMatchObject({ opens: 1, disposes: 1 });
  });

  it('never calls the model when the turn is already cancelled', async () => {
    const aborted = new AbortController();
    aborted.abort(new Error('user cancelled'));
    const model = new ScriptedModel([new AIMessage('should not run')]);

    const { opener, outcome } = await runEditor(
      model,
      new Y.Doc(),
      aborted.signal,
    );

    expect(outcome).toHaveProperty('error');
    expect(model.calls).toBe(0);
    expect(opener).toMatchObject({ opens: 0, disposes: 0 });
  });

  it('stops after a cancellation mid-run and still closes the document', async () => {
    const doc = await docFromMarkdown('hello');
    const controller = new AbortController();
    const model = new ScriptedModel([
      toolCalls([{ name: 'read_document', args: {} }]),
      new AIMessage('should not be reached'),
    ]);
    // Cancel as soon as the first model reply has been produced.
    const generate = model._generate.bind(model);
    model._generate = async (messages: BaseMessage[]) => {
      const result = await generate(messages);
      controller.abort(new Error('user cancelled'));
      return result;
    };

    const { opener, outcome } = await runEditor(model, doc, controller.signal);

    expect(outcome).toHaveProperty('error');
    expect(model.calls).toBe(1);
    expect(opener.disposes).toBe(opener.opens);
  });
});
