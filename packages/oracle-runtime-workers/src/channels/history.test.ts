import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type {
  ThreadMessageAnchor,
  ThreadMessageRow,
} from '../sqlite/sqlite-saver';
import type { TranscriptRowSource } from '../do/transcript';
import { SUMMARY_PREFIX } from '../core/middlewares/summarization';
import type { ReplyPlan } from '../delivery/types';
import {
  ChannelHistoryBody,
  ChannelError,
  type ChannelHistoryInput,
} from './contract';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  readChannelHistory,
  type ChannelHistoryItem,
  type ChannelHistorySource,
} from './history';
import type { ChannelHistoryReply, ChannelHistoryRun } from './turns';
import { CHANNEL_REQUEST_ID_KWARG } from './replies';

const BINDING = 'chb_web';
const REMOTE = (n: number) => `hmac:${String(n).padStart(64, '0')}`;

/** Where a user message came from: `bindingId`, without a recorded request id (older rows). */
function originOnly(n: number, bindingId = BINDING) {
  return {
    'org.ixo.qi.origin': {
      v: 1,
      transport: 'web',
      binding_id: bindingId,
      remote_ref: REMOTE(n),
    },
  };
}

/** A message the person sent on `bindingId`, as this build records it (`wa:` request id). */
function origin(n: number, bindingId = BINDING) {
  return {
    ...originOnly(n, bindingId),
    [CHANNEL_REQUEST_ID_KWARG]: `wa:${n}`,
  };
}

/** One turn: the person's message, a tool round, the reply. */
function turn(session: string, n: number): BaseMessage[] {
  return [
    new HumanMessage({
      id: `${session}-h${n}`,
      content: `question ${n}`,
      additional_kwargs: origin(n),
    }),
    new AIMessage({
      id: `${session}-a${n}`,
      content: '',
      tool_calls: [{ id: `${session}-call-${n}`, name: 'lookup', args: { n } }],
    }),
    new ToolMessage({
      id: `${session}-t${n}`,
      tool_call_id: `${session}-call-${n}`,
      name: 'lookup',
      content: `secret tool result ${n}`,
    }),
    new AIMessage({ id: `${session}-r${n}`, content: `answer ${n}` }),
  ];
}

/** Sessions as the saver serves them: rows per thread, in listing order. */
function sessionsSource(
  threads: Record<string, BaseMessage[]>,
): TranscriptRowSource & { reads: string[]; types: string[][] } {
  const rows = new Map<string, ThreadMessageRow[]>();
  let rowid = 0;
  for (const [thread, messages] of Object.entries(threads))
    rows.set(
      thread,
      messages.map((message) => {
        rowid += 1;
        return {
          message,
          messageId: message.id!,
          anchor: {
            createdAt: `2026-11-${String(10 + Math.floor(rowid / 1000)).padStart(2, '0')}T10:00:00.${String(rowid).padStart(3, '0')}Z`,
            rowid,
          },
        };
      }),
    );
  const before = (a: ThreadMessageAnchor, b: ThreadMessageAnchor) =>
    a.createdAt < b.createdAt ||
    (a.createdAt === b.createdAt && a.rowid < b.rowid);
  const reads: string[] = [];
  const types: string[][] = [];
  return {
    reads,
    types,
    async findThreadMessageAnchor(thread, messageId) {
      return (
        rows.get(thread)?.find((r) => r.messageId === messageId)?.anchor ?? null
      );
    },
    async listThreadMessageRows(thread, opts) {
      reads.push(thread);
      types.push([...(opts.messageTypes ?? [])]);
      const all = (rows.get(thread) ?? []).filter(
        (r) => !opts.messageTypes || opts.messageTypes.includes(r.message.type),
      );
      const anchor = opts.anchor;
      const older = opts.direction === 'older';
      const picked = all.filter((r) => {
        if (!anchor) return true;
        if (opts.inclusive && r.anchor.rowid === anchor.rowid) return true;
        return older ? before(r.anchor, anchor) : before(anchor, r.anchor);
      });
      return (older ? [...picked].reverse() : picked).slice(0, opts.limit);
    },
  };
}

