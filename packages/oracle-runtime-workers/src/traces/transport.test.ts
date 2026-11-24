import { describe, expect, it } from 'vitest';
import { tracesConfigFromEnv } from './config';
import { TEST_CONFIG, quietLogger } from './test-helpers';
import { TracesTransport, type TransportDeps } from './transport';

const body = () =>
  Promise.resolve({ bytes: new TextEncoder().encode('{}'), gzip: true });

function transportWith(
  answers: Array<number | 'timeout' | 'network'>,
  extra: Partial<TransportDeps> = {},
) {
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
    return new Response(null, {
      status: answer,
      headers: answer === 429 ? { 'retry-after': '30' } : {},
    });
  };
  const transport = new TracesTransport(
    TEST_CONFIG,
    quietLogger,
    {},
    {
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      timeoutMs: { turn: 20, start: 20 },
      ...extra,
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

  it.each([400, 401, 403, 409, 413, 422])(
    'never retries a %i',
    async (status) => {
      const t = transportWith([status, 201]);
      expect(await t.transport.send('turn', 'trace-1', body)).toBe('rejected');
      expect(t.calls).toHaveLength(1);
    },
  );

  it('drops a 429 at once, whatever Retry-After says', async () => {
    const t = transportWith([429, 201]);
    expect(await t.transport.send('turn', 'trace-1', body)).toBe(
      'rate_limited',
    );
    expect(t.calls).toHaveLength(1);
    expect(t.sleeps).toEqual([]);
  });

  it('sends one owner’s requests one after the other, in order', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const transport = new TracesTransport(
      TEST_CONFIG,
      quietLogger,
      {},
      {
        fetch: async (url) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          order.push(new URL(url).pathname);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return new Response(null, { status: 201 });
        },
      },
    );
    await Promise.all([
      transport.send('start', 'a', body),
      transport.send('turn', 'a', body),
      transport.send('start', 'b', body),
    ]);
    expect(maxInFlight).toBe(1);
    expect(order).toEqual([
      '/v1/ingest/turns/start',
      '/v1/ingest/turns',
      '/v1/ingest/turns/start',
    ]);
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
