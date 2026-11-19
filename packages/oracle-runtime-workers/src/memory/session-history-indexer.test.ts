/**
 * Session-history indexer — the Node `SessionHistoryProcessor` policy over
 * fake deps: what gets sent where (endpoint, headers, payload, speaker
 * roles), the `lastProcessedCount` watermark, the tail-only reads and
 * chunked uploads, the skip conditions, the retry-then-fail path and its
 * backoff, the per-session lock and its follow-up pass, and the quiet-period
 * debounce.
 */
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../plugin-api/types';
import { MEMORY_SEARCH_MCP_NAME } from '../plugins/memory/memory-tools';
import {
  classifyUploadRefusal,
  conversationReader,
  historyMessageUuid,
  MAX_PIECES_PER_MESSAGE,
  MEMORY_UPLOAD_MAX_MESSAGE_BYTES,
  MEMORY_UPLOAD_MAX_MESSAGES,
  pageOfMessages,
  readUploadRefusal,
  SessionHistoryIndexer,
  splitMessageContent,
  transformMessagesToMemoryEngineFormat,
  type HistoryMessage,
  type IndexableSession,
  type PassEnd,
  type SessionHistoryIndexerDeps,
} from './session-history-indexer';

afterEach(() => {
  vi.useRealTimers();
});

const SILENT: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** The oracle's configured domain entity (`ORACLE_ENTITY_DID`). */
const ENTITY_DID = 'did:ixo:entity:0123456789abcdef0123456789abcdef';

interface Harness {
  indexer: SessionHistoryIndexer;
  calls: Array<{ url: string; init: RequestInit }>;
  processed: Array<[string, number]>;
  minted: Array<{ target: { did: string; capability: string }; can?: string }>;
  sleeps: number[];
  /** Every `readMessages` call: its cursor and how many entries it returned. */
  reads: Array<{ after: string | null; entries: number }>;
  /** The transcript the reads serve (push to it to add turns). */
  messages: HistoryMessage[];
  /** The uploaded message contents, one list per request. */
  bodies(): string[][];
  /** The uploaded message `uuid`s, one list per request. */
  uuids(): string[][];
  /** Every `onPassEnd` report. */
  passEnds: PassEnd[];
  /** Every logged line, by level. */
  logs: { log: string[]; warn: string[]; error: string[] };
}

interface FakeResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** The engine's refusal body (error contract fields). */
const refusal = (fields: Record<string, unknown>): string =>
  JSON.stringify(fields);

/** The Workers engine's answer to more than `limit` messages. */
const TOO_MANY = (limit = 50): FakeResponse => ({
  status: 422,
  body: refusal({
    detail: `messages: Array must contain at most ${limit} element(s)`,
    code: 'MESSAGES_INVALID',
    retryable: false,
  }),
});

function harness(
  overrides: Partial<SessionHistoryIndexerDeps> & {
    session?: IndexableSession;
    messages?: HistoryMessage[];
    responses?: FakeResponse[];
    /** Answers each request from what it carries (instead of `responses`). */
    engine?: (messages: EngineMessage[], n: number) => FakeResponse;
  } = {},
): Harness {
  const calls: Harness['calls'] = [];
  const processed: Harness['processed'] = [];
  const minted: Harness['minted'] = [];
  const sleeps: number[] = [];
  const reads: Harness['reads'] = [];
  const responses = overrides.responses ?? [{ status: 200 }];
  const messages = overrides.messages ?? [
    { type: 'human', content: 'I live in Lisbon' },
    { type: 'ai', content: '' }, // tool-call-only turn
    { type: 'tool', content: 'weather: 24C' },
    { type: 'ai', content: 'Sunny in Lisbon today.' },
  ];
  const session = overrides.session ?? {
    title: 'Trip planning',
    roomId: '!room:x',
  };
  // The stored watermark, as the session row keeps it.
  let stored = session.lastProcessedCount;
  let n = 0;
  const passEnds: PassEnd[] = [];
  const logs: Harness['logs'] = { log: [], warn: [], error: [] };
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = overrides.engine
      ? overrides.engine(sentMessages(init ?? {}), n)
      : responses[Math.min(n, responses.length - 1)]!;
    n += 1;
    return new Response(r.body ?? '', {
      status: r.status,
      ...(r.headers ? { headers: r.headers } : {}),
    });
  };
  const deps: SessionHistoryIndexerDeps = {
    memoryEngineUrl: 'https://memory.test/',
    entityDid: ENTITY_DID,
    getSession: async () => ({
      ...session,
      ...(stored !== undefined ? { lastProcessedCount: stored } : {}),
    }),
    readMessages: async (_id, after, limit) => {
      const page = pageOfMessages(messages, after, limit);
      reads.push({ after, entries: page?.entries.length ?? -1 });
      return page;
    },
    setProcessedCount: async (id, count) => {
      stored = count;
      processed.push([id, count]);
    },
    resolveUserRoom: async () => ({ roomId: '!resolved:x' }),
    ucan: {
      hasSigningKey: () => true,
      resolveServiceDid: async () => 'did:web:memory.test',
      mintInvocation: async (target, opts) => {
        minted.push({ target, can: opts?.can });
        return 'INVOCATION';
      },
    },
    speakerLabels: async () => ({ user: 'Zed', oracle: 'Orin' }),
    logger: {
      log: (line: string) => void logs.log.push(line),
      warn: (line: string) => void logs.warn.push(line),
      error: (line: string) => void logs.error.push(line),
    },
    onPassEnd: (_id, end) => {
      passEnds.push(end);
    },
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  };
  return {
    indexer: new SessionHistoryIndexer(deps),
    calls,
    processed,
    minted,
    sleeps,
    reads,
    messages,
    passEnds,
    logs,
    bodies: () => calls.map((c) => sentMessages(c.init).map((m) => m.content)),
    uuids: () => calls.map((c) => sentMessages(c.init).map((m) => m.uuid)),
  };
}

interface EngineMessage {
  content: string;
  uuid: string;
  role_type: string;
  role: string;
  source_description: string;
}

