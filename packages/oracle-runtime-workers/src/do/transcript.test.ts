/**
 * Transcript rendering around attachment payload retention: an offloaded
 * message still lists its attachment metadata with its original text, and
 * the `view_attachment` re-attachment message never shows.
 */
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_VIEW_SOURCE, offloadInlinePayloads } from '../attachments';
import type {
  ThreadMessageAnchor,
  ThreadMessageRow,
} from '../sqlite/sqlite-saver';
import {
  contentToText,
  pageThreadTranscript,
  parseTranscriptPageQuery,
  TRANSCRIPT_PAGE_DEFAULT,
  TRANSCRIPT_PAGE_MAX,
  TranscriptCursorError,
  type TranscriptRowSource,
  transformTranscript,
} from './transcript';

const META = {
  filename: 'red.png',
  mimetype: 'image/png',
  size: 12,
  mxcUri: 'mxc://hs/red',
  category: 'image',
};
const IMAGE_BLOCK = {
  type: 'image',
  source_type: 'base64',
  mime_type: 'image/png',
  data: 'AAAA',
};

describe('transcript + attachment retention', () => {
  it('renders an offloaded message exactly like the inline one', async () => {
    const inline = new HumanMessage({
      id: 'h1',
      content: [{ type: 'text', text: 'what colour?' }, IMAGE_BLOCK],
      additional_kwargs: {
        attachment: META,
        attachments: [META],
        timestamp: 't',
      },
    });
    const offloaded = offloadInlinePayloads(inline)!;
    const before = await transformTranscript([
      inline,
      new AIMessage({ id: 'a1', content: 'red' }),
    ]);
    const after = await transformTranscript([
      offloaded,
      new AIMessage({ id: 'a1', content: 'red' }),
    ]);
    expect(after).toEqual(before);
    expect(after.messages[0]).toMatchObject({
      type: 'human',
      content: 'what colour?',
      attachment: META,
      attachments: [META],
    });
    expect(contentToText(offloaded.content)).toBe('what colour?');
  });

  it('hides the re-attachment message view_attachment adds', async () => {
    const out = await transformTranscript([
      new HumanMessage({ id: 'h2', content: 'look again' }),
      new HumanMessage({
        id: 'v1',
        content: [{ type: 'text', text: 'Re-attached "red.png"' }, IMAGE_BLOCK],
        additional_kwargs: {
          lc_source: ATTACHMENT_VIEW_SOURCE,
          attachments: [META],
        },
      }),
      new AIMessage({ id: 'a2', content: 'still red' }),
    ]);
    expect(out.messages.map((m) => [m.type, m.content])).toEqual([
      ['human', 'look again'],
      ['ai', 'still red'],
    ]);
  });
});

describe('isSummarizationMessage', () => {
  it('matches the LangChain 1.4 summary message (a tagged human message with the prefix) and the older shapes', async () => {
    const { HumanMessage, SystemMessage, AIMessage } =
      await import('@langchain/core/messages');
    const { isSummarizationMessage } = await import('./transcript');
    const { SUMMARY_PREFIX } =
      await import('../core/middlewares/summarization');
    expect(
      isSummarizationMessage(
        new HumanMessage({
          content: `${SUMMARY_PREFIX}\n\n**Active task**: …`,
          additional_kwargs: { lc_source: 'summarization' },
        }),
      ),
    ).toBe(true);
    expect(
      isSummarizationMessage(
        new HumanMessage({ content: `${SUMMARY_PREFIX} the user asked…` }),
      ),
    ).toBe(true);
    expect(
      isSummarizationMessage(
        new SystemMessage('Here is a summary of the conversation so far: …'),
      ),
    ).toBe(true);
    expect(
      isSummarizationMessage(new HumanMessage('Turn 3: call list_my_tasks')),
    ).toBe(false);
    expect(
      isSummarizationMessage(
        new AIMessage('Sure — here is a summary of the article you sent.'),
      ),
    ).toBe(false);
  });
});

// ── Paging ──────────────────────────────────────────────────────────────────

