/**
 * Shapes returned by an oracle's `GET /models` endpoint, consumed by
 * {@link useModels}. Mirrors the runtime's model catalog. Prices are already
 * marked up (what the user pays); the picker typically shows `costLabel` +
 * `badge` rather than raw numbers.
 */

export type ModelTier = 'everyday' | 'balanced' | 'top';

export type ModelFamily =
  | 'openai'
  | 'google'
  | 'anthropic'
  | 'moonshotai'
  | 'z-ai';

export interface ModelInfo {
  /** OpenRouter slug — pass this as `model` to `useChat`. */
  id: string;
  /** Friendly display name, e.g. `GPT-5.4 Nano`. */
  label: string;
  /** Provider family, for grouping / logos. */
  family: ModelFamily;
  /** Coarse capability/price tier. */
  tier: ModelTier;
  /** At-a-glance cost cue: `$` / `$$` / `$$$`. */
  costLabel: string;
  /** Short badge: `Fast` / `Balanced` / `Smartest`. */
  badge: string;
  /** One plain-language sentence describing the model. */
  blurb: string;
  /** Whether the model can read image input. */
  vision: boolean;
  /** The price the user pays (markup already applied). */
  pricing: {
    inputPerMillion: number;
    outputPerMillion: number;
    currency: 'USD';
    unit: 'per_million_tokens';
  };
  /** True for the model used when the user hasn't picked one. */
  isDefault: boolean;
}

export interface ModelsResponse {
  models: ModelInfo[];
  /** Id of the default model (also flagged via `isDefault`). */
  default: string;
}
