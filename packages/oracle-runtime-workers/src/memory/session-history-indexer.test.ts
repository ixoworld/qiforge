/**
 * Session-history indexer — the Node `SessionHistoryProcessor` policy over
 * fake deps: what gets sent where (endpoint, headers, payload, speaker
 * roles), the `lastProcessedCount` watermark, the tail-only reads and
 * chunked uploads, the skip conditions, the retry-then-fail path and its
 * backoff, the per-session lock and its follow-up pass, and the quiet-period
 * debounce.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../plugin-api/types';
import {
  pageOfMessages,
  SessionHistoryIndexer,
  transformMessagesToMemoryEngineFormat,
  type HistoryMessage,
  type IndexableSession,
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
}

function harness(
  overrides: Partial<SessionHistoryIndexerDeps> & {
    session?: IndexableSession;
    messages?: HistoryMessage[];
    responses?: Array<{ status: number; body?: string }>;
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
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(n, responses.length - 1)]!;
    n += 1;
    return new Response(r.body ?? '', { status: r.status });
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
    logger: SILENT,
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
    bodies: () =>
      calls.map((c) => {
        const body: unknown = JSON.parse(String(c.init.body));
        const list: unknown =
          typeof body === 'object' && body !== null
            ? Reflect.get(body, 'messages')
            : undefined;
        return Array.isArray(list)
          ? list.map((m: unknown) =>
              String(
                typeof m === 'object' && m !== null
                  ? Reflect.get(m, 'content')
                  : m,
              ),
            )
          : [];
      }),
  };
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
    // The empty tool-call-only AI turn is dropped; the rest keep order.
    expect(body.messages.map((m) => [m.role_type, m.name, m.content])).toEqual([
      ['user', 'Zed', 'I live in Lisbon'],
      ['assistant', 'Orin', 'weather: 24C'],
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
      chunkMaxMessages: 2,
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

  it('splits chunks by content bytes, sending an oversized message alone', async () => {
    const h = harness({
      messages: [
        { type: 'human', content: 'a'.repeat(6) },
        { type: 'human', content: 'b'.repeat(6) },
        { type: 'human', content: 'c'.repeat(30) },
        { type: 'human', content: 'd' },
      ],
      chunkMaxBytes: 16,
    });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.bodies().map((body) => body.map((c) => c[0]))).toEqual([
      ['a', 'b'],
      ['c'],
      ['d'],
    ]);
    expect(h.processed).toEqual([
      ['s1', 2],
      ['s1', 3],
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
