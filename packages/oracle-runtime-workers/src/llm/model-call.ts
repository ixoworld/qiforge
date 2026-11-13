/**
 * One record per platform model call: what was asked for, what answered,
 * what it cost and how long it took. The platform chat model
 * (`PlatformChatModel`) builds it when a call ends, logs it as one
 * `[llm-call] {…}` line, and hands it on: on the reply message as
 * `response_metadata.model_call`, or on the thrown error (`modelCallOf`).
 * The turn reads it from there for the plugins' `onModelCall` hook and, after
 * a fallback or an error, for OpenRouter's record of each provider attempt
 * (`fetchGenerationAttempts`).
 *
 * A record carries ids, model and provider names, counts and the error's
 * class: never message content, tool arguments, user ids or credentials.
 */
import { classifyLlmError } from './provider-error';

/** `response_metadata` key of a reply message's call record. */
export const MODEL_CALL_METADATA_KEY = 'model_call';

/** Property of a thrown error that holds the failed call's record. */
const MODEL_CALL_ERROR_KEY = '__modelCall';

export interface ModelCallRecord {
  /** The role the model was created for (`main`, `summarizer`, `routing`, …). */
  role: string;
  /** The model id the call asked for. */
  requestedModel: string;
  /** The model that answered, as the provider reported it. */
  servedModel?: string;
  /** The upstream provider that answered (OpenRouter's name, e.g. `OpenAI`). */
  provider?: string;
  /** OpenRouter's generation id (`gen-…`), for `GET /generation`. */
  generationId?: string;
  /** A fallback answered: another model, or a provider after the first one asked for. */
  fallback: boolean;
  /** A model from the call's `models` fallback list answered. */
  modelFallback: boolean;
  /** The requested model answered, from a provider other than the first in `provider.order`. */
  providerFallback: boolean;
  promptTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /** USD, as OpenRouter reported it (`usage.cost`). */
  costUsd?: number;
  durationMs: number;
  ok: boolean;
  finishReason?: string;
  /** The failure's class (`rate_limit`, `billing`, `auth`, `timeout`, `server`, `network`, `unknown`). */
  errorKind?: string;
  errorStatus?: number;
  errorCode?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** What one call has shown of itself so far (chunk by chunk, or whole). */
export interface CallObservation {
  generationId?: string;
  servedModel?: string;
  provider?: string;
  finishReason?: string;
  usage?: Record<string, unknown>;
}

/**
 * Take what a raw provider payload (a streamed chunk or a whole response,
 * OpenAI-compatible, with OpenRouter's `provider` field) says about the call.
 */
export function observeRawResponse(seen: CallObservation, raw: unknown): void {
  if (!isRecord(raw)) return;
  seen.generationId = str(raw.id) ?? seen.generationId;
  seen.servedModel = str(raw.model) ?? seen.servedModel;
  seen.provider = str(raw.provider) ?? seen.provider;
  if (isRecord(raw.usage)) seen.usage = raw.usage;
  const choice: unknown = Array.isArray(raw.choices)
    ? raw.choices[0]
    : undefined;
  if (isRecord(choice))
    seen.finishReason = str(choice.finish_reason) ?? seen.finishReason;
}

/** `openai/gpt-5.6-luna-20260709` and `openai/gpt-5.6-luna:nitro` are `openai/gpt-5.6-luna`. */
function sameModel(requested: string, served: string): boolean {
  const base = requested.split(':')[0]!;
  return (
    served === base || served.startsWith(`${base}-`) || served === requested
  );
}

/** `Amazon Bedrock` → `amazon-bedrock`, the slug `provider.order` uses. */
export function providerSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

export interface CallRequest {
  role: string;
  requestedModel: string;
  /** `provider.order` as sent, when the call sent one. */
  providerOrder?: readonly string[];
}

/** The record of a call that ended (`error` absent) or failed. */
export function buildModelCallRecord(
  request: CallRequest,
  seen: CallObservation,
  durationMs: number,
  error?: unknown,
): ModelCallRecord {
  const usage = seen.usage ?? {};
  const promptDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {};
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  const modelFallback =
    seen.servedModel !== undefined &&
    !sameModel(request.requestedModel, seen.servedModel);
  const first = request.providerOrder?.[0];
  const providerFallback =
    !modelFallback &&
    first !== undefined &&
    seen.provider !== undefined &&
    providerSlug(seen.provider) !== providerSlug(first);
  const record: ModelCallRecord = {
    role: request.role,
    requestedModel: request.requestedModel,
    ...(seen.servedModel ? { servedModel: seen.servedModel } : {}),
    ...(seen.provider ? { provider: seen.provider } : {}),
    ...(seen.generationId ? { generationId: seen.generationId } : {}),
    fallback: modelFallback || providerFallback,
    modelFallback,
    providerFallback,
    durationMs,
    ok: error === undefined,
  };
  const fields: Array<[keyof ModelCallRecord, number | undefined]> = [
    ['promptTokens', num(usage.prompt_tokens)],
    ['cachedTokens', num(promptDetails.cached_tokens)],
    ['cacheWriteTokens', num(promptDetails.cache_write_tokens)],
    ['outputTokens', num(usage.completion_tokens)],
    ['reasoningTokens', num(completionDetails.reasoning_tokens)],
    ['costUsd', num(usage.cost)],
  ];
  for (const [key, value] of fields)
    if (value !== undefined) Object.assign(record, { [key]: value });
  if (seen.finishReason) record.finishReason = seen.finishReason;
  if (error !== undefined) {
    const classified = classifyLlmError(error);
    record.errorKind = classified.kind;
    if (classified.status !== undefined) record.errorStatus = classified.status;
    const code = errorCode(error);
    if (code) record.errorCode = code;
  }
  return record;
}

/** The provider's error code (`code` on the error or its body), when there is one. */
function errorCode(error: unknown): string | undefined {
  if (!isRecord(error) && !(error instanceof Error)) return undefined;
  const direct: unknown = Reflect.get(error, 'code');
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (typeof direct === 'number') return String(direct);
  const body: unknown = Reflect.get(error, 'error');
  if (isRecord(body)) {
    const code = body.code;
    if (typeof code === 'string' && code.length > 0) return code;
    if (typeof code === 'number') return String(code);
  }
  return undefined;
}

/** Keep `record` on the thrown `error`, for whoever handles the failure. */
export function attachModelCall(error: unknown, record: ModelCallRecord): void {
  if (typeof error !== 'object' || error === null) return;
  try {
    Object.defineProperty(error, MODEL_CALL_ERROR_KEY, {
      value: record,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // A frozen error keeps no record; the log line still has it.
  }
}

function isModelCallRecord(value: unknown): value is ModelCallRecord {
  return (
    isRecord(value) &&
    typeof value.role === 'string' &&
    typeof value.requestedModel === 'string' &&
    typeof value.ok === 'boolean'
  );
}

/**
 * The call record of a reply message (`response_metadata.model_call`) or of
 * a failure (the error or any error in its `cause` chain), else undefined.
 */
export function modelCallOf(value: unknown): ModelCallRecord | undefined {
  if (isRecord(value) && isRecord(value.response_metadata)) {
    const meta: unknown = value.response_metadata[MODEL_CALL_METADATA_KEY];
    if (isModelCallRecord(meta)) return meta;
  }
  let current: unknown = value;
  for (let depth = 0; depth < 16; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const attached: unknown = Reflect.get(current, MODEL_CALL_ERROR_KEY);
    if (isModelCallRecord(attached)) return attached;
    current = Reflect.get(current, 'cause');
  }
  return undefined;
}

/** One provider OpenRouter tried for a generation, from its generation record. */
export interface GenerationAttempt {
  provider?: string;
  model?: string;
  status?: number;
  latencyMs?: number;
}

export interface FetchGenerationAttemptsOptions {
  apiKey: string;
  baseURL: string;
  generationId: string;
  fetch?: typeof fetch;
  /**
   * Waits before each try: OpenRouter answers 404 for a few seconds after a
   * call ends, until the record is written.
   */
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * OpenRouter's record of every provider it tried for `generationId`
 * (`GET /generation`, `provider_responses`), or undefined when the record
 * cannot be read after the last try.
 */
export async function fetchGenerationAttempts(
  options: FetchGenerationAttemptsOptions,
): Promise<GenerationAttempt[] | undefined> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const url = `${options.baseURL.replace(/\/+$/, '')}/generation?id=${encodeURIComponent(options.generationId)}`;
  for (const delay of options.delaysMs ?? [3000, 7000]) {
    await sleep(delay);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const body: unknown = await response.json();
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const attempts = data?.provider_responses;
    if (!Array.isArray(attempts)) return [];
    return attempts.filter(isRecord).map((attempt) => {
      const out: GenerationAttempt = {};
      const provider = str(attempt.provider_name);
      if (provider) out.provider = provider;
      const model = str(attempt.model_permaslug);
      if (model) out.model = model;
      const status = num(attempt.status);
      if (status !== undefined) out.status = status;
      const latency = num(attempt.latency);
      if (latency !== undefined) out.latencyMs = latency;
      return out;
    });
  }
  return undefined;
}
