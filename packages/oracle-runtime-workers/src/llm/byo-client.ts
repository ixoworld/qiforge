/**
 * Chat-model construction for BYO (bring-your-own-credential) turns — the
 * Workers port of the Node runtime's `llm/byo-client.ts`. Given a resolved
 * user credential and a provider-native model id, returns a LangChain chat
 * model wired to the user's own account. Deliberately does NOT reuse the
 * OpenRouter factory path — `require_parameters`, `models` fallbacks and the
 * `reasoning` modelKwargs block are OpenRouter wire format and break direct
 * provider APIs.
 *
 * One Workers-specific difference from Node: the `anthropic` branch speaks to
 * Anthropic's official OpenAI SDK-compatibility endpoint
 * (`https://api.anthropic.com/v1/`) through `ChatOpenAI` instead of
 * `ChatAnthropic` — `@langchain/anthropic` is not part of this package's
 * dependency set. Model ids and the user's API key are unchanged.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import type { ChatOpenAIFields, Logger } from '../plugin-api/types';
import type { ProviderModelRole } from '../core/llm';
import type { ByoCredential } from './byo-catalog';

/** OpenAI-compatible base URLs for the API-key providers that need one. */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const GEMINI_OPENAI_COMPAT_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/';
/** Anthropic's OpenAI SDK-compatibility endpoint (see module docblock). */
export const ANTHROPIC_OPENAI_COMPAT_BASE_URL = 'https://api.anthropic.com/v1/';

/**
 * ChatGPT-backend wire constants — the endpoint the Codex client family uses
 * to run models on a subscription. The base URL is joined with `/responses`
 * by the OpenAI SDK when `useResponsesApi` is on.
 */
export const CHATGPT_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/**
 * Where ChatGPT-subscription requests go. `chatgpt.com` answers Cloudflare
 * Workers egress with an HTML 403 before any authentication, so a deployment
 * can point this lane at a transparent proxy on a non-Cloudflare host
 * (`ixo-proxy-app`, one container per upstream) that forwards to the Codex
 * backend byte for byte; the proxy's own gate is a shared secret in
 * `X-Proxy-Auth`. Nothing else changes: the user's bearer token, the
 * account header and the SSE stream pass through untouched. The OAuth
 * device flow and token refresh (`auth.openai.com`) are reachable from
 * Workers and never go through the proxy.
 */
export interface ChatGptBackendConfig {
  /** Base URL standing in for `CHATGPT_BACKEND_BASE_URL`, no trailing slash. */
  baseUrl: string;
  /** Sent as `X-Proxy-Auth: Bearer <token>` when set. */
  proxyAuthToken?: string;
}

export const DEFAULT_CHATGPT_BACKEND: ChatGptBackendConfig = {
  baseUrl: CHATGPT_BACKEND_BASE_URL,
};

/**
 * `BYO_CHATGPT_BACKEND_URL` (+ `BYO_CHATGPT_PROXY_AUTH_TOKEN`) → config.
 * Unset or blank means the real backend. An invalid URL is a boot error,
 * not a silent fallback to the real backend that would be blocked anyway.
 */
