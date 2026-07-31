/**
 * Chat-model construction for BYO (bring-your-own-credential) turns.
 *
 * Counterpart of `getProviderChatModel` for the platform providers: given a
 * resolved user credential and a provider-native model id, returns a LangChain
 * chat model wired to the user's own account. Deliberately does NOT reuse the
 * OpenRouter factory path — `require_parameters`, `models` fallbacks and the
 * `reasoning` modelKwargs block are OpenRouter wire format and break direct
 * provider APIs.
 */

import {
  getChatAnthropicModel,
  getChatOpenAiModel,
  type ChatAnthropicFields,
} from '@ixo/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import type { ByoCredential } from './byo-catalog.js';
import type { ProviderModelRole } from './llm-provider.js';

type ChatOpenAIFields = Parameters<typeof getChatOpenAiModel>[0];

/** OpenAI-compatible base URLs for the API-key providers that need one. */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const GEMINI_OPENAI_COMPAT_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/';

/**
 * ChatGPT-backend wire constants — the endpoint the Codex client family uses
 * to run models on a subscription. The base URL is joined with `/responses`
 * by the OpenAI SDK when `useResponsesApi` is on.
 */
export const CHATGPT_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CHATGPT_ORIGINATOR = 'codex_cli_rs';

const chatGptHttpLogger = new Logger('ByoChatGptClient');

/**
 * The ChatGPT backend reports request errors with an empty body more often
 * than not, which the OpenAI SDK surfaces as an opaque "<status> status code
 * (no body)". Log the status and whatever body text exists (never the
 * request, which carries the bearer token) before handing the response to
 * the SDK. Success responses pass through untouched.
 */
const chatGptDiagnosticFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok) {
    let body = '';
    try {
      body = (await response.clone().text()).slice(0, 500);
    } catch {
      // Body unreadable — the status line alone will have to do.
    }
    chatGptHttpLogger.warn(
      `ChatGPT backend ${response.status} ${response.statusText}: ${body || '<empty body>'}`,
    );
  }
  return response;
};

export interface CreateByoChatModelArgs {
  credential: ByoCredential;
  /** Provider-native model id (already role-translated by the caller). */
  modelId: string;
  role: ProviderModelRole | string;
  /** Caller overrides, e.g. temperature. `model`/`apiKey` are set here. */
  params?: ChatOpenAIFields;
}

/**
 * Build the chat model for a BYO turn. The credential's access token / API
 * key lives only inside the returned client instance — it is never placed on
 * the request context, graph state, or trace metadata.
 */
export function createByoChatModel(
  args: CreateByoChatModelArgs,
): BaseChatModel {
  const { credential, modelId, role, params } = args;
  // Guard/classification roles run cold, generative roles match the platform
  // default — same policy as the platform factory. Only the `deepseek` and
  // `gemini` branches send it: GPT-5-family models (the `openai` and
  // `chatgpt` catalogs) and the Claude 5 family reject/deprecate sampling
  // params with a 400, so those branches force `temperature: undefined`
  // AFTER the spreads — the common factories inject a 0.2 default otherwise.
  const temperature = role === 'guard' ? 0 : 0.8;
  // LangChain's AsyncCaller default is SIX retries with exponential backoff
  // — a rate-limited BYO account would leave the user staring at
  // "Thinking..." for a minute before any error surfaces. Two attempts keep
  // transient-blip resilience while failing fast enough to report.
  const maxRetries = 2;

  switch (credential.provider) {
    case 'openai':
      return getChatOpenAiModel({
        __includeRawResponse: true,
        maxRetries,
        ...params,
        model: modelId,
        apiKey: credential.apiKey,
        temperature: undefined,
        topP: undefined,
      });

    case 'deepseek':
      return getChatOpenAiModel({
        temperature,
        __includeRawResponse: true,
        maxRetries,
        ...params,
        model: modelId,
        apiKey: credential.apiKey,
        configuration: {
          baseURL: DEEPSEEK_BASE_URL,
          ...params?.configuration,
        },
      });

    case 'gemini':
      return getChatOpenAiModel({
        temperature,
        __includeRawResponse: true,
        maxRetries,
        ...params,
        model: modelId,
        apiKey: credential.apiKey,
        configuration: {
          baseURL: GEMINI_OPENAI_COMPAT_BASE_URL,
          ...params?.configuration,
        },
      });

    case 'anthropic': {
      const anthropicParams: ChatAnthropicFields = {
        model: modelId,
        apiKey: credential.apiKey,
        temperature: undefined,
        maxRetries,
      };
      return getChatAnthropicModel(anthropicParams);
    }

    case 'chatgpt': {
      // The ChatGPT backend speaks the Responses API only, streamed only,
      // stateless only — `useResponsesApi` + `streaming` + `store: false` are
      // all load-bearing. Auth is the subscription access token (refreshed
      // upstream by ByoLlmService before this is constructed) plus the
      // account-id header from the token's `chatgpt_account_id` claim.
      // `session-id` (Codex spelling) and `session_id` (proxy spelling) are
      // distinct headers upstream — send both. The backend rejects sampling
      // params (`temperature`/`top_p`) the way the standard API does for
      // reasoning models, and reports request errors with an EMPTY body —
      // hence the diagnostic fetch, which logs the status + body of any
      // non-OK response before the SDK swallows it.
      const sessionId = crypto.randomUUID();
      return getChatOpenAiModel({
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
        // After the spreads: the common factory injects a 0.2 temperature
        // default and the backend hard-rejects sampling params.
        temperature: undefined,
        topP: undefined,
        configuration: {
          baseURL: CHATGPT_BACKEND_BASE_URL,
          fetch: chatGptDiagnosticFetch,
          ...params?.configuration,
          defaultHeaders: {
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
          ...params?.modelKwargs,
        },
      });
    }
  }
}
