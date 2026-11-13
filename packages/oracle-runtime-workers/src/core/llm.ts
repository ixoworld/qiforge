import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { Client } from 'langsmith';
import type { ChatOpenAIFields, Logger, ModelRole } from '../plugin-api/types';
import { PlatformChatModel } from '../llm/platform-chat-model';
import {
  livenessFetchFor,
  livenessModelFields,
  type StreamLivenessSettings,
} from '../llm/stream-liveness';
import {
  LLM_BYO_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
  LLM_HEADERS_TIMEOUT_MS_DEFAULT,
  LLM_MAX_OUTPUT_TOKENS_DEFAULT,
  LLM_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
  LLM_STREAM_RETRIES_DEFAULT,
  LLM_STREAM_RETRIES_MAX,
  TURN_TIMEOUT_MS_DEFAULT,
} from './env';
import { fetchOpenRouterPrices } from './openrouter-pricing';
import type { LlmAdapter } from './runtime-context';
import { stringify } from '../sqlite/serialization';
import { NOOP_LOGGER } from './utils';

// ── Catalog ─────────────────────────────────────────────────────────────────

/** Coarse capability/price tier. Drives the `$`/`$$`/`$$$` + badge shown to users. */
export type ModelTier = 'everyday' | 'balanced' | 'top';

/** Provider family — lets a picker group models or show a logo. */
export type ModelFamily =
  | 'openai'
  | 'google'
  | 'anthropic'
  | 'moonshotai'
  | 'z-ai'
  | 'deepseek';

/**
 * Native (non-text) input types a model accepts. Drives attachment routing:
 * an attachment is sent to the model directly only when the model accepts
 * that modality.
 */
export interface ModelInputCapabilities {
  image: boolean;
  file: boolean;
  audio: boolean;
  video: boolean;
}

/** A single hand-curated model. */
export interface ModelCatalogEntry {
  /** OpenRouter slug — sent to the provider and used as the allow-list key. */
  id: string;
  /** Friendly display name. */
  label: string;
  family: ModelFamily;
  tier: ModelTier;
  /** One plain-language sentence: when should someone pick this model? */
  blurb: string;
  /** Whether the model accepts image input. */
  vision: boolean;
  /**
   * The model's context window in tokens, as the OpenRouter catalogue lists
   * it (the smaller of `context_length` and `top_provider.context_length`).
   * The built-in fallback when the live catalogue cannot be reached
   * (`BUILTIN_CONTEXT_WINDOWS`, `context-window.ts`).
   */
  contextTokens: number;
  /**
   * Baseline list price, used when live OpenRouter pricing is unavailable
   * (see `openrouter-pricing.ts`). Raw provider price; markup applied later.
   */
  baselinePrice: ModelPrice;
}

/** Raw list price, USD per million tokens. */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * The default model for a fresh chat. An oracle operator can override this
 * per deployment via the `DEFAULT_MODEL` env var (see `getDefaultModelId`).
 */
export const DEFAULT_MODEL_ID = 'openai/gpt-5.6-luna';

/** Per-tier presentation, defined once so the wording stays consistent. */
export const TIER_DISPLAY: Record<
  ModelTier,
  { costLabel: string; badge: string; order: number }
> = {
  everyday: { costLabel: '$', badge: 'Fast', order: 0 },
  balanced: { costLabel: '$$', badge: 'Balanced', order: 1 },
  top: { costLabel: '$$$', badge: 'Smartest', order: 2 },
};

/**
 * The curated, user-facing model catalog — also the **allow-list**: a
 * per-request model override is only honoured if its id appears here.
 * `baselinePrice` is the fallback when live OpenRouter pricing is unavailable.
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  // ── $ Everyday — fast and cheap ─────────────────────────────────────────
  {
    id: 'openai/gpt-5.4-nano',
    label: 'GPT-5.4 Nano',
    family: 'openai',
    tier: 'everyday',
    blurb: 'Fast and low-cost — great for everyday questions and quick help.',
    vision: true,
    contextTokens: 400_000,
    baselinePrice: { inputPerMillion: 0.2, outputPerMillion: 1.2 },
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash Lite',
    family: 'google',
    tier: 'everyday',
    blurb: 'Speedy and inexpensive, and it can read images too.',
    vision: true,
    contextTokens: 1_048_576,
    baselinePrice: { inputPerMillion: 0.25, outputPerMillion: 1.5 },
  },
  {
    id: 'z-ai/glm-5.2',
    label: 'GLM 5.2',
    family: 'z-ai',
    tier: 'everyday',
    blurb: 'Budget-friendly open model that handles general chat well.',
    vision: false,
    contextTokens: 1_048_576,
    baselinePrice: { inputPerMillion: 0.2968, outputPerMillion: 0.9328 },
  },
  {
    id: 'moonshotai/kimi-k2.5',
    label: 'Kimi K2.5',
    family: 'moonshotai',
    tier: 'everyday',
    blurb: 'Low-cost open model that can also look at images.',
    vision: true,
    contextTokens: 262_144,
    baselinePrice: { inputPerMillion: 0.57, outputPerMillion: 2.85 },
  },

  // ── $$ Balanced — smarter, still affordable ─────────────────────────────
  {
    id: DEFAULT_MODEL_ID,
    label: 'GPT-5.6 Luna',
    family: 'openai',
    tier: 'balanced',
    blurb: 'A smart all-rounder that balances speed and reasoning.',
    vision: true,
    contextTokens: 1_050_000,
    baselinePrice: { inputPerMillion: 1.0, outputPerMillion: 6.0 },
  },
  {
    id: 'google/gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    family: 'google',
    tier: 'balanced',
    blurb: 'Capable multimodal model for tougher, more detailed tasks.',
    vision: true,
    contextTokens: 1_048_576,
    baselinePrice: { inputPerMillion: 1.5, outputPerMillion: 9.0 },
  },
  {
    id: 'anthropic/claude-sonnet-5',
    label: 'Claude Sonnet 5',
    family: 'anthropic',
    tier: 'balanced',
    blurb: 'Great at careful writing, reasoning and coding.',
    vision: true,
    contextTokens: 1_000_000,
    baselinePrice: { inputPerMillion: 2.0, outputPerMillion: 10.0 },
  },

  // ── $$$ Top-tier — most capable ─────────────────────────────────────────
  {
    id: 'moonshotai/kimi-k3',
    label: 'Kimi K3',
    family: 'moonshotai',
    tier: 'top',
    blurb: 'Powerful open model for complex, long-running tasks.',
    vision: true,
    contextTokens: 1_048_576,
    baselinePrice: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  },
  {
    id: 'anthropic/claude-opus-4.8',
    label: 'Claude Opus 4.8',
    family: 'anthropic',
    tier: 'top',
    blurb: "Anthropic's most capable model for hard problems.",
    vision: true,
    contextTokens: 1_000_000,
    baselinePrice: { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  },
  {
    id: 'openai/gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    family: 'openai',
    tier: 'top',
    blurb: "OpenAI's flagship for the most complex work.",
    vision: true,
    contextTokens: 1_050_000,
    baselinePrice: { inputPerMillion: 5.0, outputPerMillion: 30.0 },
  },
];

/** The public, per-model shape returned by a `GET /models` route. */
export interface ModelListItem {
  id: string;
  label: string;
  family: ModelFamily;
  tier: ModelTier;
  /** `$` / `$$` / `$$$` — the at-a-glance cost cue. */
  costLabel: string;
  /** `Fast` / `Balanced` / `Smartest`. */
  badge: string;
  blurb: string;
  vision: boolean;
  /**
   * The price the user pays, already including the platform markup. The raw
   * provider price and the markup multiplier are deliberately NOT included.
   */
  pricing: {
    inputPerMillion: number;
    outputPerMillion: number;
    currency: 'USD';
    unit: 'per_million_tokens';
  };
  /** True for the model a fresh chat uses when the user hasn't picked one. */
  isDefault: boolean;
}

