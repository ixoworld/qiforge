import { describe, expect, it } from 'vitest';
import { tracesConfigFromEnv } from './config';
import { TEST_CONFIG, quietLogger } from './test-helpers';
import { CONTRACT_VERSION } from './contract';
import {
  GONE_PAUSE_MS,
  MAX_RETRY_AFTER_MS,
  resetVersionPause,
  traceSendStats,
  TracesTransport,
  VERSION_PAUSE_MS,
  type TransportDeps,
} from './transport';

const body = () =>
  Promise.resolve({ bytes: new TextEncoder().encode('{}'), gzip: true });

function transportWith(
  answers: Array<number | 'timeout' | 'network'>,
  extra: Partial<TransportDeps> & {
    retryAfter?: string;
    errorBody?: unknown;
  } = {},
  logs?: string[],
) {
  const { retryAfter, errorBody, ...deps } = extra;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sleeps: number[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (answer === 'network') throw new TypeError('fetch failed');
    if (answer === 'timeout')
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        );
      });
    return new Response(
      errorBody !== undefined && answer >= 400
        ? JSON.stringify(errorBody)
        : null,
      {
        status: answer,
        headers: retryAfter !== undefined ? { 'retry-after': retryAfter } : {},
      },
    );
  };
  const logger = logs
    ? {
        log: (m: unknown) => logs.push(String(m)),
        warn: (m: unknown) => logs.push(String(m)),
        error: (m: unknown) => logs.push(String(m)),
      }
    : quietLogger;
  const transport = new TracesTransport(
    TEST_CONFIG,
    logger,
    {},
    {
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      timeoutMs: { turn: 20, start: 20 },
      ...deps,
    },
  );
  return { transport, calls, sleeps };
}

