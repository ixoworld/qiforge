/**
 * BYO degradation notices — the slice of the Node runtime's
 * `llm/provider-error.ts` the Workers runtime consumes: the payload emitted
 * when a turn silently degrades from the user's own credential to the
 * platform model. It rides the SSE `error` event channel (the only channel
 * existing clients surface) but is a warning, not a failure — the turn still
 * streams a reply.
 */

import {
  BYO_PROVIDER_INFO,
  isByoProvider,
  type ByoProvider,
} from './byo-catalog';

/** `kind` value for the BYO degradation notice. */
export const BYO_FALLBACK_KIND = 'byo_fallback';

export type ByoFallbackReason =
  | 'not_connected'
  | 'reconnect_required'
  | 'unreachable'
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
    reason === 'unreachable'
      ? `Your ${account} can't be reached from this oracle right now, so this reply is using the platform model instead.`
      : reason === 'reconnect_required'
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

export interface ClassifyLlmErrorContext {
  /** The BYO provider the failing turn ran on, when it was a BYO turn. */
  byoProvider?: ByoProvider | string | null;
}

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