/** The full `GET /models` response — the Node runtime's `ModelListing`. */
export interface ModelListing {
  models: ModelListItem[];
  /** Id of the default model (also flagged via `isDefault` on the item). */
  default: string;
}

const catalogById = new Map(MODEL_CATALOG.map((m) => [m.id, m]));

/** Look up a catalog entry by its OpenRouter id. */
export function getCatalogEntry(id: string): ModelCatalogEntry | undefined {
  return catalogById.get(id);
}

/**
 * Whether `id` is a selectable model. This is the allow-list guard for the
 * per-request override — an unknown id is rejected and the turn falls back to
 * the default model.
 */
export function isAllowedModel(id: string | undefined | null): id is string {
  return typeof id === 'string' && catalogById.has(id);
}

/**
 * The effective default model id for this deployment: the `DEFAULT_MODEL`
 * config value when an operator has set one, otherwise {@link DEFAULT_MODEL_ID}.
 * Reads the validated config, never `process.env`.
 */
export function getDefaultModelId(
  config: { DEFAULT_MODEL?: unknown } | undefined,
): string {
  const raw = config?.DEFAULT_MODEL;
  const override = typeof raw === 'string' ? raw.trim() : '';
  return override.length > 0 ? override : DEFAULT_MODEL_ID;
}

/** Native input capabilities per catalog id (every key is a `MODEL_CATALOG` id). */
export const MODEL_INPUT_CAPS: Readonly<
  Record<string, ModelInputCapabilities>
> = {
  'openai/gpt-5.4-nano': {
    image: true,
    file: true,
    audio: false,
    video: false,
  },
  'google/gemini-3.1-flash-lite': {
    image: true,
    file: true,
    audio: false,
    video: false,
  },
  'z-ai/glm-5.2': { image: false, file: false, audio: false, video: false },
  'moonshotai/kimi-k2.5': {
    image: true,
    file: false,
    audio: false,
    video: false,
  },
  'openai/gpt-5.6-luna': {
    image: true,
    file: true,
    audio: false,
    video: false,
  },
  'google/gemini-3.5-flash': {
    image: true,
    file: true,
    audio: false,
    video: false,
  },
  'anthropic/claude-sonnet-5': {
    image: true,
    file: true,
    audio: false,
    video: false,
  },
  'moonshotai/kimi-k3': {
    image: true,
    file: false,
    audio: false,
    video: false,
  },
  'anthropic/claude-opus-4.8': {
    image: true,
    file: true,
    audio: false,
    video: false,
  },
  'openai/gpt-5.6-sol': { image: true, file: true, audio: false, video: false },
};

const TEXT_ONLY_CAPS: ModelInputCapabilities = {
  image: false,
  file: false,
  audio: false,
  video: false,
};

/** Native input capabilities for a model id; text-only for unknown ids. */
export function getModelCapabilities(modelId: string): ModelInputCapabilities {
  return MODEL_INPUT_CAPS[modelId] ?? TEXT_ONLY_CAPS;
}

/** The display markup applied to raw provider prices when none is configured. */
export const DEFAULT_MODEL_PRICE_MARKUP = 1.6;

/**
 * The display markup: `MODEL_PRICE_MARKUP` when it is a positive finite number
 * (validated config or the raw Worker `env` string), else the default.
 */
export function getModelPriceMarkup(
  config: { MODEL_PRICE_MARKUP?: unknown } | undefined,
): number {
  const markup = Number(config?.MODEL_PRICE_MARKUP);
  return Number.isFinite(markup) && markup > 0
    ? markup
    : DEFAULT_MODEL_PRICE_MARKUP;
}

function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Build the public listing from the catalog, applying `markup` to each price
 * (live price when available in `livePrices`, else the entry's baseline).
 * Pure — same as the Node runtime's `buildModelListing`; the caller supplies
 * the live price map, markup, and default id.
 */
export function buildModelListing(params: {
  livePrices?: ReadonlyMap<string, ModelPrice>;
  markup: number;
  defaultModelId: string;
}): ModelListing {
  const { livePrices, markup, defaultModelId } = params;

  const models: ModelListItem[] = MODEL_CATALOG.map((entry): ModelListItem => {
    const raw = livePrices?.get(entry.id) ?? entry.baselinePrice;
    const display = TIER_DISPLAY[entry.tier];
    return {
      id: entry.id,
      label: entry.label,
      family: entry.family,
      tier: entry.tier,
      costLabel: display.costLabel,
      badge: display.badge,
      blurb: entry.blurb,
      vision: entry.vision,
      pricing: {
        inputPerMillion: roundPrice(raw.inputPerMillion * markup),
        outputPerMillion: roundPrice(raw.outputPerMillion * markup),
        currency: 'USD',
        unit: 'per_million_tokens',
      },
      isDefault: entry.id === defaultModelId,
    };
  }).sort(
    (a, b) =>
      TIER_DISPLAY[a.tier].order - TIER_DISPLAY[b.tier].order ||
      a.pricing.inputPerMillion - b.pricing.inputPerMillion,
  );

  return { models, default: defaultModelId };
}

/**
 * The `GET /models` payload without a network call: the curated catalog priced
 * from `livePrices` (else baselines) with the configured markup and the
 * deployment default flagged. `env` is the Worker `env` (or validated config)
 * — only `DEFAULT_MODEL` and `MODEL_PRICE_MARKUP` are read.
 */
export function listModelCatalog(
  env: { DEFAULT_MODEL?: unknown; MODEL_PRICE_MARKUP?: unknown } | undefined,
  livePrices?: ReadonlyMap<string, ModelPrice>,
): ModelListing {
  return buildModelListing({
    livePrices,
    markup: getModelPriceMarkup(env),
    defaultModelId: getDefaultModelId(env),
  });
}

/**
 * The `GET /models` payload with live OpenRouter prices (cached per isolate
 * for an hour; baseline prices when the fetch fails) — what the Node runtime's
 * `ModelsService.listModels` returns.
 */
export async function listModels(
  env:
    | {
        DEFAULT_MODEL?: unknown;
        MODEL_PRICE_MARKUP?: unknown;
        OPEN_ROUTER_API_KEY?: unknown;
      }
    | undefined,
  options: {
    /** Keeps a background price refresh alive past the response (`ctx.waitUntil`). */
    waitUntil?: (work: Promise<unknown>) => void;
  } = {},
): Promise<ModelListing> {
  const apiKey =
    typeof env?.OPEN_ROUTER_API_KEY === 'string' && env.OPEN_ROUTER_API_KEY
      ? env.OPEN_ROUTER_API_KEY
      : undefined;
  const livePrices = await fetchOpenRouterPrices({
    apiKey,
    ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}),
  });
  return listModelCatalog(env, livePrices);
}

