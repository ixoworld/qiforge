/**
 * BYO degradation notices — the slice of the Node runtime's
 * `llm/provider-error.ts` the Workers runtime consumes: the payload emitted
 * when a turn silently degrades from the user's own credential to the
 * platform model. It rides the SSE `error` event channel (the only channel
 * existing clients surface) but is a warning, not a failure — the turn still
 * streams a reply.
 */

import { isContextOverflowError } from '../core/context-window';
import {
  BYO_PROVIDER_INFO,
  BYO_PROVIDER_MODELS,
  isByoProvider,
  type ByoProvider,
} from './byo-catalog';
import { findProviderStall, type ProviderStallError } from './stream-liveness';

/** `kind` value for the BYO degradation notice. */
export const BYO_FALLBACK_KIND = 'byo_fallback';

export type ByoFallbackReason =
  | 'not_connected'
  | 'reconnect_required'
  | 'unreachable'
  | 'model_unavailable'
  | 'error';

export interface ByoFallbackNoticePayload {
  error: string;
  kind: typeof BYO_FALLBACK_KIND;
  source: 'byo';
  provider?: ByoProvider;
  providerLabel?: string;
  /** `model_unavailable` only: the provider-native id the provider refused. */
  model?: string;
  reason: ByoFallbackReason;
  retryable: false;
  timestamp: string;
}

export interface ByoFallbackNoticeOptions {
  /** `model_unavailable`: the provider-native model id that was refused. */
  modelId?: string;
}

/** Catalog label of a provider-native BYO model id, else the id itself. */
function byoModelLabel(provider: ByoProvider | undefined, modelId: string) {
  const entry = provider
    ? BYO_PROVIDER_MODELS[provider].find((m) => m.id === modelId)
    : undefined;
  return entry?.label ?? modelId;
}

/**
 * The user's account as the `model_unavailable` sentence names it: the
 * subscription is a plan, the API-key providers are accounts — the same
 * wording the classified-error messages use (`fallbackMessage`).
 */
function byoAccountPhrase(
  provider: ByoProvider | undefined,
  providerLabel: string | undefined,
): string {
  if (provider === 'chatgpt') return 'Your ChatGPT subscription';
  return providerLabel
    ? `Your ${providerLabel} account`
    : 'Your connected AI account';
}

export function buildByoFallbackNotice(
  reason: ByoFallbackReason,
  provider?: ByoProvider,
  opts?: ByoFallbackNoticeOptions,
): ByoFallbackNoticePayload {
  const providerLabel = provider
    ? BYO_PROVIDER_INFO[provider].label
    : undefined;
  const account = providerLabel ?? 'your connected AI account';
  const modelId = reason === 'model_unavailable' ? opts?.modelId : undefined;
  const message =
    reason === 'unreachable'
      ? `Your ${account} can't be reached from this oracle right now, so this reply is using the platform model instead.`
      : reason === 'reconnect_required'
        ? `Your ${account} connection has expired, so this reply is using the platform model instead. Reconnect it in your Personal Agent settings.`
        : reason === 'not_connected'
          ? `The model you selected needs a connected ${account}, so this reply is using the platform model instead. Connect it in your Personal Agent settings.`
          : reason === 'model_unavailable'
            ? `${byoAccountPhrase(provider, providerLabel)} doesn't offer ${modelId ? byoModelLabel(provider, modelId) : 'the model you selected'}, so this reply used the platform model instead. Pick another model in your Personal Agent settings.`
            : `Your connected AI account could not be used for this reply, so it is using the platform model instead.`;
  return {
    error: message,
    kind: BYO_FALLBACK_KIND,
    source: 'byo',
    ...(provider && { provider }),
    ...(providerLabel && { providerLabel }),
    ...(modelId && { model: modelId }),
    reason,
    retryable: false,
    timestamp: new Date().toISOString(),
  };
}

