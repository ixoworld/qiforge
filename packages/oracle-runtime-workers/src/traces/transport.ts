/**
 * Delivery of a turn (and its start marker) to IXO Traces. One request per
 * turn, sent once inside the caller's `waitUntil`; nothing is queued for
 * later and nothing is kept after a failure: a failed send is counted and
 * logged by id, status and size, never by content.
 *
 * Connection discipline: the requests of one owner (a Durable Object passes
 * itself) go one after the other, so a user object never holds more than one
 * traces connection next to the turn's own model and tool connections, and a
 * request is always made and read inside the object that started it (workerd
 * refuses I/O on behalf of another object: the reason the LangSmith client is
 * per object too). A marker is therefore always sent before its turn.
 *
 * Retries: at most one, after a short jittered pause, on a 5xx, a timeout or a
 * network error. None on a 4xx. A 429 is dropped at once, whatever its
 * `Retry-After` says (logged, not honoured by waiting).
 */
import type { Logger } from '../plugin-api/types';
import type { TracesConfig } from './config';
import { RUNTIME_VERSION } from './runtime-version';

export type TraceRequestKind = 'turn' | 'start';

export type SendOutcome =
  /** 2xx. */
  | 'sent'
  /** A 4xx other than 429: the service refused it; not retried. */
  | 'rejected'
  /** 429: dropped. */
  | 'rate_limited'
  /** 5xx, timeout or network error on every attempt. */
  | 'failed'
  /** Not sent: this owner already had `MAX_WAITING_PER_OWNER` requests waiting. */
  | 'skipped';

/** Counters of this isolate, for logs and tests. Never reset by the runtime. */
export const traceSendStats = {
  turnsSent: 0,
  startsSent: 0,
  rejected: 0,
  rateLimited: 0,
  failed: 0,
  skipped: 0,
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

/** Pause before the one retry: 250 ms plus up to 750 ms of jitter. */
const RETRY_BASE_MS = 250;
const RETRY_JITTER_MS = 750;

/**
 * Requests of one owner that may wait behind the one in flight. A user
 * object sends two per turn; more waiting means the service is slow, and a
 * longer line would only hold the object's memory.
 */
const MAX_WAITING_PER_OWNER = 8;

export interface TransportDeps {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  timeoutMs?: Partial<Record<TraceRequestKind, number>>;
}

interface Lane {
  tail: Promise<unknown>;
  waiting: number;
}

const isolateLane: Lane = { tail: Promise.resolve(), waiting: 0 };
const ownerLanes = new WeakMap<object, Lane>();

function laneOf(owner: object | undefined): Lane {
  if (!owner) return isolateLane;
  let lane = ownerLanes.get(owner);
  if (!lane) {
    lane = { tail: Promise.resolve(), waiting: 0 };
    ownerLanes.set(owner, lane);
  }
  return lane;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `0192ab34…`: enough of an id to find it, never a person's id. */
export function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

type Attempt =
  | { kind: 'status'; status: number; retryAfter: string | null }
  | { kind: 'error'; reason: 'timeout' | 'network' };

export class TracesTransport {
  private readonly fetchImpl: (
    input: string,
    init: RequestInit,
  ) => Promise<Response>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
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
    this.timeouts = { ...TIMEOUT_MS, ...deps.timeoutMs };
  }

  /**
   * Send one request in this owner's lane. Never throws. `body` is made only
   * when the request's turn in the lane comes (so a waiting turn is not built
   * early), and may decline (undefined) to send nothing.
   */
  send(
    kind: TraceRequestKind,
    traceId: string,
    body: () => Promise<{ bytes: Uint8Array; gzip: boolean } | undefined>,
  ): Promise<SendOutcome | undefined> {
    const lane = laneOf(this.owner);
    if (lane.waiting >= MAX_WAITING_PER_OWNER) {
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

  private async attempt(
    kind: TraceRequestKind,
    bytes: Uint8Array,
    gzip: boolean,
  ): Promise<Attempt> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.config.apiKey,
      'user-agent': `ixo-oracle-runtime-workers/${RUNTIME_VERSION}`,
    };
    if (gzip) headers['content-encoding'] = 'gzip';
    try {
      const response = await this.fetchImpl(
        `${this.config.baseUrl}${PATHS[kind]}`,
        {
          method: 'POST',
          headers,
          body: bytes,
          signal: AbortSignal.timeout(this.timeouts[kind]),
        },
      );
      // The body is never needed: free the connection.
      await response.body?.cancel().catch(() => undefined);
      return {
        kind: 'status',
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return {
        kind: 'error',
        reason:
          name === 'TimeoutError' || name === 'AbortError'
            ? 'timeout'
            : 'network',
      };
    }
  }

  private async deliver(
    kind: TraceRequestKind,
    traceId: string,
    bytes: Uint8Array,
    gzip: boolean,
  ): Promise<SendOutcome> {
    let result = await this.attempt(kind, bytes, gzip);
    let attempts = 1;
    const retryable = (r: Attempt): boolean =>
      r.kind === 'error' || r.status >= 500;
    if (retryable(result)) {
      await this.sleep(
        RETRY_BASE_MS + Math.floor(this.random() * RETRY_JITTER_MS),
      );
      result = await this.attempt(kind, bytes, gzip);
      attempts = 2;
    }
    const what = `[traces] ${kind} ${shortId(traceId)} (${bytes.byteLength} bytes)`;
    if (
      result.kind === 'status' &&
      result.status >= 200 &&
      result.status < 300
    ) {
      if (kind === 'turn') traceSendStats.turnsSent += 1;
      else traceSendStats.startsSent += 1;
      return 'sent';
    }
    if (result.kind === 'status' && result.status === 429) {
      traceSendStats.rateLimited += 1;
      this.logger.warn(
        `${what} dropped: HTTP 429${result.retryAfter ? ` (Retry-After ${result.retryAfter.slice(0, 16)})` : ''} (rate-limited ${traceSendStats.rateLimited} so far)`,
      );
      return 'rate_limited';
    }
    if (result.kind === 'status' && result.status < 500) {
      traceSendStats.rejected += 1;
      this.logger.warn(
        `${what} refused: HTTP ${result.status} (refused ${traceSendStats.rejected} so far)`,
      );
      return 'rejected';
    }
    traceSendStats.failed += 1;
    this.logger.warn(
      `${what} not stored: ${result.kind === 'status' ? `HTTP ${result.status}` : result.reason} after ${attempts} attempts (failed ${traceSendStats.failed} so far)`,
    );
    return 'failed';
  }
}