/** An in-memory transcript in listing order, with the saver's row semantics. */
function rowSource(messages: BaseMessage[]): TranscriptRowSource & {
  append: (...more: BaseMessage[]) => void;
} {
  const rows: ThreadMessageRow[] = [];
  const append = (...more: BaseMessage[]) => {
    for (const message of more) {
      const rowid = rows.length + 1;
      rows.push({
        message,
        messageId: message.id!,
        // Two rows share a timestamp now and then, like real ones.
        anchor: {
          createdAt: `2026-09-14T10:00:00.${String(Math.floor(rowid / 2)).padStart(4, '0')}Z`,
          rowid,
        },
      });
    }
  };
  append(...messages);
  const before = (a: ThreadMessageAnchor, b: ThreadMessageAnchor) =>
    a.createdAt < b.createdAt ||
    (a.createdAt === b.createdAt && a.rowid < b.rowid);
  return {
    append,
    async findThreadMessageAnchor(_thread, messageId) {
      return rows.find((r) => r.messageId === messageId)?.anchor ?? null;
    },
    async listThreadMessageRows(_thread, opts) {
      const older = opts.direction === 'older';
      const anchor = opts.anchor;
      const picked = rows.filter((r) => {
        if (!anchor) return true;
        if (
          opts.inclusive &&
          r.anchor.rowid === anchor.rowid &&
          r.anchor.createdAt === anchor.createdAt
        )
          return true;
        return older ? before(r.anchor, anchor) : before(anchor, r.anchor);
      });
      const ordered = older ? [...picked].reverse() : picked;
      return ordered.slice(0, opts.limit);
    },
  };
}

/** A turn: the user asks, the agent calls a tool, reads its result, answers. */
function turn(n: number): BaseMessage[] {
  return [
    new HumanMessage({ id: `h${n}`, content: `question ${n}` }),
    new AIMessage({
      id: `a${n}`,
      content: '',
      tool_calls: [{ id: `call-${n}`, name: 'lookup', args: { n } }],
    }),
    new ToolMessage({
      id: `t${n}`,
      tool_call_id: `call-${n}`,
      name: 'lookup',
      content: `result ${n}`,
    }),
    new AIMessage({ id: `r${n}`, content: `answer ${n}` }),
  ];
}

const summaryRow = () =>
  new HumanMessage({
    id: 'summary-1',
    content: 'Here is a summary of the conversation so far:\n\n…',
    additional_kwargs: { lc_source: 'summarization' },
  });

describe('transcript of a chat reply', () => {
  const url = `https://oracle.test/a/${'a'.repeat(32)}#k=key`;
  const artifactTurn = (text: string): BaseMessage[] => [
    new HumanMessage({ id: 'h1', content: 'plan my week' }),
    new AIMessage({
      id: 'a1',
      content: text,
      tool_calls: [
        {
          id: 'call-1',
          name: 'create_artifact',
          args: {
            title: 'Week plan',
            content: '# Week',
            message: 'Here is the week.',
            followUp: 'Book the slots?',
          },
        },
      ],
    }),
    new ToolMessage({
      tool_call_id: 'call-1',
      name: 'create_artifact',
      content: JSON.stringify({
        ok: true,
        artifactId: 'a'.repeat(32),
        title: 'Week plan',
        url,
        mime: 'text/markdown',
        bytes: 6,
        expiresAt: '2026-10-25T09:00:00.000Z',
      }),
    }),
  ];

  it('lists a reply that ended in create_artifact as the message, link and question the user got', async () => {
    const { messages } = await transformTranscript(artifactTurn(''));
    expect(messages[1]).toMatchObject({
      type: 'ai',
      content: `Here is the week.\n\n[Week plan](${url})\n\nBook the slots?`,
      toolCalls: [{ name: 'create_artifact', status: 'done' }],
    });
  });

  it('keeps the text of a step that wrote its own', async () => {
    const { messages } = await transformTranscript(
      artifactTurn('Putting it in a document.'),
    );
    expect(messages[1]?.content).toBe('Putting it in a document.');
  });
});