// ── LLM error classification (port of the Node runtime's provider-error) ──
// One classification is what becomes bytes on the SSE `error` channel; the
// Portal re-maps `kind` to localized copy, Matrix/Slack clients show
// `message`. `redactOperatorFault` runs at the wire so a platform-side
// billing/auth failure never leaks operator detail to end users.

export type LlmErrorKind =
  | 'rate_limit'
  | 'billing'
  | 'auth'
  | 'timeout'
  | 'server'
  | 'network'
  | 'unknown';

export interface ClassifiedLlmError {
  kind: LlmErrorKind;
  /** Where the failing credential lives — the user's own account or ours. */
  source: 'byo' | 'platform';
  /** Set on BYO turns; lets the client name the account that failed. */
  provider?: ByoProvider;
  /** Human label for the provider ("OpenAI API", "ChatGPT (subscription)"). */
  providerLabel?: string;
  /** HTTP status when one could be recovered. */
  status?: number;
  /** Whether an immediate identical retry has any chance of succeeding. */
  retryable: boolean;
  /** Human-readable message (English fallback for clients without their own error UI). */
  message: string;
  /** Raw provider text, for logs and support. */
  detail: string;
}

interface ErrorParts {
  status?: number;
  code?: string;
  text: string;
}

function extractErrorParts(error: unknown): ErrorParts {
  const text = error instanceof Error ? error.message : String(error);
  const parts: ErrorParts = { text };
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record['status'] === 'number') parts.status = record['status'];
    if (typeof record['code'] === 'string') parts.code = record['code'];
    if (error instanceof Error && error.name === 'InsufficientQuotaError') {
      parts.code = 'insufficient_quota';
    }
    const nested = record['error'];
    if (nested && typeof nested === 'object') {
      const nestedRecord = nested as Record<string, unknown>;
      if (!parts.code && typeof nestedRecord['code'] === 'string') {
        parts.code = nestedRecord['code'];
      }
      if (!parts.code && typeof nestedRecord['type'] === 'string') {
        parts.code = nestedRecord['type'];
      }
    }
    const response = record['response'];
    if (
      parts.status === undefined &&
      response &&
      typeof response === 'object' &&
      typeof (response as Record<string, unknown>)['status'] === 'number'
    ) {
      parts.status = (response as Record<string, unknown>)['status'] as number;
    }
  }
  if (parts.status === undefined) {
    const prefixed = /^(\d{3})\s/.exec(text);
    if (prefixed) parts.status = Number(prefixed[1]);
  }
  return parts;
}

const BILLING_TEXT =
  /insufficient[_ ]quota|insufficient balance|credit balance is too low|purchase credits|billing hard limit|payment required/i;
const RATE_LIMIT_TEXT =
  /rate[_ -]?limit|too many requests|usage[_ -]?limit|resource[_ -]?exhausted|tokens per min|requests per min/i;
const AUTH_TEXT =
  /incorrect api key|invalid api key|invalid x-api-key|authentication[_ ]error|permission[_ ]error|unauthorized|forbidden|token has expired|invalid bearer/i;
const TIMEOUT_TEXT = /timed?[_ ]?out|deadline exceeded|request timeout/i;
const NETWORK_TEXT =
  /fetch failed|network|econnrefused|econnreset|etimedout|eai_again|socket hang up|und_err/i;
const SERVER_TEXT =
  /internal server error|bad gateway|service unavailable|server[_ ]error|overloaded/i;

function detectKind(parts: ErrorParts): LlmErrorKind {
  const { status, code, text } = parts;
  if (code === 'insufficient_quota') return 'billing';
  if (code === 'rate_limit_error') return 'rate_limit';
  if (code === 'authentication_error' || code === 'permission_error') {
    return 'auth';
  }
  if (code === 'overloaded_error') return 'server';
  if (BILLING_TEXT.test(text)) return 'billing';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 429 || RATE_LIMIT_TEXT.test(text)) return 'rate_limit';
  if (status === 408 || status === 504 || TIMEOUT_TEXT.test(text)) {
    return 'timeout';
  }
  if (status !== undefined && status >= 500) return 'server';
  if (AUTH_TEXT.test(text)) return 'auth';
  if (NETWORK_TEXT.test(text)) return 'network';
  if (SERVER_TEXT.test(text)) return 'server';
  return 'unknown';
}

