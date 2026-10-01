/**
 * The nine-tool surface end to end, against a plain `Y.Doc`.
 *
 * `withDocument` is the plugin's only Matrix boundary, so it is the only thing
 * replaced: the tools, the write choke point, the prop allowlist, and the
 * document model are all the real implementations.
 */

import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { MatrixClient } from 'matrix-js-sdk';
import {
  makeSessionStub,
  makeWriterStub,
  TEST_ROOM_ID,
  UNGRANTED_POWER_LEVELS,
  type SessionStub,
  type SessionStubOptions,
} from './__test-fixtures__/document-session.js';
import { markdownToBlockContainers } from './blocknote-bridge.js';
import type * as ContentSessionModule from './content-session.js';
import type { DocumentSession } from './content-session.js';
import {
  appendBlocks,
  ensureRootGroup,
  readDocumentBlocks,
  DOCUMENT_FRAGMENT_NAME,
} from './document-model.js';
import { REDACTED_VALUE } from './prop-policy.js';

// The session the mocked `withDocument` hands to every tool. Assigned per test;
// the mock factory only closes over the binding, it never reads it at hoist
// time.
let activeSession: SessionStub | null = null;

vi.mock('./content-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ContentSessionModule>();
  return {
    ...actual,
    withDocument: async (
      _params: unknown,
      work: (session: DocumentSession) => Promise<unknown>,
    ) => {
      if (!activeSession) throw new Error('no test session configured');
      return work(activeSession);
    },
  };
});

const { createContentTools, CONTENT_TOOL_NAMES } =
  await import('./content-tools.js');
const { makeRuntimeContext } =
  await import('../../registries/test-fixtures.js');

/** Only the type matters here — the mocked `withDocument` ignores it. */
function toolOptions() {
  const matrixClient: Partial<MatrixClient> = {};
  return {
    matrixClient,
    appConfig: {
      matrix: {
        baseUrl: 'https://mx.test',
        accessToken: 'token',
        userId: '@oracle:mx.test',
        room: { type: 'id' as const, value: TEST_ROOM_ID },
        initialSyncTimeoutMs: 1_000,
      },
      provider: {
        docName: DOCUMENT_FRAGMENT_NAME,
        enableAwareness: false,
        retryAttempts: 1,
        retryDelayMs: 0,
      },
      blocknote: { mutableAttributeKeys: [] },
    },
  };
}

interface ToolResult {
  ok?: boolean;
  code?: string;
  message?: string;
  props?: string[];
  blockId?: string;
  blockIds?: string[];
  blocks?: Array<{
    id: string;
    type: string;
    text: string;
    props: Record<string, unknown>;
  }>;
  block?: {
    id: string;
    type: string;
    text: string;
    props: Record<string, unknown>;
  };
  matches?: Array<{ matchedIn: string; block: { id: string } }>;
  total?: number;
  title?: string;
  replacements?: number;
  readOnly?: boolean;
  edited?: number;
  inserted?: number;
  removed?: boolean;
}

async function callTool(
  name: (typeof CONTENT_TOOL_NAMES)[number],
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tools = createContentTools(toolOptions());
  const target = tools.find((tool) => tool.name === name);
  if (!target) throw new Error(`tool ${name} not built`);
  const raw = await target.handler(args, makeRuntimeContext());
  if (typeof raw !== 'string') throw new Error('tool did not return JSON');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('tool returned a non-object');
  }
  return parsed;
}

/** Seed the active session with a document built from markdown. */
async function seed(
  markdown: string,
  options: SessionStubOptions = {},
): Promise<SessionStub> {
  const doc = options.doc ?? new Y.Doc();
  if (markdown.length > 0) {
    const containers = await markdownToBlockContainers(markdown);
    doc.transact(() => {
      appendBlocks(doc, containers);
    });
  }
  activeSession = makeSessionStub({ ...options, doc });
  return activeSession;
}

