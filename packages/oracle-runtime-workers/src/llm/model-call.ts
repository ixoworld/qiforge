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

/**
 * Who pays the provider for a call: `platform` is the oracle's own key
 * (OpenRouter, Nebius, the Decision provider), `user` a bring-your-own-LLM
 * credential of the person (`BYO_LLM_ENABLED`), billed to their account.
 */
export type ModelCallPayer = 'platform' | 'user';

export interface ModelCallRecord {
  /** The role the model was created for (`main`, `summarizer`, `routing`, …). */
  role: string;
  /** Whose key the call ran on: the platform's, or the user's own (BYO). */
  paidBy: ModelCallPayer;
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
  /**
   * USD, as the provider reported it (OpenRouter's `usage.cost`, sent on
   * every response). The runtime never computes a price: absent when the
   * provider sent none (Nebius, a BYO provider, a Decision provider, a call
   * that failed before its usage arrived).
   */
  costUsd?: number;
  /**
   * The token counts are the runtime's chars/4 estimates, not the
   * provider's: a streamed platform call that failed or was aborted after
   * output started, before the provider's usage arrived. No `costUsd` then;
   * price it from the model's list price if you charge for it.
   */
  usageEstimated?: true;
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
  /** Defaults to `platform`. */
  paidBy?: ModelCallPayer;
}

/**
 * What a model call was for, as the runtime knows it at the call site:
 *
 * - `reply`: the main agent's model (a chat turn, a task run, the empty-reply
 *   retry);
 * - `summarization`: the turn's history compaction;
 * - `subagent`: a plugin sub-agent's model;
 * - `plugin`: a plugin's own `ctx.llm` call (in a tool, a middleware, a hook);
 * - `attachment`: reading a file into text (a turn's attachments,
 *   `view_attachment`, a document ingested into memory);
 * - `title`: the session title written after a turn;
 * - `group-summary`: a Matrix group room's channel-memory compaction;
 * - `routing`: a Decision that routes the turn (the capability router,
 *   channel conversation routing);
 * - `decision`: a plugin's `ctx.decisions` evaluation;
 * - `safety`: the host's safety-guardrail model;
 * - `other`: a model the runtime handed out without knowing its use.
 */
export type ModelCallPurpose =
  | 'reply'
  | 'summarization'
  | 'subagent'
  | 'plugin'
  | 'attachment'
  | 'title'
  | 'group-summary'
  | 'routing'
  | 'decision'
  | 'safety'
  | 'other';

export const MODEL_CALL_PURPOSES: readonly ModelCallPurpose[] = [
  'reply',
  'summarization',
  'subagent',
  'plugin',
  'attachment',
  'title',
  'group-summary',
  'routing',
  'decision',
  'safety',
  'other',
];

export function isModelCallPurpose(value: unknown): value is ModelCallPurpose {
  return MODEL_CALL_PURPOSES.some((purpose) => purpose === value);
}

/**
 * A call record as plugins get it (`OraclePlugin.onModelCall`,
 * `TurnUsage.calls`): the record plus what the runtime adds where it
 * reports the call.
 */
export interface ModelCallReport extends ModelCallRecord {
  purpose: ModelCallPurpose;
  /**
   * Unique per call attempt and reported once: the idempotency key of a
   * charge. A retried or fallback attempt is a new call with its own id.
   */
  callId: string;
  /** When the call started, epoch ms (`startedAt + durationMs` is its end). */
  startedAt: number;
}

/**
 * Every model call one attempt of a turn made, handed to
 * `OraclePlugin.onTurnUsage` once the attempt ended and every one of these
 * calls has been through `onModelCall` (the session title written after the
 * turn included). A run restarted after a reset is a new attempt with its
 * own report; `callId`s never repeat across them.
 */
export interface TurnModelUsage {
  requestId: string;
  runId: string;
  sessionId: string;
  /** How the attempt ended. */
  status: 'finished' | 'failed' | 'aborted' | 'interrupted';
  /** In the order they ended. */
  calls: readonly ModelCallReport[];
  /** Sum of `costUsd` over the platform-paid calls that reported one. */
  platformCostUsd: number;
  /** Platform-paid calls with no `costUsd` (a plugin prices them by tokens). */
  unpricedPlatformCalls: number;
}

/** The totals of a `TurnModelUsage`. */
export function turnModelUsageTotals(
  calls: readonly ModelCallReport[],
): Pick<TurnModelUsage, 'platformCostUsd' | 'unpricedPlatformCalls'> {
  let platformCostUsd = 0;
  let unpricedPlatformCalls = 0;
  for (const call of calls) {
    if (call.paidBy !== 'platform') continue;
    if (call.costUsd === undefined) unpricedPlatformCalls += 1;
    else platformCostUsd += call.costUsd;
  }
  return { platformCostUsd, unpricedPlatformCalls };
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
    paidBy: request.paidBy ?? 'platform',
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

/**
 * Calls whose reporter is waiting for their end, by LangChain run id. An
 * abort usually ends a streamed call without any end LangChain reports:
 * `Runnable.stream` races the signal outside the model's own loop and
 * abandons the stream, so neither `handleLLMEnd` nor `handleLLMError` is
 * called and the model never sees an error to put its record on. A model
 * that sees its signal abort hands its record to the call's reporter here
 * (`interruptCall`). Bounded: a call nobody ends (a consumer that stopped
 * reading without an abort) is dropped oldest first.
 */
const awaitingEnd = new Map<string, Array<(record: ModelCallRecord) => void>>();
const MAX_AWAITING_END = 1_024;

/** `end` receives the record of call `runId` if it is interrupted. */
export function awaitCallEnd(
  runId: string,
  end: (record: ModelCallRecord) => void,
): void {
  const ends = awaitingEnd.get(runId);
  if (ends) {
    ends.push(end);
    return;
  }
  if (awaitingEnd.size >= MAX_AWAITING_END) {
    const oldest = awaitingEnd.keys().next();
    if (!oldest.done) awaitingEnd.delete(oldest.value);
  }
  awaitingEnd.set(runId, [end]);
}

/** The call `runId` ended through its reporter's usual path. */
export function forgetCallEnd(runId: string): void {
  awaitingEnd.delete(runId);
}

/** The call `runId` was interrupted: hand its record to its reporters, once. */
export function interruptCall(runId: string, record: ModelCallRecord): void {
  const ends = awaitingEnd.get(runId);
  awaitingEnd.delete(runId);
  for (const end of ends ?? []) end(record);
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
    typeof value.ok === 'boolean' &&
    (value.paidBy === 'platform' || value.paidBy === 'user')
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