describe('TracesTransport', () => {
  it('sends once on a 2xx', async () => {
    const t = transportWith([201]);
    expect(await t.transport.send('turn', 'trace-1', body)).toBe('sent');
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toBe('https://traces.test/v1/ingest/turns');
  });

  it('retries a 5xx once, after a jittered pause', async () => {
    const t = transportWith([503, 201]);
    expect(await t.transport.send('turn', 'trace-1', body)).toBe('sent');
    expect(t.calls).toHaveLength(2);
    expect(t.sleeps).toEqual([250 + 375]);
  });

  it('gives up after the one retry', async () => {
    const t = transportWith([502, 500]);
    expect(await t.transport.send('turn', 'trace-1', body)).toBe('failed');
    expect(t.calls).toHaveLength(2);
  });

  it('retries a timeout once', async () => {
    const t = transportWith(['timeout', 'timeout']);
    expect(await t.transport.send('turn', 'trace-1', body)).toBe('failed');
    expect(t.calls).toHaveLength(2);
  });

  it('retries a network error once', async () => {
    const t = transportWith(['network', 201]);
    expect(await t.transport.send('start', 'trace-1', body)).toBe('sent');
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]!.url).toBe('https://traces.test/v1/ingest/turns/start');
  });

  it.each([400, 401, 403, 413, 415, 422])(
    'never retries a %i',
    async (status) => {
      const t = transportWith([status, 201]);
      expect(await t.transport.send('turn', 'trace-1', body)).toBe('rejected');
      expect(t.calls).toHaveLength(1);
    },
  );

  it.each([200, 201, 202])('takes a %i as sent', async (status) => {
    const deferred = traceSendStats.deferred;
    const t = transportWith([status]);
    expect(await t.transport.send('turn', 'trace-1', body)).toBe('sent');
    expect(t.calls).toHaveLength(1);
    expect(traceSendStats.deferred - deferred).toBe(status === 202 ? 1 : 0);
  });

  it('counts a 409 as a conflict, logs only ids, never retries', async () => {
    const logs: string[] = [];
    const conflicts = traceSendStats.conflicts;
    const t = transportWith(
      [409, 201],
      { errorBody: { error: { code: 'conflict' } } },
      logs,
    );
    expect(
      await t.transport.send(
        'turn',
        '0192f5d8-aaaa-7000-8000-000000000001',
        body,
      ),
    ).toBe('conflict');
    expect(t.calls).toHaveLength(1);
    expect(traceSendStats.conflicts - conflicts).toBe(1);
    expect(logs.join('\n')).toContain(
      'turn 0192f5d8… (2 bytes) conflict: HTTP 409 conflict',
    );
    expect(logs.join('\n')).not.toContain('aaaa');
  });

  it('retries a 429 once after its Retry-After, plus jitter, with the same bytes', async () => {
    const t = transportWith([429, 201], { retryAfter: '30' });
    expect(await t.transport.send('turn', 'trace-1', body)).toBe('sent');
    expect(t.calls).toHaveLength(2);
    expect(t.sleeps).toEqual([30_000 + 500]);
    expect(t.calls[1]!.init.body).toEqual(t.calls[0]!.init.body);
  });

  it('drops a 429 whose Retry-After is over the cap, without waiting', async () => {
    const limited = traceSendStats.rateLimited;
    const t = transportWith([429, 201], {
      retryAfter: String(MAX_RETRY_AFTER_MS / 1000 + 1),
    });
    expect(await t.transport.send('turn', 'trace-1', body)).toBe(
      'rate_limited',
    );
    expect(t.calls).toHaveLength(1);
    expect(t.sleeps).toEqual([]);
    expect(traceSendStats.rateLimited - limited).toBe(1);
  });

  it('reads a Retry-After given as an HTTP date', async () => {
    const now = Date.UTC(2026, 10, 24, 12, 0, 0);
    const t = transportWith([429, 201], {
      retryAfter: new Date(now + 5_000).toUTCString(),
      now: () => now,
    });
    expect(await t.transport.send('turn', 'trace-1', body)).toBe('sent');
    expect(t.sleeps).toEqual([5_000 + 500]);
  });

  it('gives up after a second 429', async () => {
    const t = transportWith([429, 429], { retryAfter: '1' });
    expect(await t.transport.send('turn', 'trace-1', body)).toBe(
      'rate_limited',
    );
    expect(t.calls).toHaveLength(2);
  });

  it('drops a marker’s 429 at once: only the turn is worth a wait', async () => {
    const t = transportWith([429, 201], { retryAfter: '1' });
    expect(await t.transport.send('start', 'trace-1', body)).toBe(
      'rate_limited',
    );
    expect(t.calls).toHaveLength(1);
    expect(t.sleeps).toEqual([]);
  });

  it('honours a 503’s Retry-After for a turn, up to the cap', async () => {
    const t = transportWith([503, 201], { retryAfter: '10' });
    expect(await t.transport.send('turn', 'trace-1', body)).toBe('sent');
    expect(t.sleeps).toEqual([10_000 + 500]);
    const long = transportWith([503, 201], { retryAfter: '3600' });
    expect(await long.transport.send('turn', 'trace-1', body)).toBe('sent');
    expect(long.sleeps).toEqual([MAX_RETRY_AFTER_MS + 500]);
  });

  it('sends the contract version on every request', async () => {
    const t = transportWith([201]);
    await t.transport.send('turn', 'trace-1', body);
    expect(new Headers(t.calls[0]!.init.headers).get('x-ixt-contract')).toBe(
      String(CONTRACT_VERSION),
    );
  });

  it('logs a refusal’s error code and first issue path, never its values', async () => {
    const logs: string[] = [];
    const t = transportWith(
      [400],
      {
        errorBody: {
          error: {
            code: 'validation_failed',
            message: 'did:ixo:ixo1secretperson is bad',
            details: {
              issues: [{ path: ['runs', 3, 'start_time'], message: 'x' }],
            },
          },
        },
      },
      logs,
    );
    expect(await t.transport.send('turn', 'trace-1', body)).toBe('rejected');
    const line = logs.join('\n');
    expect(line).toContain(
      'refused: HTTP 400 validation_failed at runs.3.start_time',
    );
    expect(line).not.toContain('secretperson');
  });

  it('pauses every send of the isolate when the service refuses the contract version, logging once', async () => {
    let now = Date.UTC(2026, 10, 24, 12);
    const logs: string[] = [];
    const t = transportWith(
      [400, 400, 201],
      {
        errorBody: {
          error: {
            code: 'validation_failed',
            // As the service answers it (the path joined with dots).
            details: {
              issues: [{ path: 'v', message: 'Invalid input: expected 1' }],
            },
          },
        },
        now: () => now,
      },
      logs,
    );
    const other = transportWith([201], { now: () => now });
    try {
      expect(await t.transport.send('turn', 'a', body)).toBe('rejected');
      expect(await t.transport.send('turn', 'b', body)).toBe('paused');
      expect(await other.transport.send('start', 'c', body)).toBe('paused');
      expect(t.calls).toHaveLength(1);
      expect(other.calls).toHaveLength(0);
      expect(
        logs.filter((l) => l.includes('does not accept contract version')),
      ).toHaveLength(1);
      // After the pause the isolate tries again.
      now += VERSION_PAUSE_MS + 1;
      expect(await other.transport.send('turn', 'd', body)).toBe('sent');
    } finally {
      resetVersionPause();
    }
  });

  it.each([
    [410, { error: { code: 'gone' } }],
    [404, { error: { code: 'not_found' } }],
  ])(
    'drops a %i for a gone project, never retries, and pauses that key only',
    async (status, errorBody) => {
      let now = Date.UTC(2026, 11, 1);
      const logs: string[] = [];
      const gone = traceSendStats.gone;
      const t = transportWith(
        [status, 201],
        { errorBody, now: () => now },
        logs,
      );
      const otherKey = new TracesTransport(
        { ...TEST_CONFIG, apiKey: 'ixt_w_otherkey_secret' },
        quietLogger,
        {},
        {
          fetch: async () => new Response(null, { status: 201 }),
          now: () => now,
        },
      );
      try {
        expect(
          await t.transport.send(
            'turn',
            '0192f5d8-bbbb-7000-8000-000000000001',
            body,
          ),
        ).toBe('gone');
        expect(t.calls).toHaveLength(1);
        expect(traceSendStats.gone - gone).toBe(1);
        expect(await t.transport.send('turn', 'b', body)).toBe('paused');
        expect(t.calls).toHaveLength(1);
        // Another write key of the isolate is not affected.
        expect(await otherKey.send('turn', 'c', body)).toBe('sent');
        expect(logs.join('\n')).toContain('turn 0192f5d8… (2 bytes) dropped');
        expect(logs.join('\n')).not.toContain('bbbb');
        expect(logs.join('\n')).not.toContain('secret');
        now += GONE_PAUSE_MS + 1;
        expect(await t.transport.send('turn', 'd', body)).toBe('sent');
      } finally {
        resetVersionPause();
      }
    },
  );

  it('retries a 503 the service answers for an outage (it never answers 500)', async () => {
    const t = transportWith([503, 201], {
      retryAfter: '2',
      errorBody: { error: { code: 'unavailable' } },
    });
    expect(await t.transport.send('turn', 'trace-1', body)).toBe('sent');
    expect(t.calls).toHaveLength(2);
    expect(t.sleeps).toEqual([2_000 + 500]);
  });

  it('ends an attempt at its timeout even when the fetch ignores the signal', async () => {
    let calls = 0;
    const transport = new TracesTransport(
      TEST_CONFIG,
      quietLogger,
      {},
      {
        fetch: () => {
          calls += 1;
          return calls === 1
            ? new Promise<Response>(() => undefined)
            : Promise.resolve(new Response(null, { status: 201 }));
        },
        sleep: async () => undefined,
        timeoutMs: { turn: 30 },
      },
    );
    expect(await transport.send('turn', 'a', body)).toBe('sent');
    expect(calls).toBe(2);
  });

  it('never lets a hung marker hold its turn back', async () => {
    const transport = new TracesTransport(
      TEST_CONFIG,
      quietLogger,
      {},
      {
        fetch: (url, init) =>
          url.endsWith('/start')
            ? new Promise<Response>((_, reject) =>
                init.signal?.addEventListener('abort', () =>
                  reject(init.signal?.reason),
                ),
              )
            : Promise.resolve(new Response(null, { status: 201 })),
        sleep: async () => undefined,
        timeoutMs: { start: 200 },
      },
    );
    const marker = transport.send('start', 'a', body);
    const started = Date.now();
    expect(await transport.send('turn', 'a', body)).toBe('sent');
    expect(Date.now() - started).toBeLessThan(150);
    expect(await marker).toBe('failed');
  });

  it('sends one owner’s requests of a kind one after the other; a marker never waits behind a turn', async () => {
    const order: string[] = [];
    const inFlight = { turn: 0, start: 0 };
    const maxInFlight = { turn: 0, start: 0 };
    let releaseTurn: () => void = () => undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const transport = new TracesTransport(
      TEST_CONFIG,
      quietLogger,
      {},
      {
        fetch: async (url) => {
          const kind = new URL(url).pathname.endsWith('/start')
            ? 'start'
            : 'turn';
          inFlight[kind] += 1;
          maxInFlight[kind] = Math.max(maxInFlight[kind], inFlight[kind]);
          order.push(kind);
          if (kind === 'turn') await turnGate;
          else await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight[kind] -= 1;
          return new Response(null, { status: 201 });
        },
      },
    );
    const turnA = transport.send('turn', 'a', body);
    const turnB = transport.send('turn', 'b', body);
    // Both markers go while the first turn is still held.
    expect(
      await Promise.all([
        transport.send('start', 'a', body),
        transport.send('start', 'b', body),
      ]),
    ).toEqual(['sent', 'sent']);
    releaseTurn();
    expect(await Promise.all([turnA, turnB])).toEqual(['sent', 'sent']);
    expect(maxInFlight).toEqual({ turn: 1, start: 1 });
    expect(order).toEqual(['turn', 'start', 'start', 'turn']);
  });

  it('skips a request when too many already wait, and never queues for later', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = new TracesTransport(
      TEST_CONFIG,
      quietLogger,
      {},
      {
        fetch: async () => {
          await gate;
          return new Response(null, { status: 201 });
        },
      },
    );
    const sends = Array.from({ length: 10 }, (_, i) =>
      transport.send('turn', `t${i}`, body),
    );
    release();
    const outcomes = await Promise.all(sends);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(2);
    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(8);
  });

  it('uses the service binding when there is one', async () => {
    const seen: string[] = [];
    const transport = new TracesTransport(
      {
        apiKey: 'k',
        baseUrl: 'https://traces.binding',
        binding: {
          fetch: async (input) => {
            seen.push(typeof input === 'string' ? input : input.url);
            return new Response(null, { status: 201 });
          },
        },
      },
      quietLogger,
      {},
    );
    expect(await transport.send('turn', 't', body)).toBe('sent');
    expect(seen).toEqual(['https://traces.binding/v1/ingest/turns']);
  });
});

