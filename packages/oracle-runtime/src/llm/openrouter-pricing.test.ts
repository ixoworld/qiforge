import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchOpenRouterPrices,
  resetOpenRouterPriceCache,
} from './openrouter-pricing.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchOpenRouterPrices', () => {
  beforeEach(() => resetOpenRouterPriceCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetOpenRouterPriceCache();
  });

  it('parses $/token strings into $/million tokens', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: 'openai/gpt-5.4-nano',
            pricing: { prompt: '0.0000002', completion: '0.00000125' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const prices = await fetchOpenRouterPrices();

    expect(fetchMock).toHaveBeenCalledOnce();
    const nano = prices.get('openai/gpt-5.4-nano');
    expect(nano?.inputPerMillion).toBeCloseTo(0.2, 6);
    expect(nano?.outputPerMillion).toBeCloseTo(1.25, 6);
  });

  it('skips models whose price is missing or non-numeric', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: [
            {
              id: 'good',
              pricing: { prompt: '0.000001', completion: '0.000002' },
            },
            { id: 'bad', pricing: { prompt: 'n/a', completion: '0.000002' } },
            { id: 'none' },
          ],
        }),
      ),
    );

    const prices = await fetchOpenRouterPrices();

    expect(prices.has('good')).toBe(true);
    expect(prices.has('bad')).toBe(false);
    expect(prices.has('none')).toBe(false);
  });

  it('caches across calls so only one network request is made', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'a', pricing: { prompt: '0.000001', completion: '0.000002' } },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchOpenRouterPrices();
    await fetchOpenRouterPrices();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns an empty map (never throws) on an HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'bad gateway' }, 502)),
    );

    const prices = await fetchOpenRouterPrices();

    expect(prices.size).toBe(0);
  });

  it('returns an empty map when the request rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );

    const prices = await fetchOpenRouterPrices();

    expect(prices.size).toBe(0);
  });
});
