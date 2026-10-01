/**
 * Live OpenRouter list prices for the model catalog — the Workers port of the
 * Node runtime's `llm/openrouter-pricing.ts`.
 *
 * Fetched from OpenRouter's public models API and cached per isolate for an
 * hour. The catalog carries baseline prices so `GET /models` always answers;
 * this module upgrades them to live numbers when the call succeeds and
 * silently keeps serving the last good map (or nothing, so the baseline
 * applies) when it doesn't. Prices returned here are RAW provider list
 * prices; the markup is applied by `buildModelListing`.
 *
 * Per isolate rather than per process: a cold isolate pays one ~100 ms fetch
 * on its first `/models`, then serves from memory until evicted.
 */
import { z } from 'zod';
import type { ModelPrice } from './llm';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_PRICE_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * OpenRouter returns `pricing.prompt` / `pricing.completion` as strings in USD
 * **per token** (e.g. `"0.0000002"`). Only those two fields are read, so a
 * schema change upstream can't break the listing.
 */
const openRouterModelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      pricing: z
        .object({
          prompt: z.string().optional(),
          completion: z.string().optional(),
        })
        .optional(),
      // The model's context window in tokens; `top_provider.context_length`
      // is the window of the provider OpenRouter routes to by default and
      // can be smaller than the model's nominal one — the smaller wins.
      context_length: z.number().nullable().optional(),
      top_provider: z
        .object({ context_length: z.number().nullable().optional() })
        .nullable()
        .optional(),
    }),
  ),
});

interface PriceCache {
  fetchedAt: number;
  prices: Map<string, ModelPrice>;
  contextLengths: Map<string, number>;
}

let cache: PriceCache | null = null;

function parseContextLengths(
  data: z.infer<typeof openRouterModelsSchema>['data'],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const model of data) {
    const candidates = [
      model.context_length,
      model.top_provider?.context_length,
    ].filter((n): n is number => typeof n === 'number' && n > 0);
    if (candidates.length === 0) continue;
    out.set(model.id, Math.floor(Math.min(...candidates)));
  }
  return out;
}

/** Convert an OpenRouter `$/token` string to `$/million tokens`, or `null`. */
function perMillion(pricePerToken: string | undefined): number | null {
  if (pricePerToken == null) return null;
  const perToken = Number(pricePerToken);
  if (!Number.isFinite(perToken)) return null;
  return perToken * 1_000_000;
}

function parsePrices(
  data: z.infer<typeof openRouterModelsSchema>['data'],
): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>();
  for (const model of data) {
    const inputPerMillion = perMillion(model.pricing?.prompt);
    const outputPerMillion = perMillion(model.pricing?.completion);
    if (inputPerMillion == null || outputPerMillion == null) continue;
    out.set(model.id, { inputPerMillion, outputPerMillion });
  }
  return out;
}

export interface FetchOpenRouterPricesOptions {
  /** Sent as a bearer when present (higher rate limits); the endpoint is public. */
  apiKey?: string;
  /** Test seam / custom transport. Defaults to the global `fetch`. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  logger?: { warn: (message: string) => void };
}

/**
 * Live OpenRouter prices keyed by model id ($/million tokens). Cached for an
 * hour. Never throws: on any failure it returns the last cached map, or an
 * empty map (so the caller falls back to the catalog's baseline prices).
 */
export async function fetchOpenRouterPrices(
  opts: FetchOpenRouterPricesOptions = {},
): Promise<ReadonlyMap<string, ModelPrice>> {
  const now = opts.now ?? Date.now;
  if (cache && now() - cache.fetchedAt < OPENROUTER_PRICE_CACHE_TTL_MS) {
    return cache.prices;
  }
  // The global `fetch` must be called as a function of the global scope on
  // workerd ("Illegal invocation" when handed around as a bare reference).
  const fetchImpl =
    opts.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const logger = opts.logger ?? console;
  try {
    const response = await fetchImpl(OPENROUTER_MODELS_URL, {
      headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {},
    });
    if (!response.ok) {
      throw new Error(`OpenRouter /models returned HTTP ${response.status}`);
    }
    const parsed = openRouterModelsSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(`Unexpected /models payload: ${parsed.error.message}`);
    }
    const prices = parsePrices(parsed.data.data);
    if (prices.size === 0) {
      throw new Error('OpenRouter /models returned no usable pricing');
    }
    cache = {
      fetchedAt: now(),
      prices,
      contextLengths: parseContextLengths(parsed.data.data),
    };
    return prices;
  } catch (error) {
    logger.warn(
      `[models] live OpenRouter pricing unavailable — serving baseline prices: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return cache?.prices ?? new Map<string, ModelPrice>();
  }
}

/**
 * Context windows (tokens) by OpenRouter model id, from the same cached
 * `/models` fetch as the prices (one request serves both). Empty when the
 * listing is unavailable — the resolver then falls back (see
 * `context-window.ts`).
 */
export async function fetchOpenRouterContextLengths(
  opts: FetchOpenRouterPricesOptions = {},
): Promise<ReadonlyMap<string, number>> {
  await fetchOpenRouterPrices(opts);
  return cache?.contextLengths ?? new Map<string, number>();
}

/** Test seam: clear the in-memory price cache between cases. */
export function resetOpenRouterPriceCache(): void {
  cache = null;
}