const RETRYABLE_KINDS: ReadonlySet<LlmErrorKind> = new Set([
  'rate_limit',
  'timeout',
  'server',
  'network',
]);

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function fallbackMessage(
  kind: LlmErrorKind,
  provider: ByoProvider | undefined,
  providerLabel: string | undefined,
): string {
  const account = providerLabel
    ? `your ${providerLabel} account`
    : 'the model provider';
  switch (kind) {
    case 'billing':
      return provider === 'chatgpt'
        ? 'Your ChatGPT subscription has no usage left. Check your plan, or switch to another model.'
        : `${capitalize(account)} is out of credit. Top up with the provider, or switch to another model.`;
    case 'rate_limit':
      return provider === 'chatgpt'
        ? "You've hit your ChatGPT plan's usage limit. Wait for it to reset, or switch to another model."
        : `${capitalize(account)} is being rate-limited. Wait a moment and try again.`;
    case 'auth':
      return providerLabel
        ? `Your ${providerLabel} credentials were rejected. Reconnect or update the key in your Personal Agent settings.`
        : 'The model provider rejected the credentials for this request.';
    case 'timeout':
      return 'The model took too long to respond. Please try again.';
    case 'server':
      return providerLabel
        ? `${providerLabel} is having trouble right now. Please try again shortly.`
        : 'The model provider is having trouble right now. Please try again shortly.';
    case 'network':
      return 'Could not reach the model provider. Please try again.';
    case 'unknown':
      return 'Something went wrong while generating the reply. Please try again.';
  }
}

/**
 * Failures of the platform model answering for a refused BYO model
 * (byo-model-fallback.ts). The turn is still a BYO turn, but such a failure
 * is the platform's: it must be classified (and redacted) as one, never
 * blamed on the user's account. Identity-keyed, so the error object itself
 * is left untouched.
 */
const PLATFORM_FALLBACK_FAILURES = new WeakSet<object>();

export function markPlatformFallbackFailure(error: unknown): void {
  if (error && typeof error === 'object') PLATFORM_FALLBACK_FAILURES.add(error);
}

/** The error, or one it wraps (`cause`, as LangChain's MiddlewareError does). */
function isPlatformFallbackFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== 'object') return false;
    if (PLATFORM_FALLBACK_FAILURES.has(current)) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

export interface ClassifyLlmErrorContext {
  /** The BYO provider the failing turn ran on, when it was a BYO turn. */
  byoProvider?: ByoProvider | string | null;
}

/**
 * What the user is told about a stalled call (`ProviderStallError`): a stall
 * mid-reply reads differently from a model that never started.
 */
function stallMessage(stall: ProviderStallError): string {
  return stall.phase === 'stream'
    ? 'The model stopped responding mid-reply. Please try again.'
    : 'The model did not start responding. Please try again.';
}

export function classifyLlmError(
  error: unknown,
  ctx?: ClassifyLlmErrorContext,
): ClassifiedLlmError {
  // A stall is found through the wrappers (the OpenAI SDK's
  // `APIConnectionError`, LangChain's middleware errors) by its `cause`.
  const stall = findProviderStall(error);
  const parts: ErrorParts = stall
    ? { text: stall.message }
    : extractErrorParts(error);
  const kind: LlmErrorKind = stall ? 'timeout' : detectKind(parts);
  const provider =
    typeof ctx?.byoProvider === 'string' &&
    isByoProvider(ctx.byoProvider) &&
    !isPlatformFallbackFailure(error)
      ? ctx.byoProvider
      : undefined;
  const providerLabel = provider
    ? BYO_PROVIDER_INFO[provider].label
    : undefined;
  return {
    kind,
    source: provider ? 'byo' : 'platform',
    ...(provider && { provider }),
    ...(providerLabel && { providerLabel }),
    ...(parts.status !== undefined && { status: parts.status }),
    retryable: RETRYABLE_KINDS.has(kind),
    message: stall
      ? stallMessage(stall)
      : fallbackMessage(kind, provider, providerLabel),
    detail: parts.text,
  };
}

