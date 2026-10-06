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
 *
 * Every turn reads it (the context-window resolver), so it never holds a
 * turn up for long: the fetch is cut off after `OPENROUTER_FETCH_TIMEOUT_MS`,
 * concurrent callers share one fetch, an expired listing is served while a
 * fresh one is fetched in the background, and a failure is remembered for
 * `OPENROUTER_FAILURE_TTL_MS` before the next attempt.
 */
import { z } from 'zod';
import type { ModelPrice } from './llm';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_PRICE_CACHE_TTL_MS = 60 * 60 * 1000;
/** How long a `/models` fetch (response and body) may take before it counts as failed. */
export const OPENROUTER_FETCH_TIMEOUT_MS = 3_000;
/** How long a failed fetch is remembered before the next one is attempted. */
export const OPENROUTER_FAILURE_TTL_MS = 60_000;
/**
 * Past its timeout plus this, a shared fetch that never settled (the runtime
 * dropped the request that started it, its timer with it) is abandoned and
 * the next caller starts a new one.
 */
export const OPENROUTER_INFLIGHT_MARGIN_MS = 1_000;

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
interface InflightFetch {
  done: Promise<void>;
  /** When it started, by the caller's clock. */
  startedAt: number;
  /** How long it may stay shared (its timeout plus the margin). */
  limitMs: number;
}

/** The fetch in flight, shared by every caller that needs it. */
let inflight: InflightFetch | null = null;
/** When the last fetch failed (by the caller's clock); `null` after a success. */
let failedAt: number | null = null;

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
  /** Fetch timeout (default `OPENROUTER_FETCH_TIMEOUT_MS`). */
  timeoutMs?: number;
  /**
   * Keeps a background refresh alive after the caller has its answer
   * (`ctx.waitUntil` on Workers). Without it the refresh is merely detached.
   */
  waitUntil?: (work: Promise<unknown>) => void;
}

/** `work`, or a rejection once `ms` have passed (the timer never outlives it). */
function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`OpenRouter /models timed out after ${ms} ms`);
      error.name = 'TimeoutError';
      controller.abort(error);
      reject(error);
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** One fetch of the listing into `cache`; a failure is logged and remembered, never thrown. */
async function refresh(opts: FetchOpenRouterPricesOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  // The global `fetch` must be called as a function of the global scope on
  // workerd ("Illegal invocation" when handed around as a bare reference).
  const fetchImpl =
    opts.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const logger = opts.logger ?? console;
  const controller = new AbortController();
  try {
    const parsed = await withTimeout(
      (async () => {
        const response = await fetchImpl(OPENROUTER_MODELS_URL, {
          headers: opts.apiKey
            ? { Authorization: `Bearer ${opts.apiKey}` }
            : {},
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            `OpenRouter /models returned HTTP ${response.status}`,
          );
        }
        return openRouterModelsSchema.safeParse(await response.json());
      })(),
      opts.timeoutMs ?? OPENROUTER_FETCH_TIMEOUT_MS,
      controller,
    );
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
    failedAt = null;
  } catch (error) {
    failedAt = now();
    logger.warn(
      `[models] live OpenRouter pricing unavailable — serving ${cache ? 'the last listing' : 'baseline prices'}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Live OpenRouter prices keyed by model id ($/million tokens). Cached for an
 * hour. Never throws: on any failure it returns the last cached map, or an
 * empty map (so the caller falls back to the catalog's baseline prices).
 * Waits at most the fetch timeout, and only when nothing is cached.
 */
export async function fetchOpenRouterPrices(
  opts: FetchOpenRouterPricesOptions = {},
): Promise<ReadonlyMap<string, ModelPrice>> {
  const now = opts.now ?? Date.now;
  if (cache && now() - cache.fetchedAt < OPENROUTER_PRICE_CACHE_TTL_MS) {
    return cache.prices;
  }
  // A clock that went backwards does not keep a failure remembered.
  const sinceFailure = failedAt === null ? null : now() - failedAt;
  const failedRecently =
    sinceFailure !== null &&
    sinceFailure >= 0 &&
    sinceFailure < OPENROUTER_FAILURE_TTL_MS;
  if (!failedRecently) {
    const limitMs =
      (opts.timeoutMs ?? OPENROUTER_FETCH_TIMEOUT_MS) +
      OPENROUTER_INFLIGHT_MARGIN_MS;
    if (inflight) {
      const age = now() - inflight.startedAt;
      if (age < 0 || age > inflight.limitMs) inflight = null;
    }
    const shared = inflight ?? startRefresh(opts, now(), limitMs);
    if (!cache) await settledWithin(shared.done, limitMs);
    else opts.waitUntil?.(shared.done);
  }
  return cache?.prices ?? new Map<string, ModelPrice>();
}

function startRefresh(
  opts: FetchOpenRouterPricesOptions,
  startedAt: number,
  limitMs: number,
): InflightFetch {
  const entry: InflightFetch = {
    done: refresh(opts).finally(() => {
      // An abandoned fetch that settles late leaves its successor alone.
      if (inflight === entry) inflight = null;
    }),
    startedAt,
    limitMs,
  };
  inflight = entry;
  return entry;
}

/** Waits for `work`, or for `ms` on this caller's own timer, whichever is first. */
async function settledWithin(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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

/** Test seam: clear the in-memory price cache, the shared fetch and the remembered failure. */
export function resetOpenRouterPriceCache(): void {
  cache = null;
  inflight = null;
  failedAt = null;
}
