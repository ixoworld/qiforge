/**
 * Bring-your-own-credential (BYO) provider and model catalog.
 *
 * When `BYO_LLM_ENABLED` is on (the personal companion deployment), a user can
 * connect their own ChatGPT subscription (OAuth) or per-provider API keys and
 * run their chat turns on their own account instead of the platform's
 * OpenRouter key. This file is the single source of truth for:
 *
 *   - which providers are supported and how each authenticates,
 *   - the reserved room-secret name each credential is stored under,
 *   - the `byo:` model-id namespace and its parsing,
 *   - the curated per-provider model list shown in the picker, and
 *   - the role→model translation used so sub-agents, vision, guards etc. run
 *     on the user's provider too (embedding always stays platform-side — no
 *     BYO provider serves the embedding role here).
 *
 * Everything here is pure data + pure functions; credential resolution and
 * client construction live in `modules/byo-llm/` and `llm/byo-client.ts`.
 */

import type { ProviderModelRole } from './llm-provider.js';
import {
  TIER_DISPLAY,
  type ModelListItem,
  type ModelTier,
} from './model-catalog.js';

export type ByoProvider =
  | 'chatgpt'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek';

export const BYO_PROVIDERS: readonly ByoProvider[] = [
  'chatgpt',
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
];

export function isByoProvider(value: string): value is ByoProvider {
  return (BYO_PROVIDERS as readonly string[]).includes(value);
}

/** How a provider's credential is obtained on the connect surface. */
export type ByoAuthType = 'oauth' | 'api-key';

export interface ByoProviderInfo {
  provider: ByoProvider;
  /** Display name for the connect UI. */
  label: string;
  authType: ByoAuthType;
  /** Picker badge for models running on this credential. */
  badge: string;
}

export const BYO_PROVIDER_INFO: Record<ByoProvider, ByoProviderInfo> = {
  chatgpt: {
    provider: 'chatgpt',
    label: 'ChatGPT (subscription)',
    authType: 'oauth',
    badge: 'Your subscription',
  },
  openai: {
    provider: 'openai',
    label: 'OpenAI API',
    authType: 'api-key',
    badge: 'Your API key',
  },
  anthropic: {
    provider: 'anthropic',
    label: 'Anthropic API',
    authType: 'api-key',
    badge: 'Your API key',
  },
  gemini: {
    provider: 'gemini',
    label: 'Google Gemini API',
    authType: 'api-key',
    badge: 'Your API key',
  },
  deepseek: {
    provider: 'deepseek',
    label: 'DeepSeek API',
    authType: 'api-key',
    badge: 'Your API key',
  },
};

/**
 * Reserved room-secret names, one per provider. The portal writes API keys
 * under these names via the existing agent-secrets flow (JWE-encrypted to the
 * oracle's on-chain P-256 key); the ChatGPT OAuth blob is written server-side
 * after the token exchange. Stored in the canonical user↔oracle room, so the
 * credential is account-level for this oracle, not per-session.
 */
export const BYO_SECRET_NAMES: Record<ByoProvider, string> = {
  chatgpt: 'BYO_LLM_CHATGPT_OAUTH',
  openai: 'BYO_LLM_OPENAI_API_KEY',
  anthropic: 'BYO_LLM_ANTHROPIC_API_KEY',
  gemini: 'BYO_LLM_GEMINI_API_KEY',
  deepseek: 'BYO_LLM_DEEPSEEK_API_KEY',
};

const SECRET_NAME_TO_PROVIDER = new Map<string, ByoProvider>(
  (Object.entries(BYO_SECRET_NAMES) as Array<[ByoProvider, string]>).map(
    ([provider, name]) => [name, provider],
  ),
);

