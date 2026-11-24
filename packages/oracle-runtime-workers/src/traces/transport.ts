/**
 * Delivery of a turn (and its start marker) to IXO Traces. One request per
 * turn, sent once inside the caller's `waitUntil`; nothing is queued for
 * later and nothing is kept after a failure: a failed send is counted and
 * logged by id, status and size, never by content.
 *
 * Connection discipline: the requests of one owner (a Durable Object passes
 * itself) go one after the other per kind, in two lanes: turns in one,
 * start markers in the other. So an object holds at most one traces
 * connection per kind next to the turn's own model and tool connections,
 * and a slow or failing marker never holds its turn back (the service takes
 * a marker that arrives after its turn and never downgrades the turn). A
 * request is always made and read inside the object that started it
 * (workerd refuses I/O on behalf of another object: the reason the
 * LangSmith client is per object too).
 *
 * What each answer means (the service's ingest contract, `docs/api.md`):
 * - 200 (duplicate), 201 (created), 202 (stored, index deferred): sent.
 * - 409: another body is stored under this trace id. An anomaly (a retry is
 *   always byte-identical, so it never causes one): counted, logged by id,
 *   never retried.
 * - 429: a turn waits `Retry-After` (plus jitter) and tries once more, when
 *   that is at most `MAX_RETRY_AFTER_MS`; a longer wait is not taken (the
 *   object must not stay busy for it): dropped and counted. A marker is
 *   dropped at once.
 * - 5xx, 408, a timeout or a network error: one retry after a jittered
 *   pause (a 503's `Retry-After` is honoured up to the same cap for a turn).
 * - 410 `gone` (or 404 `not_found`: the project is being deleted): dropped
 *   and counted, never retried, and every send with that write key pauses
 *   in this isolate for `GONE_PAUSE_MS`.
 * - Any other 4xx (400, 401, 403, 413, 415 …): refused, never retried;
 *   logged with the service's error code and the first issue's path (never
 *   values). "Unsupported contract version" pauses every send of the
 *   isolate for `VERSION_PAUSE_MS`, logged once per pause.
 *
 * Every retry sends the same bytes, so the service sees the same turn.
 */
import type { Logger } from '../plugin-api/types';
import type { TracesConfig } from './config';
import { CONTRACT_VERSION } from './contract';
import { RUNTIME_VERSION } from './runtime-version';

export type TraceRequestKind = 'turn' | 'start';

export type SendOutcome =
  /** 200, 201 or 202. */
  | 'sent'
  /** A 4xx other than 409 and 429: the service refused it; not retried. */
  | 'rejected'
  /** 409: another body is stored under this trace id; not retried. */
  | 'conflict'
  /** 429 on every attempt, or a `Retry-After` past the cap: dropped. */
  | 'rate_limited'
  /** 5xx, timeout or network error on every attempt. */
  | 'failed'
  /** Not sent: this owner already had `MAX_WAITING` requests of the kind waiting. */
  | 'skipped'
  /** 410 (or 404 `not_found`): the key's project is gone or being deleted; not retried. */
  | 'gone'
  /** Not sent: the service refused the contract version, or said the key's project is gone, a moment ago. */
  | 'paused';

/** Counters of this isolate, for logs and tests. Never reset by the runtime. */
export const traceSendStats = {
  turnsSent: 0,
  startsSent: 0,
  /** Turns the service stored but indexes later (202). */
  deferred: 0,
  rejected: 0,
  conflicts: 0,
  /** 410 `gone` (or 404 `not_found`): the key's project is deleted or being deleted. */
  gone: 0,
  rateLimited: 0,
  failed: 0,
  skipped: 0,
  /** Requests not sent while the contract version was refused. */
  paused: 0,
  /** Turns sent with payloads dropped to fit the size limit. */
  truncated: 0,
  /** Turns not sent because they could not be built or did not fit at all. */
  unbuildable: 0,
};

const PATHS: Record<TraceRequestKind, string> = {
  turn: '/v1/ingest/turns',
  start: '/v1/ingest/turns/start',
};

const TIMEOUT_MS: Record<TraceRequestKind, number> = {
  turn: 15_000,
  start: 5_000,
};

/** Pause before a retry: 250 ms plus up to 750 ms of jitter. */
const RETRY_BASE_MS = 250;
const RETRY_JITTER_MS = 750;
/** Jitter added to a `Retry-After` wait, so objects do not retry in step. */
const RETRY_AFTER_JITTER_MS = 1_000;

/**
 * The longest `Retry-After` a turn waits for. The wait runs in the object's
 * `waitUntil` with the built turn in memory and holds the owner's turn lane,
 * so it stays short; a longer one drops the turn (counted).
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** How long an isolate stops sending after "unsupported contract version". */
export const VERSION_PAUSE_MS = 10 * 60_000;

