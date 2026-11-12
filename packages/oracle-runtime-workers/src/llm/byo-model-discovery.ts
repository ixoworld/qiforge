/**
 * Account-specific model discovery for the BYO lanes.
 *
 * The curated per-provider list (`BYO_PROVIDER_MODELS`) says which models the
 * runtime knows how to run, not which ones the user's account may use. Two
 * lanes can ask the provider:
 *
 *   - `openai`: `GET https://api.openai.com/v1/models` lists the models the
 *     key can use (`{ data: [{ id }] }`).
 *   - `chatgpt`: the Codex client family lists a subscription's models with
 *     `GET <backend>/models?client_version=<semver>` (`{ models: [{ slug,
 *     visibility, minimal_client_version, available_in_plans, … }] }`; the
 *     backend filters by plan and drops models whose `minimal_client_version`
 *     is above the version sent). The request goes through the same backend
 *     (or transparent proxy) as the lane's model calls.
 *
 * Every other provider has no discovery here: the picker keeps the curated
 * list and says so (`modelSource: 'catalog'`).
 *
 * The result is kept per user and provider in the host's `ByoStateStore`
 * (Durable Object storage), next to — never inside — the credential, whose
 * secret name and value shape are shared with the Node runtime and the
 * Portal. A failed discovery is kept too, briefly, so a provider that does
 * not answer is not asked on every picker refresh.
 */

import type { ByoCredential, ByoProvider } from './byo-catalog';
import {
  chatGptBackendHeaders,
  OPENAI_API_BASE_URL,
  type ChatGptBackendConfig,
} from './byo-client';

/**
 * The Codex release whose model catalog the ChatGPT backend is asked for.
 * The backend returns only models whose `minimal_client_version` is at or
 * below it, so it must not trail the models the curated list names
 * (`gpt-5.6-*` need 0.144.0).
 */
export const CHATGPT_MODELS_CLIENT_VERSION = '0.167.0';

/** The Codex client's `originator` header, as the model calls send it. */
const CHATGPT_ORIGINATOR = 'codex_cli_rs';

/** A discovered list is trusted this long before the next status asks again. */
export const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
/** A failed discovery is not retried before this. */
export const DISCOVERY_FAILURE_TTL_MS = 5 * 60 * 1000;

/** Providers that can list an account's models. */
export function canDiscoverModels(
  provider: ByoProvider,
): provider is 'openai' | 'chatgpt' {
  return provider === 'openai' || provider === 'chatgpt';
}

export type ByoModelDiscovery =
  | {
      /** The provider listed the account's models. */
      source: 'account';
      modelIds: string[];
      fetchedAt: number;
    }
  | {
      /** Discovery was impossible or failed: the curated list stands. */
      source: 'catalog';
      reason: string;
      fetchedAt: number;
    };

export type DiscoveryResult =
  | { ok: true; modelIds: string[] }
  | { ok: false; reason: string };

export interface DiscoverDeps {
  fetch: typeof fetch;
  chatGptBackend: ChatGptBackendConfig;
  timeoutMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `{ data: [{ id }] }` (OpenAI) → ids; `null` for any other shape. */
export function parseOpenAiModelList(body: unknown): string[] | null {
  const data = asRecord(body)?.['data'];
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const entry of data) {
    const id = asRecord(entry)?.['id'];
    if (typeof id !== 'string' || id.length === 0) return null;
    ids.push(id);
  }
  return ids;
}

/** `{ models: [{ slug }] }` (ChatGPT backend) → slugs; `null` for any other shape. */
export function parseChatGptModelList(body: unknown): string[] | null {
  const models = asRecord(body)?.['models'];
  if (!Array.isArray(models)) return null;
  const slugs: string[] = [];
  for (const entry of models) {
    const slug = asRecord(entry)?.['slug'];
    if (typeof slug !== 'string' || slug.length === 0) return null;
    slugs.push(slug);
  }
  return slugs;
}

/**
 * Ask the provider which models the credential can use. Never throws: a
 * provider that cannot be reached, answers with an error status or answers
 * with a shape this parser does not know is a `{ ok: false, reason }`, never
 * an empty list (an empty list would claim the account has no models).
 */
export async function discoverAccountModels(
  credential: ByoCredential,
  deps: DiscoverDeps,
): Promise<DiscoveryResult> {
  let url: string;
  let headers: Record<string, string>;
  if (credential.provider === 'openai') {
    url = `${OPENAI_API_BASE_URL}/models`;
    headers = { Authorization: `Bearer ${credential.apiKey}` };
  } else if (credential.provider === 'chatgpt') {
    url = `${deps.chatGptBackend.baseUrl}/models?client_version=${CHATGPT_MODELS_CLIENT_VERSION}`;
    headers = {
      ...chatGptBackendHeaders(deps.chatGptBackend),
      Authorization: `Bearer ${credential.oauth.accessToken}`,
      'ChatGPT-Account-ID': credential.oauth.accountId,
      originator: CHATGPT_ORIGINATOR,
    };
  } else {
    return {
      ok: false,
      reason: `${credential.provider} has no model listing the runtime reads`,
    };
  }

  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `the model listing could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: `the model listing answered HTTP ${response.status}`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'the model listing was not JSON' };
  }
  const modelIds =
    credential.provider === 'openai'
      ? parseOpenAiModelList(body)
      : parseChatGptModelList(body);
  return modelIds
    ? { ok: true, modelIds }
    : { ok: false, reason: 'the model listing had an unexpected shape' };
}

/** Stored form of a discovery, `null` for anything this code did not write. */
export function parseStoredDiscovery(raw: string): ByoModelDiscovery | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record || typeof record['fetchedAt'] !== 'number') return null;
  const fetchedAt = record['fetchedAt'];
  if (record['source'] === 'account') {
    const ids = record['modelIds'];
    return Array.isArray(ids) && ids.every((id) => typeof id === 'string')
      ? { source: 'account', modelIds: ids, fetchedAt }
      : null;
  }
  if (record['source'] === 'catalog' && typeof record['reason'] === 'string') {
    return { source: 'catalog', reason: record['reason'], fetchedAt };
  }
  return null;
}
