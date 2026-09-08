/**
 * Session-history indexer — the Node `SessionHistoryProcessor` policy over
 * fake deps: what gets sent where (endpoint, headers, payload, speaker
 * roles), the `lastProcessedCount` watermark, the skip conditions, the
 * retry-then-fail path, and the per-session lock.
 */
import { describe, expect, it } from 'vitest';
import type { Logger } from '../plugin-api/types';
import {
  SessionHistoryIndexer,
  transformMessagesToMemoryEngineFormat,
  type HistoryMessage,
  type IndexableSession,
  type SessionHistoryIndexerDeps,
} from './session-history-indexer';

const SILENT: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Harness {
  indexer: SessionHistoryIndexer;
  calls: Array<{ url: string; init: RequestInit }>;
  processed: Array<[string, number]>;
  minted: Array<{ target: { did: string; capability: string }; can?: string }>;
  sleeps: number[];
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
  const responses = overrides.responses ?? [{ status: 200 }];
  let n = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(n, responses.length - 1)]!;
    n += 1;
    return new Response(r.body ?? '', { status: r.status });
  };
  const deps: SessionHistoryIndexerDeps = {
    memoryEngineUrl: 'https://memory.test/',
    getSession: async () =>
      overrides.session ?? { title: 'Trip planning', roomId: '!room:x' },
    listMessages: async () =>
      overrides.messages ?? [
        { type: 'human', content: 'I live in Lisbon' },
        { type: 'ai', content: '' }, // tool-call-only turn
        { type: 'tool', content: 'weather: 24C' },
        { type: 'ai', content: 'Sunny in Lisbon today.' },
      ],
    setProcessedCount: async (id, count) => {
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
  };
}

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
  it('posts the unprocessed transcript to <MEMORY_ENGINE_URL>/messages with UCAN + room headers and advances the watermark', async () => {
    const h = harness();
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe('https://memory.test/messages');
    expect(h.calls[0]!.init.method).toBe('POST');
    expect(h.calls[0]!.init.headers).toEqual({
      Authorization: 'Bearer INVOCATION',
      'X-Auth-Type': 'ucan',
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

  it('succeeds on a later attempt', async () => {
    const h = harness({ responses: [{ status: 502 }, { status: 200 }] });
    await expect(h.indexer.process('s1')).resolves.toBe('processed');
    expect(h.calls).toHaveLength(2);
    expect(h.processed).toEqual([['s1', 4]]);
  });

  it('collapses concurrent runs for the same session into one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      listMessages: async () => {
        await gate;
        return [{ type: 'human', content: 'x' }];
      },
    });
    const first = h.indexer.process('s1');
    const second = h.indexer.process('s1');
    await expect(second).resolves.toBe('skipped');
    release();
    await expect(first).resolves.toBe('processed');
    expect(h.calls).toHaveLength(1);
  });
});