function source(
  threads: Record<string, BaseMessage[]>,
  options: {
    owned?: string[];
    replies?: Record<string, ChannelHistoryReply>;
    runs?: Record<string, ChannelHistoryRun>;
  } = {},
): ChannelHistorySource & {
  lookups: string[][];
  reads: string[];
  types: string[][];
} {
  const rows = sessionsSource(threads);
  const lookups: string[][] = [];
  const owned = options.owned ?? Object.keys(threads);
  return {
    rows,
    reads: rows.reads,
    types: rows.types,
    lookups,
    ownedSessions: async () =>
      owned.map((sessionId, index) => ({
        sessionId,
        createdAt: Date.parse('2026-11-01T00:00:00Z') + index * 86_400_000,
      })),
    replies: async (_sessionId, messageIds) => {
      lookups.push([...messageIds]);
      const found = new Map<string, ChannelHistoryReply>();
      for (const id of messageIds) {
        const reply = options.replies?.[id];
        if (reply) found.set(id, reply);
      }
      return found;
    },
    runs: async (_sessionId, requestIds) => {
      const found = new Map<string, ChannelHistoryRun>();
      for (const id of requestIds) {
        const run = options.runs?.[id];
        if (run) found.set(id, run);
      }
      return found;
    },
  };
}

const request = (
  query: ChannelHistoryInput['query'] = {},
): ChannelHistoryInput => ({
  provider: 'web',
  bindingId: BINDING,
  bindingRevision: 2,
  requestId: 'web-history:1',
  query,
});

const texts = (items: ChannelHistoryItem[]) =>
  items.map((item) =>
    item.kind === 'divider' ? `--${item.sessionId}--` : item.text,
  );

const PLAN: ReplyPlan = {
  v: 1,
  parts: [
    { partId: 'p1', kind: 'text', text: 'Pick one' },
    {
      partId: 'p2',
      kind: 'choices',
      text: 'Yes or No',
      choices: {
        body: 'Pick one',
        style: 'buttons',
        options: [
          { id: 'yes', title: 'Yes' },
          { id: 'no', title: 'No' },
        ],
      },
    },
  ],
};

describe('history request body', () => {
  it('takes limit 1-50, before or after (never both), and nothing else', () => {
    const ok = (query: unknown) =>
      ChannelHistoryBody.safeParse({ ...request(), query }).success;
    expect(ok({ limit: 20 })).toBe(true);
    expect(ok({})).toBe(true);
    expect(ok({ limit: 50, before: 'c1.abc' })).toBe(true);
    expect(ok({ limit: 0 })).toBe(false);
    expect(ok({ limit: 51 })).toBe(false);
    expect(ok({ limit: 2.5 })).toBe(false);
    expect(ok({ before: 'c1.a', after: 'c1.b' })).toBe(false);
    expect(ok({ before: 'has space' })).toBe(false);
    expect(ok({ before: 'x'.repeat(512) })).toBe(true);
    expect(ok({ before: 'x'.repeat(513) })).toBe(false);
    expect(ok({ limit: 5, sessionId: '$x' })).toBe(false);
  });
});

describe('history cursors', () => {
  it('round-trips a session and message, and refuses anything else', () => {
    const cursor = { sessionId: '$s:ixo.world', messageId: 'm-1' };
    const raw = encodeHistoryCursor(cursor);
    expect(raw).toMatch(/^c1\.[A-Za-z0-9_-]+$/);
    expect(decodeHistoryCursor(raw)).toEqual(cursor);
    for (const bad of [
      'm-1',
      'c1.',
      'c1.%%%',
      `c1.${btoa('{"a":1}')}`,
      `c1.${btoa('["only-one"]')}`,
      `c2.${raw.slice(3)}`,
    ])
      expect(decodeHistoryCursor(bad)).toBeNull();
  });
});