describe('parseTranscriptPageQuery', () => {
  it('defaults, clamps and rejects', () => {
    expect(parseTranscriptPageQuery({})).toEqual({
      ok: true,
      options: { limit: TRANSCRIPT_PAGE_DEFAULT },
    });
    expect(parseTranscriptPageQuery({ limit: '5', before: 'h3' })).toEqual({
      ok: true,
      options: { limit: 5, before: 'h3' },
    });
    expect(parseTranscriptPageQuery({ limit: '9999', after: ' r3 ' })).toEqual({
      ok: true,
      options: { limit: TRANSCRIPT_PAGE_MAX, after: 'r3' },
    });
    expect(parseTranscriptPageQuery({ limit: '0' })).toMatchObject({
      ok: false,
    });
    expect(parseTranscriptPageQuery({ limit: 'ten' })).toMatchObject({
      ok: false,
    });
    expect(parseTranscriptPageQuery({ before: 'a', after: 'b' })).toMatchObject(
      { ok: false },
    );
  });
});

describe('pageThreadTranscript', () => {
  const contents = (page: {
    messages: Array<{ content: string; type: string }>;
  }) => page.messages.map((m) => m.content);

  it('pages the newest turns first and walks back to the first message', async () => {
    const source = rowSource([
      ...turn(1),
      ...turn(2),
      summaryRow(),
      ...turn(3),
      ...turn(4),
      ...turn(5),
    ]);
    const last = await pageThreadTranscript(source, 'thread', { limit: 2 });
    expect(contents(last)).toEqual([
      'question 4',
      '',
      'answer 4',
      'question 5',
      '',
      'answer 5',
    ]);
    expect(last).toMatchObject({
      prevCursor: 'h4',
      nextCursor: 'r5',
      hasOlder: true,
      hasNewer: false,
    });
    // Tool results are folded into the reply that called them, inside the page.
    const reply = last.messages.find((m) => m.toolCalls?.length);
    expect(reply?.toolCalls?.[0]).toMatchObject({
      name: 'lookup',
      status: 'done',
      output: JSON.stringify('result 4'),
    });

    const middle = await pageThreadTranscript(source, 'thread', {
      limit: 2,
      before: last.prevCursor!,
    });
    // The summary bookkeeping row is neither shown nor a turn boundary.
    expect(contents(middle)).toEqual([
      'question 2',
      '',
      'answer 2',
      'question 3',
      '',
      'answer 3',
    ]);
    expect(middle).toMatchObject({
      prevCursor: 'h2',
      nextCursor: 'r3',
      hasOlder: true,
      hasNewer: true,
    });

    const first = await pageThreadTranscript(source, 'thread', {
      limit: 2,
      before: middle.prevCursor!,
    });
    expect(contents(first)).toEqual(['question 1', '', 'answer 1']);
    expect(first).toMatchObject({
      prevCursor: null,
      nextCursor: 'r1',
      hasOlder: false,
      hasNewer: true,
    });
  });

  it('a page never splits a turn, however many rows it has', async () => {
    const big: BaseMessage[] = [new HumanMessage({ id: 'h1', content: 'go' })];
    for (let i = 0; i < 200; i += 1) {
      big.push(
        new AIMessage({
          id: `a1-${i}`,
          content: '',
          tool_calls: [{ id: `c1-${i}`, name: 'step', args: {} }],
        }),
        new ToolMessage({
          id: `t1-${i}`,
          tool_call_id: `c1-${i}`,
          name: 'step',
          content: `${i}`,
        }),
      );
    }
    big.push(new AIMessage({ id: 'r1', content: 'done' }), ...turn(2));
    const source = rowSource(big);
    const page = await pageThreadTranscript(source, 'thread', { limit: 2 });
    expect(page.messages[0]?.content).toBe('go');
    expect(page.messages.at(-1)?.content).toBe('answer 2');
    expect(page.messages.filter((m) => m.toolCalls?.length)).toHaveLength(201);
    expect(page).toMatchObject({ hasOlder: false, prevCursor: null });
  });

  it('an empty thread is an empty page', async () => {
    const page = await pageThreadTranscript(rowSource([]), 'thread', {
      limit: 20,
    });
    expect(page).toEqual({
      messages: [],
      prevCursor: null,
      nextCursor: null,
      hasOlder: false,
      hasNewer: false,
    });
  });

  it('after: nothing new keeps the cursor; new turns come whole, with a limit', async () => {
    const source = rowSource([...turn(1), ...turn(2)]);
    const tail = await pageThreadTranscript(source, 'thread', { limit: 20 });
    expect(tail.nextCursor).toBe('r2');
    const idle = await pageThreadTranscript(source, 'thread', {
      limit: 20,
      after: 'r2',
    });
    expect(idle).toEqual({
      messages: [],
      prevCursor: null,
      nextCursor: 'r2',
      hasOlder: false,
      hasNewer: false,
    });

    source.append(...turn(3), ...turn(4), ...turn(5));
    const next = await pageThreadTranscript(source, 'thread', {
      limit: 2,
      after: 'r2',
    });
    expect(contents(next)).toEqual([
      'question 3',
      '',
      'answer 3',
      'question 4',
      '',
      'answer 4',
    ]);
    expect(next).toMatchObject({ nextCursor: 'r4', hasNewer: true });
    const rest = await pageThreadTranscript(source, 'thread', {
      limit: 2,
      after: next.nextCursor!,
    });
    expect(contents(rest)).toEqual(['question 5', '', 'answer 5']);
    expect(rest).toMatchObject({ nextCursor: 'r5', hasNewer: false });
  });

  it('after a cursor that split a turn, the turn is re-sent whole so its tool result folds again', async () => {
    // The client loaded while the reply was being written: it holds the
    // question and the tool-calling reply, not yet the tool result.
    const source = rowSource([
      ...turn(1),
      new HumanMessage({ id: 'h2', content: 'question 2' }),
      new AIMessage({
        id: 'a2',
        content: '',
        tool_calls: [{ id: 'call-2', name: 'lookup', args: {} }],
      }),
    ]);
    const loaded = await pageThreadTranscript(source, 'thread', { limit: 20 });
    expect(loaded.nextCursor).toBe('a2');
    expect(loaded.messages.at(-1)?.toolCalls?.[0]?.output).toBeUndefined();

    source.append(
      new ToolMessage({
        id: 't2',
        tool_call_id: 'call-2',
        name: 'lookup',
        content: 'result 2',
      }),
      new AIMessage({ id: 'r2', content: 'answer 2' }),
    );
    const page = await pageThreadTranscript(source, 'thread', {
      limit: 20,
      after: 'a2',
    });
    expect(contents(page)).toEqual(['question 2', '', 'answer 2']);
    expect(page.messages[1]?.toolCalls?.[0]).toMatchObject({
      status: 'done',
      output: JSON.stringify('result 2'),
    });
    expect(page.messages[0]?.id).toBe(loaded.messages.at(-2)?.id); // same DTO ids: the client replaces in place
    expect(page).toMatchObject({ nextCursor: 'r2', hasNewer: false });
  });

  it('rejects a cursor the thread does not have', async () => {
    const source = rowSource(turn(1));
    await expect(
      pageThreadTranscript(source, 'thread', { limit: 5, before: 'nope' }),
    ).rejects.toBeInstanceOf(TranscriptCursorError);
    await expect(
      pageThreadTranscript(source, 'thread', { limit: 5, after: 'nope' }),
    ).rejects.toBeInstanceOf(TranscriptCursorError);
  });
});

it('preserves only validated channel provenance on human messages in session history', async () => {
  const origin = {
    v: 1,
    transport: 'whatsapp',
    binding_id: 'chb_one',
    remote_ref: `hmac:${'a'.repeat(64)}`,
  };
  const result = await transformTranscript([
    new HumanMessage({
      id: 'channel-user',
      content: 'Hello Qi',
      additional_kwargs: { 'org.ixo.qi.origin': origin },
    }),
    new AIMessage({
      id: 'channel-answer',
      content: 'Hello',
      additional_kwargs: { 'org.ixo.qi.origin': origin },
    }),
    new HumanMessage({
      id: 'invalid-origin',
      content: 'Other message',
      additional_kwargs: {
        'org.ixo.qi.origin': { ...origin, phone: 'sensitive' },
      },
    }),
  ]);
  expect(result.messages[0]?.metadata).toEqual({ 'org.ixo.qi.origin': origin });
  expect(result.messages[1]?.metadata).toBeUndefined();
  expect(result.messages[2]?.metadata).toBeUndefined();
});