/** The messages one request carried. */
function sentMessages(init: RequestInit): EngineMessage[] {
  const body: unknown = JSON.parse(String(init.body));
  const list: unknown =
    typeof body === 'object' && body !== null
      ? Reflect.get(body, 'messages')
      : undefined;
  if (!Array.isArray(list)) return [];
  return list.map((m: unknown) => {
    const field = (key: string): string => {
      const v: unknown =
        typeof m === 'object' && m !== null ? Reflect.get(m, key) : undefined;
      return typeof v === 'string' ? v : '';
    };
    return {
      content: field('content'),
      uuid: field('uuid'),
      role_type: field('role_type'),
      role: field('role'),
      source_description: field('source_description'),
    };
  });
}

/** `n` conversation messages, each followed by a tool result the filter drops. */
function longChat(n: number): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ type: i % 2 === 0 ? 'human' : 'ai', content: `m${i}` });
    out.push({ type: 'tool', content: `tool ${i}` });
  }
  return out;
}

/** Let pending promise continuations (and zero-delay timers) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('transformMessagesToMemoryEngineFormat', () => {
  it('maps LangChain types to engine roles with real speaker identities', () => {
    const out = transformMessagesToMemoryEngineFormat(
      [
        { type: 'human', content: 'hi' },
        { type: 'ai', content: 'hello' },
        { type: 'tool', content: 'result' },
        { type: 'system', content: 'sys' },
        { type: 'weird', content: '?' },
      ],
      'My chat',
      'Zed',
      'Orin',
    );
    expect(out.map((m) => [m.role_type, m.role, m.name])).toEqual([
      ['user', 'Zed', 'Zed'],
      ['assistant', 'Orin', 'Orin'],
      ['system', 'System', 'System'],
      ['user', 'Zed', 'Zed'],
    ]);
    expect(new Set(out.map((m) => m.source_description))).toEqual(
      new Set(['Chat Session: My chat']),
    );
  });
});

describe('SessionHistoryIndexer', () => {
  it('posts the unprocessed transcript to <MEMORY_ENGINE_URL>/messages with UCAN + entity + room headers and advances the watermark', async () => {
    const h = harness();
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe('https://memory.test/messages');
    expect(h.calls[0]!.init.method).toBe('POST');
    expect(h.calls[0]!.init.headers).toEqual({
      Authorization: 'Bearer INVOCATION',
      'X-Auth-Type': 'ucan',
      'x-oracle-entity-did': ENTITY_DID,
      'x-room-id': '!room:x',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(String(h.calls[0]!.init.body)) as {
      messages: Array<{ content: string; role_type: string; name: string }>;
    };
    // The empty tool-call-only AI turn and the tool reply are dropped; the
    // rest keep order.
    expect(body.messages.map((m) => [m.role_type, m.name, m.content])).toEqual([
      ['user', 'Zed', 'I live in Lisbon'],
      ['assistant', 'Orin', 'Sunny in Lisbon today.'],
    ]);
    expect(h.minted).toEqual([
      {
        target: { did: 'did:web:memory.test', capability: 'ixo:memory' },
        can: 'memory/*',
      },
    ]);
    // Watermark counts ALL transcript messages, including the dropped one.
    expect(h.processed).toEqual([['s1', 4]]);
  });

  it('indexes the final tail when another turn completes during an upload', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted: string[] = [];
    const h = harness({
      session: { roomId: '!room:x' },
      messages: [{ type: 'human', content: 'First' }],
      fetchImpl: async (_url, init) => {
        posted.push(String(init?.body));
        if (posted.length === 1) await held;
        return new Response('{}');
      },
    });
    const first = h.indexer.process('continuous');
    while (posted.length === 0) await settle();
    h.messages.push({ type: 'human', content: 'Last decision' });
    // The joining call settles with the follow-up pass, not before it.
    const second = h.indexer.process('continuous');
    release();
    await expect(first).resolves.toBe('processed');
    await expect(second).resolves.toBe('skipped');
    expect(posted).toHaveLength(2);
    expect(JSON.parse(posted[1]!).messages).toMatchObject([
      { content: 'Last decision' },
    ]);
    expect(h.processed).toEqual([
      ['continuous', 1],
      ['continuous', 2],
    ]);
  });

  it('indexes the final tail when another turn completes while the transcript is being read', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const messages: HistoryMessage[] = [{ type: 'human', content: 'First' }];
    let reading = false;
    const h = harness({
      messages,
      readMessages: async (_id, after, limit) => {
        if (!reading) {
          reading = true;
          await gate;
        }
        return pageOfMessages(messages, after, limit);
      },
    });
    const first = h.indexer.process('s1');
    while (!reading) await settle();
    // The finish lands before any upload started: still one more pass.
    messages.push({ type: 'ai', content: 'Booked the 9:40 ferry.' });
    const second = h.indexer.process('s1');
    release();
    await Promise.all([first, second]);
    expect(h.bodies().flat()).toEqual(['First', 'Booked the 9:40 ferry.']);
    expect(h.processed.at(-1)).toEqual(['s1', 2]);
  });

  it('reads only the unindexed tail on a later pass', async () => {
    const h = harness();
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.reads).toEqual([{ after: null, entries: 4 }]);
    h.reads.length = 0;
    h.messages.push(
      { type: 'human', content: 'Book a table for two' },
      { type: 'ai', content: 'Booked for 8pm.' },
    );
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    // Resumed after the fourth message: nothing before it was read again.
    expect(h.reads).toEqual([{ after: '#4', entries: 2 }]);
    expect(h.bodies()[1]).toEqual(['Book a table for two', 'Booked for 8pm.']);
    expect(h.processed.at(-1)).toEqual(['s1', 6]);
  });

  it('scans from the start once when the resume point is gone, skipping what is indexed', async () => {
    const messages: HistoryMessage[] = [
      { type: 'human', content: 'one' },
      { type: 'ai', content: 'two' },
    ];
    let rewritten = false;
    const reads: Array<string | null> = [];
    const h = harness({
      messages,
      readMessages: async (_id, after, limit) => {
        reads.push(after);
        // After a rewrite the cursor handed out before no longer resolves.
        if (rewritten && after === '#2') return null;
        return pageOfMessages(messages, after, limit);
      },
    });
    await h.indexer.process('s1');
    rewritten = true;
    messages.push({ type: 'human', content: 'three' });
    reads.length = 0;
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(reads).toEqual(['#2', null]);
    expect(h.bodies()).toEqual([['one', 'two'], ['three']]);
    expect(h.processed.at(-1)).toEqual(['s1', 3]);
  });

  it('a fresh indexer scans from the start and skips what the stored count covers', async () => {
    const h = harness({
      session: { title: 't', roomId: '!r', lastProcessedCount: 3 },
    });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.reads).toEqual([{ after: null, entries: 4 }]);
    expect(h.bodies()).toEqual([['Sunny in Lisbon today.']]);
  });

  it('uploads a long tail in chunks and advances the watermark per accepted chunk', async () => {
    const messages: HistoryMessage[] = Array.from({ length: 5 }, (_, i) => ({
      type: 'human',
      content: `m${i}`,
    }));
    const h = harness({
      messages,
      maxMessagesPerRequest: 2,
      // The second upload fails on both attempts.
      responses: [
        { status: 200 },
        { status: 503 },
        { status: 503 },
        { status: 200 },
      ],
    });
    await expect(h.indexer.process('s1')).resolves.toBe('failed');
    expect(h.bodies()).toEqual([
      ['m0', 'm1'],
      ['m2', 'm3'],
      ['m2', 'm3'],
    ]);
    // The accepted chunk stays indexed; the failed one is not counted.
    expect(h.processed).toEqual([['s1', 2]]);
  });

  it('splits parts by JSON body bytes', async () => {
    const h = harness({
      messages: [
        { type: 'human', content: 'a'.repeat(1500) },
        { type: 'human', content: 'b'.repeat(1500) },
        { type: 'human', content: 'c'.repeat(1500) },
        { type: 'human', content: 'd' },
      ],
      maxRequestBytes: 4096,
    });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.bodies().map((body) => body.map((c) => c[0]))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    for (const call of h.calls)
      expect(
        new TextEncoder().encode(String(call.init.body)).byteLength,
      ).toBeLessThanOrEqual(4096);
    expect(h.processed).toEqual([
      ['s1', 2],
      ['s1', 4],
    ]);
  });

  it('backs off a session after a failed pass, doubling to the cap, and resets on success', async () => {
    let now = 1_000_000;
    const h = harness({
      responses: [{ status: 500 }],
      now: () => now,
      backoffInitialMs: 60_000,
      backoffMaxMs: 150_000,
    });
    await expect(h.indexer.process('s1')).resolves.toBe('failed');
    expect(h.calls).toHaveLength(2);
    // Within the first minute: no attempt at all.
    now += 59_000;
    await expect(h.indexer.process('s1')).resolves.toBe('skipped');
    expect(h.calls).toHaveLength(2);
    // Another session is not affected.
    await expect(h.indexer.process('s2')).resolves.toBe('failed');
    expect(h.calls).toHaveLength(4);
    now += 1_000;
    await expect(h.indexer.process('s1')).resolves.toBe('failed');
    expect(h.calls).toHaveLength(6);
    // The second failure doubled the wait to 2 min.
    now += 119_000;
    await expect(h.indexer.process('s1')).resolves.toBe('skipped');
    now += 1_000;
    await expect(h.indexer.process('s1')).resolves.toBe('failed');
    expect(h.calls).toHaveLength(8);
    // The third failure would wait 4 min; the cap holds it at 150 s.
    now += 149_000;
    await expect(h.indexer.process('s1')).resolves.toBe('skipped');
    expect(h.calls).toHaveLength(8);
    // Deletion (the transcript's last chance) ignores the backoff.
    await expect(
      h.indexer.process('s1', { ignoreBackoff: true }),
    ).resolves.toBe('failed');
    expect(h.calls).toHaveLength(10);
    now += 1_000;
    await expect(h.indexer.process('s1')).resolves.toBe('skipped');
  });

  it('a success clears the backoff', async () => {
    let now = 0;
    const h = harness({
      responses: [
        { status: 500 },
        { status: 500 },
        { status: 200 },
        { status: 500 },
      ],
      now: () => now,
    });
    await expect(h.indexer.process('s1')).resolves.toBe('failed');
    now += 60_000;
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    h.messages.push({ type: 'human', content: 'more' });
    await expect(h.indexer.process('s1')).resolves.toBe('failed');
    // Back to the first step (1 min), not the doubled 2 min.
    now += 60_000;
    const before = h.calls.length;
    await expect(h.indexer.process('s1')).resolves.toBe('failed');
    expect(h.calls.length).toBe(before + 2);
  });

  it('coalesces finished turns into one pass after the quiet period', async () => {
    vi.useFakeTimers();
    const h = harness();
    const waits = [
      h.indexer.processAfterQuiet('s1', 180_000),
      h.indexer.processAfterQuiet('s1', 180_000),
    ];
    await vi.advanceTimersByTimeAsync(179_000);
    expect(h.calls).toHaveLength(0);
    // A third finish restarts the wait.
    waits.push(h.indexer.processAfterQuiet('s1', 180_000));
    await vi.advanceTimersByTimeAsync(179_000);
    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(waits);
    expect(h.calls).toHaveLength(1);
    expect(h.processed).toEqual([['s1', 4]]);
  });

  it('an immediate trigger takes over a pending quiet-period wait', async () => {
    vi.useFakeTimers();
    const h = harness();
    const wait = h.indexer.processAfterQuiet('s1', 180_000);
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    await wait;
    await vi.advanceTimersByTimeAsync(200_000);
    expect(h.calls).toHaveLength(1);
  });

  it('only sends messages after lastProcessedCount and skips when nothing is new', async () => {
    const h = harness({
      session: { title: 't', roomId: '!r', lastProcessedCount: 3 },
    });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    const body = JSON.parse(String(h.calls[0]!.init.body)) as {
      messages: unknown[];
    };
    expect(body.messages).toHaveLength(1);
    expect(h.processed).toEqual([['s1', 4]]);

    const done = harness({
      session: { title: 't', roomId: '!r', lastProcessedCount: 4 },
    });
    await expect(done.indexer.process('s1')).resolves.toBe('skipped');
    expect(done.calls).toHaveLength(0);
  });

  it('falls back to the resolved user room when the session row has none', async () => {
    const h = harness({ session: { title: 't' } });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(
      (h.calls[0]!.init.headers as Record<string, string>)['x-room-id'],
    ).toBe('!resolved:x');
  });

  it('skips (no upload, no retry) when the session, room, messages, key or delegation are missing', async () => {
    const noSession = harness({ getSession: async () => undefined });
    await expect(noSession.indexer.process('s1')).resolves.toBe('skipped');

    const noRoom = harness({
      session: { title: 't' },
      resolveUserRoom: async () => null,
    });
    await expect(noRoom.indexer.process('s1')).resolves.toBe('skipped');

    const noMessages = harness({ messages: [] });
    await expect(noMessages.indexer.process('s1')).resolves.toBe('skipped');

    const noKey = harness({
      ucan: {
        hasSigningKey: () => false,
        resolveServiceDid: async () => 'did:web:memory.test',
        mintInvocation: async () => 'x',
      },
    });
    await expect(noKey.indexer.process('s1')).resolves.toBe('skipped');

    const noDelegation = harness({
      ucan: {
        hasSigningKey: () => true,
        resolveServiceDid: async () => 'did:web:memory.test',
        mintInvocation: async () => {
          throw new Error('No delegation from did:ixo:u available');
        },
      },
    });
    await expect(noDelegation.indexer.process('s1')).resolves.toBe('skipped');
    expect(noDelegation.sleeps).toEqual([]);
    for (const h of [noSession, noRoom, noMessages, noKey, noDelegation]) {
      expect(h.calls).toHaveLength(0);
      expect(h.processed).toEqual([]);
    }
  });

  it('is disabled without MEMORY_ENGINE_URL', async () => {
    const h = harness({ memoryEngineUrl: undefined });
    expect(h.indexer.enabled).toBe(false);
    await expect(h.indexer.process('s1')).resolves.toBe('skipped');
    expect(h.calls).toHaveLength(0);
  });

  it('skips without ORACLE_ENTITY_DID — no mint, no upload, the watermark stays — and warns once', async () => {
    const warnings: string[] = [];
    const h = harness({
      entityDid: undefined,
      logger: { ...SILENT, warn: (msg) => warnings.push(String(msg)) },
    });
    await expect(h.indexer.process('s1')).resolves.toBe('skipped');
    await expect(h.indexer.process('s2')).resolves.toBe('skipped');
    expect(h.calls).toHaveLength(0);
    expect(h.minted).toEqual([]);
    expect(h.processed).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ORACLE_ENTITY_DID');
  });

  it('retries a rejected upload 2× with the configured pause, then reports failure without moving the watermark', async () => {
    const h = harness({
      responses: [{ status: 500, body: 'boom' }],
      retryDelayMs: 10_000,
    });
    await expect(h.indexer.process('s1')).resolves.toBe('failed');
    // Two attempts by default: the run keeps the object resident under
    // `ctx.waitUntil`, so the envelope stays short.
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([10_000]);
    expect(h.processed).toEqual([]);
  });

  it('reports the room after an accepted upload, never after a rejected one or a skip', async () => {
    const indexed: string[] = [];
    const ok = harness({ onIndexed: (roomId) => indexed.push(roomId) });
    await expect(ok.indexer.process('s1')).resolves.toBe('processed');
    expect(indexed).toEqual(['!room:x']);

    indexed.length = 0;
    const rejected = harness({
      responses: [{ status: 500 }],
      onIndexed: (roomId) => indexed.push(roomId),
    });
    await expect(rejected.indexer.process('s1')).resolves.toBe('failed');
    const nothingNew = harness({
      session: { title: 't', roomId: '!r', lastProcessedCount: 4 },
      onIndexed: (roomId) => indexed.push(roomId),
    });
    await expect(nothingNew.indexer.process('s1')).resolves.toBe('skipped');
    expect(indexed).toEqual([]);
  });

  it('succeeds on a later attempt', async () => {
    const h = harness({ responses: [{ status: 502 }, { status: 200 }] });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.calls).toHaveLength(2);
    expect(h.processed).toEqual([['s1', 4]]);
  });

  it('collapses concurrent runs for the same session into one pass plus one follow-up', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const messages: HistoryMessage[] = [{ type: 'human', content: 'x' }];
    const h = harness({
      messages,
      readMessages: async (_id, after, limit) => {
        await gate;
        return pageOfMessages(messages, after, limit);
      },
    });
    const first = h.indexer.process('s1');
    const second = h.indexer.process('s1');
    const third = h.indexer.process('s1');
    expect(h.indexer.inFlightCount).toBe(1);
    release();
    await expect(first).resolves.toBe('processed');
    await expect(second).resolves.toBe('skipped');
    await expect(third).resolves.toBe('skipped');
    // One upload: the follow-up pass found nothing new.
    expect(h.calls).toHaveLength(1);
    expect(h.indexer.inFlightCount).toBe(0);
  });
});

/** Every content sent across all requests, in order. */
const allSent = (h: Harness): string[] => h.bodies().flat();

