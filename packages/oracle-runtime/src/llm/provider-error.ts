/**
 * Classification of model-provider failures into a stable, wire-friendly
 * shape. The raw errors thrown by the LangChain/OpenAI/Anthropic SDK stack
 * are wildly inconsistent — status on `error.status` or `error.response.
 * status` or only as a "429 ..." message prefix, billing exhaustion as a 429
 * (OpenAI `insufficient_quota`), a 400 (Anthropic "credit balance is too
 * low"), or a 402 (DeepSeek "Insufficient Balance") — and the ChatGPT
 * backend frequently reports errors with an empty body. Classifying here,
 * where the provider context is known, lets every downstream surface (SSE
 * error events, logs, the portal banner) speak one language.
 */

import {
  BYO_PROVIDER_INFO,
  isByoProvider,
  type ByoProvider,
} from './byo-catalog.js';

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
  /**
   * Human-readable message. English fallback for clients without their own
   * error UI (Matrix, Slack); the portal re-maps `kind` to localized copy.
   */
  message: string;
  /** The raw upstream message, for the collapsible details/support view. */
  detail: string;
}

interface ErrorParts {
  status?: number;
  code?: string;
  text: string;
}

/**
 * Pull status/code/message out of an unknown error without trusting any one
 * SDK's shape. Checks, in order: direct fields (`status`, `code`), the
 * OpenAI SDK's nested `error.error.{code,type}`, an axios-style
 * `error.response.status`, and finally a leading "NNN " message prefix.
 */
function extractErrorParts(error: unknown): ErrorParts {
  const text = error instanceof Error ? error.message : String(error);
  const parts: ErrorParts = { text };
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.status === 'number') parts.status = record.status;
    if (typeof record.code === 'string') parts.code = record.code;
    if (error instanceof Error && error.name === 'InsufficientQuotaError') {
      parts.code = 'insufficient_quota';
    }
    const nested = record.error;
    if (nested && typeof nested === 'object') {
      const nestedRecord = nested as Record<string, unknown>;
      if (!parts.code && typeof nestedRecord.code === 'string') {
        parts.code = nestedRecord.code;
      }
      // Anthropic puts the machine-readable type at `error.error.type`
      // ("rate_limit_error", "authentication_error", "overloaded_error").
      if (!parts.code && typeof nestedRecord.type === 'string') {
        parts.code = nestedRecord.type;
      }
    }
    const response = record.response;
    if (
      parts.status === undefined &&
      response &&
      typeof response === 'object' &&
      typeof (response as Record<string, unknown>).status === 'number'
    ) {
      parts.status = (response as Record<string, unknown>).status as number;
    }
  }
  if (parts.status === undefined) {
    const prefixed = /^(\d{3})\s/.exec(text);
    if (prefixed) parts.status = Number(prefixed[1]);
  }
  return parts;
}

// Deliberately does NOT match "exceeded your current quota": OpenAI's
// billing-exhaustion 429 carries that wording but ALWAYS pairs it with
// `code: insufficient_quota` (caught above via code/name), while Gemini's
// free-tier RATE limit reuses the identical sentence — for a bare quota
// message, rate-limit is the correct read.
const BILLING_TEXT =
  /insufficient[_ ]quota|insufficient balance|credit balance is too low|purchase credits|billing hard limit|payment required/i;
const RATE_LIMIT_TEXT =
  /rate[_ -]?limit|too many requests|usage[_ -]?limit|resource[_ -]?exhausted|tokens per min|requests per min/i;
const AUTH_TEXT =
  /incorrect api key|invalid api key|invalid x-api-key|authentication[_ ]error|permission[_ ]error|unauthorized|forbidden|token has expired|invalid bearer|account_deactivated/i;
const TIMEOUT_TEXT = /timed?[_ ]?out|deadline exceeded|request timeout/i;
const NETWORK_TEXT =
  /fetch failed|network|econnrefused|econnreset|etimedout|eai_again|socket hang up|und_err/i;
const SERVER_TEXT =
  /internal server error|bad gateway|service unavailable|server[_ ]error|overloaded/i;