export function chatGptBackendFromEnv(env: {
  BYO_CHATGPT_BACKEND_URL?: string;
  BYO_CHATGPT_PROXY_AUTH_TOKEN?: string;
}): ChatGptBackendConfig {
  const raw = env.BYO_CHATGPT_BACKEND_URL?.trim();
  if (!raw) return DEFAULT_CHATGPT_BACKEND;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`BYO_CHATGPT_BACKEND_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`BYO_CHATGPT_BACKEND_URL must be http(s): ${raw}`);
  const token = env.BYO_CHATGPT_PROXY_AUTH_TOKEN?.trim();
  return {
    baseUrl: raw.replace(/\/+$/, ''),
    ...(token ? { proxyAuthToken: token } : {}),
  };
}

/** Headers the proxy gate needs, if any. */
export function chatGptBackendHeaders(
  backend: ChatGptBackendConfig,
): Record<string, string> {
  return backend.proxyAuthToken
    ? { 'X-Proxy-Auth': `Bearer ${backend.proxyAuthToken}` }
    : {};
}
const CHATGPT_ORIGINATOR = 'codex_cli_rs';

/**
 * The ChatGPT backend reports request errors with an empty body more often
 * than not, which the OpenAI SDK surfaces as an opaque "<status> status code
 * (no body)". Log the status and whatever body text exists (never the
 * request, which carries the bearer token) before handing the response to
 * the SDK. Success responses pass through untouched.
 */
function chatGptDiagnosticFetch(logger: Logger): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (!response.ok) {
      let body = '';
      try {
        body = (await response.clone().text()).slice(0, 500);
      } catch {
        // Body unreadable — the status line alone will have to do.
      }
      logger.warn(
        `[byo-chatgpt] backend ${response.status} ${response.statusText}: ${body || '<empty body>'}`,
      );
    }
    return response;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface CreateByoChatModelArgs {
  credential: ByoCredential;
  /** Provider-native model id (already role-translated by the caller). */
  modelId: string;
  role: ProviderModelRole | string;
  /** Caller overrides, e.g. temperature. `model`/`apiKey` are set here. */
  params?: ChatOpenAIFields;
  logger?: Logger;
  /** ChatGPT lane only: where requests go (default: the real backend). */
  chatGptBackend?: ChatGptBackendConfig;
}

const NOOP: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Build the chat model for a BYO turn. The credential's access token / API
 * key lives only inside the returned client instance — it is never placed on
 * the request context, graph state, or trace metadata.
 */
export function createByoChatModel(
  args: CreateByoChatModelArgs,
): BaseChatModel {
  const { credential, modelId, role, params } = args;
  const logger = args.logger ?? NOOP;
  const backend = args.chatGptBackend ?? DEFAULT_CHATGPT_BACKEND;
  // Guard/classification roles run cold, generative roles match the platform
  // default — same policy as the platform factory. Only the `deepseek` and
  // `gemini` branches send it: GPT-5-family models (the `openai` and
  // `chatgpt` catalogs) and the Claude 5 family reject/deprecate sampling
  // params with a 400, so those branches force `temperature: undefined`
  // AFTER the spreads.
  const temperature = role === 'guard' ? 0 : 0.8;
  // LangChain's AsyncCaller default is SIX retries with exponential backoff
  // — a rate-limited BYO account would leave the user staring at
  // "Thinking..." for a minute before any error surfaces. Two attempts keep
  // transient-blip resilience while failing fast enough to report.
  const maxRetries = 2;

  switch (credential.provider) {
    case 'openai':
      return new ChatOpenAI({
        __includeRawResponse: true,
        maxRetries,
        ...params,
        model: modelId,
        apiKey: credential.apiKey,
        temperature: undefined,
        topP: undefined,
      });

    case 'deepseek':
      return new ChatOpenAI({
        temperature,
        __includeRawResponse: true,
        maxRetries,
        ...params,
        model: modelId,
        apiKey: credential.apiKey,
        configuration: {
          baseURL: DEEPSEEK_BASE_URL,
          ...asRecord(params?.configuration),
        },
      });

    case 'gemini':
      return new ChatOpenAI({
        temperature,
        __includeRawResponse: true,
        maxRetries,
        ...params,
        model: modelId,
        apiKey: credential.apiKey,
        configuration: {
          baseURL: GEMINI_OPENAI_COMPAT_BASE_URL,
          ...asRecord(params?.configuration),
        },
      });

    case 'anthropic':
      // Claude 5 family: sampling params are rejected — force undefined
      // after the spreads, exactly like the openai/chatgpt branches.
      return new ChatOpenAI({
        __includeRawResponse: true,
        maxRetries,
        ...params,
        model: modelId,
        apiKey: credential.apiKey,
        temperature: undefined,
        topP: undefined,
        configuration: {
          baseURL: ANTHROPIC_OPENAI_COMPAT_BASE_URL,
          ...asRecord(params?.configuration),
        },
      });

    case 'chatgpt': {
      // The ChatGPT backend speaks the Responses API only, streamed only,
      // stateless only — `useResponsesApi` + `streaming` + `store: false` are
      // all load-bearing. Auth is the subscription access token (refreshed
      // upstream by WorkersByoService before this is constructed) plus the
      // account-id header from the token's `chatgpt_account_id` claim.
      // `session-id` (Codex spelling) and `session_id` (proxy spelling) are
      // distinct headers upstream — send both. The backend rejects sampling
      // params (`temperature`/`top_p`) the way the standard API does for
      // reasoning models, and reports request errors with an EMPTY body —
      // hence the diagnostic fetch.
      const sessionId = crypto.randomUUID();
      return new ChatOpenAI({
        __includeRawResponse: true,
        maxRetries,
        useResponsesApi: true,
        streaming: true,
        // Zero-data-retention mode matches the backend's mandatory
        // `store: false`: prior-turn reasoning is only replayed when it
        // carries `encrypted_content`, and raw `responseMetadata.output`
        // items (which the stateless backend cannot resolve) are never
        // echoed back. This also keeps foreign-provider reasoning kwargs in
        // checkpointed history out of the request.
        zdrEnabled: true,
        // Effort + human-readable reasoning summaries, exactly the pair the
        // Codex clients send — summaries feed the portal's thinking stream.
        reasoning: { effort: 'medium', summary: 'auto' },
        ...params,
        model: modelId,
        apiKey: credential.oauth.accessToken,
        // After the spreads: the backend hard-rejects sampling params.
        temperature: undefined,
        topP: undefined,
        configuration: {
          baseURL: backend.baseUrl,
          fetch: chatGptDiagnosticFetch(logger),
          ...asRecord(params?.configuration),
          defaultHeaders: {
            ...chatGptBackendHeaders(backend),
            'ChatGPT-Account-ID': credential.oauth.accountId,
            originator: CHATGPT_ORIGINATOR,
            'session-id': sessionId,
            session_id: sessionId,
          },
        },
        modelKwargs: {
          // Stateless mode is mandatory; encrypted reasoning content rides
          // along so multi-turn reasoning survives without server-side state.
          store: false,
          include: ['reasoning.encrypted_content'],
          ...asRecord(params?.modelKwargs),
        },
      });
    }
  }
}