describe('readChannelHistory', () => {
  it('answers an empty page for a binding that owns no session', async () => {
    expect(await readChannelHistory(request(), source({}))).toEqual({
      items: [],
      prevCursor: null,
      nextCursor: null,
      hasOlder: false,
      hasNewer: false,
    });
    await expect(
      readChannelHistory(
        request({
          before: encodeHistoryCursor({ sessionId: '$a', messageId: 'x' }),
        }),
        source({}),
      ),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });
  });

  it('reads every owned session oldest first, a divider before each later one, tools hidden', async () => {
    const src = source({
      $one: [...turn('one', 1), ...turn('one', 2)],
      $two: turn('two', 3),
    });
    const page = await readChannelHistory(request({ limit: 20 }), src);
    expect(texts(page.items)).toEqual([
      'question 1',
      'answer 1',
      'question 2',
      'answer 2',
      '--$two--',
      'question 3',
      'answer 3',
    ]);
    expect(JSON.stringify(page)).not.toContain('secret tool result');
    expect(page.items[4]).toEqual({
      kind: 'divider',
      id: 'div:$two',
      at: '2026-11-02T00:00:00.000Z',
      sessionId: '$two',
    });
    expect(page.items[0]).toMatchObject({
      kind: 'message',
      id: 'one-h1',
      sessionId: '$one',
      role: 'user',
      remoteRef: REMOTE(1),
    });
    expect(page.items[1]).toMatchObject({
      role: 'oracle',
      id: 'one-r1',
      requestId: null,
    });
    expect(page.items[1]).not.toHaveProperty('plan');
    expect(page).toMatchObject({
      prevCursor: null,
      hasOlder: false,
      hasNewer: false,
    });
    expect(decodeHistoryCursor(page.nextCursor!)).toEqual({
      sessionId: '$two',
      messageId: 'two-r3',
    });
  });

  it('pages by turns across sessions, older then newer, with the divider where its session starts', async () => {
    const src = source({
      $one: [...turn('one', 1), ...turn('one', 2)],
      $two: [...turn('two', 3), ...turn('two', 4)],
    });
    const newest = await readChannelHistory(request({ limit: 1 }), src);
    expect(texts(newest.items)).toEqual(['question 4', 'answer 4']);
    expect(newest).toMatchObject({ hasOlder: true, hasNewer: false });

    const crossing = await readChannelHistory(
      request({ limit: 2, before: newest.prevCursor! }),
      src,
    );
    expect(texts(crossing.items)).toEqual([
      'question 2',
      'answer 2',
      '--$two--',
      'question 3',
      'answer 3',
    ]);
    expect(crossing).toMatchObject({ hasOlder: true, hasNewer: true });

    const oldest = await readChannelHistory(
      request({ limit: 5, before: crossing.prevCursor! }),
      src,
    );
    expect(texts(oldest.items)).toEqual(['question 1', 'answer 1']);
    expect(oldest).toMatchObject({ hasOlder: false, prevCursor: null });

    // Newer from the oldest page's end: the rest, across the boundary.
    const newer = await readChannelHistory(
      request({ limit: 2, after: oldest.nextCursor! }),
      src,
    );
    expect(texts(newer.items)).toEqual([
      'question 2',
      'answer 2',
      '--$two--',
      'question 3',
      'answer 3',
    ]);
    expect(newer).toMatchObject({ hasNewer: true, hasOlder: false });
    const rest = await readChannelHistory(
      request({ limit: 2, after: newer.nextCursor! }),
      src,
    );
    expect(texts(rest.items)).toEqual(['question 4', 'answer 4']);
    expect(rest.hasNewer).toBe(false);
    // Nothing newer: an empty page that keeps the cursor.
    const none = await readChannelHistory(
      request({ after: rest.nextCursor! }),
      src,
    );
    expect(none).toEqual({
      items: [],
      prevCursor: null,
      nextCursor: rest.nextCursor,
      hasOlder: false,
      hasNewer: false,
    });
  });

  it('defaults to 20 turns and never reads a session the page does not reach', async () => {
    const many: BaseMessage[] = [];
    for (let n = 1; n <= 25; n += 1) many.push(...turn('big', n));
    const src = source({ $old: turn('old', 0), $big: many });
    const page = await readChannelHistory(request(), src);
    expect(
      page.items.filter((i) => i.kind === 'message' && i.role === 'user'),
    ).toHaveLength(20);
    expect(page.hasOlder).toBe(true);
    // The page filled inside `$big`: `$old` was never read.
    expect(src.reads).not.toContain('$old');
    expect(new Set(src.reads)).toEqual(new Set(['$big']));
  });

  it('refuses a cursor that names no message of an owned session', async () => {
    const src = source(
      { $mine: turn('mine', 1), $portal: turn('portal', 2) },
      { owned: ['$mine'] },
    );
    for (const cursor of [
      'not-a-cursor',
      encodeHistoryCursor({ sessionId: '$mine', messageId: 'nope' }),
      // A Portal session the binding never held: refused, not read.
      encodeHistoryCursor({ sessionId: '$portal', messageId: 'portal-h2' }),
    ])
      for (const query of [{ before: cursor }, { after: cursor }]) {
        const refused = readChannelHistory(request(query), src);
        await expect(refused).rejects.toBeInstanceOf(ChannelError);
        await expect(refused).rejects.toMatchObject({
          status: 400,
          code: 'invalid_cursor',
        });
      }
    // And the Portal session's messages never appear.
    const page = await readChannelHistory(request(), src);
    expect(texts(page.items)).toEqual(['question 1', 'answer 1']);
  });

  it("attaches the run's Reply Plan to its final message and leaves the run's earlier messages out", async () => {
    const threads = {
      $s: [
        new HumanMessage({
          id: 'h1',
          content: 'Can you help?',
          additional_kwargs: origin(1),
        }),
        new AIMessage({ id: 'early', content: 'Let me check that.' }),
        new AIMessage({ id: 'final', content: 'Pick one' }),
        new HumanMessage({
          id: 'h2',
          content: 'Yes',
          additional_kwargs: origin(2),
        }),
        new AIMessage({ id: 'no-plan-1', content: 'Thinking aloud.' }),
        new AIMessage({ id: 'no-plan-2', content: 'Done.' }),
      ],
    };
    const src = source(threads, {
      replies: {
        final: { runId: 'channel_r1', requestId: 'wa:r1', plan: PLAN },
        // The run is kept but had no plan (a text reply): text only.
        'no-plan-2': { runId: 'channel_r2', requestId: 'wa:r2', plan: null },
      },
    });
    const page = await readChannelHistory(request(), src);
    expect(page.items).toEqual([
      expect.objectContaining({ id: 'h1', role: 'user' }),
      {
        kind: 'message',
        id: 'final',
        sessionId: '$s',
        role: 'oracle',
        at: expect.any(String),
        text: 'Pick one\n\nYes or No',
        requestId: 'wa:r1',
        plan: { parts: PLAN.parts },
      },
      expect.objectContaining({ id: 'h2', role: 'user', text: 'Yes' }),
      expect.objectContaining({
        id: 'no-plan-1',
        text: 'Thinking aloud.',
        requestId: null,
      }),
      expect.objectContaining({ id: 'no-plan-2', requestId: 'wa:r2' }),
    ]);
    expect(page.items[4]).not.toHaveProperty('plan');
    // Only the agent messages were looked up, by their own ids.
    expect(src.lookups).toEqual([['early', 'final', 'no-plan-1', 'no-plan-2']]);
  });

  it('keeps a reply to a hidden event apart from the turn before it', async () => {
    const page = await readChannelHistory(
      request(),
      source(
        {
          $s: [
            new HumanMessage({
              id: 'h1',
              content: 'Verify me',
              additional_kwargs: origin(1),
            }),
            new AIMessage({ id: 'r1', content: 'Here is the link.' }),
            // A permission event's note: hidden, but its own run.
            new HumanMessage({
              id: 'evt',
              content: '',
              additional_kwargs: { channel_delivery_notice: '[event]' },
            }),
            new AIMessage({ id: 'r2', content: 'Thanks, you allowed it.' }),
          ],
        },
        {
          replies: {
            r2: {
              runId: 'channel_e',
              requestId: 'permission:p:allowed',
              plan: PLAN,
            },
          },
        },
      ),
    );
    expect(texts(page.items)).toEqual([
      'Verify me',
      'Here is the link.',
      'Pick one\n\nYes or No',
    ]);
  });

  it('shows files as placeholders, never a link, and leaves summaries and failed replies out', async () => {
    const page = await readChannelHistory(
      request(),
      source({
        $s: [
          new HumanMessage({
            id: 'sum',
            content: `${SUMMARY_PREFIX} earlier things`,
            additional_kwargs: { lc_source: 'summarization' },
          }),
          new HumanMessage({
            id: 'h1',
            content: 'Here it is',
            additional_kwargs: {
              ...origin(1),
              attachments: [
                {
                  filename: 'cv.pdf',
                  mimetype: 'application/pdf',
                  category: 'document',
                },
              ],
            },
          }),
          new AIMessage({
            id: 'err',
            content: 'boom',
            additional_kwargs: { isError: true },
          }),
          new AIMessage({ id: 'r1', content: 'Got it' }),
        ],
      }),
    );
    expect(texts(page.items)).toEqual([
      'Here it is\n\n[File sent: cv.pdf]',
      'Got it',
    ]);
  });

  it('lists the channel files of a message from its row alone: reference, name, type and size, no link and no extra lookup', async () => {
    const thread = (withFiles: boolean) => ({
      $s: [
        new HumanMessage({
          id: 'h1',
          content: 'Two photos',
          additional_kwargs: {
            ...origin(1),
            attachments: withFiles
              ? [
                  {
                    filename: 'a.jpg',
                    mimetype: 'image/jpeg',
                    size: 1234,
                    channelRef: 'channel:0123456789abcdef',
                    category: 'image',
                  },
                  {
                    filename: 'b.pdf',
                    mimetype: 'application/pdf',
                    channelRef: 'channel:fedcba9876543210',
                    category: 'document',
                  },
                  // Not a channel file (no reference): a placeholder only.
                  {
                    filename: 'c.png',
                    mimetype: 'image/png',
                    mxcUri: 'mxc://hs/c',
                    category: 'image',
                  },
                ]
              : [],
          },
        }),
        new AIMessage({ id: 'r1', content: 'Nice' }),
      ],
    });
    const withFiles = source(thread(true));
    const page = await readChannelHistory(request(), withFiles);
    const user = page.items[0];
    if (user?.kind !== 'message' || user.role !== 'user')
      throw new Error('no user item');
    expect(user.files).toEqual([
      {
        ref: 'channel:0123456789abcdef',
        name: 'a.jpg',
        mime: 'image/jpeg',
        size: 1234,
      },
      {
        ref: 'channel:fedcba9876543210',
        name: 'b.pdf',
        mime: 'application/pdf',
      },
    ]);
    expect(user.text).toBe(
      'Two photos\n\n[File sent: a.jpg]\n[File sent: b.pdf]\n[File sent: c.png]',
    );
    expect(JSON.stringify(page)).not.toContain('mxc://');
    // The same reads and lookups as the page without files: the files come
    // from the rows the page already read.
    const withoutFiles = source(thread(false));
    const plain = await readChannelHistory(request(), withoutFiles);
    expect(withFiles.reads).toEqual(withoutFiles.reads);
    expect(withFiles.lookups).toEqual(withoutFiles.lookups);
    const plainUser = plain.items[0];
    expect(plainUser && 'files' in plainUser).toBe(false);
  });

  it("lists only this binding's own messages and their replies: never a Portal message or another binding's turn in the same session", async () => {
    const page = await readChannelHistory(
      request(),
      source({
        $s: [
          new HumanMessage({
            id: 'mine',
            content: 'one',
            additional_kwargs: origin(1),
          }),
          new AIMessage({ id: 'r1', content: 'mine answered' }),
          // A WhatsApp or Telegram binding's turn written into this session.
          new HumanMessage({
            id: 'other',
            content: 'two',
            additional_kwargs: origin(2, 'chb_other'),
          }),
          new AIMessage({ id: 'r2', content: 'other answered' }),
          // A message typed in the Portal into the same session.
          new HumanMessage({ id: 'portal', content: 'three' }),
          new AIMessage({ id: 'r3', content: 'portal answered' }),
        ],
      }),
    );
    expect(texts(page.items)).toEqual(['one', 'mine answered']);
    expect(page.items[0]).toMatchObject({ remoteRef: REMOTE(1) });
  });
});

