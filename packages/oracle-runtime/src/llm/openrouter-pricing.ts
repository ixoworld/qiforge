import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { ModelPrice } from './model-catalog.js';

/**
 * Fetches live list prices from OpenRouter's public models API and caches them
 * process-wide for an hour. The catalog carries baseline prices so the
 * `GET /models` endpoint always works; this module upgrades those to live
 * numbers when the network call succeeds, and silently keeps serving the last
 * good (or baseline) prices when it doesn't. Prices returned here are RAW
 * (provider list price); the markup is applied by the caller.
 */

const logger = new Logger('OpenRouterPricing');

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * OpenRouter returns `pricing.prompt` / `pricing.completion` as strings in USD
 * **per token** (e.g. `"0.0000002"`). We only need those two fields; anything
 * else in the payload is ignored so a schema change upstream can't break us.
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
    }),
  ),
});

interface PriceCache {
  fetchedAt: number;
  prices: Map<string, ModelPrice>;
}

let cache: PriceCache | null = null;

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

/**
 * Live OpenRouter prices keyed by model id ($/million tokens). Cached for an
 * hour. Never throws: on any failure it returns the last cached map, or an
 * empty map (so the caller falls back to the catalog's baseline prices).
 */
export async function fetchOpenRouterPrices(): Promise<
  ReadonlyMap<string, ModelPrice>
> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.prices;
  }

  const apiKey = process.env.OPEN_ROUTER_API_KEY;
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
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
    cache = { fetchedAt: Date.now(), prices };
    return prices;
  } catch (error) {
    logger.warn(
      `Live OpenRouter pricing unavailable — falling back to baseline prices: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return cache?.prices ?? new Map<string, ModelPrice>();
  }
}

/** Test seam: clear the in-memory price cache between cases. */
export function resetOpenRouterPriceCache(): void {
  cache = null;
}
