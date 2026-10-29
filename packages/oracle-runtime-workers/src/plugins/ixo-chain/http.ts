/**
 * The network edge shared by the chain REST and Blocksync reads: one bounded
 * HTTP exchange per attempt, the retry policy around it, and the per-user
 * permits every attempt takes. Upstream failures become a {@link Failure}
 * the tools hand to the model; nothing here throws for them. Only the
 * turn's own abort is rethrown.
 */
import {
  boundedBytes,
  fetchWithoutRedirects,
} from '../../core/domain-context/transport';

/**
 * Where a read goes. `chain` and `blocksync` are ixo-chain's; the Yoma
 * plugin (`../yoma`) adds the Jambo worker's job list and the documents
 * entities link to (profiles, forms), under the same policy.
 */
export type Source = 'chain' | 'blocksync' | 'job-list' | 'document';

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
/**
 * Longest `Retry-After` waited for before the one retry; an upstream that
 * asks for a longer wait is not asked again by this call.
 */
export const MAX_RETRY_DELAY_MS = 5_000;
/** Whole-tool budget: every attempt and wait of one tool call fits inside it. */
export const TOOL_BUDGET_MS = 20_000;
/** An attempt, the first one included, is not started with less time than this left in the budget. */
export const MIN_ATTEMPT_MS = 1_000;
/**
 * How long a 429, 502, 503, 504 or network error answers the isolate's
 * other reads of that upstream without asking it.
 */
export const UNHEALTHY_MS = 10_000;
/**
 * Reads of one user in flight at once, across every ixo-chain tool call of
 * that user in the isolate: chain REST GETs, denom lookups and Blocksync
 * POSTs alike. Each attempt takes a permit and gives it back when its
 * answer is read, so a retry's wait holds none.
 */
export const USER_READ_PERMITS = 5;
/** The most of an error answer's body read (for its gRPC status code). */
export const ERROR_BODY_MAX_BYTES = 8 * 1024;

const SOURCE_NAME: Record<Source, string> = {
  chain: 'The chain node',
  blocksync: 'Blocksync',
  'job-list': 'The Yoma job list',
  document: 'The document host',
};

function rateLimited(source: Source): Failure {
  return {
    reason: 'rate_limited',
    detail: `${SOURCE_NAME[source]} is rate-limiting requests; try again in a few seconds.`,
    retryable: true,
  };
}

/** The upstream asked for a wait longer than this call waits: say how long. */
function rateLimitedFor(source: Source, waitMs: number): Failure {
  return {
    reason: 'rate_limited',
    detail: `${SOURCE_NAME[source]} is rate-limiting requests and asks to wait ${Math.ceil(waitMs / 1000)} s before asking again.`,
    retryable: true,
  };
}

/** The call's time budget ran out before a read could start or finish. */
export const BUDGET_SPENT: Failure = {
  reason: 'timeout',
  detail:
    "The tool's time budget ran out before this read could finish; ask again, or ask for less in one call.",
  retryable: true,
};

/** Whether the call has at least {@link MIN_ATTEMPT_MS} of its budget left. */
export function hasBudget(call: ChainCall): boolean {
  return call.deadline - Date.now() >= MIN_ATTEMPT_MS;
}