describe('the engine request rules', () => {
  it('never sends more than 50 messages per request, counted after the filter, in order and exactly once', async () => {
    // 130 conversation messages, 260 transcript messages with the tool results.
    const h = harness({ messages: longChat(130) });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(MEMORY_UPLOAD_MAX_MESSAGES).toBe(50);
    expect(h.bodies().map((b) => b.length)).toEqual([50, 50, 30]);
    expect(allSent(h)).toEqual(Array.from({ length: 130 }, (_, i) => `m${i}`));
    // The count is in transcript messages and moves per accepted part.
    expect(h.processed).toEqual([
      ['s1', 100],
      ['s1', 200],
      ['s1', 260],
    ]);
    const ids = h.uuids().flat();
    expect(new Set(ids).size).toBe(130);
    for (const id of ids)
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    expect(h.logs.log.join('\n')).toContain(
      'backlog done, 130 messages in 3 parts (lastProcessedCount 0 → 260)',
    );
    expect(h.passEnds).toEqual([
      expect.objectContaining({ backlog: false, progressed: true }),
    ]);
  });

  it('a failure in part N keeps parts before it; the next pass resumes at N with the same ids, no gap, no repeat', async () => {
    let now = 0;
    const h = harness({
      messages: longChat(120),
      now: () => now,
      // Part 3 fails on both attempts of the first pass.
      responses: [
        { status: 202 },
        { status: 202 },
        { status: 503 },
        { status: 503 },
        { status: 202 },
      ],
    });
    await expect(h.indexer.process('s1')).resolves.toBe('failed');
    expect(h.processed).toEqual([
      ['s1', 100],
      ['s1', 200],
    ]);
    expect(h.passEnds).toEqual([
      expect.objectContaining({ backlog: true, progressed: true }),
    ]);
    now += 60_000;
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    const bodies = h.bodies();
    expect(bodies.map((b) => b.length)).toEqual([50, 50, 20, 20, 20]);
    // The resend is the same request: same messages, same ids.
    expect(h.uuids()[2]).toEqual(h.uuids()[4]);
    expect(bodies[4]).toEqual(
      Array.from({ length: 20 }, (_, i) => `m${100 + i}`),
    );
    expect(h.processed.at(-1)).toEqual(['s1', 240]);
  });

  it('derives ids from session, position and text: stable across indexers, different per message', async () => {
    const a = await historyMessageUuid('s1', 4, 0, 'user', 'hello');
    expect(await historyMessageUuid('s1', 4, 0, 'user', 'hello')).toBe(a);
    expect(await historyMessageUuid('s1', 5, 0, 'user', 'hello')).not.toBe(a);
    expect(await historyMessageUuid('s2', 4, 0, 'user', 'hello')).not.toBe(a);
    expect(await historyMessageUuid('s1', 4, 1, 'user', 'hello')).not.toBe(a);
    const first = harness({ messages: longChat(3) });
    const second = harness({ messages: longChat(3) });
    await first.indexer.process('s1');
    await second.indexer.process('s1');
    expect(first.uuids()).toEqual(second.uuids());
  });

  it('splits a message over the per-message limit into marked pieces, and cuts one too long for 8 pieces', async () => {
    const long = 'word '.repeat(8_000); // 40,000 bytes
    const huge = 'x'.repeat(200_000);
    const h = harness({
      messages: [
        { type: 'human', content: long },
        { type: 'ai', content: huge },
      ],
    });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    const sent = allSent(h);
    const enc = new TextEncoder();
    for (const piece of sent)
      expect(enc.encode(piece).byteLength).toBeLessThanOrEqual(
        MEMORY_UPLOAD_MAX_MESSAGE_BYTES,
      );
    const longPieces = sent.filter((p) => p.includes('word'));
    expect(longPieces).toHaveLength(3);
    expect(longPieces[0]).toMatch(/^\[part 1\/3\] /);
    expect(
      longPieces.map((p) => p.replace(/^\[part \d\/\d\] /, '')).join(''),
    ).toBe(long);
    const hugePieces = sent.filter((p) => p.includes('xxx'));
    expect(hugePieces).toHaveLength(MAX_PIECES_PER_MESSAGE);
    expect(hugePieces.at(-1)).toMatch(
      /\[message cut here: \d+ more bytes not stored\]$/,
    );
    // Both whole transcript messages are counted once their pieces are in.
    expect(h.processed.at(-1)).toEqual(['s1', 2]);
  });

  it('cuts labels the engine would refuse (over 500 characters)', () => {
    const [m] = transformMessagesToMemoryEngineFormat(
      [{ type: 'human', content: 'hi' }],
      't'.repeat(900),
      'u'.repeat(900),
      'Orin',
    );
    expect(m!.role).toHaveLength(500);
    expect(m!.name).toHaveLength(500);
    expect(m!.source_description).toHaveLength(500);
  });
});

