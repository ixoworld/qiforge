import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchOpenRouterPrices,
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
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