// ── Role → model map (OpenRouter only) ──────────────────────────────────────

/**
 * Every role the provider maps to a model id. The plugin-API exposes a lean
 * `ModelRole` (`'main' | 'subagent' | 'utility' | string`); the adapter falls
 * back to `subagent` for unrecognized strings.
 *
 * `summarizer` condenses a thread's history (the summarization middleware).
 * It is always served by the turn's own `main` model, on the same lane: the
 * same id (`DEFAULT_MODEL`, a per-request choice passed as `params.model`,
 * or the BYO model), so the summary is written by a model whose window holds
 * everything the turn holds, and a BYO turn's history never leaves the
 * user's own provider. `routing` stays the cheap helper (capability router,
 * other one-shot helper calls).
 */
export type ProviderModelRole =
  | 'main'
  | 'summarizer'
  | 'skills'
  | 'subagent'
  | 'vision'
  | 'guard'
  | 'routing'
  | 'session-title'
  | 'embedding'
  | 'custom_medium'
  | 'custom_low';

/**
 * OpenRouter role map. `main` and `summarizer` are resolved through
 * `getDefaultModelId` (the entries here are the catalog default).
 */
export const OPENROUTER_MODEL_MAP: Record<ProviderModelRole, string> = {
  main: DEFAULT_MODEL_ID,
  summarizer: DEFAULT_MODEL_ID,
  skills: 'openai/gpt-5.6-luna',
  subagent: 'openai/gpt-5.6-luna',
  vision: 'google/gemini-3.1-flash-lite',
  guard: 'meta-llama/llama-3.1-8b-instruct',
  routing: 'openai/gpt-oss-120b',
  custom_low: 'openai/gpt-oss-120b',
  custom_medium: 'google/gemini-3.1-flash-lite',
  'session-title': 'meta-llama/llama-3.1-8b-instruct',
  embedding: 'text-embedding-3-small',
};

/**
 * OpenRouter fallback models for the 'main' role (via `models`), unless the
 * deployment sets `OPENROUTER_MAIN_FALLBACKS`. Both keep a repeated prompt
 * prefix cached (Google's implicit caching), accept the tool schemas the
 * runtime sends, and have a 1M-token window. OpenRouter moves to them only
 * when every provider of the requested model failed.
 */
export const OPENROUTER_MAIN_FALLBACKS: readonly string[] = [
  'google/gemini-3.1-flash-lite',
  'google/gemini-2.5-flash-lite',
];

/** The provider order every GPT-5.6 call is pinned to (see {@link openRouterProviderRouting}). */
export const OPENROUTER_GPT_5_6_PROVIDER_ORDER: readonly string[] = [
  'openai',
  'azure',
];

/**
 * A comma-separated list setting (`OPENROUTER_MAIN_FALLBACKS`,
 * `OPENROUTER_PROVIDER_ORDER`): unset or blank → undefined (the built-in
 * value), `none` → an empty list, anything else → its trimmed entries.
 */