describe('tracesConfigFromEnv', () => {
  it('is off without a key or a destination', () => {
    expect(tracesConfigFromEnv({}, quietLogger)).toBeUndefined();
    expect(
      tracesConfigFromEnv({ TRACES_API_KEY: 'k' }, quietLogger),
    ).toBeUndefined();
    expect(
      tracesConfigFromEnv(
        { TRACES_ENDPOINT: 'https://t.example' },
        quietLogger,
      ),
    ).toBeUndefined();
  });

  it('takes an https endpoint, and http only for a local host', () => {
    expect(
      tracesConfigFromEnv(
        { TRACES_API_KEY: 'k', TRACES_ENDPOINT: 'https://t.example/' },
        quietLogger,
      ),
    ).toEqual({ apiKey: 'k', baseUrl: 'https://t.example' });
    expect(
      tracesConfigFromEnv(
        { TRACES_API_KEY: 'k', TRACES_ENDPOINT: 'http://127.0.0.1:8787' },
        quietLogger,
      ),
    ).toEqual({ apiKey: 'k', baseUrl: 'http://127.0.0.1:8787' });
    expect(
      tracesConfigFromEnv(
        { TRACES_API_KEY: 'k', TRACES_ENDPOINT: 'http://t.example' },
        quietLogger,
      ),
    ).toBeUndefined();
  });

  it('prefers the service binding', () => {
    const binding = { fetch: async () => new Response(null) };
    const config = tracesConfigFromEnv(
      {
        TRACES_API_KEY: 'k',
        TRACES: binding,
        TRACES_ENDPOINT: 'https://t.example',
      },
      quietLogger,
    );
    expect(config?.binding).toBe(binding);
  });
});