/** Bytes of an error answer read for its code (the rest is never read). */
const ERROR_BODY_BYTES = 4_096;

/**
 * Requests of one owner that may wait behind the one in flight, per kind. A
 * user object sends one of each per turn; more waiting means the service is
 * slow, and a longer line would only hold the object's memory.
 */
const MAX_WAITING: Record<TraceRequestKind, number> = { turn: 8, start: 2 };

export interface TransportDeps {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  timeoutMs?: Partial<Record<TraceRequestKind, number>>;
}

interface Lane {
  tail: Promise<unknown>;
  waiting: number;
}

type Lanes = Record<TraceRequestKind, Lane>;

const newLanes = (): Lanes => ({
  turn: { tail: Promise.resolve(), waiting: 0 },
  start: { tail: Promise.resolve(), waiting: 0 },
});

const isolateLanes: Lanes = newLanes();
const ownerLanes = new WeakMap<object, Lanes>();

function laneOf(owner: object | undefined, kind: TraceRequestKind): Lane {
  if (!owner) return isolateLanes[kind];
  let lanes = ownerLanes.get(owner);
  if (!lanes) {
    lanes = newLanes();
    ownerLanes.set(owner, lanes);
  }
  return lanes[kind];
}

/** Until when this isolate sends nothing (the contract version was refused). */
const versionPause = { until: 0 };

/**
 * How long this isolate sends nothing with a write key whose project the
 * service called gone (410, or 404 `not_found` while it is being deleted).
 */
export const GONE_PAUSE_MS = 10 * 60_000;

/** Until when each write key sends nothing (its project is gone). */
const gonePauses = new Map<string, number>();