describe('splitMessageContent', () => {
  it('keeps a short message whole and never cuts inside a character', () => {
    expect(splitMessageContent('hello', 1024, 8)).toEqual(['hello']);
    const text = '🙂'.repeat(1000); // 4,000 bytes
    const pieces = splitMessageContent(text, 1024, 8);
    expect(pieces.length).toBeGreaterThan(3);
    const enc = new TextEncoder();
    for (const piece of pieces) {
      expect(enc.encode(piece).byteLength).toBeLessThanOrEqual(1024);
      expect(piece).not.toContain('�');
    }
    expect(
      pieces.map((p) => p.replace(/^\[part \d+\/\d+\] /, '')).join(''),
    ).toBe(text);
  });

  it('prefers a line break near the end of a piece', () => {
    const text = `${'a'.repeat(900)}\n${'b'.repeat(900)}`;
    const [first] = splitMessageContent(text, 1024, 8);
    expect(first).toBe(`[part 1/2] ${'a'.repeat(900)}\n`);
  });
});

describe('the engine error contract', () => {
  it('reads the contract fields and the known limit texts, and keeps no detail from a code-less body', async () => {
    const workers = await readUploadRefusal(
      new Response(
        refusal({
          detail: 'messages: Array must contain at most 50 element(s)',
          code: 'MESSAGES_INVALID',
          retryable: false,
          reason: 'too_many:messages',
          limit: 50,
          actual: 120,
        }),
        { status: 422 },
      ),
    );
    expect(workers).toMatchObject({
      status: 422,
      code: 'MESSAGES_INVALID',
      retryable: false,
      reason: 'too_many:messages',
      limit: 50,
      actual: 120,
      countLimit: 50,
    });
    expect(classifyUploadRefusal(workers)).toBe('count');
    // The old engine's pydantic error echoes the input: nothing of it is kept.
    const old = await readUploadRefusal(
      new Response(
        JSON.stringify({
          detail: [
            {
              type: 'too_long',
              msg: 'List should have at most 50 items after validation, not 51',
              input: [{ content: 'SECRET' }],
            },
          ],
        }),
        { status: 422 },
      ),
    );
    expect(old.countLimit).toBe(50);
    expect(old.detail).toBeUndefined();
    expect(JSON.stringify(old)).not.toContain('SECRET');
    expect(classifyUploadRefusal(old)).toBe('count');
    const queueFull = await readUploadRefusal(
      new Response(
        refusal({ detail: 'x', code: 'QUEUE_FULL', retryable: true }),
        { status: 429, headers: { 'Retry-After': '5' } },
      ),
    );
    expect(queueFull.retryAfterMs).toBe(5000);
    expect(classifyUploadRefusal(queueFull)).toBe('retry');
  });

  it.each([
    [{ status: 413, code: 'EPISODE_TOO_LARGE', retryable: false }, 'message'],
    [{ status: 413, code: 'BODY_TOO_LARGE', retryable: false }, 'body'],
    [{ status: 413 }, 'body'],
    [{ status: 422, code: 'MESSAGES_INVALID', retryable: false }, 'invalid'],
    [{ status: 422 }, 'invalid'],
    [{ status: 400, code: 'BAD_JSON', retryable: false }, 'invalid'],
    [{ status: 400, code: 'ENTITY_HEADER_INVALID', retryable: false }, 'stop'],
    [{ status: 401 }, 'stop'],
    [{ status: 403, code: 'ENTITY_NOT_VOUCHED', retryable: false }, 'stop'],
    [{ status: 508, code: 'CALLER_DEPTH', retryable: false }, 'stop'],
    [{ status: 507, code: 'SPACE_TOO_LARGE', retryable: false }, 'stop'],
    [{ status: 429, code: 'USER_RATE_LIMITED', retryable: true }, 'retry'],
    [{ status: 500, code: 'INTERNAL', retryable: true }, 'retry'],
    [{ status: 503 }, 'retry'],
  ] as const)('%o → %s', (r, kind) => {
    expect(classifyUploadRefusal(r)).toBe(kind);
  });

  it('learns a lower count limit from the refusal and goes on in smaller parts, never resending the refused request', async () => {
    const h = harness({
      messages: longChat(60),
      engine: (messages) =>
        messages.length > 20 ? TOO_MANY(20) : { status: 202 },
    });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.bodies().map((b) => b.length)).toEqual([50, 20, 20, 20]);
    expect(h.bodies().slice(1).flat()).toEqual(
      Array.from({ length: 60 }, (_, i) => `m${i}`),
    );
    const warn = h.logs.warn.join('\n');
    expect(warn).toContain('422 MESSAGES_INVALID');
    expect(warn).toContain('rule=count');
    expect(warn).toContain('50 messages from 100 transcript messages');
    expect(warn).toContain('sending at most 20 messages per request');
    // The indexer keeps the learned limit for later passes.
    h.messages.push(...longChat(30));
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(
      h
        .bodies()
        .slice(4)
        .map((b) => b.length),
    ).toEqual([20, 10]);
  });

  it('uses the engine reason and limit fields when it sends them', async () => {
    const h = harness({
      messages: longChat(25),
      engine: (messages) =>
        messages.length > 10
          ? {
              status: 422,
              body: refusal({
                detail: 'messages: too many',
                code: 'MESSAGES_INVALID',
                retryable: false,
                reason: 'too_many:messages',
                limit: 10,
                actual: messages.length,
              }),
            }
          : { status: 202 },
    });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.bodies().map((b) => b.length)).toEqual([25, 10, 10, 5]);
    expect(h.logs.warn.join('\n')).toContain('reason=too_many:messages');
  });

  it('splits smaller when the engine refuses a message as too large (413 EPISODE_TOO_LARGE)', async () => {
    const enc = new TextEncoder();
    const text = 'abc '.repeat(1250); // 5,000 bytes
    const h = harness({
      messages: [
        { type: 'human', content: 'short' },
        { type: 'ai', content: text },
      ],
      engine: (messages) => {
        const big = messages.findIndex(
          (m) => enc.encode(m.content).byteLength > 2000,
        );
        return big >= 0
          ? {
              status: 413,
              body: refusal({
                detail: `messages[${big}].content is larger than 2000 bytes; split it into several messages`,
                code: 'EPISODE_TOO_LARGE',
                retryable: false,
              }),
            }
          : { status: 202 };
      },
    });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.calls).toHaveLength(2);
    const pieces = h.bodies()[1]!;
    expect(pieces[0]).toBe('short');
    expect(pieces.length).toBeGreaterThan(3);
    expect(
      pieces
        .slice(1)
        .map((p) => p.replace(/^\[part \d+\/\d+\] /, ''))
        .join(''),
    ).toBe(text);
    expect(h.logs.warn.join('\n')).toContain(
      'splitting messages at 2000 bytes',
    );
  });

  it('skips one message the engine will never take, with a warning, and stores the rest exactly once', async () => {
    const messages = longChat(12);
    messages[10] = { type: 'human', content: 'POISON' };
    const h = harness({
      messages,
      engine: (sent) =>
        sent.some((m) => m.content === 'POISON')
          ? {
              status: 422,
              body: refusal({
                detail: 'messages.3.role_type: Invalid enum value',
                code: 'MESSAGES_INVALID',
                retryable: false,
              }),
            }
          : { status: 202 },
    });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    const accepted = h.calls
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c }) => !sentMessages(c.init).some((m) => m.content === 'POISON'),
      )
      .flatMap(({ c }) => sentMessages(c.init).map((m) => m.content));
    expect(accepted).toEqual(
      Array.from({ length: 12 }, (_, i) => `m${i}`).filter((m) => m !== 'm5'),
    );
    expect(h.processed.at(-1)).toEqual(['s1', 24]);
    // Halving narrows 24 transcript messages down in a dozen requests.
    expect(h.calls.length).toBeLessThanOrEqual(12);
    expect(h.logs.warn.join('\n')).toContain(
      'skipping transcript message 10 (human) so the rest of the session is stored',
    );
    // The warning carries counts and sizes, never the content.
    expect(h.logs.warn.join('\n')).not.toContain('POISON');
  });

  it('skips nothing when the engine refuses every request (a shared reason, not a message)', async () => {
    const h = harness({
      messages: longChat(20),
      engine: () => ({ status: 422, body: refusal({ detail: 'nope' }) }),
    });
    await expect(h.indexer.process('s1')).resolves.toBe('failed');
    expect(h.processed).toEqual([]);
    // Halving down to one message, then one request after it to check.
    expect(h.calls.length).toBeLessThanOrEqual(8);
    expect(h.logs.warn.join('\n')).toContain(
      'the refusal is not about this message; nothing skipped',
    );
    expect(h.logs.warn.join('\n')).not.toContain('skipping transcript message');
    expect(h.passEnds).toEqual([
      expect.objectContaining({ backlog: true, progressed: false }),
    ]);
  });

  it('skips a refused first message once the messages after it are accepted', async () => {
    const messages = longChat(6);
    messages[0] = { type: 'human', content: 'POISON' };
    const h = harness({
      messages,
      engine: (sent) =>
        sent.some((m) => m.content === 'POISON')
          ? {
              status: 422,
              body: refusal({
                detail: 'bad',
                code: 'MESSAGES_INVALID',
                retryable: false,
              }),
            }
          : { status: 202 },
    });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.processed.at(-1)).toEqual(['s1', 12]);
    expect(h.logs.warn.join('\n')).toContain(
      'skipping transcript message 0 (human)',
    );
    const accepted = h
      .bodies()
      .filter((b) => !b.includes('POISON'))
      .flat();
    expect(accepted).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('keeps a refused last message (nothing after it to confirm) and stops without skipping', async () => {
    const messages = longChat(3);
    messages.push({ type: 'human', content: 'POISON' });
    const h = harness({
      messages,
      maxMessagesPerRequest: 1,
      engine: (sent) =>
        sent.some((m) => m.content === 'POISON')
          ? {
              status: 422,
              body: refusal({
                detail: 'bad',
                code: 'MESSAGES_INVALID',
                retryable: false,
              }),
            }
          : { status: 202 },
    });
    // m0..m2 go up one by one; POISON is refused with an acceptance before
    // it, which is evidence enough: skipped.
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.processed.at(-1)).toEqual(['s1', 7]);
    // Alone (nothing accepted before or after it): kept, pass stopped.
    const alone = harness({
      messages: [{ type: 'human', content: 'POISON' }],
      engine: () => ({
        status: 422,
        body: refusal({
          detail: 'bad',
          code: 'MESSAGES_INVALID',
          retryable: false,
        }),
      }),
    });
    await expect(alone.indexer.process('s1')).resolves.toBe('failed');
    expect(alone.processed).toEqual([]);
    expect(alone.calls).toHaveLength(1);
  });

  it('an engine whose DID cannot be resolved is a failure that keeps the backlog, not a skip', async () => {
    const h = harness({
      ucan: {
        hasSigningKey: () => true,
        resolveServiceDid: async () => null,
        mintInvocation: async () => 'INVOCATION',
      },
    });
    await expect(h.indexer.process('s1')).resolves.toBe('failed');
    expect(h.calls).toHaveLength(0);
    expect(h.passEnds).toEqual([expect.objectContaining({ backlog: true })]);
  });

  it('goes straight to the message the engine names (index)', async () => {
    const messages = longChat(30);
    messages[40] = { type: 'human', content: 'POISON' }; // message 20
    const h = harness({
      messages,
      engine: (sent) => {
        const at = sent.findIndex((m) => m.content === 'POISON');
        return at >= 0
          ? {
              status: 422,
              body: refusal({
                detail: 'messages.x: bad',
                code: 'MESSAGES_INVALID',
                retryable: false,
                reason: 'too_long:messages[].name',
                index: at,
              }),
            }
          : { status: 202 };
      },
    });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    // All 30 (refused, index 20) → the 20 before it → the rest (refused,
    // index 0) → POISON alone (refused, skipped) → the 9 after it.
    expect(h.bodies().map((b) => b.length)).toEqual([30, 20, 10, 1, 9]);
    expect(h.processed.at(-1)).toEqual(['s1', 60]);
  });

  it('waits as the engine says on a retryable refusal (429 QUEUE_FULL) and sends the same part again', async () => {
    const h = harness({
      messages: longChat(60),
      responses: [
        { status: 202 },
        {
          status: 429,
          body: refusal({
            detail: 'queued',
            code: 'QUEUE_FULL',
            retryable: true,
          }),
          headers: { 'Retry-After': '5' },
        },
        { status: 202 },
      ],
    });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.sleeps).toEqual([5000]);
    expect(h.uuids()[1]).toEqual(h.uuids()[2]);
    expect(h.minted).toHaveLength(3);
    expect(allSent(h)).toHaveLength(70);
  });

  it('a wait longer than a pass may hold ends the pass at once, keeps what went up, and floors the backoff', async () => {
    let now = 0;
    const h = harness({
      messages: longChat(60),
      now: () => now,
      responses: [
        { status: 202 },
        {
          status: 429,
          body: refusal({
            detail: 'budget',
            code: 'BUDGET_EXCEEDED',
            retryable: true,
            retry_after_ms: 3_600_000,
          }),
        },
      ],
    });
    await expect(h.indexer.process('s1')).resolves.toBe('failed');
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([]);
    expect(h.processed).toEqual([['s1', 100]]);
    expect(h.passEnds).toEqual([
      expect.objectContaining({
        backlog: true,
        progressed: true,
        retryAfterMs: 3_600_000,
      }),
    ]);
    now += 3_599_000;
    await expect(h.indexer.process('s1')).resolves.toBe('skipped');
    expect(h.calls).toHaveLength(2);
  });

  it('bounds the waits for one part, then defers', async () => {
    const h = harness({
      responses: [
        {
          status: 503,
          body: refusal({
            detail: 'busy',
            code: 'INTERNAL',
            retryable: true,
          }),
        },
      ],
    });
    await expect(h.indexer.process('s1')).resolves.toBe('failed');
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it.each([
    [401, refusal({ detail: 'UCAN validation failed' })],
    [
      400,
      refusal({
        detail: 'bad entity',
        code: 'ENTITY_HEADER_INVALID',
        retryable: false,
      }),
    ],
    [508, refusal({ detail: 'depth', code: 'CALLER_DEPTH', retryable: false })],
  ])(
    'a non-retryable refusal that is not about the messages (%i) is sent once, skips nothing and keeps the count',
    async (status, body) => {
      const h = harness({ responses: [{ status, body }] });
      await expect(h.indexer.process('s1')).resolves.toBe('failed');
      expect(h.calls).toHaveLength(1);
      expect(h.sleeps).toEqual([]);
      expect(h.processed).toEqual([]);
      expect(h.passEnds).toEqual([
        expect.objectContaining({ backlog: true, progressed: false }),
      ]);
    },
  );

  it('caps a pass in requests and reports the backlog; the next pass continues', async () => {
    const h = harness({ messages: longChat(150), maxRequestsPerPass: 2 });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.processed).toEqual([
      ['s1', 100],
      ['s1', 200],
    ]);
    expect(h.passEnds).toEqual([
      expect.objectContaining({ backlog: true, progressed: true }),
    ]);
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(allSent(h)).toEqual(Array.from({ length: 150 }, (_, i) => `m${i}`));
    expect(h.passEnds[1]).toMatchObject({ backlog: false, progressed: true });
  });

  it('reports no backlog when nothing is new or a prerequisite is missing', async () => {
    const nothingNew = harness({
      session: { title: 't', roomId: '!r', lastProcessedCount: 4 },
    });
    await nothingNew.indexer.process('s1');
    expect(nothingNew.passEnds).toEqual([
      expect.objectContaining({ backlog: false, progressed: false }),
    ]);
    const noDelegation = harness({
      ucan: {
        hasSigningKey: () => true,
        resolveServiceDid: async () => 'did:web:memory.test',
        mintInvocation: async () => {
          throw new Error('no ixo:memory grant');
        },
      },
    });
    await expect(noDelegation.indexer.process('s1')).resolves.toBe('skipped');
    expect(noDelegation.passEnds).toEqual([
      expect.objectContaining({ backlog: false }),
    ]);
  });
});

