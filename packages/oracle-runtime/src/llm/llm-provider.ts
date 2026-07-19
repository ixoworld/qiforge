import {
  getChatOpenAiModel,
  getLLMProvider,
  type LLMProvider,
} from '@ixo/common';
import { Logger } from '@nestjs/common';
import {
  createEnvCredentialBroker,
  DEFAULT_CREDENTIAL_REF_MAPPING,
  type CredentialBroker,
} from './credential-broker.js';
import { builtinModelPolicy } from './default-model-policy.js';
import {
  buildGatewayTransport,
  getModelAdapter,
  registerModelAdapter,
} from './model-adapters.js';
import {
  buildModelPolicy,
  parseModelPolicyEnv,
  type ModelPolicy,
  type ModelPolicyInput,
  type ResolvedModelTarget,
} from './model-policy.js';

import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * Caller-supplied params are narrowed to the structured surface adapters
 * accept. Anything outside it is intentionally dropped — structured extras
 * belong in the policy target's `params`, which flows through the same
 * narrowing.
 */
const callerParamsSchema = z.object({
  model: z.string().optional(),
  temperature: z.number().optional(),
  modelKwargs: z.record(z.string(), z.unknown()).optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
});

function narrowParams(raw: unknown): z.infer<typeof callerParamsSchema> {
  const parsed = callerParamsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1/';

const logger = new Logger('LLMProvider');

/**
 * The roles the BUILT-IN policy declares. The public plugin-API `ModelRole`
 * stays deliberately lean; custom roles are valid exactly when the operator
 * declares them in a policy layer — an undeclared role fails loudly instead
 * of silently downgrading to `subagent` (which used to hide configuration
 * errors).
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

/**
 * Extended-thinking effort for the main model, from `MAIN_REASONING_EFFORT`
 * (default `medium`). Read from `process.env` directly to match how this
 * factory already resolves provider keys (no Nest DI here).
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

// ---------------------------------------------------------------------------
// Provider adapters (Node). New providers register here — boot code, not
// configuration strings.
// ---------------------------------------------------------------------------

registerModelAdapter('openrouter', (ctx) => {
  const { target, modelId, apiKey, baseURL, defaultHeaders, params } = ctx;
  const fallbackKwargs: Record<string, unknown> =
    target.fallbacks.length > 0
      ? {
          models: target.fallbacks.map((f) => f.model),
          provider: { sort: 'latency' },
        }
      : {};
  return getChatOpenAiModel({
    apiKey,
    model: modelId,
    __includeRawResponse: true,
    ...(params.temperature !== undefined
      ? { temperature: params.temperature }
      : {}),
    modelKwargs: {
      require_parameters: true,
      include_reasoning: true,
      ...fallbackKwargs,
      ...params.modelKwargs,
    },
    reasoning: {
      effort:
        params.reasoningEffort ??
        (target.role === 'main' ? resolveMainReasoningEffort() : 'medium'),
    },
    configuration: {
      baseURL: baseURL ?? 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'oracle-app.com',
        'X-Title': process.env.ORACLE_NAME ?? 'Oracle App',
        ...defaultHeaders,
      },
    },
  });
});

registerModelAdapter('nebius', (ctx) => {
  const { target, modelId, apiKey, baseURL, defaultHeaders, params } = ctx;
  // Low temperature for classification models (guard), higher for generative.
  const defaultTemp = target.role === 'guard' ? 0 : 0.8;
  return getChatOpenAiModel({
    temperature: params.temperature ?? defaultTemp,
    apiKey,
    __includeRawResponse: true,
    model: modelId,
    ...(params.modelKwargs ? { modelKwargs: params.modelKwargs } : {}),
    configuration: {
      baseURL: baseURL ?? NEBIUS_BASE_URL,
      ...(defaultHeaders ? { defaultHeaders } : {}),
    },
  });
});

registerModelAdapter('openai-compat', (ctx) => {
  const { modelId, apiKey, baseURL, defaultHeaders, params } = ctx;
  return getChatOpenAiModel({
    apiKey,
    model: modelId,
    __includeRawResponse: true,
    ...(params.temperature !== undefined
      ? { temperature: params.temperature }
      : {}),
    ...(params.modelKwargs ? { modelKwargs: params.modelKwargs } : {}),
    ...(baseURL || defaultHeaders
      ? {
          configuration: {
            ...(baseURL ? { baseURL } : {}),
            ...(defaultHeaders ? { defaultHeaders } : {}),
          },
        }
      : {}),
  });
});

// ---------------------------------------------------------------------------
// Policy resolution (layered, memoized)
// ---------------------------------------------------------------------------

let hostPolicyLayer: ModelPolicyInput | undefined;
let cache: { policy: ModelPolicy; broker: CredentialBroker } | null = null;

/**
 * Install the host's policy layer (from `createOracleApp` options today,
 * from the signed config document later). Resets the memoized policy.
 */
export function setHostModelPolicy(layer: ModelPolicyInput | undefined): void {
  hostPolicyLayer = layer;
  cache = null;
}

function resolvePolicy(): { policy: ModelPolicy; broker: CredentialBroker } {
  if (cache) return cache;
  const envLayer = parseModelPolicyEnv(process.env.MODEL_POLICY_JSON);
  const policy = buildModelPolicy([
    builtinModelPolicy(getLLMProvider()),
    envLayer,
    hostPolicyLayer,
  ]);
  const broker = createEnvCredentialBroker(
    DEFAULT_CREDENTIAL_REF_MAPPING,
    process.env,
  );
  // Disclose every configured fallback once per policy build — a fallback
  // that fires should never be the first time the operator hears of it.
  for (const role of policy.roles()) {
    const target = policy.targetFor(role);
    for (const fallback of target.fallbacks) {
      const extras = [
        fallback.disclosure.residencyChange,
        fallback.disclosure.retentionChange,
        fallback.disclosure.costChange,
      ]
        .filter((part): part is string => Boolean(part))
        .join('; ');
      logger.log(
        `[model-policy] role=${role} fallback → ${fallback.model} (${fallback.disclosure.reason}${extras ? `; ${extras}` : ''})`,
      );
    }
  }
  cache = { policy, broker };
  return cache;
}

function defaultCredentialRef(provider: string): string {
  if (provider === 'openrouter') return 'openrouter-default';
  if (provider === 'nebius') return 'nebius-default';
  return 'openai-default';
}

/**
 * Resolve a role to its concrete target without constructing a model —
 * used by the semantic router and the model-receipt records.
 */
export function resolveModelTarget(role: string): ResolvedModelTarget {
  return resolvePolicy().policy.targetFor(role);
}

/**
 * Get the model identifier for a given role under the active policy.
 * Unknown roles throw (`ModelPolicyError`) — declare the role in a policy
 * layer instead of relying on a silent downgrade.
 */
export function getModelForRole(role: ProviderModelRole | string): string {
  return resolveModelTarget(role).model;
}

// ---------------------------------------------------------------------------
// Policy-aware chat model factory
// ---------------------------------------------------------------------------

/**
 * Construct a chat model for `role` under the operator's model policy.
 *
 * - `params.model` may narrow the choice but only WITHIN the operator's
 *   constraint set — out-of-policy overrides throw.
 * - When an AI Gateway transport is configured, traffic routes through the
 *   gateway URL with the gateway auth header; `pooled` mode sends a
 *   broker-resolved upstream key with the request, `byok` mode relies on
 *   the key stored gateway-side under the operator's account.
 */
export const getProviderChatModel = (
  role: ProviderModelRole | string,
  params?: Record<string, unknown>,
): BaseChatModel => {
  const { policy, broker } = resolvePolicy();
  const target = policy.targetFor(role);
  const caller = narrowParams(params);
  const fromPolicy = narrowParams(target.params);

  const requestedModel =
    typeof caller.model === 'string' && caller.model.length > 0
      ? caller.model
      : target.model;
  if (requestedModel !== target.model) {
    policy.assertWithinConstraints(target.provider, requestedModel);
  }

  let modelId = requestedModel;
  let baseURL: string | undefined;
  let defaultHeaders: Record<string, string> | undefined;
  let apiKey: string;

  if (target.gateway) {
    const token = broker.resolve(target.gateway.authTokenRef);
    const transport = buildGatewayTransport(
      target.gateway,
      target.provider,
      requestedModel,
      token,
    );
    baseURL = transport.baseURL;
    modelId = transport.model;
    defaultHeaders = transport.headers;
    apiKey =
      target.gateway.mode === 'pooled'
        ? broker.resolve(
            target.gateway.providerKeyRef ??
              target.credentialRef ??
              defaultCredentialRef(target.provider),
          )
        : token;
  } else {
    apiKey = broker.resolve(
      target.credentialRef ?? defaultCredentialRef(target.provider),
    );
  }

  logger.log(
    `Creating model — provider=${target.provider}, role=${role}, model=${requestedModel}${target.gateway ? ` via ai-gateway(${target.gateway.mode})` : ''}`,
  );

  // Caller wins over policy `target.params`; `model` travels as `modelId`
  // (gateway styles rewrite it), never through the params bag.
  const mergedParams = {
    ...(fromPolicy.temperature !== undefined
      ? { temperature: fromPolicy.temperature }
      : {}),
    ...(fromPolicy.modelKwargs ? { modelKwargs: fromPolicy.modelKwargs } : {}),
    ...(fromPolicy.reasoningEffort
      ? { reasoningEffort: fromPolicy.reasoningEffort }
      : {}),
    ...(caller.temperature !== undefined
      ? { temperature: caller.temperature }
      : {}),
    ...(caller.modelKwargs ? { modelKwargs: caller.modelKwargs } : {}),
    ...(caller.reasoningEffort
      ? { reasoningEffort: caller.reasoningEffort }
      : {}),
  };

  return getModelAdapter(target.provider)({
    target,
    modelId,
    apiKey,
    baseURL,
    defaultHeaders,
    params: mergedParams,
  });
};

// ---------------------------------------------------------------------------
// Provider config for raw fetch callers (file processing, embeddings)
// ---------------------------------------------------------------------------

/**
 * Provider-aware base URL and API key for raw fetch calls (e.g. file
 * processing). Follows the same broker-resolved credentials as the chat
 * factory.
 */
export function getProviderConfig() {
  const provider = getLLMProvider();
  const { broker } = resolvePolicy();

  if (provider === 'nebius') {
    return {
      provider,
      baseURL: NEBIUS_BASE_URL,
      apiKey: broker.resolve('nebius-default'),
      headers: {} as Record<string, string>,
    };
  }

  return {
    provider,
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: broker.resolve('openrouter-default'),
    headers: {
      'HTTP-Referer': 'oracle-app.com',
      'X-Title': process.env.ORACLE_NAME ?? 'Oracle App',
    },
  };
}

/**
 * Embed texts with the policy's `embedding` role over the provider's
 * OpenAI-compatible `/embeddings` endpoint. Used by the semantic router's
 * embedding strategy; failures propagate (the router fails open, safely).
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const { policy } = resolvePolicy();
  const target = policy.targetFor('embedding');
  const cfg = getProviderConfig();
  const response = await fetch(`${cfg.baseURL}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
      ...cfg.headers,
    },
    body: JSON.stringify({ model: target.model, input: texts }),
  });
  if (!response.ok) {
    throw new Error(`Embedding request failed with status ${response.status}`);
  }
  const json = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const vectors = (json.data ?? []).map((entry) => entry.embedding ?? []);
  if (vectors.length !== texts.length || vectors.some((v) => v.length === 0)) {
    throw new Error('Embedding response did not cover every input text.');
  }
  return vectors;
}

export { getLLMProvider };
export type { LLMProvider };