// ── Model refused by the user's own provider ─────────────────────────────

/** Provider codes that name the model as the problem. */
const MODEL_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'model_not_found',
  'unsupported_model',
]);
/**
 * Provider texts that name the model as the problem: OpenAI's "The model `x`
 * does not exist or you do not have access to it", the ChatGPT backend's
 * "The 'x' model is not supported when using Codex with a ChatGPT account".
 */
const MODEL_UNAVAILABLE_TEXT =
  /model_not_found|unsupported[_ ]model|model\b[^.\n]{0,120}\b(?:does not exist|is not supported|not available)/i;
/** LangChain's code for a 400 about the request's tool messages. */
const INVALID_TOOL_RESULTS = 'INVALID_TOOL_RESULTS';

export interface ModelUnavailableOptions {
  /**
   * The failing call had already produced output (text, reasoning or a tool
   * call). Such a failure is never this case: the reply is under way and
   * the turn keeps today's error handling.
   */
  afterOutput?: boolean;
}

/**
 * Whether a BYO model call failed because the user's provider does not
 * serve the requested model — the ChatGPT backend answers an immediate
 * `400` with an empty body for a model id the subscription does not offer.
 *
 * Positive: an explicit model code or text (`model_not_found`, "does not
 * exist", "unsupported model", "is not supported") on a 400/403/404 or a
 * status-less error; or a bare HTTP 400/404 that is nothing else this module
 * or LangChain recognises (not a context overflow, not a malformed
 * tool-result history, not a billing/auth/rate/timeout/network/server
 * text). Never once the call produced output (`afterOutput`).
 */
export function isModelUnavailableError(
  error: unknown,
  opts?: ModelUnavailableOptions,
): boolean {
  if (opts?.afterOutput) return false;
  const parts = extractErrorParts(error);
  const { status, code, text } = parts;
  if (
    status !== undefined &&
    status !== 400 &&
    status !== 403 &&
    status !== 404
  ) {
    return false;
  }
  if (
    isContextOverflowError(error) ||
    (error instanceof Error && error.name === 'ContextOverflowError')
  ) {
    return false;
  }
  if (code && MODEL_UNAVAILABLE_CODES.has(code)) return true;
  if (MODEL_UNAVAILABLE_TEXT.test(text)) return true;
  if (status !== 400 && status !== 404) return false;
  if (
    error &&
    typeof error === 'object' &&
    'lc_error_code' in error &&
    error.lc_error_code === INVALID_TOOL_RESULTS
  ) {
    return false;
  }
  return detectKind(parts) === 'unknown';
}

const OPERATOR_FAULT_KINDS: ReadonlySet<LlmErrorKind> = new Set([
  'billing',
  'auth',
]);

/**
 * A platform-side billing/auth failure is the operator's problem, not the
 * user's: collapse it to a generic error before it reaches any client.
 */
export function redactOperatorFault(
  classified: ClassifiedLlmError,
): ClassifiedLlmError {
  if (
    classified.source !== 'platform' ||
    !OPERATOR_FAULT_KINDS.has(classified.kind)
  ) {
    return classified;
  }
  const message = fallbackMessage('unknown', undefined, undefined);
  return {
    kind: 'unknown',
    source: 'platform',
    status: 500,
    retryable: false,
    message,
    detail: message,
  };
}

export function isOperatorFault(classified: ClassifiedLlmError): boolean {
  return (
    classified.source === 'platform' &&
    OPERATOR_FAULT_KINDS.has(classified.kind)
  );
}