describe('conversationReader', () => {
  const read = (messages: BaseMessage[]) => {
    const reader = conversationReader();
    return messages
      .map(reader)
      .filter((m) => !m.notConversation)
      .map((m) => m.content);
  };
  const call = (name: string) =>
    new AIMessage({
      content: 'Checking.',
      tool_calls: [{ id: 'c1', name, args: {} }],
    });
  const toolResult = (content: string) =>
    new ToolMessage({ content, tool_call_id: 'c1' });

  it('keeps what the user said and the reply, and neither the tool step nor its result', () => {
    expect(
      read([
        new HumanMessage('I moved to Lisbon'),
        call('chain_lookup'),
        toolResult('{"ok":true}'),
        new AIMessage('Noted, welcome to Lisbon.'),
      ]),
    ).toEqual(['I moved to Lisbon', 'Noted, welcome to Lisbon.']);
  });

  it('never sends back a reply to a turn that read memory, and resumes on the next turn', () => {
    expect(
      read([
        new HumanMessage('Does my sister live near the sea?'),
        call(MEMORY_SEARCH_MCP_NAME),
        toolResult('{"nodes":[]}'),
        new AIMessage('Yes, she lives by the sea.'),
        new HumanMessage('Thanks'),
        new AIMessage('You are welcome.'),
      ]),
    ).toEqual([
      'Does my sister live near the sea?',
      'Thanks',
      'You are welcome.',
    ]);
  });

  it('leaves out tool-shaped assistant text, extracted file text and failed replies, not a user who pastes JSON', () => {
    expect(
      read([
        new HumanMessage('{"my":"config"}'),
        new AIMessage('{"nodes":[{"uuid":"1"}]}'),
        new AIMessage({
          content: 'Salary: 90,000',
          additional_kwargs: {
            attachment: { filename: 'a.pdf', mimetype: 'application/pdf' },
          },
        }),
        new AIMessage({
          content: 'boom',
          additional_kwargs: { isError: true },
        }),
        new AIMessage('[a real reply, in brackets]'),
      ]),
    ).toEqual(['{"my":"config"}', '[a real reply, in brackets]']);
  });

  it("reads the person's own words, without the notes the model got", () => {
    const note = 'Current time: Monday';
    expect(
      read([
        new HumanMessage({
          content: `${note}\n\nhello`,
          additional_kwargs: { turn_time_note: note },
        }),
      ]),
    ).toEqual(['hello']);
  });
});

describe('what reaches the engine', () => {
  it('sends neither tool results nor flagged messages, and the watermark still counts them', async () => {
    const h = harness({
      messages: [
        { type: 'human', content: 'I live in Lisbon' },
        { type: 'tool', content: '{"nodes":[]}' },
        { type: 'ai', content: 'From memory.', notConversation: true },
        { type: 'ai', content: 'Sunny today.' },
      ],
    });
    expect(await h.indexer.process('s1')).toBe('processed');
    expect(h.bodies()).toEqual([['I live in Lisbon', 'Sunny today.']]);
    expect(h.processed.at(-1)?.[1]).toBe(4);
  });
});
