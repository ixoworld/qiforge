/**
 * The network edge shared by the chain REST and Blocksync reads: one bounded
 * HTTP exchange per attempt and the retry policy around it. Upstream
 * failures become a {@link Failure} the tools hand to the model; nothing
 * here throws for them. Only the turn's own abort is rethrown.
 */
import {
  boundedBytes,
  fetchWithoutRedirects,
} from '../../core/domain-context/transport';

export type Source = 'chain' | 'blocksync';

export type FailureReason =
  | 'rate_limited'
  | 'timeout'
  | 'index_timeout'
  | 'unavailable'
  | 'not_found'
  | 'too_large'
  | 'invalid_input';

/** Why a read failed: a code, the plain sentence the model relays, and whether asking again can help. */
export interface Failure {
  reason: FailureReason;
  detail: string;
  retryable: boolean;
}

/**
 * The one retry waits a uniform 1–3 s when the upstream names no
 * `Retry-After`, so isolates that failed together do not retry together.
 */
export const RETRY_DELAY_MIN_MS = 1_000;
export const RETRY_DELAY_MAX_MS = 3_000;
/** Longest `Retry-After` honoured. */
export const MAX_RETRY_DELAY_MS = 5_000;
/** Whole-tool budget: every attempt and wait of one tool call fits inside it. */
export const TOOL_BUDGET_MS = 20_000;
/** A read, or its retry, is not started with less time than this left in the budget. */
export const MIN_ATTEMPT_MS = 1_000;
/** How long a 429 or 503 answers the isolate's other reads of that upstream without asking it. */
export const UNHEALTHY_MS = 10_000;

const SOURCE_NAME: Record<Source, string> = {
  chain: 'The chain node',
  blocksync: 'Blocksync',
};

function rateLimited(source: Source): Failure {
  return {
    reason: 'rate_limited',
    detail: `${SOURCE_NAME[source]} is rate-limiting requests; try again in a few seconds.`,
    retryable: true,
  };
}

function timedOut(source: Source): Failure {
  return {
    reason: 'timeout',
    detail:
      source === 'blocksync'
        ? 'Blocksync did not answer in time; narrow the question (fewer rows or requests).'
        : 'The chain node did not answer in time; try again shortly.',
    retryable: true,
  };
}

export const tooLarge = (detail: string): Failure => ({
  reason: 'too_large',
  detail,
  retryable: false,
});

export function unavailable(
  source: Source,
  why: string,
  retryable: boolean,
): Failure {
  return {
    reason: 'unavailable',
    detail: `${SOURCE_NAME[source]} is unavailable right now (${why}).`,
    retryable,
  };
}

/** What one tool call's reads share: where they go, the budget and the turn's abort. */
export interface ChainCall {
  network: 'mainnet' | 'testnet' | 'devnet';
  restUrl: string;
  blocksyncUrl: string;
  /** Epoch ms by which every read of the call has finished. */
  deadline: number;
  signal: AbortSignal;
  fetch: typeof fetch;
}

/**
 * One attempt's outcome. `retry` asks for the policy's one retry: on a
 * failure it is the failure's, on a value it means the answer was
 * transient (a GraphQL "transaction aborted") and is kept if the retry
 * cannot run or fails.
 */
export type Attempt<T> =
  | { ok: true; value: T; retry?: false }
  | { ok: true; value: T; retry: true; note: string }
  | {
      ok: false;
      failure: Failure;
      retry: boolean;
      retryAfterMs?: number;
      /** A 429 or 503: the upstream is marked unhealthy for {@link UNHEALTHY_MS}. */
      unhealthy?: true;
      /** An expected answer rather than a fault (a 404 the caller asked for): not logged. */
      quiet?: true;
      /** Log text: status or error class, never a request body or an address. */
      note: string;
    };

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; failure: Failure };

/** The turn's abort reason as an error (a non-error reason becomes an `AbortError`). */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

/** Throws the turn's abort reason once the turn is aborted. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/** Resolves after `ms`; rejects with the turn's abort reason if it ends first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The wait before the one retry when the upstream named none: uniform in 1–3 s. */
export function retryDelayMs(): number {
  return Math.round(
    RETRY_DELAY_MIN_MS +
      Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS),
  );
}

/**
 * Upstreams that answered 429 or 503 within the last {@link UNHEALTHY_MS},
 * keyed by base URL, with the failure that marked them. Per isolate: every
 * call of the isolate answers with it instead of asking the upstream again.
 */
const unhealthy = new Map<string, { until: number; failure: Failure }>();

/** Tests only: forget every unhealthy mark. */
export function resetUpstreamHealth(): void {
  unhealthy.clear();
}

function heldBack(upstream: string): Failure | null {
  const mark = unhealthy.get(upstream);
  if (!mark) return null;
  if (mark.until > Date.now()) return mark.failure;
  unhealthy.delete(upstream);
  return null;
}

/** An answer clears the upstream's mark; a 429 or 503 sets it. */
function recordHealth(upstream: string, attempt: Attempt<unknown>): void {
  if (attempt.ok) unhealthy.delete(upstream);
  else if (attempt.unhealthy)
    unhealthy.set(upstream, {
      until: Date.now() + UNHEALTHY_MS,
      failure: attempt.failure,
    });
}

/** One logical read: its log label and the base URL its health is kept under. */
export interface Read {
  label: string;
  upstream: string;
}

/**
 * Runs `attempt`, and once more when it asks for a retry and the budget
 * leaves room: after `Retry-After` (capped at 5 s) when the upstream sent
 * one, else after a uniform 1–3 s. An upstream marked unhealthy is not
 * asked at all; the call's own retry is. A transient answer is kept when
 * its retry fails. Each failed attempt logs one line, except an expected
 * (`quiet`) answer.
 */
