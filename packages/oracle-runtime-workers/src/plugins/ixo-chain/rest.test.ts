import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  BUDGET_SPENT,
  ERROR_BODY_MAX_BYTES,
  READ_GRACE_MS,
  RETRY_DELAY_MAX_MS,
  RETRY_DELAY_MIN_MS,
  TOOL_BUDGET_MS,
  USER_READ_PERMITS,
  resetUpstreamHealth,
  retryAfterMs,
  retryDelayMs,
  usersReading,
  type ChainCall,
} from './http';
import { REST_ATTEMPT_TIMEOUT_MS, restJson } from './rest';

const schema = z.object({ balances: z.array(z.object({ denom: z.string() })) });

function callWith(
  fetcher: typeof fetch,
  overrides: Partial<ChainCall> = {},
): ChainCall {
  return {
    network: 'mainnet',
    restUrl: 'https://rest.test/rest/',
    blocksyncUrl: 'https://blocksync.test/graphql',
    user: 'did:ixo:ixo1test',
    deadline: Date.now() + TOOL_BUDGET_MS,
    signal: new AbortController().signal,
    fetch: fetcher,
    ...overrides,
  };
}

/** A response that never comes: the request fails only when its signal aborts. */
const hang = (_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });

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

  it('answers a status the read names in noneOn as absent: ok, not retried, not logged', async () => {
    for (const [status, body] of [
      [400, '{"code":3,"message":"voter not found","details":[]}'],
      [400, '{"code":5}'],
      [404, '<html>not found</html>'],
    ] as const) {
      const fetcher = vi.fn(async () => new Response(body, { status }));
      expect(
        await restJson(callWith(fetcher), '/x', schema, {
          label: 'x',
          noneOn: [400, 404],
          notFoundOn404: true,
        }),
      ).toEqual({ ok: true, absent: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    expect(warn).not.toHaveBeenCalled();
    // A status it does not name is still a failure; a 200 is still parsed.
    const fault = vi.fn(async () => new Response('', { status: 500 }));
    expect(
      await restJson(callWith(fault), '/x', schema, {
        label: 'x',
        noneOn: [400, 404],
      }),
    ).toEqual({
      ok: false,
      failure: {
        reason: 'unavailable',
        detail: 'The chain node is unavailable right now (HTTP 500).',
        retryable: true,
      },
    });
    expect(warn).toHaveBeenCalledWith(
      '[ixo-chain] x attempt 1 failed: HTTP 500',
    );
    const found = vi.fn(
      async () => new Response(JSON.stringify({ balances: [] })),
    );
    expect(
      await restJson(callWith(found), '/x', schema, {
        label: 'x',
        noneOn: [404],
      }),
    ).toEqual({ ok: true, value: { balances: [] } });
  });

  it('counts a 400 as none only with gRPC code 3 or 5 in at most 8 KiB of its body', async () => {
    const huge = JSON.stringify({
      code: 3,
      message: 'x'.repeat(ERROR_BODY_MAX_BYTES),
    });
    for (const body of ['{"code":9}', 'Bad Request', '', huge]) {
      const fetcher = vi.fn(async () => new Response(body, { status: 400 }));
      expect(
        await restJson(callWith(fetcher), '/x', schema, {
          label: 'x',
          noneOn: [400, 404],
        }),
      ).toEqual({
        ok: false,
        failure: {
          reason: 'unavailable',
          detail: 'The chain node is unavailable right now (HTTP 400).',
          retryable: false,
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
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

describe('the time budget', () => {
  it('starts no attempt, the first included, with less than 1 s left, and says the budget ran out', async () => {
    const fetcher = vi.fn(async () => new Response('{}'));
    expect(
      await restJson(
        callWith(fetcher, { deadline: Date.now() + 999 }),
        '/x',
        schema,
        { label: 'x' },
      ),
    ).toEqual({ ok: false, failure: BUDGET_SPENT });
    expect(fetcher).not.toHaveBeenCalled();
    expect(BUDGET_SPENT.detail).toMatch(/time budget ran out/);
  });

  it('says the budget ran out when the deadline, not the attempt bound, cut the read', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(hang);
    const pending = restJson(
      callWith(fetcher, { deadline: Date.now() + 3_000 }),
      '/x',
      schema,
      { label: 'x' },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual({
      ok: false,
      failure: BUDGET_SPENT,
    });
    const own = vi.fn(hang);
    const bounded = restJson(callWith(own), '/x', schema, { label: 'x' });
    await vi.advanceTimersByTimeAsync(REST_ATTEMPT_TIMEOUT_MS);
    await expect(bounded).resolves.toMatchObject({
      ok: false,
      failure: {
        reason: 'timeout',
        detail: 'The chain node did not answer in time; try again shortly.',
      },
    });
  });
});

describe("the user's read permits", () => {
  it("takes back a permit its read never returned, once past that read's deadline and the grace", async () => {
    vi.useFakeTimers();
    // Reads whose actor died: nothing after the fetch ever runs.
    const dead = vi.fn(() => new Promise<Response>(() => undefined));
    const budget = 2_000;
    for (let n = 0; n < USER_READ_PERMITS; n += 1)
      void restJson(
        callWith(dead, { deadline: Date.now() + budget }),
        `/dead/${n}`,
        schema,
        { label: 'x' },
      );
    await vi.advanceTimersByTimeAsync(0);
    expect(dead).toHaveBeenCalledTimes(USER_READ_PERMITS);
    const live = vi.fn(
      async () => new Response(JSON.stringify({ balances: [] })),
    );
    // Until then none is free: the read ends without one.
    const queued = restJson(
      callWith(live, { deadline: Date.now() + budget }),
      '/queued',
      schema,
      { label: 'x' },
    );
    await vi.advanceTimersByTimeAsync(budget - 1_000);
    expect(await queued).toEqual({ ok: false, failure: BUDGET_SPENT });
    expect(live).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000 + READ_GRACE_MS);
    expect(
      await restJson(callWith(live), '/live', schema, { label: 'x' }),
    ).toEqual({ ok: true, value: { balances: [] } });
    expect(usersReading()).toBe(0);
  });

  it(`lets ${USER_READ_PERMITS} reads of a user run at once and queues the rest, oldest first`, async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(hang);
    const reads = Array.from({ length: USER_READ_PERMITS + 2 }, (_, n) =>
      restJson(callWith(fetcher), `/x/${n}`, schema, { label: 'x' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(USER_READ_PERMITS);
    expect(usersReading()).toBe(1);
    await vi.advanceTimersByTimeAsync(REST_ATTEMPT_TIMEOUT_MS);
    expect(fetcher.mock.calls.map(([url]) => String(url).slice(-2))).toEqual([
      ...Array.from({ length: USER_READ_PERMITS }, (_, n) => `/${n}`),
      `/${USER_READ_PERMITS}`,
      `/${USER_READ_PERMITS + 1}`,
    ]);
    await vi.advanceTimersByTimeAsync(REST_ATTEMPT_TIMEOUT_MS);
    await Promise.all(reads);
    expect(usersReading()).toBe(0);
  });

  it("starts a queued attempt's timer only once it holds a permit", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(hang);
    const reads = Array.from({ length: USER_READ_PERMITS + 1 }, (_, n) =>
      restJson(callWith(fetcher), `/x/${n}`, schema, { label: 'x' }),
    );
    await vi.advanceTimersByTimeAsync(REST_ATTEMPT_TIMEOUT_MS);
    // The sixth read started at 8 s with its whole 8 s bound.
    const late = fetcher.mock.calls[USER_READ_PERMITS]?.[1]?.signal;
    expect(late?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(REST_ATTEMPT_TIMEOUT_MS - 1);
    expect(late?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(late?.aborted).toBe(true);
    await Promise.all(reads);
    expect(usersReading()).toBe(0);
  });

  it('holds no permit while a read waits to retry', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/busy/')
        ? new Response('', { status: 502 })
        : new Response(JSON.stringify({ balances: [] })),
    );
    const retrying = Array.from({ length: USER_READ_PERMITS }, (_, n) =>
      restJson(callWith(fetcher), `/busy/${n}`, schema, { label: 'x' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    // Every permit is free during the 2 s wait: another read of the user
    // runs at once (on another upstream: the 502s marked this one).
    await expect(
      restJson(
        callWith(fetcher, { restUrl: 'https://other.test/rest/' }),
        '/free',
        schema,
        { label: 'x' },
      ),
    ).resolves.toEqual({ ok: true, value: { balances: [] } });
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all(retrying);
    expect(fetcher).toHaveBeenCalledTimes(2 * USER_READ_PERMITS + 1);
    expect(usersReading()).toBe(0);
  });

  it('gives up waiting for a permit when the budget would leave less than 1 s', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(hang);
    const holders = Array.from({ length: USER_READ_PERMITS }, (_, n) =>
      restJson(callWith(fetcher), `/x/${n}`, schema, { label: 'x' }),
    );
    const waiting = restJson(
      callWith(fetcher, { deadline: Date.now() + 5_000 }),
      '/late',
      schema,
      { label: 'x' },
    );
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(waiting).resolves.toEqual({
      ok: false,
      failure: BUDGET_SPENT,
    });
    expect(fetcher).toHaveBeenCalledTimes(USER_READ_PERMITS);
    await vi.advanceTimersByTimeAsync(REST_ATTEMPT_TIMEOUT_MS);
    await Promise.all(holders);
    expect(usersReading()).toBe(0);
  });

  it("throws the turn's abort to a read waiting for a permit, which then never starts", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(hang);
    const holders = Array.from({ length: USER_READ_PERMITS }, (_, n) =>
      restJson(callWith(fetcher), `/x/${n}`, schema, { label: 'x' }),
    );
    const turn = new AbortController();
    const waiting = restJson(
      callWith(fetcher, { signal: turn.signal }),
      '/late',
      schema,
      { label: 'x' },
    );
    await vi.advanceTimersByTimeAsync(0);
    const reason = new Error('turn aborted');
    turn.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(REST_ATTEMPT_TIMEOUT_MS);
    await Promise.all(holders);
    expect(fetcher).toHaveBeenCalledTimes(USER_READ_PERMITS);
    expect(usersReading()).toBe(0);
  });

  it("does not hold back another user's reads", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes('/mine/')
          ? hang(input, init)
          : new Response(JSON.stringify({ balances: [] })),
    );
    const mine = Array.from({ length: USER_READ_PERMITS + 3 }, (_, n) =>
      restJson(callWith(fetcher), `/mine/${n}`, schema, { label: 'x' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      restJson(
        callWith(fetcher, { user: 'did:ixo:ixo1other' }),
        '/theirs',
        schema,
        {
          label: 'x',
        },
      ),
    ).resolves.toEqual({ ok: true, value: { balances: [] } });
    expect(usersReading()).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * REST_ATTEMPT_TIMEOUT_MS);
    await Promise.all(mine);
    expect(usersReading()).toBe(0);
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