export function parseListSetting(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  if (raw.trim().toLowerCase() === 'none') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenAI's GPT-5.6 models on OpenRouter. Every call to one of them, on any
 * role, is pinned to the providers that keep the prompt cache (see
 * {@link openRouterProviderRouting}).
 */
export const OPENROUTER_GPT_5_6_IDS: readonly string[] = [
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-sol',
];

/** The `provider` routing preferences a call sends to OpenRouter. */
export type OpenRouterProviderRouting =
  | { order: string[]; allow_fallbacks: true }
  | { sort: 'latency' };

/** A deployment's own provider order (`OPENROUTER_PROVIDER_ORDER`). */
export interface ProviderOrderSetting {
  /** The deployment's default model: the one the setting is for. */
  defaultModelId: string;
  /** The providers to try first, in order; empty = no pin. */
  order: readonly string[];
}

/**
 * The `provider` field of a call to `modelId` on `role` on OpenRouter.
 *
 * A deployment that sets `OPENROUTER_PROVIDER_ORDER` decides it for its
 * default model (`DEFAULT_MODEL`) on every role: the listed providers first,
 * in order, with `allow_fallbacks` (`none` sends no pin). Every other call
 * follows the rules below.
 *
 * A GPT-5.6 model goes to OpenAI first, then Azure: both keep a repeated
 * prompt prefix cached between calls seconds apart, while the faster Amazon
 * Bedrock endpoint that latency sorting picks for `openai/gpt-5.6-luna` keeps
 * it only some of the time, and a miss costs about 11 times a hit.
 * `allow_fallbacks` keeps a turn answering when both are down: OpenRouter then
 * uses the model's other providers (Bedrock, without the cache), and after
 * them the `models` fallback list. A fallback model OpenAI and Azure do not
 * serve is routed by OpenRouter's default routing, since `order` names none
 * of its providers and OpenRouter ignores `sort` whenever `order` is set.
 *
 * The pin applies on every role. Any other model's `main` call is sent to its
 * lowest-latency provider; its calls on the other roles carry no `provider`
 * field and get OpenRouter's default routing.
 */
export function openRouterProviderRouting(
  modelId: string,
  role: ModelRole,
  setting?: ProviderOrderSetting,
): { provider?: OpenRouterProviderRouting } {
  if (setting && modelId === setting.defaultModelId) {
    if (setting.order.length > 0)
      return { provider: { order: [...setting.order], allow_fallbacks: true } };
    return role === 'main' ? { provider: { sort: 'latency' } } : {};
  }
  if (OPENROUTER_GPT_5_6_IDS.includes(modelId))
    return {
      provider: {
        order: [...OPENROUTER_GPT_5_6_PROVIDER_ORDER],
        allow_fallbacks: true,
      },
    };
  return role === 'main' ? { provider: { sort: 'latency' } } : {};
}

/**
 * The request-body field that turns on prompt caching for an Anthropic model
 * on OpenRouter: one top-level `cache_control` makes OpenRouter cache the
 * longest stable prefix (tools, system message, history) and move the
 * breakpoint forward as the thread grows. Anthropic caches only on request;
 * every other model id gets nothing, so its request is unchanged. The cache
 * lives five minutes; a cache write costs 1.25× the input price and a read
 * 0.1×.
 */
export function openRouterPromptCacheKwargs(modelId: string): {
  cache_control?: { type: 'ephemeral' };
} {
  return modelId.startsWith('anthropic/')
    ? { cache_control: { type: 'ephemeral' } }
    : {};
}

/**
 * Attribution headers OpenRouter asks callers to send. Shared by the chat
 * models and the `openrouter-jev` Decision adapter so every request the
 * oracle makes is credited to the same app.
 */
export function openRouterAttributionHeaders(
  oracleName?: string,
): Record<string, string> {
  return {
    'HTTP-Referer': 'oracle-app.com',
    'X-Title': oracleName ?? 'Oracle App',
  };
}

// ── Nebius (self-hosted deployments) ────────────────────────────────────────

export const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1/';

/**
 * Nebius role map — a fixed map (mirrors the Node provider): only OpenRouter
 * participates in `DEFAULT_MODEL` selection, so self-hosted deployments are
 * unaffected by catalog changes.
 */
export const NEBIUS_MODEL_MAP: Record<ProviderModelRole, string> = {
  main: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
  // The main model, as on every lane.
  summarizer: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
  skills: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
  subagent: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
  vision: 'Qwen/Qwen2.5-VL-72B-Instruct',
  guard: 'meta-llama/Llama-Guard-3-8B',
  routing: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
  custom_low: '',
  custom_medium: '',
  'session-title': 'meta-llama/Meta-Llama-3.1-8B-Instruct',
  embedding: 'Qwen/Qwen3-Embedding-8B',
};

// ── Built-in context windows ────────────────────────────────────────────────

/**
 * Context windows (tokens) of the non-catalog model ids the runtime itself
 * sends to a provider, keyed the way `catalogCandidates` (`context-window.ts`)
 * looks a model up: an OpenRouter or Nebius id as is, a BYO provider-native
 * id under its vendor prefix (`claude-haiku-4-5` → `anthropic/claude-haiku-4-5`).
 *
 * Unless noted, a number is OpenRouter's `/models` listing (the smaller of
 * `context_length` and `top_provider.context_length`) as of 2026-10-09.
 * Embedding models are left out: their input limit is not a chat window and
 * no context budget is derived for them.
 */
const NON_CATALOG_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  // OpenRouter role map and `main` fallbacks (Gemini 3.1 Flash Lite is in
  // the catalog).
  'openai/gpt-oss-120b': 131_072,
  'meta-llama/llama-3.1-8b-instruct': 131_072,
  'google/gemini-2.5-flash-lite': 1_048_576,
  // BYO provider-native ids (`BYO_ROLE_MODELS`, `BYO_PROVIDER_MODELS` in
  // `src/llm/byo-catalog.ts`) the curated catalog does not list. The
  // ChatGPT lane resolves to the same `openai/…` keys as the OpenAI lane.
  'openai/gpt-5.6-terra': 1_050_000,
  'anthropic/claude-opus-5': 1_000_000,
  // Anthropic's native id; OpenRouter lists it as `anthropic/claude-haiku-4.5`.
  'anthropic/claude-haiku-4-5': 200_000,
  'google/gemini-3.6-flash': 1_048_576,
  // Not on OpenRouter under this id: Google's Gemini API model page
  // (`gemini-3.1-pro-preview`, input token limit 1,048,576).
  'google/gemini-3.1-pro': 1_048_576,
  'deepseek/deepseek-v4-flash': 1_048_576,
  'deepseek/deepseek-v4-pro': 1_024_000,
  // Nebius role map. Nebius's own listing needs an API key; these are the
  // model publishers' published windows (the Hugging Face model configs'
  // `max_position_embeddings`; Meta's Llama 3.1 models, whose configs are
  // gated, at Meta's published 128K, the 131,072 OpenRouter lists for
  // Llama 3.1 8B). A deployment serving less is learned from its first
  // overflow error.
  'Qwen/Qwen3-235B-A22B-Thinking-2507': 262_144,
  'Qwen/Qwen3-235B-A22B-Instruct-2507': 262_144,
  'Qwen/Qwen3-30B-A3B-Instruct-2507': 262_144,
  'Qwen/Qwen2.5-VL-72B-Instruct': 128_000,
  'meta-llama/Llama-Guard-3-8B': 131_072,
  'meta-llama/Meta-Llama-3.1-8B-Instruct': 131_072,
};

/**
 * Every model id the runtime knows a context window for without asking
 * anyone: the curated catalog's `contextTokens` plus
 * {@link NON_CATALOG_CONTEXT_WINDOWS}. The context-window resolver falls
 * back to it when the live OpenRouter catalogue is unreachable or does not
 * list the id, before the deployment default.
 */
export const BUILTIN_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ...MODEL_CATALOG.map((entry): [string, number] => [
    entry.id,
    entry.contextTokens,
  ]),
  ...Object.entries(NON_CATALOG_CONTEXT_WINDOWS),
]);

/** Provider families the platform adapter can be built for. */
export type LlmProvider = 'openrouter' | 'nebius';

/** The slice of validated config the adapter reads. */
export interface LlmEnv {
  OPEN_ROUTER_API_KEY: string;
  DEFAULT_MODEL?: string;
  MAIN_REASONING_EFFORT?: 'low' | 'medium' | 'high';
  ORACLE_NAME?: string;
  /** Platform provider — `openrouter` (default) or `nebius`. */
  LLM_PROVIDER?: LlmProvider;
  /** Required when `LLM_PROVIDER=nebius`. */
  NEBIUS_API_KEY?: string;
  /** Model-call liveness budgets (defaults in `env.ts`). */
  LLM_HEADERS_TIMEOUT_MS?: number;
  LLM_STREAM_IDLE_TIMEOUT_MS?: number;
  LLM_STREAM_RETRIES?: number;
  /** The turn deadline the stall retries are clamped to. */
  TURN_TIMEOUT_MS?: number;
  /** Most tokens one call may generate; 0 = the model's own limit. */
  LLM_MAX_OUTPUT_TOKENS?: number;
  /**
   * The `main` role's fallback models, comma-separated (`none` = no
   * fallback); unset = {@link OPENROUTER_MAIN_FALLBACKS}.
   */
  OPENROUTER_MAIN_FALLBACKS?: string;
  /**
   * The providers OpenRouter tries first for the default model, in order,
   * comma-separated (`none` = no pin); unset = the built-in routing
   * ({@link openRouterProviderRouting}).
   */
  OPENROUTER_PROVIDER_ORDER?: string;
}