function detectKind(parts: ErrorParts): LlmErrorKind {
  const { status, code, text } = parts;
  // Machine-readable codes are the most trustworthy signal — check first.
  if (code === 'insufficient_quota') return 'billing';
  if (code === 'rate_limit_error') return 'rate_limit';
  if (code === 'authentication_error' || code === 'permission_error') {
    return 'auth';
  }
  if (code === 'overloaded_error') return 'server';
  // Message text beats bare status: billing exhaustion hides behind 400s
  // (Anthropic) and 429s (OpenAI), so the wording is the discriminator.
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

/** English fallback copy per kind, personalized to the failing account. */
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

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * `kind` value for the notice emitted when a turn silently degrades from the
 * user's own credential to the platform model. Rides the SSE `error` event
 * channel (the only channel existing clients surface), but is a warning, not
 * a failure — the turn still streams a reply.
 */
export const BYO_FALLBACK_KIND = 'byo_fallback';

export type ByoFallbackReason =
  | 'not_connected'
  | 'reconnect_required'
  | 'error';

export interface ByoFallbackNoticePayload {
  error: string;
  kind: typeof BYO_FALLBACK_KIND;
  source: 'byo';
  provider?: ByoProvider;
  providerLabel?: string;
  reason: ByoFallbackReason;
  retryable: false;
  timestamp: string;
}

export function buildByoFallbackNotice(
  reason: ByoFallbackReason,
  provider?: ByoProvider,
): ByoFallbackNoticePayload {
  const providerLabel = provider
    ? BYO_PROVIDER_INFO[provider].label
    : undefined;
  const account = providerLabel ?? 'your connected AI account';
  const message =
    reason === 'reconnect_required'
      ? `Your ${account} connection has expired, so this reply is using the platform model instead. Reconnect it in your Personal Agent settings.`
      : reason === 'not_connected'
        ? `The model you selected needs a connected ${account}, so this reply is using the platform model instead. Connect it in your Personal Agent settings.`
        : `Your connected AI account could not be used for this reply, so it is using the platform model instead.`;
  return {
    error: message,
    kind: BYO_FALLBACK_KIND,
    source: 'byo',
    ...(provider && { provider }),
    ...(providerLabel && { providerLabel }),
    reason,
    retryable: false,
    timestamp: new Date().toISOString(),
  };
}

export interface ClassifyLlmErrorContext {
  /** The BYO provider active on the turn, when known. */
  byoProvider?: ByoProvider | string | null;
}

/**
 * Classify a model-call failure. Never throws; an unrecognizable error
 * degrades to `kind: 'unknown'` with the raw text preserved in `detail`.
 */
export function classifyLlmError(
  error: unknown,
  ctx?: ClassifyLlmErrorContext,
): ClassifiedLlmError {
  const parts = extractErrorParts(error);
  const kind = detectKind(parts);
  const provider =
    typeof ctx?.byoProvider === 'string' && isByoProvider(ctx.byoProvider)
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
    message: fallbackMessage(kind, provider, providerLabel),
    detail: parts.text,
  };
}

/**
 * Kinds that mean "the credential we used is the problem" — the account is
 * out of credit, or its key was rejected.
 */
const OPERATOR_FAULT_KINDS: ReadonlySet<LlmErrorKind> = new Set([
  'billing',
  'auth',
]);

/**
 * Strip operator-account failures before they reach a client.
 *
 * A `billing` / `auth` failure on `source: 'platform'` is OUR provider
 * account failing (out of credit, key revoked) — the end user did nothing
 * and can do nothing, so "top up with the provider" is both wrong and a leak:
 * the raw `detail` carries the upstream billing text and, on an auth failure,
 * the rejected key's prefix. It is also indistinguishable, at the client, from
 * the 402 the subscription middleware raises when the *user* runs out of
 * oracle credits. Present it as a generic server-side fault instead.
 *
 * BYO failures pass through untouched: there the failing account belongs to
 * the user, so the actionable copy is exactly what they need.
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
    // An identical retry hits the same exhausted account. Nothing to gain.
    retryable: false,
    message,
    detail: message,
  };
}

/** True when the failure is ours to fix (top up / rotate the key), not the user's. */
export function isOperatorFault(classified: ClassifiedLlmError): boolean {
  return (
    classified.source === 'platform' &&
    OPERATOR_FAULT_KINDS.has(classified.kind)
  );
}
