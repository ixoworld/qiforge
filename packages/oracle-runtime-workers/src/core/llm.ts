import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { ChatOpenAI } from '@langchain/openai';
import { Client } from 'langsmith';
import type { ChatOpenAIFields, Logger, ModelRole } from '../plugin-api/types';
import { fetchOpenRouterPrices } from './openrouter-pricing';
import type { LlmAdapter } from './runtime-context';
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
    id: DEFAULT_MODEL_ID,
    label: 'GPT-5.4 Nano',
    family: 'openai',
    tier: 'everyday',
    blurb: 'Fast and low-cost — great for everyday questions and quick help.',
    vision: true,
    baselinePrice: { inputPerMillion: 0.2, outputPerMillion: 1.2 },
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash Lite',
    family: 'google',
    tier: 'everyday',
    blurb: 'Speedy and inexpensive, and it can read images too.',
    vision: true,
    baselinePrice: { inputPerMillion: 0.25, outputPerMillion: 1.5 },
  },
  {
    id: 'z-ai/glm-5.2',
    label: 'GLM 5.2',
    family: 'z-ai',
    tier: 'everyday',
    blurb: 'Budget-friendly open model that handles general chat well.',
    vision: false,
    baselinePrice: { inputPerMillion: 0.2968, outputPerMillion: 0.9328 },
  },
  {
    id: 'moonshotai/kimi-k2.5',
    label: 'Kimi K2.5',
    family: 'moonshotai',
    tier: 'everyday',
    blurb: 'Low-cost open model that can also look at images.',
    vision: true,
    baselinePrice: { inputPerMillion: 0.57, outputPerMillion: 2.85 },
  },

  // ── $$ Balanced — smarter, still affordable ─────────────────────────────
  {
    id: 'openai/gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    family: 'openai',
    tier: 'balanced',
    blurb: 'A smart all-rounder that balances speed and reasoning.',
    vision: true,
    baselinePrice: { inputPerMillion: 1.0, outputPerMillion: 6.0 },
  },
  {
    id: 'google/gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    family: 'google',
    tier: 'balanced',
    blurb: 'Capable multimodal model for tougher, more detailed tasks.',
    vision: true,
    baselinePrice: { inputPerMillion: 1.5, outputPerMillion: 9.0 },
  },
  {
    id: 'anthropic/claude-sonnet-5',
    label: 'Claude Sonnet 5',
    family: 'anthropic',
    tier: 'balanced',
    blurb: 'Great at careful writing, reasoning and coding.',
    vision: true,
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
    baselinePrice: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  },
  {
    id: 'anthropic/claude-opus-4.8',
    label: 'Claude Opus 4.8',
    family: 'anthropic',
    tier: 'top',
    blurb: "Anthropic's most capable model for hard problems.",
    vision: true,
    baselinePrice: { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  },
  {
    id: 'openai/gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    family: 'openai',
    tier: 'top',
    blurb: "OpenAI's flagship for the most complex work.",
    vision: true,
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

const MODEL_INPUT_CAPS: Record<string, ModelInputCapabilities> = {
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
): Promise<ModelListing> {
  const apiKey =
    typeof env?.OPEN_ROUTER_API_KEY === 'string' && env.OPEN_ROUTER_API_KEY
      ? env.OPEN_ROUTER_API_KEY
      : undefined;
  const livePrices = await fetchOpenRouterPrices({ apiKey });
  return listModelCatalog(env, livePrices);
}

// ── Role → model map (OpenRouter only) ──────────────────────────────────────

/**
 * Every role the provider maps to a model id. The plugin-API exposes a lean
 * `ModelRole` (`'main' | 'subagent' | 'utility' | string`); the adapter falls
 * back to `subagent` for unrecognized strings.
 */
export type ProviderModelRole =
  | 'main'
  | 'skills'
  | 'subagent'
  | 'vision'
  | 'guard'
  | 'routing'
  | 'session-title'
  | 'embedding'
  | 'custom_medium'
  | 'custom_low';

/** OpenRouter role map. `main` is resolved through `getDefaultModelId`. */
export const OPENROUTER_MODEL_MAP: Record<ProviderModelRole, string> = {
  main: DEFAULT_MODEL_ID,
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

/** OpenRouter fallback models for the 'main' role (via `models`, sorted by latency). */
export const OPENROUTER_MAIN_FALLBACKS: readonly string[] = [
  'qwen/qwen3-235b-a22b-thinking-2507',
  'google/gemini-2.5-flash-lite',
];

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// ── Nebius (self-hosted deployments) ────────────────────────────────────────

export const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1/';

/**
 * Nebius role map — a fixed map (mirrors the Node provider): only OpenRouter
 * participates in `DEFAULT_MODEL` selection, so self-hosted deployments are
 * unaffected by catalog changes.
 */
export const NEBIUS_MODEL_MAP: Record<ProviderModelRole, string> = {
  main: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
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
 * provider by `LLM_PROVIDER` (`openrouter` default | `nebius`). `ChatOpenAI`
 * speaks to both OpenAI-compatible endpoints over `fetch`, so it runs
 * unchanged on Workers. Every model is created with `maxRetries: 2`.
 *
 * OpenRouter role handling mirrors the Node provider:
 *   - `main` → `DEFAULT_MODEL` (or the catalog default), with the OpenRouter
 *     `models` fallback array and `provider.sort: 'latency'`; reasoning
 *     effort from `MAIN_REASONING_EFFORT`.
 *   - every other role → the fixed map; unknown roles fall back to `subagent`.
 *   - `params.model` always wins over the role default.
 *
 * Reasoning goes through `modelKwargs` (spread verbatim into the request
 * body), never ChatOpenAI's top-level `reasoning` field: that field is
 * dropped for OpenRouter-prefixed ids, and a top-level `reasoning.summary`
 * silently reroutes the call to the Responses API.
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
  const mainEffort = env.MAIN_REASONING_EFFORT ?? 'medium';
  const headers: Record<string, string> = {
    'HTTP-Referer': 'oracle-app.com',
    'X-Title': env.ORACLE_NAME ?? 'Oracle App',
  };

  const modelForRole = (role: ModelRole): string => {
    if (role === 'main') return defaultModelId;
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
      role === 'main'
        ? {
            models: [...OPENROUTER_MAIN_FALLBACKS],
            provider: { sort: 'latency' },
          }
        : {};

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
    return new ChatOpenAI({
      temperature: 0.8,
      maxRetries: 2,
      apiKey: env.OPEN_ROUTER_API_KEY,
      ...rest,
      model,
      __includeRawResponse: true,
      configuration: {
        baseURL: OPENROUTER_BASE_URL,
        ...configuration,
        defaultHeaders: { ...headers, ...overrideHeaders },
      },
      modelKwargs: {
        require_parameters: true,
        include_reasoning: true,
        ...fallbackKwargs,
        reasoning: reasoningKwargs,
        ...asRecord(paramsModelKwargs),
      },
    });
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
 * No OpenRouter wire extras (`require_parameters`, fallback `models`,
 * `reasoning` kwargs) — those break non-OpenRouter APIs.
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
    return new ChatOpenAI({
      // Cold for classification (guard), platform default otherwise.
      temperature: role === 'guard' ? 0 : 0.8,
      maxRetries: 2,
      apiKey,
      __includeRawResponse: true,
      ...rest,
      model,
      configuration: {
        baseURL: NEBIUS_BASE_URL,
        ...asRecord(paramsConfiguration),
      },
    });
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
 * LangChain's env-driven auto-attached tracer. Workers has no `process.env`,
 * so the callback manager never auto-attaches anything — here BOTH modes
 * attach an explicit `LangChainTracer` whose `Client` is constructed from the
 * Worker env (`LANGSMITH_API_KEY` / `LANGSMITH_ENDPOINT`) and memoised per
 * isolate, so every tracer shares one batched upload queue:
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
  client: 'portal' | 'matrix' | 'slack';
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
    client = new Client({ apiKey, ...(endpoint && { apiUrl: endpoint }) });
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