/** Tests: forget every pause (version and gone keys). */
export function resetVersionPause(): void {
  versionPause.until = 0;
  gonePauses.clear();
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `0192ab34…`: enough of an id to find it, never a person's id. */
export function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

/** What the service said about a refused request: its code and first issue path. */
interface Refusal {
  code?: string;
  path?: string;
}

type Attempt =
  | {
      kind: 'status';
      status: number;
      retryAfterMs: number | undefined;
      refusal?: Refusal;
    }
  | { kind: 'error'; reason: 'timeout' | 'network' };

/** `Retry-After` in ms (delta-seconds or an HTTP date), undefined when absent or unreadable. */
export function retryAfterMs(
  header: string | null,
  now: number,
): number | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  if (/^\d{1,10}$/.test(text)) return Number(text) * 1_000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

async function readSmall(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(size, ERROR_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.byteLength - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
    if (offset >= bytes.byteLength) break;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * An issue path as the service gives it (`"runs.3.start_time"`, or a list
 * of keys and indexes), kept only when it is made of key-like parts: never
 * a value.
 */
function issuePath(path: unknown): string | undefined {
  const parts: unknown[] =
    typeof path === 'string'
      ? path.split('.')
      : Array.isArray(path)
        ? path
        : [];
  const kept = parts
    .slice(0, 8)
    .filter(
      (part): part is string | number =>
        (typeof part === 'number' && Number.isInteger(part)) ||
        (typeof part === 'string' && /^[A-Za-z0-9_$-]{1,64}$/.test(part)),
    );
  return kept.length > 0 && kept.length === Math.min(parts.length, 8)
    ? kept.join('.')
    : undefined;
}

/** The error code and first issue path of a `{ error: { code, details } }` answer. */
function refusalOf(text: string): Refusal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const error: unknown =
    typeof parsed === 'object' && parsed !== null
      ? Reflect.get(parsed, 'error')
      : undefined;
  if (typeof error !== 'object' || error === null) return {};
  const code: unknown = Reflect.get(error, 'code');
  const details: unknown = Reflect.get(error, 'details');
  const issues: unknown =
    typeof details === 'object' && details !== null
      ? Reflect.get(details, 'issues')
      : undefined;
  const first: unknown = Array.isArray(issues) ? issues[0] : undefined;
  const path: unknown =
    typeof first === 'object' && first !== null
      ? Reflect.get(first, 'path')
      : undefined;
  return {
    ...(typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)
      ? { code }
      : {}),
    ...(issuePath(path) ? { path: issuePath(path) } : {}),
  };
}

/** The service refused the contract version itself (not one turn's content). */
function refusesVersion(status: number, refusal: Refusal | undefined): boolean {
  if (status === 426) return true;
  if (
    refusal?.code === 'unsupported_version' ||
    refusal?.code === 'unsupported_contract_version'
  )
    return true;
  return refusal?.code === 'validation_failed' && refusal.path === 'v';
}

export class TracesTransport {
  private readonly fetchImpl: (
    input: string,
    init: RequestInit,
  ) => Promise<Response>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly timeouts: Record<TraceRequestKind, number>;

  constructor(
    private readonly config: TracesConfig,
    private readonly logger: Logger,
    private readonly owner: object | undefined,
    deps: TransportDeps = {},
  ) {
    const binding = config.binding;
    this.fetchImpl =
      deps.fetch ??
      (binding
        ? (input, init) => binding.fetch(input, init)
        : (input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.timeouts = { ...TIMEOUT_MS, ...deps.timeoutMs };
  }

  /**
   * Send one request in this owner's lane of its kind. Never throws. `body`
   * is made only when the request's turn in the lane comes (so a waiting
   * turn is not built early), and may decline (undefined) to send nothing.
   */
  send(
    kind: TraceRequestKind,
    traceId: string,
    body: () => Promise<{ bytes: Uint8Array; gzip: boolean } | undefined>,
  ): Promise<SendOutcome | undefined> {
    if (this.paused()) return Promise.resolve('paused');
    const lane = laneOf(this.owner, kind);
    if (lane.waiting >= MAX_WAITING[kind]) {
      traceSendStats.skipped += 1;
      this.logger.warn(
        `[traces] ${kind} ${shortId(traceId)} not sent: ${lane.waiting} trace requests already waiting (skipped ${traceSendStats.skipped} so far)`,
      );
      return Promise.resolve('skipped');
    }
    lane.waiting += 1;
    const run = lane.tail.then(async () => {
      lane.waiting -= 1;
      try {
        if (this.paused()) return 'paused' as const;
        const made = await body();
        if (!made) return undefined;
        return await this.deliver(kind, traceId, made.bytes, made.gzip);
      } catch (error) {
        traceSendStats.failed += 1;
        this.logger.warn(
          `[traces] ${kind} ${shortId(traceId)} not sent: ${error instanceof Error ? error.name : 'error'} (failed ${traceSendStats.failed} so far)`,
        );
        return 'failed' as const;
      }
    });
    lane.tail = run.catch(() => undefined);
    return run.catch(() => 'failed' as const);
  }

  private paused(): boolean {
    const now = this.now();
    const goneUntil = gonePauses.get(this.config.apiKey);
    if (goneUntil !== undefined && goneUntil <= now)
      gonePauses.delete(this.config.apiKey);
    if (versionPause.until <= now && (goneUntil ?? 0) <= now) return false;
    traceSendStats.paused += 1;
    return true;
  }

  private async attempt(
    kind: TraceRequestKind,
    bytes: Uint8Array,
    gzip: boolean,
  ): Promise<Attempt> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.config.apiKey,
      'x-ixt-contract': String(CONTRACT_VERSION),
      'user-agent': `ixo-oracle-runtime-workers/${RUNTIME_VERSION}`,
    };
    if (gzip) headers['content-encoding'] = 'gzip';
    const timeoutMs = this.timeouts[kind];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The signal aborts the request; the race ends the attempt at the
      // timeout even when a fetch (a binding, a test double) ignores it.
      const response = await Promise.race([
        this.fetchImpl(`${this.config.baseUrl}${PATHS[kind]}`, {
          method: 'POST',
          headers,
          body: bytes,
          signal: AbortSignal.timeout(timeoutMs),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DOMException('trace request timed out', 'TimeoutError'),
              ),
            timeoutMs + 50,
          );
        }),
      ]);
      clearTimeout(timer);
      const status = response.status;
      const retryAfter = retryAfterMs(
        response.headers.get('retry-after'),
        this.now(),
      );
      // Only a refusal's body is read (its code), and only its first bytes.
      if (status >= 400 && status < 500 && status !== 429)
        return {
          kind: 'status',
          status,
          retryAfterMs: retryAfter,
          refusal: refusalOf(await readSmall(response).catch(() => '')),
        };
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'status', status, retryAfterMs: retryAfter };
    } catch (error) {
      clearTimeout(timer);
      const name =
        error instanceof Error || error instanceof DOMException
          ? error.name
          : '';
      return {
        kind: 'error',
        reason:
          name === 'TimeoutError' || name === 'AbortError'
            ? 'timeout'
            : 'network',
      };
    }
  }

  private jitter(): number {
    return RETRY_BASE_MS + Math.floor(this.random() * RETRY_JITTER_MS);
  }

  /** The wait before the one retry, or undefined when there is none. */
  private retryWait(
    kind: TraceRequestKind,
    result: Attempt,
  ): { ms: number } | { tooLong: number } | undefined {
    if (result.kind === 'error') return { ms: this.jitter() };
    const { status, retryAfterMs: after } = result;
    if (status === 429) {
      if (kind === 'start') return undefined;
      if (after !== undefined && after > MAX_RETRY_AFTER_MS)
        return { tooLong: after };
      return {
        ms:
          (after ?? 0) +
          Math.floor(this.random() * RETRY_AFTER_JITTER_MS) +
          (after === undefined ? RETRY_BASE_MS : 0),
      };
    }
    if (status >= 500 || status === 408) {
      if (kind === 'turn' && status === 503 && after !== undefined && after > 0)
        return {
          ms:
            Math.min(after, MAX_RETRY_AFTER_MS) +
            Math.floor(this.random() * RETRY_AFTER_JITTER_MS),
        };
      return { ms: this.jitter() };
    }
    return undefined;
  }

  private async deliver(
    kind: TraceRequestKind,
    traceId: string,
    bytes: Uint8Array,
    gzip: boolean,
  ): Promise<SendOutcome> {
    const what = `[traces] ${kind} ${shortId(traceId)} (${bytes.byteLength} bytes)`;
    let result = await this.attempt(kind, bytes, gzip);
    let attempts = 1;
    const wait = this.retryWait(kind, result);
    if (wait && 'tooLong' in wait) {
      traceSendStats.rateLimited += 1;
      this.logger.warn(
        `${what} dropped: HTTP 429 with Retry-After ${Math.round(wait.tooLong / 1000)} s, over the ${MAX_RETRY_AFTER_MS / 1000} s the tracer waits (rate-limited ${traceSendStats.rateLimited} so far)`,
      );
      return 'rate_limited';
    }
    if (wait) {
      await this.sleep(wait.ms);
      result = await this.attempt(kind, bytes, gzip);
      attempts = 2;
    }
    if (
      result.kind === 'status' &&
      result.status >= 200 &&
      result.status < 300
    ) {
      if (kind === 'turn') traceSendStats.turnsSent += 1;
      else traceSendStats.startsSent += 1;
      if (result.status === 202) traceSendStats.deferred += 1;
      return 'sent';
    }
    if (result.kind === 'status' && result.status === 429) {
      traceSendStats.rateLimited += 1;
      this.logger.warn(
        `${what} dropped: HTTP 429 after ${attempts} attempt${attempts > 1 ? 's' : ''} (rate-limited ${traceSendStats.rateLimited} so far)`,
      );
      return 'rate_limited';
    }
    if (result.kind === 'status' && result.status === 409) {
      traceSendStats.conflicts += 1;
      this.logger.warn(
        `${what} conflict: HTTP 409${result.refusal?.code ? ` ${result.refusal.code}` : ''}, another body is stored under this trace id; not retried (conflicts ${traceSendStats.conflicts} so far)`,
      );
      return 'conflict';
    }
    if (
      result.kind === 'status' &&
      (result.status === 410 ||
        (result.status === 404 && result.refusal?.code === 'not_found'))
    ) {
      traceSendStats.gone += 1;
      const now = this.now();
      const first = (gonePauses.get(this.config.apiKey) ?? 0) <= now;
      gonePauses.set(this.config.apiKey, now + GONE_PAUSE_MS);
      this.logger.warn(
        `${what} dropped: HTTP ${result.status}${result.refusal?.code ? ` ${result.refusal.code}` : ''}, the write key's project is gone or being deleted (gone ${traceSendStats.gone} so far)${first ? `; turn traces with this key paused for ${GONE_PAUSE_MS / 60_000} min in this isolate` : ''}`,
      );
      return 'gone';
    }
    if (
      result.kind === 'status' &&
      result.status < 500 &&
      result.status !== 408
    ) {
      const { status, refusal } = result;
      if (refusesVersion(status, refusal)) {
        const first = versionPause.until <= this.now();
        versionPause.until = this.now() + VERSION_PAUSE_MS;
        if (first)
          this.logger.warn(
            `[traces] the traces service does not accept contract version ${CONTRACT_VERSION} (HTTP ${status}${refusal?.code ? ` ${refusal.code}` : ''}): turn traces of this isolate paused for ${VERSION_PAUSE_MS / 60_000} min`,
          );
      }
      traceSendStats.rejected += 1;
      this.logger.warn(
        `${what} refused: HTTP ${status}${refusal?.code ? ` ${refusal.code}` : ''}${refusal?.path ? ` at ${refusal.path}` : ''} (refused ${traceSendStats.rejected} so far)`,
      );
      return 'rejected';
    }
    traceSendStats.failed += 1;
    this.logger.warn(
      `${what} not stored: ${result.kind === 'status' ? `HTTP ${result.status}` : result.reason} after ${attempts} attempt${attempts > 1 ? 's' : ''} (failed ${traceSendStats.failed} so far)`,
    );
    return 'failed';
  }
}
