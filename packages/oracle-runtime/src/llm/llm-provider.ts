import {
  getChatOpenAiModel,
  getLLMProvider,
  getOpenRouterChatModel,
  type LLMProvider,
} from '@ixo/common';
import { Logger } from '@nestjs/common';
import { DEFAULT_MODEL_ID, getDefaultModelId } from './model-catalog.js';

// Re-use ChatOpenAIFields type via the return type of getChatOpenAiModel
type ChatOpenAIFields = Parameters<typeof getChatOpenAiModel>[0];
type ChatOpenAIInstance = ReturnType<typeof getChatOpenAiModel>;

const NEBIUS_CONFIG = {
  baseURL: 'https://api.tokenfactory.nebius.com/v1/',
  apiKeyEnv: 'NEBIUS_API_KEY' as const,
};

const logger = new Logger('LLMProvider');

// ---------------------------------------------------------------------------
// Model role → provider model mapping
// ---------------------------------------------------------------------------
/**
 * The roles recognized by the production provider map. The plugin-API exposes
 * a lean `ModelRole` (`'main' | 'subagent' | 'utility' | string`) — that public
 * type stays narrow on purpose. This internal type lists every role the
 * provider actually maps to a model id; the adapter falls back to `subagent`
 * for unrecognized strings.
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

const MODEL_MAP: Record<LLMProvider, Record<ProviderModelRole, string>> = {
  openrouter: {
    // The user-facing default. Overridable per deployment via DEFAULT_MODEL and
    // per request via the model field on a send — both resolved in
    // `getModelForRole('main')` / `getProviderChatModel`.
    main: DEFAULT_MODEL_ID,
    skills: 'openai/gpt-5.4-nano',
    subagent: 'openai/gpt-5.4-nano',
    vision: 'google/gemini-3.1-flash-lite',
    guard: 'meta-llama/llama-3.1-8b-instruct',
    routing: 'openai/gpt-oss-20b',
    custom_low: 'openai/gpt-oss-120b',
    custom_medium: 'moonshotai/kimi-k2-thinking',
    'session-title': 'meta-llama/llama-3.1-8b-instruct',
    embedding: 'text-embedding-3-small',
  },
  nebius: {
    custom_low: '',
    custom_medium: '',
    main: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
    skills: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
    subagent: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
    vision: 'Qwen/Qwen2.5-VL-72B-Instruct',
    guard: 'meta-llama/Llama-Guard-3-8B',
    routing: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
    'session-title': 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    embedding: 'Qwen/Qwen3-Embedding-8B',
  },
};

/** OpenRouter fallback models for the 'main' role (used via `models` array, sorted by latency). */
const OPENROUTER_MAIN_FALLBACKS = [
  'qwen/qwen3-235b-a22b-thinking-2507',
  'google/gemini-2.5-flash-lite',
];

/**
 * Extended-thinking effort for the main model, from `MAIN_REASONING_EFFORT`
 * (default `medium`). Lower effort trims time-to-first-token on simple turns
 * at some cost to hard multi-step reasoning. Scoped to the `main` role so
 * sub-agent reasoning is unchanged. Read from `process.env` directly to match
 * how this factory already resolves provider keys (no Nest DI here).
 */
function resolveMainReasoningEffort(): 'low' | 'medium' | 'high' {
  switch (process.env.MAIN_REASONING_EFFORT) {
    case 'low':
      return 'low';
    case 'high':
      return 'high';
    default:
      return 'medium';
  }
}

/**
 * Get the model identifier for a given role, respecting the active provider.
 * Unknown roles fall back to `subagent` so plugin-side custom roles still resolve.
 */
export function getModelForRole(role: ProviderModelRole | string): string {
  const provider = getLLMProvider();
  const map = MODEL_MAP[provider];
  // The `main` model is deployment-configurable via DEFAULT_MODEL. Only
  // OpenRouter participates in model selection today; Nebius keeps its fixed
  // role map so its self-hosted deployments are unaffected.
  if (role === 'main' && provider === 'openrouter') {
    return getDefaultModelId();
  }
  return map[role as ProviderModelRole] ?? map.subagent;
}

// ---------------------------------------------------------------------------
// Provider-aware chat model factory
// ---------------------------------------------------------------------------

/**
 * Provider-aware chat model factory.
 * Uses LLM_PROVIDER env var to select OpenRouter or Nebius.
 * Pass a `role` to auto-resolve the model, or override with `params.model`.
 */
export const getProviderChatModel = (
  role: ProviderModelRole | string,
  params?: ChatOpenAIFields,
): ChatOpenAIInstance => {
  const provider = getLLMProvider();
  const model = params?.model ?? getModelForRole(role);

  // Use NestJS Logger instead of console.log
  logger.log(
    `Creating model — provider=${provider}, role=${role}, model=${model}`,
  );

  if (provider === 'openrouter') {
    // For 'main' role, add fallback models sorted by latency
    const fallbackKwargs: Record<string, unknown> =
      role === 'main'
        ? {
            models: OPENROUTER_MAIN_FALLBACKS,
            provider: { sort: 'latency' },
          }
        : {};

    return getOpenRouterChatModel({
      ...params,
      model,
      __includeRawResponse: true,
      modelKwargs: {
        require_parameters: true,
        include_reasoning: true,
        ...fallbackKwargs,
        ...params?.modelKwargs,
      },
      reasoning: {
        effort: role === 'main' ? resolveMainReasoningEffort() : 'medium',
        ...params?.reasoning,
      },
    });
  }

  const apiKey = process.env[NEBIUS_CONFIG.apiKeyEnv];
  logger.log(
    `Nebius config — baseURL=${NEBIUS_CONFIG.baseURL}, apiKey=${apiKey ? 'set' : 'MISSING'}`,
  );

  // Use low temperature for classification models (guard), higher for generative
  const defaultTemp = role === 'guard' ? 0 : 0.8;

  return getChatOpenAiModel({
    temperature: defaultTemp,
    apiKey,
    __includeRawResponse: true,
    model,
    ...params,
    configuration: {
      baseURL: NEBIUS_CONFIG.baseURL,
      ...params?.configuration,
    },
  });
};

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

/**
 * Provider-aware base URL and API key for raw fetch calls (e.g. file processing).
 */
export function getProviderConfig() {
  const provider = getLLMProvider();

  if (provider === 'nebius') {
    return {
      provider,
      baseURL: NEBIUS_CONFIG.baseURL,
      apiKey: process.env[NEBIUS_CONFIG.apiKeyEnv] ?? '',
      headers: {} as Record<string, string>,
    };
  }

  return {
    provider,
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPEN_ROUTER_API_KEY ?? '',
    headers: {
      'HTTP-Referer': 'oracle-app.com',
      'X-Title': process.env.ORACLE_NAME ?? 'Oracle App',
    },
  };
}

export { getLLMProvider };