/** Reverse lookup: room-secret name → provider (undefined for non-BYO names). */
export function providerForSecretName(name: string): ByoProvider | undefined {
  return SECRET_NAME_TO_PROVIDER.get(name);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Parsed ChatGPT OAuth blob stored under `BYO_LLM_CHATGPT_OAUTH`. */
export interface ChatGptOAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** `chatgpt_account_id` claim — sent as a header on backend calls. */
  accountId: string;
  /** Epoch ms when `accessToken` expires. */
  expiresAt: number;
}

export type ByoCredential =
  | { provider: 'chatgpt'; oauth: ChatGptOAuthTokens }
  | {
      provider: Exclude<ByoProvider, 'chatgpt'>;
      apiKey: string;
    };

/**
 * Parse the stored ChatGPT OAuth JSON. Returns `null` on any malformed value
 * so a corrupted secret degrades to "not connected" instead of throwing on
 * the chat hot path.
 */
export function parseChatGptOAuthTokens(
  raw: string,
): ChatGptOAuthTokens | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if (
      typeof o.accessToken === 'string' &&
      o.accessToken.length > 0 &&
      typeof o.refreshToken === 'string' &&
      typeof o.accountId === 'string' &&
      typeof o.expiresAt === 'number'
    ) {
      return {
        accessToken: o.accessToken,
        refreshToken: o.refreshToken,
        accountId: o.accountId,
        expiresAt: o.expiresAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model-id namespace
// ---------------------------------------------------------------------------

/**
 * BYO model ids are namespaced `byo:<provider>/<provider-native-id>` so they
 * can never collide with OpenRouter slugs in the platform catalog, and so the
 * allow-list gate can route them to the BYO validation path.
 */
export const BYO_MODEL_PREFIX = 'byo:';

export function isByoModelId(id: string | undefined | null): id is string {
  return typeof id === 'string' && id.startsWith(BYO_MODEL_PREFIX);
}

export function toByoModelId(provider: ByoProvider, modelId: string): string {
  return `${BYO_MODEL_PREFIX}${provider}/${modelId}`;
}

export interface ParsedByoModelId {
  provider: ByoProvider;
  /** The provider-native model id (what goes on the wire). */
  modelId: string;
}

/**
 * Parse and validate a `byo:` model id. Returns `null` for unknown providers
 * or models outside the curated per-provider list — this is the BYO
 * counterpart of `isAllowedModel`, so a client can't point a turn at an
 * arbitrary model even on their own key.
 */
export function parseByoModelId(
  id: string | undefined | null,
): ParsedByoModelId | null {
  if (!isByoModelId(id)) return null;
  const rest = id.slice(BYO_MODEL_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const provider = rest.slice(0, slash);
  const modelId = rest.slice(slash + 1);
  if (!isByoProvider(provider) || modelId.length === 0) return null;
  const known = BYO_PROVIDER_MODELS[provider].some((m) => m.id === modelId);
  return known ? { provider, modelId } : null;
}

// ---------------------------------------------------------------------------
// Curated per-provider models
// ---------------------------------------------------------------------------

export interface ByoModelEntry {
  /** Provider-native model id (sent on the wire, no `byo:` prefix). */
  id: string;
  label: string;
  tier: ModelTier;
  blurb: string;
  vision: boolean;
}

/**
 * The models a connected user can pick per provider. Kept deliberately small,
 * mirroring the platform catalog's curation stance. Ids are the providers'
 * native API ids.
 */
export const BYO_PROVIDER_MODELS: Record<
  ByoProvider,
  readonly ByoModelEntry[]
> = {
  // Served by the ChatGPT backend on the user's subscription quota. Ids match
  // the backend's live model catalog (the Codex client's models.json).
  chatgpt: [
    {
      id: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      tier: 'everyday',
      blurb: 'Runs on your ChatGPT plan — fast everyday model.',
      vision: true,
    },
    {
      id: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      tier: 'balanced',
      blurb: 'Runs on your ChatGPT plan — the balanced flagship.',
      vision: true,
    },
    {
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      tier: 'top',
      blurb: 'Runs on your ChatGPT plan — strongest for complex work.',
      vision: true,
    },
  ],
  openai: [
    {
      id: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      tier: 'everyday',
      blurb: 'Fast and low-cost, billed to your OpenAI account.',
      vision: true,
    },
    {
      id: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      tier: 'balanced',
      blurb: 'Smart all-rounder, billed to your OpenAI account.',
      vision: true,
    },
    {
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      tier: 'top',
      blurb: "OpenAI's flagship, billed to your OpenAI account.",
      vision: true,
    },
  ],
  anthropic: [
    {
      id: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      tier: 'everyday',
      blurb: 'Fast and inexpensive on your Anthropic key.',
      vision: true,
    },
    {
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      tier: 'balanced',
      blurb: 'Careful writing, reasoning and coding on your Anthropic key.',
      vision: true,
    },
    {
      id: 'claude-opus-5',
      label: 'Claude Opus 5',
      tier: 'top',
      blurb: "Anthropic's most capable model on your Anthropic key.",
      vision: true,
    },
  ],
  gemini: [
    {
      id: 'gemini-3.1-flash-lite',
      label: 'Gemini 3.1 Flash Lite',
      tier: 'everyday',
      blurb: 'Speedy and inexpensive on your Gemini key.',
      vision: true,
    },
    {
      id: 'gemini-3.6-flash',
      label: 'Gemini 3.6 Flash',
      tier: 'balanced',
      blurb: 'Capable multimodal model on your Gemini key.',
      vision: true,
    },
    {
      id: 'gemini-3.1-pro',
      label: 'Gemini 3.1 Pro',
      tier: 'top',
      blurb: "Google's most capable model on your Gemini key.",
      vision: true,
    },
  ],
  deepseek: [
    {
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      tier: 'everyday',
      blurb: 'Budget-friendly general chat on your DeepSeek key.',
      vision: false,
    },
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      tier: 'balanced',
      blurb: 'Deep step-by-step reasoning on your DeepSeek key.',
      vision: false,
    },
  ],
};

/** Default `main` model when a user connects a provider (picker preselect). */
export const BYO_DEFAULT_MODEL: Record<ByoProvider, string> = {
  chatgpt: 'gpt-5.6-terra',
  openai: 'gpt-5.6-terra',
  anthropic: 'claude-sonnet-5',
  gemini: 'gemini-3.6-flash',
  deepseek: 'deepseek-v4-flash',
};

// ---------------------------------------------------------------------------
// Role translation
// ---------------------------------------------------------------------------

/**
 * Role→model translation per provider. On a BYO turn every model role the
 * provider can serve runs on the user's credential — sub-agents, vision,
 * guards, routing, titles — so the user's own account absorbs the whole turn.
 * A role absent here falls back to the platform provider (deliberately:
 * `embedding` everywhere — none of these providers is wired for the runtime's
 * embedding path — and `vision` on DeepSeek, whose chat models are text-only).
 */
export const BYO_ROLE_MODELS: Record<
  ByoProvider,
  Partial<Record<ProviderModelRole, string>>
> = {
  chatgpt: {
    skills: 'gpt-5.6-luna',
    subagent: 'gpt-5.6-luna',
    vision: 'gpt-5.6-luna',
    guard: 'gpt-5.6-luna',
    routing: 'gpt-5.6-luna',
    'session-title': 'gpt-5.6-luna',
    custom_low: 'gpt-5.6-luna',
    custom_medium: 'gpt-5.6-terra',
  },
  openai: {
    skills: 'gpt-5.6-luna',
    subagent: 'gpt-5.6-luna',
    vision: 'gpt-5.6-luna',
    guard: 'gpt-5.6-luna',
    routing: 'gpt-5.6-luna',
    'session-title': 'gpt-5.6-luna',
    custom_low: 'gpt-5.6-luna',
    custom_medium: 'gpt-5.6-terra',
  },
  anthropic: {
    skills: 'claude-haiku-4-5',
    subagent: 'claude-haiku-4-5',
    vision: 'claude-haiku-4-5',
    guard: 'claude-haiku-4-5',
    routing: 'claude-haiku-4-5',
    'session-title': 'claude-haiku-4-5',
    custom_low: 'claude-haiku-4-5',
    custom_medium: 'claude-sonnet-5',
  },
  gemini: {
    skills: 'gemini-3.1-flash-lite',
    subagent: 'gemini-3.1-flash-lite',
    vision: 'gemini-3.1-flash-lite',
    guard: 'gemini-3.1-flash-lite',
    routing: 'gemini-3.1-flash-lite',
    'session-title': 'gemini-3.1-flash-lite',
    custom_low: 'gemini-3.1-flash-lite',
    custom_medium: 'gemini-3.6-flash',
  },
  deepseek: {
    skills: 'deepseek-v4-flash',
    subagent: 'deepseek-v4-flash',
    guard: 'deepseek-v4-flash',
    routing: 'deepseek-v4-flash',
    'session-title': 'deepseek-v4-flash',
    custom_low: 'deepseek-v4-flash',
    custom_medium: 'deepseek-v4-pro',
  },
};

/**
 * The full role vocabulary the provider maps cover. A KNOWN role absent from
 * a provider's map is deliberately unserved (embedding everywhere, vision on
 * DeepSeek) and must fall back to the platform adapter — while an UNKNOWN
 * plugin-custom role falls back to the provider's cheap `subagent` model,
 * mirroring `getModelForRole`'s behaviour.
 */
const KNOWN_MODEL_ROLES: ReadonlySet<string> = new Set([
  'main',
  'skills',
  'subagent',
  'vision',
  'guard',
  'routing',
  'session-title',
  'embedding',
  'custom_low',
  'custom_medium',
]);

/**
 * Resolve the provider-native model id for a role on a BYO turn.
 * `main` uses the turn's selected model; other roles use the translation
 * table. `null` → the role is not served by this provider and the caller
 * must fall back to the platform adapter.
 */
export function byoModelForRole(
  provider: ByoProvider,
  role: ProviderModelRole | string,
  mainModelId: string,
): string | null {
  if (role === 'main') return mainModelId;
  const map = BYO_ROLE_MODELS[provider];
  const direct = map[role as ProviderModelRole];
  if (direct) return direct;
  if (KNOWN_MODEL_ROLES.has(role)) return null;
  return map.subagent ?? null;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * Build picker entries for a user's connected providers, in the platform
 * `ModelListItem` shape so the client SDK renders them without changes.
 * Pricing is zeroed — the user pays their provider directly. Tier badge and
 * cost label mirror the platform catalog so BYO rows read the same; the
 * client marks BYO-ness itself from the `byo:` id namespace.
 */
export function buildByoModelListing(
  connected: readonly ByoProvider[],
): ModelListItem[] {
  const items: ModelListItem[] = [];
  for (const provider of connected) {
    for (const entry of BYO_PROVIDER_MODELS[provider]) {
      items.push({
        id: toByoModelId(provider, entry.id),
        label: entry.label,
        family: byoFamily(provider),
        tier: entry.tier,
        costLabel: TIER_DISPLAY[entry.tier].costLabel,
        badge: TIER_DISPLAY[entry.tier].badge,
        blurb: entry.blurb,
        vision: entry.vision,
        pricing: {
          inputPerMillion: 0,
          outputPerMillion: 0,
          currency: 'USD',
          unit: 'per_million_tokens',
        },
        isDefault: false,
      });
    }
  }
  return items;
}

function byoFamily(provider: ByoProvider): ModelListItem['family'] {
  switch (provider) {
    case 'chatgpt':
    case 'openai':
      return 'openai';
    case 'anthropic':
      return 'anthropic';
    case 'gemini':
      return 'google';
    case 'deepseek':
      return 'deepseek';
  }
}
