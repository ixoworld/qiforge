import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchOpenRouterContextLengths,
  fetchOpenRouterPrices,
  OPENROUTER_FAILURE_TTL_MS,
  OPENROUTER_INFLIGHT_MARGIN_MS,
  OPENROUTER_MODELS_URL,
  OPENROUTER_PRICE_CACHE_TTL_MS,
  resetOpenRouterPriceCache,
} from './openrouter-pricing';

const payload = {
  data: [
    {
      id: 'openai/gpt-5.6-luna',
      pricing: { prompt: '0.000001', completion: '0.000006' },
    },
    { id: 'no-pricing/model' },
    { id: 'bad/model', pricing: { prompt: 'abc', completion: '1' } },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchOpenRouterPrices', () => {
  afterEach(() => resetOpenRouterPriceCache());

  it('parses $/token strings into $/million and skips unusable rows', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(payload));
    const prices = await fetchOpenRouterPrices({
      fetch: fetchImpl,
      apiKey: 'k',
    });
    expect(fetchImpl).toHaveBeenCalledWith(OPENROUTER_MODELS_URL, {
      headers: { Authorization: 'Bearer k' },
      signal: expect.any(AbortSignal),
    });
    expect(prices.get('openai/gpt-5.6-luna')).toEqual({
      inputPerMillion: 1,
      outputPerMillion: 6,
    });
    expect(prices.has('no-pricing/model')).toBe(false);
    expect(prices.has('bad/model')).toBe(false);
  });

  it('caches for an hour, then refetches', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => jsonResponse(payload));
    const opts = { fetch: fetchImpl, now: () => now };
    await fetchOpenRouterPrices(opts);
    await fetchOpenRouterPrices(opts);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += OPENROUTER_PRICE_CACHE_TTL_MS + 1;
    await fetchOpenRouterPrices(opts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never throws: HTTP errors, bad payloads and empty pricing fall back to the last good map', async () => {
    const warn = vi.fn();
    const empty = await fetchOpenRouterPrices({
      fetch: async () => jsonResponse({ nope: true }, 500),
      logger: { warn },
    });
    expect(empty.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);

    let now = 5_000_000;
    const good = await fetchOpenRouterPrices({
      fetch: async () => jsonResponse(payload),
      now: () => now,
    });
    expect(good.size).toBe(1);
    now += OPENROUTER_PRICE_CACHE_TTL_MS + 1;
    const stale = await fetchOpenRouterPrices({
      fetch: async () => jsonResponse({ data: [] }),
      now: () => now,
      logger: { warn },
    });
    expect(stale.get('openai/gpt-5.6-luna')).toEqual({
      inputPerMillion: 1,
      outputPerMillion: 6,
    });
    // The expired listing is served at once; the refresh that fails runs
    // behind it.
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
  });

  it('a refresh that settles after a reset writes nothing', async () => {
    let now = 1_000_000;
    await fetchOpenRouterPrices({
      fetch: async () => jsonResponse(payload),
      now: () => now,
    });
    now += OPENROUTER_PRICE_CACHE_TTL_MS + 1;
    let release: ((response: Response) => void) | undefined;
    let refreshed: Promise<unknown> | undefined;
    const stale = await fetchOpenRouterPrices({
      fetch: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
      now: () => now,
      waitUntil: (work) => {
        refreshed = work;
      },
    });
    expect(stale.size).toBe(1);
    expect(release).toBeDefined();
    expect(refreshed).toBeDefined();

    resetOpenRouterPriceCache();
    release?.(jsonResponse(payload));
    await refreshed;

    // The late listing did not land: the next caller fetches afresh, and a
    // failure there leaves it with no listing at all.
    const warn = vi.fn();
    const after = await fetchOpenRouterPrices({
      fetch: async () => jsonResponse({ nope: true }, 500),
      now: () => now,
      logger: { warn },
    });
    expect(after.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gives up on a hanging fetch at the timeout, and remembers the failure', async () => {
    let now = 1_000_000;
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>(() => {
          signal = init?.signal ?? undefined;
        }),
    );
    const warn = vi.fn();
    const opts = {
      fetch: fetchImpl,
      now: () => now,
      timeoutMs: 50,
      logger: { warn },
    };
    const started = Date.now();
    const prices = await fetchOpenRouterPrices(opts);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(prices.size).toBe(0);
    expect(signal?.aborted).toBe(true);
    expect(String(warn.mock.calls[0]?.[0])).toContain('timed out after 50 ms');
    // Within the failure window nobody waits on the fetch again.
    now += OPENROUTER_FAILURE_TTL_MS - 1;
    expect((await fetchOpenRouterContextLengths(opts)).size).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // After it, the next caller tries again.
    now += 2;
    await fetchOpenRouterPrices(opts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one fetch between concurrent callers', async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const pending = [
      fetchOpenRouterPrices({ fetch: fetchImpl }),
      fetchOpenRouterContextLengths({ fetch: fetchImpl }),
      fetchOpenRouterPrices({ fetch: fetchImpl }),
    ];
    release(jsonResponse(payload));
    const [first, , third] = await Promise.all(pending);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toBe(third);
    expect(first?.size).toBe(1);
  });

  it('serves an expired listing at once and refreshes it in the background', async () => {
    let now = 7_000_000;
    const first = vi.fn(async () => jsonResponse(payload));
    await fetchOpenRouterPrices({ fetch: first, now: () => now });
    now += OPENROUTER_PRICE_CACHE_TTL_MS + 1;

    let release: (response: Response) => void = () => undefined;
    const slow = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const background: Array<Promise<unknown>> = [];
    const stale = await fetchOpenRouterPrices({
      fetch: slow,
      now: () => now,
      waitUntil: (work) => background.push(work),
    });
    // Answered from the expired listing while the fetch is still open.
    expect(stale.get('openai/gpt-5.6-luna')?.inputPerMillion).toBe(1);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(background).toHaveLength(1);

    release(
      jsonResponse({
        data: [
          {
            id: 'openai/gpt-5.6-luna',
            pricing: { prompt: '0.0000002', completion: '0.0000012' },
          },
        ],
      }),
    );
    await background[0];
    const fresh = await fetchOpenRouterPrices({ fetch: slow, now: () => now });
    expect(fresh.get('openai/gpt-5.6-luna')?.inputPerMillion).toBeCloseTo(0.2);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('starts a new fetch once a shared one has outlived its time limit without settling', async () => {
    // Timers that never fire: what a fetch looks like after the runtime
    // dropped the request that started it, timer and all.
    vi.useFakeTimers();
    try {
      let now = 9_000_000;
      const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
      const opts = { fetch: fetchImpl, now: () => now, timeoutMs: 50 };
      const first = fetchOpenRouterPrices(opts);
      let firstSettled = false;
      void first.then(() => {
        firstSettled = true;
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // Within its limit the fetch is shared.
      void fetchOpenRouterPrices(opts);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // Past it, it is given up and the next caller fetches again.
      now += 50 + OPENROUTER_INFLIGHT_MARGIN_MS + 1;
      void fetchOpenRouterPrices(opts);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      // A waiting caller is released by its own timer.
      await vi.advanceTimersByTimeAsync(50 + OPENROUTER_INFLIGHT_MARGIN_MS);
      expect(firstSettled).toBe(true);
      expect((await first).size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