describe("readChannelHistory: only the person's own inputs, and replies without a message", () => {
  const asked = (id: string, requestId: string, content: string, extra = {}) =>
    new HumanMessage({
      id,
      content,
      additional_kwargs: {
        ...origin(1),
        [CHANNEL_REQUEST_ID_KWARG]: requestId,
        ...extra,
      },
    });

  it("leaves out the gateway's connect prompt, events and notices; keeps the referral first message and taps", async () => {
    const page = await readChannelHistory(
      request(),
      source({
        $s: [
          // The connect opening: composed by the gateway, not the person.
          asked('connect', 'connect:abc', 'Hi'),
          new AIMessage({ id: 'greet', content: 'Welcome to Yo!' }),
          // The referral first message: the person's (a `wa:` request).
          asked('ref', 'wa:ref', "Hi Yo! I'd like to take part. yo-01-K7MP4X"),
          new AIMessage({ id: 'r1', content: 'Great, let us start.' }),
          // A permission event's note: hidden.
          asked('evt', 'permission:p1:allowed', '', {
            channel_delivery_notice: '[Permission answered]',
          }),
          new AIMessage({ id: 'r2', content: 'Thanks for allowing it.' }),
          // A tapped option is the person's.
          asked('tap', 'wa:tap', 'Yes'),
          new AIMessage({ id: 'r3', content: 'Noted.' }),
        ],
      }),
    );
    expect(
      page.items.map((item) =>
        item.kind === 'message' ? `${item.role}:${item.text}` : item.kind,
      ),
    ).toEqual([
      'oracle:Welcome to Yo!',
      "user:Hi Yo! I'd like to take part. yo-01-K7MP4X",
      'oracle:Great, let us start.',
      'oracle:Thanks for allowing it.',
      'user:Yes',
      'oracle:Noted.',
    ]);
  });

  it('for a message written before request ids were recorded, the run that answered it decides', async () => {
    const page = await readChannelHistory(
      request(),
      source(
        {
          $s: [
            new HumanMessage({
              id: 'old-connect',
              content: 'Hi',
              additional_kwargs: originOnly(1),
            }),
            new AIMessage({ id: 'greet', content: 'Welcome' }),
            new HumanMessage({
              id: 'old-mine',
              content: 'Hello',
              additional_kwargs: originOnly(2),
            }),
            new AIMessage({ id: 'answer', content: 'Hi there' }),
          ],
        },
        {
          replies: {
            greet: { runId: 'channel_c', requestId: 'connect:abc', plan: null },
            answer: { runId: 'channel_m', requestId: 'wa:m', plan: null },
          },
        },
      ),
    );
    expect(texts(page.items)).toEqual(['Welcome', 'Hello', 'Hi there']);
  });

  it("shows a busy line or a failed run's files (a plan, no message) right after the input it answers", async () => {
    const busy: ReplyPlan = {
      v: 1,
      parts: [
        { partId: 'busy_reply', kind: 'text', text: 'I am busy, try again.' },
      ],
    };
    const page = await readChannelHistory(
      request(),
      source(
        {
          $s: [
            asked('h1', 'wa:one', 'First'),
            asked('h2', 'wa:two', 'Second'),
            new AIMessage({ id: 'a2', content: 'Answer two' }),
          ],
        },
        {
          runs: {
            'wa:one': {
              runId: 'channel_one',
              requestId: 'wa:one',
              messageId: null,
              at: '2026-11-20T10:00:00.000Z',
              plan: busy,
            },
            // A run with its own message: nothing extra.
            'wa:two': {
              runId: 'channel_two',
              requestId: 'wa:two',
              messageId: 'a2',
              at: '2026-11-20T10:01:00.000Z',
              plan: null,
            },
          },
        },
      ),
    );
    expect(page.items).toEqual([
      expect.objectContaining({ id: 'h1', role: 'user', text: 'First' }),
      {
        kind: 'message',
        id: 'run:channel_one',
        sessionId: '$s',
        role: 'oracle',
        at: '2026-11-20T10:00:00.000Z',
        text: 'I am busy, try again.',
        requestId: 'wa:one',
        plan: { parts: busy.parts },
      },
      expect.objectContaining({ id: 'h2', role: 'user' }),
      expect.objectContaining({ id: 'a2', text: 'Answer two' }),
    ]);
    // An empty plan (a busy line that was not sent) shows nothing.
    const silent = await readChannelHistory(
      request(),
      source(
        { $s: [asked('h1', 'wa:one', 'First')] },
        {
          runs: {
            'wa:one': {
              runId: 'channel_one',
              requestId: 'wa:one',
              messageId: null,
              at: '2026-11-20T10:00:00.000Z',
              plan: { v: 1, parts: [] },
            },
          },
        },
      ),
    );
    expect(texts(silent.items)).toEqual(['First']);
  });

  it("reads only the person's and the agent's rows, never tool rows", async () => {
    const src = source({ $s: [...turn('s', 1), ...turn('s', 2)] });
    await readChannelHistory(request(), src);
    expect(src.types.length).toBeGreaterThan(0);
    for (const asked of src.types) expect(asked).toEqual(['human', 'ai']);
  });

  it('never issues a cursor longer than 512 characters', async () => {
    const longId = 'm'.repeat(250);
    const page = await readChannelHistory(
      request(),
      source({
        [`$${'s'.repeat(200)}`]: [
          new HumanMessage({
            id: longId,
            content: 'hello',
            additional_kwargs: origin(1),
          }),
          new AIMessage({ id: `${longId}-r`, content: 'hi' }),
        ],
      }),
    );
    expect(texts(page.items)).toEqual(['hello', 'hi']);
    expect(page.nextCursor).toBeNull();
  });
});

