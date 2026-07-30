/**
 * The curated, user-facing model catalog.
 *
 * The runtime can technically route to any OpenRouter model, but exposing the
 * full ~300-model list to an end user (who may be entirely non-technical) is
 * hostile. Instead we hand-pick a small set spanning the price/capability
 * range, tag each with a coarse tier, and let the client render a
 * ChatGPT-style switcher from it. This catalog doubles as the **allow-list**:
 * a per-request model override is only honoured if its id appears here, so a
 * client can never point a turn at an arbitrary (or absurdly expensive) model.
 *
 * Prices here are the raw OpenRouter list prices (USD per million tokens) and
 * are only a *baseline* — `openrouter-pricing.ts` fetches the live prices at
 * runtime and falls back to these when the fetch is unavailable. The markup a
 * user actually pays is applied when the listing is built; the raw price and
 * the markup multiplier are never sent to the client.
 */

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

/** Raw list price, USD per million tokens. */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Native (non-text) input types a model accepts, from OpenRouter's
 * `input_modalities`. Drives attachment routing: an attachment is sent to the
 * model directly only when the model accepts that modality; otherwise it is
 * turned into text by the helper model first.
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
  /** Friendly display name, e.g. `GPT-5.4 Nano`. */
  label: string;
  /** Provider family, for grouping / logos in a picker. */
  family: ModelFamily;
  /** Coarse tier → the `$`/`$$`/`$$$` + badge a non-technical user sees. */
  tier: ModelTier;
  /** One plain-language sentence: when should someone pick this model? */
  blurb: string;
  /** Whether the model accepts image input (so a picker can show a vision hint). */
  vision: boolean;
  /** Baseline OpenRouter list price, used when the live fetch is unavailable. */
  baselinePrice: ModelPrice;
}

/**
 * The default model for a fresh chat. GPT-5.4 Nano is the cheapest capable
 * OpenAI model — fast, inexpensive, and a name users recognise. An oracle
 * operator can override this per deployment via the `DEFAULT_MODEL` env var
 * (see `getDefaultModelId`).
 */
export const DEFAULT_MODEL_ID = 'openai/gpt-5.4-nano';

/**
 * Per-tier presentation. Kept separate from the entries so the wording is
 * defined once and stays consistent across the catalog. `order` sorts tiers
 * cheapest-first in a picker.
 */
export const TIER_DISPLAY: Record<
  ModelTier,
  { costLabel: string; badge: string; order: number }
> = {
  everyday: { costLabel: '$', badge: 'Fast', order: 0 },
  balanced: { costLabel: '$$', badge: 'Balanced', order: 1 },
  top: { costLabel: '$$$', badge: 'Smartest', order: 2 },
};

/**
 * The curated set. Ordered cheapest-tier first; within a tier, roughly by
 * price. Spans OpenAI / Google / Anthropic and open-weight (Moonshot, Z.ai)
 * so users have a recognisable name in every price band.
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
    baselinePrice: { inputPerMillion: 0.2, outputPerMillion: 1.25 },
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

/** The public, per-model shape returned by `GET /models`. */
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

/** The full `GET /models` response. */
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
 * The effective default model id for this deployment: the `DEFAULT_MODEL` env
 * var when an operator has set one, otherwise {@link DEFAULT_MODEL_ID}. Read
 * from `process.env` directly to match how the LLM factory resolves config
 * (no Nest DI on this path).
 */
export function getDefaultModelId(): string {
  const override = process.env.DEFAULT_MODEL?.trim();
  return override && override.length > 0 ? override : DEFAULT_MODEL_ID;
}

/**
 * Native input capabilities per model — the routing source of truth (the
 * catalog's `vision` flag is the display counterpart of `image`). Kept as a
 * compact map so adding a model is one line. An id not listed here — e.g. a
 * `DEFAULT_MODEL` override outside the catalog — is treated as text-only, so
 * attachments are always turned into text rather than assumed-supported.
 *
 * `audio`/`video` are `false` everywhere for now: the runtime only builds
 * native `image` and `file` content blocks (the proven LangChain→OpenRouter
 * path), so audio/video are transcribed by the helper model regardless of the
 * model's own capability. Flip these to `true` once native a/v blocks are
 * wired.
 */
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

/** Round a USD-per-million price to 4 dp — enough for sub-cent-per-M models. */
function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Build the public listing from the catalog, applying `markup` to each price
 * (live price when available in `livePrices`, else the entry's baseline).
 * Pure — the Nest service supplies the live price map, markup, and default id.
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