/** The liveness-related env keys, as validated config (numbers) or raw Worker env (strings). */
export interface StreamLivenessEnv {
  LLM_HEADERS_TIMEOUT_MS?: unknown;
  LLM_STREAM_IDLE_TIMEOUT_MS?: unknown;
  LLM_BYO_STREAM_IDLE_TIMEOUT_MS?: unknown;
  LLM_STREAM_RETRIES?: unknown;
  TURN_TIMEOUT_MS?: unknown;
}

/** A whole number at least `min` (a number or a numeric string), else undefined. */
function wholeNumber(value: unknown, min: number): number | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(n) && n >= min ? n : undefined;
}

/**
 * The `maxTokens` field every platform model gets: `LLM_MAX_OUTPUT_TOKENS`
 * (default `LLM_MAX_OUTPUT_TOKENS_DEFAULT`), none when it is 0. Reasoning
 * counts against it, and a caller's own `maxTokens` wins.
 */
function outputCapModelFields(env: { LLM_MAX_OUTPUT_TOKENS?: unknown }): {
  maxTokens?: number;
} {
  const cap =
    wholeNumber(env.LLM_MAX_OUTPUT_TOKENS, 0) ?? LLM_MAX_OUTPUT_TOKENS_DEFAULT;
  return cap > 0 ? { maxTokens: cap } : {};
}

/**
 * The liveness budgets of a model lane: `platform` (OpenRouter / Nebius,
 * idle `LLM_STREAM_IDLE_TIMEOUT_MS`) or `byo` (the user's own provider, idle
 * `LLM_BYO_STREAM_IDLE_TIMEOUT_MS`). Unset or invalid values take the
 * defaults in `env.ts`.
 *
 * Retries are clamped so every attempt the guard may make fits the turn:
 * the largest count up to `LLM_STREAM_RETRIES` (at most 5) with
 * `(retries + 1) × (headers + idle) ≤ TURN_TIMEOUT_MS`, never below 0. A
 * retry that cannot finish before the deadline would only end in
 * `budget_exhausted` after a wasted second request. With the defaults the
 * platform lane keeps one retry (2 × 210 s) and BYO lanes get none (420 s).
 */
export function streamLivenessFromEnv(
  env: StreamLivenessEnv,
  lane: 'platform' | 'byo',
): StreamLivenessSettings {
  const headersTimeoutMs =
    wholeNumber(env.LLM_HEADERS_TIMEOUT_MS, 1) ??
    LLM_HEADERS_TIMEOUT_MS_DEFAULT;
  const idleTimeoutMs =
    lane === 'platform'
      ? (wholeNumber(env.LLM_STREAM_IDLE_TIMEOUT_MS, 1) ??
        LLM_STREAM_IDLE_TIMEOUT_MS_DEFAULT)
      : (wholeNumber(env.LLM_BYO_STREAM_IDLE_TIMEOUT_MS, 1) ??
        LLM_BYO_STREAM_IDLE_TIMEOUT_MS_DEFAULT);
  const configured = Math.min(
    wholeNumber(env.LLM_STREAM_RETRIES, 0) ?? LLM_STREAM_RETRIES_DEFAULT,
    LLM_STREAM_RETRIES_MAX,
  );
  const turnTimeoutMs =
    wholeNumber(env.TURN_TIMEOUT_MS, 1) ?? TURN_TIMEOUT_MS_DEFAULT;
  const fitting =
    Math.floor(turnTimeoutMs / (headersTimeoutMs + idleTimeoutMs)) - 1;
  return {
    headersTimeoutMs,
    idleTimeoutMs,
    retries: Math.max(0, Math.min(configured, fitting)),
  };
}

/**
 * Narrow the raw Worker `env` bindings to the adapter's env slice. Lets the
 * host build a provider-selected adapter from `OracleWorkerEnv` directly
 * (`LLM_PROVIDER` / `NEBIUS_API_KEY` are not part of the validated base
 * schema); non-string / empty values read as unset.
 */