export async function withRetry<T>(
  call: ChainCall,
  read: Read,
  attempt: () => Promise<Attempt<T>>,
): Promise<Outcome<T>> {
  const held = heldBack(read.upstream);
  if (held) {
    console.warn(
      `[ixo-chain] ${read.label} not attempted: the upstream answered ${held.reason === 'rate_limited' ? '429' : '503'} moments ago`,
    );
    return { ok: false, failure: held };
  }
  const first = await attempt();
  recordHealth(read.upstream, first);
  if (first.ok && !first.retry) return { ok: true, value: first.value };
  if (first.ok || !first.quiet)
    console.warn(`[ixo-chain] ${read.label} attempt 1 failed: ${first.note}`);
  const wait =
    !first.ok && first.retryAfterMs !== undefined
      ? Math.min(first.retryAfterMs, MAX_RETRY_DELAY_MS)
      : retryDelayMs();
  const giveUp = (): Outcome<T> =>
    first.ok
      ? { ok: true, value: first.value }
      : { ok: false, failure: first.failure };
  if (!first.retry || Date.now() + wait + MIN_ATTEMPT_MS > call.deadline)
    return giveUp();
  await sleep(wait, call.signal);
  const second = await attempt();
  recordHealth(read.upstream, second);
  if (second.ok) {
    if (second.retry)
      console.warn(
        `[ixo-chain] ${read.label} attempt 2 failed: ${second.note}`,
      );
    return { ok: true, value: second.value };
  }
  console.warn(`[ixo-chain] ${read.label} attempt 2 failed: ${second.note}`);
  return first.ok
    ? { ok: true, value: first.value }
    : { ok: false, failure: second.failure };
}

/**
 * `Retry-After` in ms: delta seconds or an HTTP date. Undefined when absent,
 * unreadable, zero or in the past, so the default wait applies.
 */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  const ms = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

const REDIRECTED = 'ixo-chain-redirect';

/**
 * One bounded HTTP exchange: at most `timeoutMs` (and never past the call's
 * deadline) including the body read, no redirects followed, the body cut
 * off at `maxBytes`; the answer is the body text. Only a 2xx body is read.
 * 429/502/503/504 and network errors ask for a retry; anything else is a
 * failure the retry cannot fix. A 404 is `unavailable` (a wrong route or
 * gateway) unless the caller reads a resource that may be absent
 * (`notFoundOn404`): then it is a quiet `not_found`.
 */
export async function exchange(
  call: ChainCall,
  source: Source,
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; maxBytes: number; notFoundOn404?: boolean },
): Promise<Attempt<string>> {
  throwIfAborted(call.signal);
  const budget = Math.min(opts.timeoutMs, call.deadline - Date.now());
  if (budget <= 0)
    return {
      ok: false,
      failure: timedOut(source),
      retry: false,
      note: 'no budget left',
    };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  const onAbort = () => controller.abort();
  call.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchWithoutRedirects(
      call.fetch,
      url,
      { ...init, signal: controller.signal },
      REDIRECTED,
    );
    const { status } = response;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (status === 429)
        return {
          ok: false,
          failure: rateLimited(source),
          retry: true,
          unhealthy: true,
          note: 'HTTP 429',
          ...optionalRetryAfter(response.headers.get('retry-after')),
        };
      if (status === 502 || status === 503 || status === 504)
        return {
          ok: false,
          failure: unavailable(source, `HTTP ${status}`, true),
          retry: true,
          ...(status === 503 ? { unhealthy: true } : {}),
          note: `HTTP ${status}`,
          ...optionalRetryAfter(response.headers.get('retry-after')),
        };
      if (status === 404 && opts.notFoundOn404)
        return {
          ok: false,
          failure: {
            reason: 'not_found',
            detail: 'Nothing was found for that request.',
            retryable: false,
          },
          retry: false,
          quiet: true,
          note: 'HTTP 404',
        };
      // 501 says the route is not implemented: asking again cannot help.
      return {
        ok: false,
        failure: unavailable(
          source,
          `HTTP ${status}`,
          status >= 500 && status !== 501,
        ),
        retry: false,
        note: `HTTP ${status}`,
      };
    }
    const bytes = await boundedBytes(response, opts.maxBytes);
    return { ok: true, value: new TextDecoder().decode(bytes) };
  } catch (error) {
    throwIfAborted(call.signal);
    if (controller.signal.aborted)
      return {
        ok: false,
        failure: timedOut(source),
        retry: false,
        note: `timeout after ${budget} ms`,
      };
    if (error instanceof Error && error.message === REDIRECTED)
      return {
        ok: false,
        failure: unavailable(source, 'it redirected the request', false),
        retry: false,
        note: 'redirect refused',
      };
    if (error instanceof Error && error.message === 'document-too-large')
      return {
        ok: false,
        failure: tooLarge(
          'The answer was too large to read; ask for fewer rows or a narrower filter.',
        ),
        retry: false,
        note: `body over ${opts.maxBytes} bytes`,
      };
    return {
      ok: false,
      failure: unavailable(source, 'network error', true),
      retry: true,
      note: `network error (${error instanceof Error ? error.name : 'unknown'})`,
    };
  } finally {
    clearTimeout(timer);
    call.signal.removeEventListener('abort', onAbort);
  }
}

function optionalRetryAfter(header: string | null): { retryAfterMs?: number } {
  const ms = retryAfterMs(header);
  return ms === undefined ? {} : { retryAfterMs: ms };
}
