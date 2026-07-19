import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ResolvedModelTarget } from './model-policy.js';

/**
 * The structured parameter surface the provider layer forwards to
 * adapters. Callers and policy `target.params` are narrowed into this shape
 * once (zod, in the provider layer) — adapters never see untyped records,
 * and parameters outside this surface are intentionally not forwarded.
 */
export interface ChatModelParams {
  temperature?: number;
  modelKwargs?: Record<string, unknown>;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

/**
 * Everything an adapter needs to construct a chat model for one resolved
 * target. Credentials arrive already broker-resolved; gateway transport
 * arrives already reduced to a base URL + headers. Adapters stay dumb.
 */
export interface ModelAdapterContext {
  target: ResolvedModelTarget;
  /** Final wire model id (gateway compat style namespaces it `provider/model`). */
  modelId: string;
  /** Broker-resolved API key for the upstream provider (when applicable). */
  apiKey?: string;
  /** Transport override (AI Gateway): base URL replacing the provider's. */
  baseURL?: string;
  /** Transport headers (e.g. `cf-aig-authorization`). */
  defaultHeaders?: Record<string, string>;
  /** Narrowed params, caller-over-policy merged by the provider layer. */
  params: ChatModelParams;
}

export type ModelAdapterFactory = (ctx: ModelAdapterContext) => BaseChatModel;

const adapters = new Map<string, ModelAdapterFactory>();

/**
 * Register a provider adapter. New providers are an adapter registration in
 * boot code — not a framework release, and never a configuration string
 * pointing at arbitrary code.
 */
export function registerModelAdapter(
  name: string,
  factory: ModelAdapterFactory,
): void {
  adapters.set(name, factory);
}

export function getModelAdapter(name: string): ModelAdapterFactory {
  const factory = adapters.get(name);
  if (!factory) {
    throw new Error(
      `No model adapter registered for provider '${name}'. Registered: ${[...adapters.keys()].join(', ') || '(none)'}.`,
    );
  }
  return factory;
}

export function registeredModelAdapters(): string[] {
  return [...adapters.keys()];
}

/**
 * Reduce an AI Gateway transport declaration to the base URL + model id the
 * OpenAI-compatible SDK needs. `compat` style uses the unified endpoint
 * (model ids namespaced `provider/model`, gateway dynamic routes usable as
 * model names); `provider` style mounts the provider's own path.
 */
export function buildGatewayTransport(
  gateway: NonNullable<ResolvedModelTarget['gateway']>,
  provider: string,
  model: string,
  authToken: string,
): { baseURL: string; model: string; headers: Record<string, string> } {
  const root = `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.gatewayId}`;
  const headers = { 'cf-aig-authorization': `Bearer ${authToken}` };
  if (gateway.urlStyle === 'provider') {
    return { baseURL: `${root}/${provider}`, model, headers };
  }
  return { baseURL: `${root}/compat`, model: `${provider}/${model}`, headers };
}
