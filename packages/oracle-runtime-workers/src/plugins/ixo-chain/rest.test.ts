import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  RETRY_DELAY_MAX_MS,
  RETRY_DELAY_MIN_MS,
  TOOL_BUDGET_MS,
  resetUpstreamHealth,
  retryAfterMs,
  retryDelayMs,
  type ChainCall,
} from './http';
import { restJson } from './rest';

const schema = z.object({ balances: z.array(z.object({ denom: z.string() })) });

function callWith(fetcher: typeof fetch): ChainCall {
  return {
    network: 'mainnet',
    restUrl: 'https://rest.test/rest/',
    blocksyncUrl: 'https://blocksync.test/graphql',
    deadline: Date.now() + TOOL_BUDGET_MS,
    signal: new AbortController().signal,
    fetch: fetcher,
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetUpstreamHealth();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('restJson', () => {
  it('GETs the path under the REST base and parses the body', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ balances: [{ denom: 'uixo' }] })),
    );
    const result = await restJson(
      callWith(fetcher),
      '/cosmos/bank/v1beta1/balances/ixo1abc',
      schema,
      { label: 'balances' },
    );
    expect(result).toEqual({
      ok: true,
      value: { balances: [{ denom: 'uixo' }] },
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://rest.test/rest/cosmos/bank/v1beta1/balances/ixo1abc',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
  });

  it('retries a 502 once after 2 s', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ balances: [] })));
    const pending = restJson(callWith(fetcher), '/x', schema, {
      label: 'balances',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({
      ok: true,
      value: { balances: [] },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      '[ixo-chain] balances attempt 1 failed: HTTP 502',
    );
  });

  it('answers a 404 as unavailable (a wrong route), never as not_found, without retrying', async () => {
    const fetcher = vi.fn(
      async () => new Response('{"code":5}', { status: 404 }),
    );
    expect(
      await restJson(callWith(fetcher), '/x', schema, { label: 'x' }),
    ).toEqual({
      ok: false,
      failure: {
        reason: 'unavailable',
        detail: 'The chain node is unavailable right now (HTTP 404).',
        retryable: false,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[ixo-chain] x attempt 1 failed: HTTP 404',
    );
  });

  it('answers a 404 as a quiet not_found when the read may find nothing', async () => {
    const fetcher = vi.fn(
      async () => new Response('{"code":5}', { status: 404 }),
    );
    expect(
      await restJson(callWith(fetcher), '/x', schema, {
        label: 'x',
        notFoundOn404: true,
      }),
    ).toEqual({
      ok: false,
      failure: {
        reason: 'not_found',
        detail: 'Nothing was found for that request.',
        retryable: false,
      },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not retry a 501 and says asking again cannot help', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 501 }));
    expect(
      await restJson(callWith(fetcher), '/x', schema, { label: 'x' }),
    ).toEqual({
      ok: false,
      failure: {
        reason: 'unavailable',
        detail: 'The chain node is unavailable right now (HTTP 501).',
        retryable: false,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('waits the default 1–3 s when Retry-After is zero or in the past', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    for (const header of ['0', new Date(Date.now() - 60_000).toUTCString()]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response('', { status: 502, headers: { 'retry-after': header } }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ balances: [] })));
      const pending = restJson(callWith(fetcher), '/x', schema, {
        label: 'x',
      });
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MIN_MS - 1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ ok: true });
    }
  });

  it('never retries a body of the wrong shape', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ balances: 3 })),
    );
    expect(
      await restJson(callWith(fetcher), '/x', schema, { label: 'x' }),
    ).toEqual({
      ok: false,
      failure: {
        reason: 'unavailable',
        detail:
          'The chain node is unavailable right now (it answered in an unexpected shape).',
        retryable: false,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('retryAfterMs', () => {
  it('reads delta seconds and HTTP dates; nothing usable is undefined', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T10:00:00Z'));
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs('3')).toBe(3_000);
    expect(retryAfterMs('Thu, 29 Oct 2026 10:00:04 GMT')).toBe(4_000);
    for (const unusable of ['soon', '0', '-5', 'Thu, 29 Oct 2026 09:59:59 GMT'])
      expect(retryAfterMs(unusable)).toBeUndefined();
  });
});

describe('retryDelayMs', () => {
  it('is uniform in 1–3 s', () => {
    const random = vi.spyOn(Math, 'random');
    for (const [value, ms] of [
      [0, 1_000],
      [0.5, 2_000],
      [0.9999999, 3_000],
    ] as const) {
      random.mockReturnValue(value);
      expect(retryDelayMs()).toBe(ms);
    }
    random.mockRestore();
    for (let i = 0; i < 100; i++) {
      const ms = retryDelayMs();
      expect(ms).toBeGreaterThanOrEqual(RETRY_DELAY_MIN_MS);
      expect(ms).toBeLessThanOrEqual(RETRY_DELAY_MAX_MS);
    }
  });
});