/** Attach a content-less custom block, as the Portal's editor stores them. */
function addCustomBlock(
  doc: Y.Doc,
  id: string,
  type: string,
  props: Record<string, string>,
): void {
  doc.transact(() => {
    const group = ensureRootGroup(doc.getXmlFragment(DOCUMENT_FRAGMENT_NAME));
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', id);
    container.setAttribute('textColor', 'default');
    container.setAttribute('backgroundColor', 'default');
    const content = new Y.XmlElement(type);
    for (const [key, value] of Object.entries(props)) {
      content.setAttribute(key, value);
    }
    container.insert(0, [content]);
    group.insert(group.length, [container]);
  });
}

describe('content tools: surface', () => {
  it('builds exactly the nine content tools, in order', () => {
    const tools = createContentTools(toolOptions());
    expect(tools.map((tool) => tool.name)).toEqual([
      'read_document',
      'read_block',
      'search_document',
      'insert_content',
      'edit_block',
      'delete_block',
      'move_block',
      'replace_text',
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([...CONTENT_TOOL_NAMES]);
    expect(tools.every((tool) => tool.description.length > 0)).toBe(true);
  });
});

describe('content tools: reads', () => {
  it('reads the document with ids, types, text and the page title', async () => {
    const session = await seed('# Heading\n\nA paragraph.\n');
    session.doc.transact(() => {
      session.doc.getText('title').insert(0, 'My page');
    });

    const result = await callTool('read_document', {});
    expect(result.ok).toBe(true);
    expect(result.title).toBe('My page');
    expect(result.readOnly).toBe(false);
    expect(result.blocks?.map((b) => b.type)).toEqual(['heading', 'paragraph']);
    expect(result.blocks?.[1]?.text).toBe('A paragraph.');
  });

  it('flags a live flow as read-only on read', async () => {
    await seed('content\n', { isFlow: true, alias: '#flow-x:mx.test' });
    const result = await callTool('read_document', {});
    expect(result.ok).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('paginates and filters by block type', async () => {
    await seed('# one\n\n# two\n\nbody\n');
    const page = await callTool('read_document', { start: 1, limit: 1 });
    expect(page.total).toBe(3);
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks?.[0]?.text).toBe('two');

    const headings = await callTool('read_document', { block_type: 'heading' });
    expect(headings.total).toBe(2);
  });

  it('redacts secrets block prop values on read but keeps the keys', async () => {
    const session = await seed('intro\n');
    addCustomBlock(session.doc, 'sec-1', 'secrets', {
      title: 'API keys',
      value: 'sk-live-super-secret',
    });

    const document = await callTool('read_document', {});
    const secrets = document.blocks?.find((b) => b.id === 'sec-1');
    expect(secrets?.props).toEqual({
      title: REDACTED_VALUE,
      value: REDACTED_VALUE,
    });
    expect(JSON.stringify(document)).not.toContain('sk-live-super-secret');

    const single = await callTool('read_block', { block_id: 'sec-1' });
    expect(single.block?.props.value).toBe(REDACTED_VALUE);
    expect(JSON.stringify(single)).not.toContain('sk-live-super-secret');
  });

  it('does not redact other custom blocks', async () => {
    const session = await seed('intro\n');
    addCustomBlock(session.doc, 'cb-1', 'checkbox', {
      title: 'Ship it',
      checked: 'false',
    });
    const result = await callTool('read_block', { block_id: 'cb-1' });
    expect(result.block?.props).toMatchObject({
      title: 'Ship it',
      checked: 'false',
    });
  });

  it('returns block_not_found for a stale id', async () => {
    await seed('intro\n');
    const result = await callTool('read_block', { block_id: 'ghost' });
    expect(result.code).toBe('block_not_found');
    expect(result.blockId).toBe('ghost');
    expect(result.message).toContain('read_document');
  });

  it('searches text and props, and never leaks a redacted secret', async () => {
    const session = await seed('The quick brown fox\n\nunrelated\n');
    addCustomBlock(session.doc, 'sec-1', 'secrets', {
      value: 'quick-secret-value',
    });

    const byText = await callTool('search_document', { query: 'QUICK' });
    expect(byText.total).toBe(1);
    expect(byText.matches?.[0]?.matchedIn).toBe('text');
    expect(JSON.stringify(byText)).not.toContain('quick-secret-value');

    const byProp = await callTool('search_document', { query: 'Ship' });
    expect(byProp.total).toBe(0);

    addCustomBlock(session.doc, 'cb-1', 'checkbox', { title: 'Ship it' });
    const propHit = await callTool('search_document', { query: 'ship' });
    expect(propHit.matches?.[0]?.matchedIn).toBe('props');
  });
});

describe('content tools: writes', () => {
  it('inserts markdown at the end and returns the new block ids', async () => {
    const session = await seed('first\n');
    const result = await callTool('insert_content', {
      markdown: '## Added\n\nnew body\n',
    });

    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(2);
    expect(result.blockIds).toHaveLength(2);
    expect(readDocumentBlocks(session.doc).map((b) => b.text)).toEqual([
      'first',
      'Added',
      'new body',
    ]);
    expect(session.writer.flushes).toBe(1);
  });

  it('inserts relative to a block, and refuses a stale anchor', async () => {
    const session = await seed('first\n\nsecond\n');
    const [first] = readDocumentBlocks(session.doc);

    const ok = await callTool('insert_content', {
      markdown: 'between',
      position: 'after',
      reference_block_id: first?.id,
    });
    expect(ok.ok).toBe(true);
    expect(readDocumentBlocks(session.doc).map((b) => b.text)).toEqual([
      'first',
      'between',
      'second',
    ]);

    const stale = await callTool('insert_content', {
      markdown: 'nope',
      position: 'before',
      reference_block_id: 'ghost',
    });
    expect(stale.code).toBe('block_not_found');
    expect(readDocumentBlocks(session.doc)).toHaveLength(3);
  });

  it('requires an anchor for a relative insert', async () => {
    await seed('first\n');
    const result = await callTool('insert_content', {
      markdown: 'x',
      position: 'after',
    });
    expect(result.code).toBe('error');
    expect(result.message).toContain('reference_block_id');
  });

  it('edits a prose block: text and props together', async () => {
    const session = await seed('# old title\n');
    const [heading] = readDocumentBlocks(session.doc);

    const result = await callTool('edit_block', {
      edits: [
        {
          block_id: heading?.id,
          text: 'new **title**',
          props: { textAlignment: 'center' },
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.edited).toBe(1);
    const after = readDocumentBlocks(session.doc)[0];
    expect(after?.id).toBe(heading?.id);
    expect(after?.text).toBe('new **title**');
    expect(after?.props.textAlignment).toBe('center');
    expect(after?.props.level).toBe(1);
  });

  it('applies a batch atomically and rolls the whole batch back on refusal', async () => {
    const session = await seed('one\n\ntwo\n');
    const [first, second] = readDocumentBlocks(session.doc);

    const ok = await callTool('edit_block', {
      edits: [
        { block_id: first?.id, text: 'ONE' },
        { block_id: second?.id, text: 'TWO' },
      ],
    });
    expect(ok.edited).toBe(2);
    expect(readDocumentBlocks(session.doc).map((b) => b.text)).toEqual([
      'ONE',
      'TWO',
    ]);

    // A stale id anywhere in the batch means nothing is written.
    const refused = await callTool('edit_block', {
      edits: [
        { block_id: first?.id, text: 'changed' },
        { block_id: 'ghost', text: 'never' },
      ],
    });
    expect(refused.code).toBe('block_not_found');
    expect(readDocumentBlocks(session.doc).map((b) => b.text)).toEqual([
      'ONE',
      'TWO',
    ]);
  });

  it('allows title and description on a custom block', async () => {
    const session = await seed('intro\n');
    addCustomBlock(session.doc, 'cb-1', 'checkbox', {
      title: 'old',
      checked: 'false',
    });

    const result = await callTool('edit_block', {
      edits: [
        {
          block_id: 'cb-1',
          props: { title: 'Review the draft', description: 'by Friday' },
        },
      ],
    });

    expect(result.ok).toBe(true);
    const block = readDocumentBlocks(session.doc).find((b) => b.id === 'cb-1');
    expect(block?.props).toMatchObject({
      title: 'Review the draft',
      description: 'by Friday',
      checked: 'false',
    });
  });

  it('refuses a behavioural prop and names it', async () => {
    const session = await seed('intro\n');
    addCustomBlock(session.doc, 'act-1', 'action', {
      title: 'Send',
      conditions: '{"enabled":false}',
    });

    const result = await callTool('edit_block', {
      edits: [
        {
          block_id: 'act-1',
          props: { title: 'Send now', conditions: '{"enabled":true}' },
        },
      ],
    });

    expect(result.code).toBe('prop_not_editable');
    expect(result.props).toEqual(['conditions']);
    expect(result.message).toContain('conditions');
    expect(result.blockId).toBe('act-1');
    // The allowed half of the same edit is not written either.
    const block = readDocumentBlocks(session.doc).find((b) => b.id === 'act-1');
    expect(block?.props.title).toBe('Send');
    expect(session.writer.flushes).toBe(0);
  });

  it('refuses text on a block that holds none, naming `text`', async () => {
    const session = await seed('intro\n');
    addCustomBlock(session.doc, 'cb-1', 'checkbox', { title: 'x' });

    const result = await callTool('edit_block', {
      edits: [{ block_id: 'cb-1', text: 'not allowed' }],
    });
    expect(result.code).toBe('prop_not_editable');
    expect(result.props).toEqual(['text']);
    expect(result.message).toContain('checkbox');
  });

  it('refuses every write to a locked block', async () => {
    const session = await seed('intro\n');
    addCustomBlock(session.doc, 'sec-1', 'secrets', { title: 'keys' });
    addCustomBlock(session.doc, 'sk-1', 'skills', { title: 'skills' });

    for (const blockId of ['sec-1', 'sk-1']) {
      const result = await callTool('edit_block', {
        edits: [{ block_id: blockId, props: { title: 'renamed' } }],
      });
      expect(result.code).toBe('prop_not_editable');
      expect(result.props).toEqual(['title']);
    }
  });

  it('deletes a block and refuses a stale id', async () => {
    const session = await seed('one\n\ntwo\n');
    const [first] = readDocumentBlocks(session.doc);

    const ok = await callTool('delete_block', { block_id: first?.id });
    expect(ok.ok).toBe(true);
    expect(ok.removed).toBe(true);
    expect(readDocumentBlocks(session.doc).map((b) => b.text)).toEqual(['two']);

    const stale = await callTool('delete_block', { block_id: first?.id });
    expect(stale.code).toBe('block_not_found');
  });

  it('moves a block and refuses a self-move', async () => {
    const session = await seed('a\n\nb\n\nc\n');
    const [a, , c] = readDocumentBlocks(session.doc);

    const ok = await callTool('move_block', {
      block_id: a?.id,
      reference_block_id: c?.id,
      placement: 'after',
    });
    expect(ok.ok).toBe(true);
    expect(readDocumentBlocks(session.doc).map((b) => b.text)).toEqual([
      'b',
      'c',
      'a',
    ]);

    const self = await callTool('move_block', {
      block_id: a?.id,
      reference_block_id: a?.id,
      placement: 'after',
    });
    expect(self.code).toBe('error');
    expect(self.message).toContain('itself');
  });

  it('replaces text and reports when nothing matched', async () => {
    const session = await seed('The **quick** fox is quick\n');

    const hit = await callTool('replace_text', {
      find: 'quick',
      replace: 'slow',
    });
    expect(hit.ok).toBe(true);
    expect(hit.replacements).toBe(2);
    expect(readDocumentBlocks(session.doc)[0]?.text).toBe(
      'The **slow** fox is slow',
    );

    const miss = await callTool('replace_text', {
      find: 'absent',
      replace: 'x',
    });
    expect(miss.ok).toBe(true);
    expect(miss.replacements).toBe(0);
    expect(miss.message).toBeUndefined();
  });

  it('refuses replace_text scoped to a stale block id', async () => {
    await seed('text\n');
    const result = await callTool('replace_text', {
      find: 'text',
      replace: 'x',
      block_id: 'ghost',
    });
    expect(result.code).toBe('block_not_found');
  });
});

describe('content tools: access failures', () => {
  it('returns read_only_flow for every write against a live flow', async () => {
    const session = await seed('content\n', {
      isFlow: true,
      alias: '#flow-x:mx.test',
    });
    const [block] = readDocumentBlocks(session.doc);

    const attempts: Array<
      [Parameters<typeof callTool>[0], Record<string, unknown>]
    > = [
      ['insert_content', { markdown: 'new' }],
      ['edit_block', { edits: [{ block_id: block?.id, text: 'x' }] }],
      ['delete_block', { block_id: block?.id }],
      [
        'move_block',
        {
          block_id: block?.id,
          reference_block_id: block?.id,
          placement: 'after',
        },
      ],
      ['replace_text', { find: 'content', replace: 'x' }],
    ];

    for (const [name, args] of attempts) {
      const result = await callTool(name, args);
      expect(result.code).toBe('read_only_flow');
      expect(result.message).toContain('flow builder');
    }
    expect(readDocumentBlocks(session.doc).map((b) => b.text)).toEqual([
      'content',
    ]);
  });

  it('returns needs_access naming grant_assistant_access when the room is not writable', async () => {
    const session = await seed('content\n', {
      powerLevels: UNGRANTED_POWER_LEVELS,
    });

    const result = await callTool('insert_content', { markdown: 'new' });
    expect(result.code).toBe('needs_access');
    expect(result.message).toContain('grant_assistant_access');
    expect(readDocumentBlocks(session.doc)).toHaveLength(1);
  });

  it('returns needs_access when the homeserver rejects the flushed write', async () => {
    const session = await seed('content\n', {
      writer: makeWriterStub({ rejectOnFlush: true }),
    });

    const result = await callTool('insert_content', { markdown: 'new' });
    expect(result.code).toBe('needs_access');
    // The local doc changed, but the tool refuses to call that success.
    expect(readDocumentBlocks(session.doc)).toHaveLength(2);
    expect(session.writer.flushes).toBe(1);
  });
});

describe('content tools: run state is never touched', () => {
  it('leaves runtime, runs, invocations and delegations empty after a full edit cycle', async () => {
    const session = await seed('start\n');
    const [block] = readDocumentBlocks(session.doc);

    await callTool('insert_content', { markdown: 'appended' });
    await callTool('edit_block', {
      edits: [
        {
          block_id: block?.id,
          text: 'changed',
          props: { textAlignment: 'right' },
        },
      ],
    });
    await callTool('replace_text', {
      find: 'changed',
      replace: 'changed again',
    });
    const blocks = readDocumentBlocks(session.doc);
    await callTool('move_block', {
      block_id: blocks[0]?.id,
      reference_block_id: blocks[1]?.id,
      placement: 'after',
    });
    await callTool('delete_block', { block_id: blocks[1]?.id });

    for (const name of [
      'runtime',
      'runs',
      'runsTerminal',
      'invocations',
      'delegations',
    ]) {
      expect(session.doc.getMap(name).size).toBe(0);
    }
  });
});