export function llmEnvFromWorkerEnv(env: Record<string, unknown>): LlmEnv {
  const str = (key: string): string | undefined => {
    const value = env[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const effort = str('MAIN_REASONING_EFFORT');
  return {
    OPEN_ROUTER_API_KEY: str('OPEN_ROUTER_API_KEY') ?? '',
    DEFAULT_MODEL: str('DEFAULT_MODEL'),
    MAIN_REASONING_EFFORT:
      effort === 'low' || effort === 'medium' || effort === 'high'
        ? effort
        : undefined,
    ORACLE_NAME: str('ORACLE_NAME'),
    LLM_PROVIDER: str('LLM_PROVIDER') === 'nebius' ? 'nebius' : 'openrouter',
    NEBIUS_API_KEY: str('NEBIUS_API_KEY'),
    ...platformStreamLivenessEnv(env),
    ...outputCapEnv(env),
    ...routingEnv(env),
  };
}

/** `OPENROUTER_MAIN_FALLBACKS` and `OPENROUTER_PROVIDER_ORDER` of `env`, when set as strings. */
export function routingEnv(env: {
  OPENROUTER_MAIN_FALLBACKS?: unknown;
  OPENROUTER_PROVIDER_ORDER?: unknown;
}): Pick<LlmEnv, 'OPENROUTER_MAIN_FALLBACKS' | 'OPENROUTER_PROVIDER_ORDER'> {
  return {
    ...(typeof env.OPENROUTER_MAIN_FALLBACKS === 'string'
      ? { OPENROUTER_MAIN_FALLBACKS: env.OPENROUTER_MAIN_FALLBACKS }
      : {}),
    ...(typeof env.OPENROUTER_PROVIDER_ORDER === 'string'
      ? { OPENROUTER_PROVIDER_ORDER: env.OPENROUTER_PROVIDER_ORDER }
      : {}),
  };
}

/** `LLM_MAX_OUTPUT_TOKENS` of `env` as a number (unset when absent or invalid). */
export function outputCapEnv(env: {
  LLM_MAX_OUTPUT_TOKENS?: unknown;
}): Pick<LlmEnv, 'LLM_MAX_OUTPUT_TOKENS'> {
  const cap = wholeNumber(env.LLM_MAX_OUTPUT_TOKENS, 0);
  return cap !== undefined ? { LLM_MAX_OUTPUT_TOKENS: cap } : {};
}

/** The platform lane's liveness keys of `env`, as numbers (unset when absent or invalid). */
export function platformStreamLivenessEnv(
  env: StreamLivenessEnv,
): Pick<
  LlmEnv,
  | 'LLM_HEADERS_TIMEOUT_MS'
  | 'LLM_STREAM_IDLE_TIMEOUT_MS'
  | 'LLM_STREAM_RETRIES'
  | 'TURN_TIMEOUT_MS'
> {
  const headers = wholeNumber(env.LLM_HEADERS_TIMEOUT_MS, 1);
  const idle = wholeNumber(env.LLM_STREAM_IDLE_TIMEOUT_MS, 1);
  const retries = wholeNumber(env.LLM_STREAM_RETRIES, 0);
  const turnTimeout = wholeNumber(env.TURN_TIMEOUT_MS, 1);
  return {
    ...(headers !== undefined ? { LLM_HEADERS_TIMEOUT_MS: headers } : {}),
    ...(idle !== undefined ? { LLM_STREAM_IDLE_TIMEOUT_MS: idle } : {}),
    ...(retries !== undefined ? { LLM_STREAM_RETRIES: retries } : {}),
    ...(turnTimeout !== undefined ? { TURN_TIMEOUT_MS: turnTimeout } : {}),
  };
}

/**
 * Adapter surface — the ambient `llm` plus the role/model resolvers. The name
 * predates provider selection; a Nebius-backed adapter satisfies the same
 * interface (`providerConfig` then carries the Nebius base URL/key).
 */
export interface OpenRouterLlmAdapter extends LlmAdapter {
  /** Model id a role resolves to (honours `DEFAULT_MODEL` for `main`). */
  modelForRole(role: ModelRole): string;
  /** The deployment's default `main` model id. */
  readonly defaultModelId: string;
  /** Provider config for raw fetch calls the host may make itself. */
  readonly providerConfig: {
    baseURL: string;
    apiKey: string;
    headers: Record<string, string>;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Build the platform LLM adapter from validated config, selecting the
 * provider by `LLM_PROVIDER` (`openrouter` default | `nebius`).
 * `ChatOpenAICompletions` speaks to both OpenAI-compatible endpoints over
 * `fetch`, so it runs unchanged on Workers. It always calls Chat Completions:
 * `ChatOpenAI` sends any model id containing `gpt-5.6` (the default
 * `openai/gpt-5.6-luna` among them) to the Responses API, a different request
 * body and stream shape that `useResponsesApi: false` cannot turn off. Every
 * model is created with `maxRetries: 2` and the
 * stream liveness guard (`src/llm/stream-liveness.ts`) as its `fetch`, with
 * the platform lane's budgets (`LLM_HEADERS_TIMEOUT_MS`,
 * `LLM_STREAM_IDLE_TIMEOUT_MS`, `LLM_STREAM_RETRIES`).
 *
 * OpenRouter role handling mirrors the Node provider:
 *   - `main` → `DEFAULT_MODEL` (or the catalog default), with the OpenRouter
 *     `models` fallback array; reasoning effort from `MAIN_REASONING_EFFORT`.
 *   - provider routing from {@link openRouterProviderRouting}: a GPT-5.6
 *     model, on any role, is pinned to OpenAI, then Azure; any other model
 *     gets `sort: 'latency'` on `main` and no `provider` field elsewhere.
 *   - `summarizer` → the same model as `main` (no fallback array), with the
 *     helper calls' `medium` reasoning effort.
 *   - every other role → the fixed map; unknown roles fall back to `subagent`.
 *   - `params.model` always wins over the role default.
 *
 * Reasoning goes through `modelKwargs` (spread verbatim into the request
 * body), never the top-level `reasoning` field: that field is dropped for
 * OpenRouter-prefixed ids.
 *
 * A model whose id (the role default or `params.model`) is an Anthropic one
 * also gets {@link openRouterPromptCacheKwargs}. The `main` fallback models
 * are not Anthropic: when OpenRouter falls back from an Anthropic model, the
 * same body, `cache_control` included, goes to the fallback, which accepts
 * it; a non-Anthropic `main` sends no `cache_control` to its fallbacks.
 *
 * Nebius mirrors the Node provider's second branch: the fixed
 * {@link NEBIUS_MODEL_MAP} (no `DEFAULT_MODEL` participation, no fallback
 * array, no reasoning kwargs), `temperature` 0 for `guard` / 0.8 otherwise.
 */
export function createLlmAdapter(
  env: LlmEnv,
  logger: Logger = NOOP_LOGGER,
): OpenRouterLlmAdapter {
  if (env.LLM_PROVIDER === 'nebius') return createNebiusAdapter(env, logger);
  const defaultModelId = getDefaultModelId(env);
  const liveness = streamLivenessFromEnv(env, 'platform');
  const mainEffort = env.MAIN_REASONING_EFFORT ?? 'medium';
  const headers = openRouterAttributionHeaders(env.ORACLE_NAME);
  const outputCap = outputCapModelFields(env);
  const mainFallbacks = parseListSetting(env.OPENROUTER_MAIN_FALLBACKS) ?? [
    ...OPENROUTER_MAIN_FALLBACKS,
  ];
  const configuredOrder = parseListSetting(env.OPENROUTER_PROVIDER_ORDER);
  const providerOrder: ProviderOrderSetting | undefined = configuredOrder
    ? { defaultModelId, order: configuredOrder }
    : undefined;

  const modelForRole = (role: ModelRole): string => {
    if (role === 'main' || role === 'summarizer') return defaultModelId;
    return (
      OPENROUTER_MODEL_MAP[role as ProviderModelRole] ??
      OPENROUTER_MODEL_MAP.subagent
    );
  };

  const get = (role: ModelRole, params?: ChatOpenAIFields): BaseChatModel => {
    const {
      model: paramsModel,
      reasoning: paramsReasoning,
      modelKwargs: paramsModelKwargs,
      configuration: paramsConfiguration,
      ...rest
    } = params ?? {};
    const model =
      typeof paramsModel === 'string' && paramsModel.length > 0
        ? paramsModel
        : modelForRole(role);

    const fallbackKwargs: Record<string, unknown> =
      role === 'main' && mainFallbacks.length > 0
        ? { models: [...mainFallbacks] }
        : {};

    // `MAIN_REASONING_EFFORT` is for the reply only; helper calls (the
    // summarizer included, although it runs on the main model) reason at
    // `medium`.
    const reasoningKwargs = {
      effort: role === 'main' ? mainEffort : 'medium',
      summary: 'auto',
      ...asRecord(paramsReasoning),
    };

    logger.debug?.(
      `[llm] creating model — role=${String(role)}, model=${model}, reasoning=${JSON.stringify(reasoningKwargs)}`,
    );

    const configuration = asRecord(paramsConfiguration);
    const overrideHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      asRecord(configuration.defaultHeaders),
    )) {
      if (typeof value === 'string') overrideHeaders[key] = value;
    }
    const chat = new PlatformChatModel({
      temperature: 0.8,
      maxRetries: 2,
      ...livenessModelFields(liveness),
      ...outputCap,
      apiKey: env.OPEN_ROUTER_API_KEY,
      ...rest,
      model,
      __includeRawResponse: true,
      configuration: {
        baseURL: OPENROUTER_BASE_URL,
        ...configuration,
        fetch: livenessFetchFor({
          settings: liveness,
          label: `openrouter ${String(role)} ${model}`,
          logger,
          callerFetch: configuration.fetch,
        }),
        defaultHeaders: { ...headers, ...overrideHeaders },
      },
      modelKwargs: {
        include_reasoning: true,
        ...fallbackKwargs,
        ...openRouterProviderRouting(model, role, providerOrder),
        reasoning: reasoningKwargs,
        ...openRouterPromptCacheKwargs(model),
        ...asRecord(paramsModelKwargs),
      },
    });
    chat.reporting = { role: String(role), logger };
    return chat;
  };

  return {
    get,
    modelForRole,
    defaultModelId,
    providerConfig: {
      baseURL: OPENROUTER_BASE_URL,
      apiKey: env.OPEN_ROUTER_API_KEY,
      headers,
    },
  };
}

/**
 * Nebius Token Factory adapter — the Node provider's `nebius` branch:
 * a plain OpenAI-compatible endpoint, the fixed role map, `temperature` 0
 * for the `guard` role and 0.8 otherwise (callers override via `params`).
 * No OpenRouter wire extras (`include_reasoning`, fallback `models`,
 * `provider`, `reasoning` kwargs) — those break non-OpenRouter APIs.
 */
function createNebiusAdapter(
  env: LlmEnv,
  logger: Logger,
): OpenRouterLlmAdapter {
  const apiKey = env.NEBIUS_API_KEY ?? '';
  if (!apiKey) {
    logger.warn(
      '[llm] LLM_PROVIDER=nebius but NEBIUS_API_KEY is not set — model calls will fail',
    );
  }

  const modelForRole = (role: ModelRole): string =>
    NEBIUS_MODEL_MAP[role as ProviderModelRole] ?? NEBIUS_MODEL_MAP.subagent;
  const liveness = streamLivenessFromEnv(env, 'platform');
  const outputCap = outputCapModelFields(env);

  const get = (role: ModelRole, params?: ChatOpenAIFields): BaseChatModel => {
    const {
      model: paramsModel,
      configuration: paramsConfiguration,
      ...rest
    } = params ?? {};
    const model =
      typeof paramsModel === 'string' && paramsModel.length > 0
        ? paramsModel
        : modelForRole(role);
    logger.debug?.(
      `[llm] creating model — provider=nebius, role=${String(role)}, model=${model}`,
    );
    const configuration = asRecord(paramsConfiguration);
    const chat = new PlatformChatModel({
      // Cold for classification (guard), platform default otherwise.
      temperature: role === 'guard' ? 0 : 0.8,
      maxRetries: 2,
      ...livenessModelFields(liveness),
      ...outputCap,
      apiKey,
      __includeRawResponse: true,
      ...rest,
      model,
      configuration: {
        baseURL: NEBIUS_BASE_URL,
        ...configuration,
        fetch: livenessFetchFor({
          settings: liveness,
          label: `nebius ${String(role)} ${model}`,
          logger,
          callerFetch: configuration.fetch,
        }),
      },
    });
    chat.reporting = { role: String(role), logger };
    return chat;
  };

  return {
    get,
    modelForRole,
    defaultModelId: NEBIUS_MODEL_MAP.main,
    providerConfig: { baseURL: NEBIUS_BASE_URL, apiKey, headers: {} },
  };
}

// ── LangSmith tracing ───────────────────────────────────────────────────────

/**
 * Per-turn LangSmith tracing decision — the Workers port of the Node
 * runtime's `modules/messages/langsmith-tracing.ts`.
 *
 * One deliberate difference: on Node, `LANGSMITH_TRACING=true` relies on
 * LangChain's env-driven auto-attached tracer. Here BOTH modes attach an
 * explicit `LangChainTracer` whose `Client` is constructed from the Worker
 * env (`LANGSMITH_API_KEY` / `LANGSMITH_ENDPOINT`) and memoised per isolate,
 * so every tracer shares one batched upload queue. LangChain's callback
 * manager would attach its own tracer (default client, none of the
 * redaction below) to any run that does not carry this one when
 * `LANGSMITH_TRACING` or a sibling switch is `true` in `process.env`, which
 * `nodejs_compat` fills from the Worker's vars and secrets; the runtime's
 * entry removes those switches from `process.env` when the isolate loads
 * (`removeLangChainTracingSwitches`, `tracing-env.ts`).
 *
 *  - **Global** — `LANGSMITH_TRACING === 'true'`: every turn is traced.
 *  - **Selective** — `LANGSMITH_TRACED_DIDS` allowlist (`*` = everyone):
 *    only turns whose UCAN-authenticated user DID matches are traced.
 *
 * Fail-closed: no API key ⇒ no tracer, nothing leaves the isolate. The
 * `metadata` is returned unconditionally — attached to the run config, it is
 * inert without a tracer and filterable per user in LangSmith with one.
 */
export interface LangsmithTracingEnv {
  /** Raw `LANGSMITH_TRACING`. `'true'` (LangChain's exact check) = trace everyone. */
  tracing?: string;
  /** Raw `LANGSMITH_API_KEY`. Nothing is traced without it. */
  apiKey?: string;
  /** Raw `LANGSMITH_PROJECT`. Forwarded to the tracer when set. */
  project?: string;
  /** Raw `LANGSMITH_ENDPOINT` (self-hosted / EU). */
  endpoint?: string;
  /** Raw `LANGSMITH_TRACED_DIDS` comma-separated allowlist (`*` = everyone). */
  tracedDids?: string;
}

/** Narrow the raw Worker `env` bindings to the tracing env slice. */
export function langsmithEnvFromWorkerEnv(
  env: Record<string, unknown>,
): LangsmithTracingEnv {
  const str = (key: string): string | undefined => {
    const value = env[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  return {
    tracing: str('LANGSMITH_TRACING'),
    apiKey: str('LANGSMITH_API_KEY'),
    project: str('LANGSMITH_PROJECT'),
    endpoint: str('LANGSMITH_ENDPOINT'),
    tracedDids: str('LANGSMITH_TRACED_DIDS'),
  };
}

export interface ResolveLangsmithTracingArgs {
  /** The turn's user DID — from the authenticated payload, never client-set metadata. */
  userDid: string;
  /** Ingress surface, so latency can be sliced per client in LangSmith. */
  client: 'portal' | 'matrix' | 'slack' | 'channel';
  env: LangsmithTracingEnv;
}

export interface LangsmithTracingDecision {
  /**
   * Attached to the run config unconditionally — LangGraph forwards it to
   * the tracer when one is attached, and it is inert otherwise.
   */
  metadata: Record<string, string | number>;
  /** Present only when this turn should be traced. */
  callbacks?: [LangChainTracer];
}

/** The signature of a signed storage link, whatever carries the link. */
const SIGNED_LINK_SIGNATURE = /(X-Amz-Signature=)[0-9a-f]+/gi;

/** What `SIGNED_LINK_SIGNATURE` needs to match somewhere: the marker and one hex digit. */
const SIGNED_LINK_MARKER = /X-Amz-Signature=[0-9a-f]/i;

/**
 * Whether `values` needs the full pass of `redactSignedLinks`: some string
 * its JSON would carry (a value or a key, through `toJSON` like
 * `JSON.stringify`) holds a signature, or the walk cannot tell (a BigInt, a
 * getter or `toJSON` that throws: the full pass decides what is sent).
 * JSON escaping never touches the marker's characters, so the marker is in
 * the JSON exactly when it is in one of those strings. Walks without
 * serializing: every run of a traced turn carries the whole history, and a
 * stringify per run was a copy of it per run.
 */
function needsSignedLinkPass(values: unknown): boolean {
  const pending: unknown[] = [values];
  const seen = new Set<object>();
  try {
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value === 'string') {
        if (SIGNED_LINK_MARKER.test(value)) return true;
        continue;
      }
      if (typeof value === 'bigint') return true;
      if (value === null || typeof value !== 'object') continue;
      // A shared object adds no string a first visit did not; a cycle none.
      if (seen.has(value)) continue;
      seen.add(value);
      const toJSON: unknown = Reflect.get(value, 'toJSON');
      if (typeof toJSON === 'function') {
        pending.push(toJSON.call(value, ''));
        continue;
      }
      for (const key of Object.keys(value)) {
        if (SIGNED_LINK_MARKER.test(key)) return true;
        pending.push(Reflect.get(value, key));
      }
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * What a trace may keep of a run's inputs and outputs. A signed link is a
 * bearer credential, and a trace holds every `ToolMessage.artifact`, so its
 * signature goes. A value that cannot be read is not sent. A payload with
 * no signature anywhere is handed back as it is, without serializing it.
 */
export function redactSignedLinks(
  values: Record<string, unknown>,
): Record<string, unknown> {
  if (!needsSignedLinkPass(values)) return values;
  const json = stringify(values);
  const redacted = json.replace(SIGNED_LINK_SIGNATURE, '$1[redacted]');
  if (redacted !== json) return JSON.parse(redacted) as Record<string, unknown>;
  // `stringify` answers with a bare string when it cannot serialize.
  return json.startsWith('{') ? values : {};
}

/** Newest messages a traced graph/middleware/tool run keeps of the thread state. */
export const TRACE_STATE_TAIL_MESSAGES = 4;

/**
 * Collapse the thread state a traced graph, node or middleware run carries
 * (`{ messages: [...whole thread], ...}`) to its newest
 * `TRACE_STATE_TAIL_MESSAGES` messages plus a count of what was left out.
 * Every such run of a turn carries the whole history, and the client
 * serializes each one for upload: on a long thread a tool turn shipped tens
 * of full copies of it from the user object's isolate. A chat model's run is
 * left whole — its inputs are `{ messages: [[...]] }` (one list per prompt),
 * the prompt the model really read, which is what a trace is for.
 */
export function collapseTracedState(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const messages = values.messages;
  if (
    !Array.isArray(messages) ||
    messages.length <= TRACE_STATE_TAIL_MESSAGES ||
    messages.some((entry) => Array.isArray(entry))
  )
    return values;
  return {
    ...values,
    messages: messages.slice(-TRACE_STATE_TAIL_MESSAGES),
    messagesOmitted: messages.length - TRACE_STATE_TAIL_MESSAGES,
  };
}

/** What a trace keeps of a run's inputs or outputs: collapsed state, signed links redacted. */
function traceValues(values: Record<string, unknown>): Record<string, unknown> {
  return redactSignedLinks(collapseTracedState(values));
}

/**
 * Upload batch size of the tracing client. The library default (24 MiB)
 * assumes a server process; a user object shares a 128 MB isolate with the
 * turn it traces, and a batch is serialized as a whole before it is sent,
 * so its size is the transient cost of an upload. Smaller batches drop
 * nothing: the queue is left at the library default, so no run is dropped.
 */
const TRACE_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * One `langsmith` Client per (apiKey, endpoint) per isolate. Tracer instances
 * are per-turn and cheap; the client owns the batched upload queue, so
 * sharing it is what keeps tracing off the hot path.
 */
const langsmithClients = new Map<string, Client>();

function langsmithClientFor(apiKey: string, endpoint?: string): Client {
  const key = `${apiKey}\n${endpoint ?? ''}`;
  let client = langsmithClients.get(key);
  if (!client) {
    client = new Client({
      apiKey,
      ...(endpoint && { apiUrl: endpoint }),
      hideInputs: traceValues,
      hideOutputs: traceValues,
      // Everything else a run uploads that the client lets us clean: its
      // `error` text (a tool error can quote a signed link) and its
      // metadata. `hideInputs` / `hideOutputs` take precedence over it for
      // inputs and outputs.
      anonymizer: redactSignedLinks,
      // No per-run `runtime` block and no `LANGSMITH_*` / `LANGCHAIN_*`
      // values from `process.env` (which workerd fills from vars and
      // secrets) in each run's metadata: `LANGSMITH_TRACED_DIDS` would put
      // the other traced users' DIDs on every run.
      omitTracedRuntimeInfo: true,
      batchSizeBytesLimit: TRACE_BATCH_BYTES,
    });
    langsmithClients.set(key, client);
  }
  return client;
}

/** Single-slot memo for the parsed allowlist (raw string is deploy-stable). */
let tracedDidsMemoRaw: string | undefined;
let tracedDidsMemoSet: ReadonlySet<string> = new Set();

function parseTracedDids(raw: string | undefined): ReadonlySet<string> {
  if (raw === tracedDidsMemoRaw) return tracedDidsMemoSet;
  tracedDidsMemoRaw = raw;
  tracedDidsMemoSet = new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  return tracedDidsMemoSet;
}

export function resolveLangsmithTracing(
  args: ResolveLangsmithTracingArgs,
): LangsmithTracingDecision {
  const { userDid, client, env } = args;

  // `user_id` duplicates the DID under the key LangSmith examples use for
  // user-scoped filtering; `user_did` is the self-describing key.
  const metadata: Record<string, string | number> = {
    user_did: userDid,
    user_id: userDid,
    client,
  };

  // Fail-closed: a tracer that cannot authenticate is never attached.
  if (!env.apiKey) {
    return { metadata };
  }

  const globalOn = env.tracing?.trim() === 'true';
  if (!globalOn) {
    const allowlist = parseTracedDids(env.tracedDids);
    const traced = allowlist.has('*') || allowlist.has(userDid);
    if (!traced) return { metadata };
  }

  return {
    metadata,
    callbacks: [
      new LangChainTracer({
        client: langsmithClientFor(env.apiKey, env.endpoint),
        ...(env.project && { projectName: env.project }),
      }),
    ],
  };
}