function timedOut(source: Source): Failure {
  return {
    reason: 'timeout',
    detail:
      source === 'blocksync'
        ? 'Blocksync did not answer in time; narrow the question (fewer rows or requests).'
        : `${SOURCE_NAME[source]} did not answer in time; try again shortly.`,
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

/** What one tool call's reads share: where they go, whose they are, the budget and the turn's abort. */
export interface ChainCall {
  network: 'mainnet' | 'testnet' | 'devnet';
  restUrl: string;
  blocksyncUrl: string;
  /**
   * The DID of the user the call reads for: every read of that user's
   * calls shares the user's {@link USER_READ_PERMITS} permits.
   */
  user: string;
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
      /** The upstream's `Retry-After`, at most {@link MAX_RETRY_DELAY_MS}. */
      retryAfterMs?: number;
      /**
       * A 429, 502, 503, 504 or network error: the upstream is marked
       * unhealthy for {@link UNHEALTHY_MS}.
       */
      unhealthy?: true;
      /** An expected answer rather than a fault (a 404 the caller asked for): not logged. */
      quiet?: true;
      /** The HTTP status the upstream answered, when it answered one. */
      status?: number;
      /** The error answer's body, for a status the caller asked to read it on. */
      errorBody?: string;
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

/**
 * `shared` (a read another call started) as this call waits for it: its
 * answer, or this turn's own abort reason as soon as this turn is aborted.
 * A joiner never throws another caller's abort for its own.
 */
export function untilAborted<T>(
  shared: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([shared, aborted]).finally(() =>
    signal.removeEventListener('abort', onAbort),
  );
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
 * Upstreams that answered 429, 502, 503 or 504, or failed with a network
 * error, within the last {@link UNHEALTHY_MS}, keyed by base URL, with the
 * failure that marked them and its log note. Per isolate: every call of
 * the isolate answers with that failure instead of asking the upstream
 * again. A timeout of our own never marks an upstream.
 */
const unhealthy = new Map<
  string,
  { until: number; failure: Failure; note: string }
>();

/** Tests only: forget every unhealthy mark. */
export function resetUpstreamHealth(): void {
  unhealthy.clear();
}

function heldBack(upstream: string): { failure: Failure; note: string } | null {
  const mark = unhealthy.get(upstream);
  if (!mark) return null;
  if (mark.until > Date.now()) return mark;
  unhealthy.delete(upstream);
  return null;
}

/** An answer clears the upstream's mark; an `unhealthy` failure sets it. */
function recordHealth(upstream: string, attempt: Attempt<unknown>): void {
  if (attempt.ok) unhealthy.delete(upstream);
  else if (attempt.unhealthy)
    unhealthy.set(upstream, {
      until: Date.now() + UNHEALTHY_MS,
      failure: attempt.failure,
      note: attempt.note,
    });
}

/** One logical read: its log label and the base URL its health is kept under. */
export interface Read {
  label: string;
  upstream: string;
  /** The log line's tag; `[ixo-chain]` unless the reading plugin names its own. */
  tag?: string;
}

/**
 * Runs `attempt`, and once more when it asks for a retry and the budget
 * leaves room: after `Retry-After` (at most 5 s: {@link exchange} asks no
 * retry for a longer one) when the upstream sent one, else after a uniform
 * 1–3 s. An upstream marked unhealthy is not asked at all; the call's own
 * retry is. A transient answer is kept when its retry fails. Each failed
 * attempt logs one line, except an expected (`quiet`) answer.
 */
export async function withRetry<T>(
  call: ChainCall,
  read: Read,
  attempt: () => Promise<Attempt<T>>,
): Promise<Outcome<T>> {
  const tag = read.tag ?? '[ixo-chain]';
  const held = heldBack(read.upstream);
  if (held) {
    console.warn(
      `${tag} ${read.label} not attempted: the upstream failed moments ago (${held.note})`,
    );
    return { ok: false, failure: held.failure };
  }
  const first = await attempt();
  recordHealth(read.upstream, first);
  if (first.ok && !first.retry) return { ok: true, value: first.value };
  if (first.ok || !first.quiet)
    console.warn(`${tag} ${read.label} attempt 1 failed: ${first.note}`);
  const wait =
    !first.ok && first.retryAfterMs !== undefined
      ? first.retryAfterMs
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
      console.warn(`${tag} ${read.label} attempt 2 failed: ${second.note}`);
    return { ok: true, value: second.value };
  }
  console.warn(`${tag} ${read.label} attempt 2 failed: ${second.note}`);
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

/* ── per-user permits ─────────────────────────────────────────────────── */

/** One user's permits: how many are taken, and the reads waiting for one, oldest first. */
interface Permits {
  taken: number;
  waiting: Set<() => void>;
}

/**
 * Per isolate, the permits of each user with a read in flight or waiting;
 * a user's entry is dropped as soon as none is.
 */
const permitsByUser = new Map<string, Permits>();

/** Tests only: how many users have a read in flight or waiting for a permit. */
export function usersReading(): number {
  return permitsByUser.size;
}

/** Gives a permit back: to the oldest waiting read, else to the user's pool. */
function releaserOf(user: string, permits: Permits): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = permits.waiting.values().next();
    if (!next.done) {
      next.value();
      return;
    }
    permits.taken -= 1;
    if (permits.taken === 0) permitsByUser.delete(user);
  };
}

/**
 * One of the call's user's {@link USER_READ_PERMITS} permits, as the
 * function that gives it back; null when none frees up while the call
 * still has {@link MIN_ATTEMPT_MS} of its budget left. Rejects with the
 * turn's abort reason when the turn ends while it waits.
 */
function takePermit(call: ChainCall): Promise<(() => void) | null> {
  const permits = permitsByUser.get(call.user) ?? {
    taken: 0,
    waiting: new Set<() => void>(),
  };
  permitsByUser.set(call.user, permits);
  if (permits.taken < USER_READ_PERMITS) {
    permits.taken += 1;
    return Promise.resolve(releaserOf(call.user, permits));
  }
  return new Promise((resolve, reject) => {
    const leave = () => {
      permits.waiting.delete(handOver);
      clearTimeout(timer);
      call.signal.removeEventListener('abort', onAbort);
    };
    // A released permit passes straight to this read: `taken` is unchanged.
    const handOver = () => {
      leave();
      resolve(releaserOf(call.user, permits));
    };
    const onAbort = () => {
      leave();
      reject(abortReason(call.signal));
    };
    const timer = setTimeout(
      () => {
        leave();
        resolve(null);
      },
      Math.max(0, call.deadline - MIN_ATTEMPT_MS - Date.now()),
    );
    permits.waiting.add(handOver);
    call.signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* ── one exchange ─────────────────────────────────────────────────────── */

/** An attempt the call's budget left no time for. */
const outOfBudget = (note: string): Attempt<never> => ({
  ok: false,
  failure: BUDGET_SPENT,
  retry: false,
  note,
});

/**
 * The body of an error answer as text, or undefined when it is longer than
 * {@link ERROR_BODY_MAX_BYTES} (the rest is not read).
 */
async function errorBodyOf(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.length;
      if (size > ERROR_BODY_MAX_BYTES) return undefined;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** What bounds one exchange, and which error bodies it reads. */
interface ExchangeOptions {
  timeoutMs: number;
  maxBytes: number;
  notFoundOn404?: boolean;
  /** Statuses whose error body is read (at most {@link ERROR_BODY_MAX_BYTES}) and returned. */
  errorBodyOn?: readonly number[];
}

/**
 * One bounded HTTP exchange, under one of the user's permits: it waits
 * for the permit first, and its timer starts once it holds one. At most
 * `timeoutMs` (and never past the call's deadline) including the body
 * read, no redirects followed, the body cut off at `maxBytes`; the answer
 * is the body text. No exchange starts with less than
 * {@link MIN_ATTEMPT_MS} of the budget left: that, like an exchange the
 * deadline cut short, is {@link BUDGET_SPENT}.
 *
 * Only a 2xx body is read, and an error body the caller names in
 * `errorBodyOn`. 429/502/503/504 and network errors mark the upstream
 * unhealthy and ask for a retry, unless the upstream asks to wait longer
 * than {@link MAX_RETRY_DELAY_MS} (`rate_limited`, the wait in the
 * detail); anything else is a failure the retry cannot fix. A 404 is
 * `unavailable` (a wrong route or gateway) unless the caller reads a
 * resource that may be absent (`notFoundOn404`): then it is a quiet
 * `not_found`.
 */
export async function exchange(
  call: ChainCall,
  source: Source,
  url: string,
  init: RequestInit,
  opts: ExchangeOptions,
): Promise<Attempt<string>> {
  throwIfAborted(call.signal);
  const release = await takePermit(call);
  if (!release) return outOfBudget('no permit before the budget ran out');
  try {
    return await exchangeHolding(call, source, url, init, opts);
  } finally {
    release();
  }
}

/** {@link exchange} once its permit is held. */
async function exchangeHolding(
  call: ChainCall,
  source: Source,
  url: string,
  init: RequestInit,
  opts: ExchangeOptions,
): Promise<Attempt<string>> {
  throwIfAborted(call.signal);
  const left = call.deadline - Date.now();
  if (left < MIN_ATTEMPT_MS) return outOfBudget('no budget left');
  const budget = Math.min(opts.timeoutMs, left);
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
      let errorBody: string | undefined;
      if (opts.errorBodyOn?.includes(status))
        errorBody = await errorBodyOf(response);
      else await response.body?.cancel().catch(() => undefined);
      if (
        status === 429 ||
        status === 502 ||
        status === 503 ||
        status === 504
      ) {
        const wait = retryAfterMs(response.headers.get('retry-after'));
        if (wait !== undefined && wait > MAX_RETRY_DELAY_MS)
          return {
            ok: false,
            failure: rateLimitedFor(source, wait),
            retry: false,
            unhealthy: true,
            status,
            note: `HTTP ${status}, Retry-After ${Math.ceil(wait / 1000)} s`,
          };
        return {
          ok: false,
          failure:
            status === 429
              ? rateLimited(source)
              : unavailable(source, `HTTP ${status}`, true),
          retry: true,
          unhealthy: true,
          status,
          note: `HTTP ${status}`,
          ...(wait !== undefined ? { retryAfterMs: wait } : {}),
        };
      }
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
          status,
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
        status,
        ...(errorBody !== undefined ? { errorBody } : {}),
        note: `HTTP ${status}`,
      };
    }
    const bytes = await boundedBytes(response, opts.maxBytes);
    return { ok: true, value: new TextDecoder().decode(bytes) };
  } catch (error) {
    throwIfAborted(call.signal);
    // Our own timer: the attempt's bound, or the call's deadline when that
    // came first. Neither says the upstream is unhealthy.
    if (controller.signal.aborted)
      return budget < opts.timeoutMs
        ? outOfBudget(`deadline reached after ${budget} ms`)
        : {
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
      unhealthy: true,
      note: `network error (${error instanceof Error ? error.name : 'unknown'})`,
    };
  } finally {
    clearTimeout(timer);
    call.signal.removeEventListener('abort', onAbort);
  }
}