describe('readChannelHistory: unknown inputs and one item per run', () => {
  it("does not take a message with no known request id for the person's (its run pruned)", async () => {
    const page = await readChannelHistory(
      request(),
      source({
        $s: [
          // An older connect prompt whose run was pruned: nothing tells it apart.
          new HumanMessage({
            id: 'old',
            content: 'Hi',
            additional_kwargs: originOnly(1),
          }),
          new AIMessage({ id: 'greet', content: 'Welcome to Yo!' }),
        ],
      }),
    );
    expect(
      page.items.map((item) =>
        item.kind === 'message' ? `${item.role}:${item.text}` : item.kind,
      ),
    ).toEqual(['oracle:Welcome to Yo!']);
  });

  it('shows a failed run once: its busy line, not also the partial text it left', async () => {
    const busy: ReplyPlan = {
      v: 1,
      parts: [{ partId: 'busy_reply', kind: 'text', text: 'Busy, try again.' }],
    };
    const page = await readChannelHistory(
      request(),
      source(
        {
          $s: [
            new HumanMessage({
              id: 'h1',
              content: 'Help',
              additional_kwargs: origin(1),
            }),
            new AIMessage({ id: 'partial', content: 'Let me look that up' }),
          ],
        },
        {
          runs: {
            'wa:1': {
              runId: 'channel_one',
              requestId: 'wa:1',
              messageId: null,
              at: '2026-11-20T10:00:00.000Z',
              plan: busy,
            },
          },
        },
      ),
    );
    expect(page.items.map((item) => item.id)).toEqual([
      'h1',
      'run:channel_one',
    ]);
  });
});
