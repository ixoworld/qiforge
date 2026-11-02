/**
 * Frontend (browser-tool / AG-UI action) invocations of one user object:
 * the calls waiting for an answer from the user's browser, and a bounded
 * record of the ones already finished.
 *
 * The contract (see docs/frontend-bridge.md):
 *   - every invocation has its own id (`frontendInvocationId`), and an id is
 *     issued once — never reused while it is pending or remembered;
 *   - an invocation is sent to ONE socket (`dispatched`), and only a result
 *     arriving on that socket — same engine.io sid, same session, same
 *     authenticated DID — settles it. Another tab of the same session, a
 *     reconnected tab (a new sid) or another session cannot;
 *   - until it is sent an invocation is parked: its clock is the park
 *     deadline, and a park deadline that passes — or the turn's abort —
 *     rejects it as never sent (`FrontendCallNotSentError`, a definite
 *     failure: no browser saw it). `dispatched` restarts the clock with the
 *     call's own deadline;
 *   - a settled invocation is remembered (bounded by count and age), so a
 *     replayed or late result is recognised and rejected as such;
 *   - pending invocations — parked ones included — are never evicted to
 *     make room; a full table refuses new calls instead;
 *   - a sent invocation whose answer cannot arrive any more — its deadline
 *     passed, or its socket went — resolves with `FRONTEND_OUTCOME_UNKNOWN`:
 *     the browser may have performed the write, so it is neither a success
 *     nor a failure, and it is never sent again.
 *
 * Settlement rules for a matching result:
 *   - `error` set                                   → reject(Error(error))
 *   - AG-UI, `result.success === false`, and not an
 *     unknown outcome the client reported            → reject(Error(result.error ?? 'Action failed'))
 *   - otherwise                                     → resolve(result)
 *
 * Purely in-memory, which is exact on Workers: a pending call holds a timer,
 * so its object cannot hibernate before the call ends, and an object restart
 * ends the turn that made it. What a resumed durable run does with the call
 * is the tool marks' policy: `onDispatched` lets the caller record the
 * moment the call left the object, so a call still parked at the restart
 * (never sent) is issued again and a sent write is not (see tool-marks).
 * Finished-call records are lost when the object hibernates; a result for a
 * forgotten id is then rejected as never issued, which is the same outcome.
 */
import {
  frontendOutcomeUnknown,
  reportsUnknownOutcome,
} from '@ixo/common/ai/frontend-bridge';

export type FrontendCallKind = 'browser' | 'agui';

/** The socket an invocation was sent to, as its attachment identifies it. */
export interface FrontendExecutor {
  /** engine.io sid of the socket (stable across hibernation, new on reconnect). */
  sid: string;
  sessionId: string;
  /** The DID the socket's CONNECT authenticated. */
  userDid: string;
}

export interface FrontendCallResult {
  /** The invocation id the client echoes back. */
  toolCallId: string;
  /** The socket the result arrived on (never the client's claims). */
  from: FrontendExecutor;
  result?: unknown;
  error?: string;
}

/** Why a result settled nothing (the call, if any, keeps waiting). */
export type FrontendResultRejection =
  /** No such invocation was issued (or its record has expired). */
  | 'not-issued'
  /** The invocation already ended: a duplicate, replayed or late result. */
  | 'already-settled'
  /** The result came from a socket other than the one the call was sent to. */
  | 'wrong-socket'
  /** A browser-tool result for an AG-UI invocation, or the reverse. */
  | 'wrong-kind';

export type SettleOutcome =
  | { settled: true }
  | { settled: false; reason: FrontendResultRejection };

export interface PendingFrontendCall {
  kind: FrontendCallKind;
  /** The invocation id (what the browser received as `toolCallId`). */
  toolCallId: string;
  toolName: string;
  sessionId: string;
  startedAt: number;
  /** Not sent yet: no socket that can run it has joined the session. */
  parked: boolean;
  /** sid of the socket executing it (unset while it is parked). */
  executorSid?: string;
}

interface Pending extends Omit<PendingFrontendCall, 'executorSid' | 'parked'> {
  executor?: FrontendExecutor;
  /** The call's own deadline once it is sent. */
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Removes the listener on the turn's abort signal (set when one was added). */
  detach?: () => void;
  onDispatched?: () => void;
}

export interface FrontendCallOpenOptions {
  /** How long the browser has to answer once the call is sent. */
  timeoutMs: number;
  /**
   * How long the call may wait unsent for a socket that can run it (default
   * `timeoutMs`). Past it the call rejects as never sent.
   */
  parkTimeoutMs?: number;
  /** The turn's abort signal. */
  signal?: AbortSignal;
  /**
   * Called once, when the call is sent to a socket (`dispatched`); never for
   * a call that ends parked (park deadline, abort, full table). A throwing
   * callback does not affect the call.
   */
  onDispatched?: () => void;
}

/** Finished invocations kept to recognise replays: at most this many… */
export const MAX_COMPLETED_FRONTEND_CALLS = 1024;
/** …for at most this long. */
export const COMPLETED_FRONTEND_CALL_TTL_MS = 30 * 60_000;
/** Calls in flight at once for one user; beyond it new calls are refused. */
export const MAX_PENDING_FRONTEND_CALLS = 256;

export const FRONTEND_CALL_LABEL: Record<FrontendCallKind, string> = {
  browser: 'Browser tool',
  agui: 'AG-UI action',
};

/** Why a frontend call was never sent (see `FrontendCallNotSentError`). */
export type FrontendCallNotSentReason =
  /** The turn aborted while the call was parked (or before it was opened). */
  | 'aborted'
  /** No socket that can run it joined the session within the park deadline. */
  | 'park-deadline'
  /** An earlier call of the session hit its park deadline and no socket has joined since. */
  | 'no-browser'
  /** The user's table of calls in flight is full. */
  | 'table-full';

/**
 * A frontend call that never reached a browser: a definite failure, so the
 * tool layer releases a write's claim (`isUncertainOutcome` is false for it,
 * even on an aborted turn). Its message never contains the words the tool
 * layer reads as an uncertain outcome.
 */
export class FrontendCallNotSentError extends Error {
  constructor(
    readonly reason: FrontendCallNotSentReason,
    message: string,
  ) {
    super(message);
    this.name = 'FrontendCallNotSentError';
  }
}

/**
 * Whether `error` is, or wraps (`cause`, as LangChain's middleware errors
 * do), a `FrontendCallNotSentError`.
 */
export function isFrontendCallNotSent(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof FrontendCallNotSentError) return true;
    current = current.cause;
  }
  return false;
}

/**
 * The model-facing ending of a call that waited for a browser in vain: the
 * user has to open the chat, and the model must not loop on the tool.
 */
export const OPEN_CHAT_HINT =
  'Ask the user to open this chat; do not retry on your own.';

export interface FrontendCallRegistryOptions {
  now?: () => number;
  maxPending?: number;
  maxCompleted?: number;
  completedTtlMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `300000` → `300`, `1500` → `1.5`: the park deadline as the error states it. */
export function seconds(ms: number): string {
  return String(Number((ms / 1000).toFixed(3)));
}

function sameExecutor(a: FrontendExecutor, b: FrontendExecutor): boolean {
  return (
    a.sid === b.sid && a.sessionId === b.sessionId && a.userDid === b.userDid
  );
}

export class FrontendCallRegistry {
  private readonly pending = new Map<string, Pending>();

  /** Invocation id → when it finished; insertion order is completion order. */
  private readonly completed = new Map<string, number>();

  private readonly now: () => number;

  private readonly maxPending: number;

  private readonly maxCompleted: number;

  private readonly completedTtlMs: number;

  constructor(options: FrontendCallRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxPending = options.maxPending ?? MAX_PENDING_FRONTEND_CALLS;
    this.maxCompleted = options.maxCompleted ?? MAX_COMPLETED_FRONTEND_CALLS;
    this.completedTtlMs =
      options.completedTtlMs ?? COMPLETED_FRONTEND_CALL_TTL_MS;
  }

  /**
   * Register an invocation BEFORE it is sent, so an immediate answer cannot
   * be missed, and return the promise its result settles. Throws when the id
   * was already issued or the table is full — the call is then not sent.
   * Until `dispatched` the call is parked on `parkTimeoutMs`; past it the
   * call rejects as never sent. `signal` (the turn's abort signal) ends it
   * early: rejected as not sent before `dispatched`, an unknown outcome after.
   */
  open(
    call: Omit<PendingFrontendCall, 'startedAt' | 'executorSid' | 'parked'>,
    opts: FrontendCallOpenOptions,
  ): Promise<unknown> {
    const id = call.toolCallId;
    const label = FRONTEND_CALL_LABEL[call.kind];
    this.prune();
    if (this.pending.has(id) || this.completed.has(id))
      throw new Error(`${label} invocation ${id} was already issued`);
    if (this.pending.size >= this.maxPending)
      throw new FrontendCallNotSentError(
        'table-full',
        `${label} ${call.toolName} was not sent: ${this.maxPending} frontend calls are already in flight`,
      );
    const parkTimeoutMs = opts.parkTimeoutMs ?? opts.timeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      // The park deadline: the call was never sent, so it definitely did not
      // run — worded so the tool layer never reads it as an uncertain outcome.
      const timer = setTimeout(() => {
        if (this.complete(id))
          reject(
            new FrontendCallNotSentError(
              'park-deadline',
              `${label} ${call.toolName} was not sent: no browser joined session ${call.sessionId} within ${seconds(parkTimeoutMs)} s. ${OPEN_CHAT_HINT}`,
            ),
          );
      }, parkTimeoutMs);
      const entry: Pending = {
        ...call,
        startedAt: this.now(),
        timeoutMs: opts.timeoutMs,
        resolve,
        reject,
        timer,
        onDispatched: opts.onDispatched,
      };
      this.pending.set(id, entry);
      const { signal } = opts;
      if (signal) {
        // The turn ended (Stop, deadline). Before the call was sent it is a
        // definite failure; once sent, the browser may already have run it.
        const onAbort = () => {
          if (this.pending.get(id) !== entry) return;
          this.complete(id);
          if (entry.executor) resolve(frontendOutcomeUnknown(id));
          else
            reject(
              new FrontendCallNotSentError(
                'aborted',
                `${label} ${call.toolName} was not sent: the turn was aborted`,
              ),
            );
        };
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener('abort', onAbort, { once: true });
          // However the call ends, the turn's signal stops referencing it.
          entry.detach = () => signal.removeEventListener('abort', onAbort);
        }
      }
    });
  }

  /** Whether `toolCallId` is still waiting (an already-aborted call is not). */
  isPending(toolCallId: string): boolean {
    return this.pending.has(toolCallId);
  }

  /** Whether `toolCallId` is waiting unsent (parked). */
  isParked(toolCallId: string): boolean {
    const entry = this.pending.get(toolCallId);
    return entry !== undefined && !entry.executor;
  }

  /**
   * Bind a pending invocation to the one socket it was sent to; its clock
   * restarts with its own deadline, past which the outcome is unknown.
   */
  dispatched(toolCallId: string, executor: FrontendExecutor): void {
    const entry = this.pending.get(toolCallId);
    if (!entry || entry.executor) return;
    entry.executor = executor;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.complete(toolCallId))
        entry.resolve(frontendOutcomeUnknown(toolCallId));
    }, entry.timeoutMs);
    const { onDispatched } = entry;
    entry.onDispatched = undefined;
    try {
      onDispatched?.();
    } catch {
      // The record of the dispatch is best effort; the call is already sent.
    }
  }

  /** Deliver a result that arrived on a socket. */
  settle(kind: FrontendCallKind, data: FrontendCallResult): SettleOutcome {
    const id = data.toolCallId;
    const entry = this.pending.get(id);
    if (!entry) {
      this.prune();
      return {
        settled: false,
        reason: this.completed.has(id) ? 'already-settled' : 'not-issued',
      };
    }
    if (entry.kind !== kind) return { settled: false, reason: 'wrong-kind' };
    if (!entry.executor || !sameExecutor(entry.executor, data.from))
      return { settled: false, reason: 'wrong-socket' };
    this.complete(id);
    const result = data.result;
    if (data.error) entry.reject(new Error(data.error));
    else if (
      kind === 'agui' &&
      isRecord(result) &&
      result.success === false &&
      !reportsUnknownOutcome(result)
    )
      entry.reject(
        new Error(
          typeof result.error === 'string' && result.error
            ? result.error
            : 'Action failed',
        ),
      );
    else entry.resolve(result);
    return { settled: true };
  }

  /**
   * The socket `sid` is gone (closed, errored, dropped by the heartbeat).
   * Its pending invocations can never be answered — a reconnect is a new
   * socket — and are never re-sent elsewhere: they resolve with an unknown
   * outcome now instead of at their deadline. Returns how many there were.
   */
  executorGone(sid: string): number {
    let ended = 0;
    for (const [id, entry] of [...this.pending]) {
      if (entry.executor?.sid !== sid) continue;
      this.complete(id);
      entry.resolve(frontendOutcomeUnknown(id));
      ended += 1;
    }
    return ended;
  }

  /** Pending calls, oldest first (diagnostics / status). */
  list(): PendingFrontendCall[] {
    return [...this.pending.values()]
      .map(
        ({ kind, toolCallId, toolName, sessionId, startedAt, executor }) => ({
          kind,
          toolCallId,
          toolName,
          sessionId,
          startedAt,
          parked: !executor,
          ...(executor ? { executorSid: executor.sid } : {}),
        }),
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Finished invocations currently remembered. */
  get completedCount(): number {
    this.prune();
    return this.completed.size;
  }

  /** Move a pending invocation to the finished records; false if it was not pending. */
  private complete(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.detach?.();
    this.pending.delete(id);
    this.completed.set(id, this.now());
    this.prune();
    return true;
  }

  /** Drop finished records past their age, then the oldest beyond the bound. */
  private prune(): void {
    const cutoff = this.now() - this.completedTtlMs;
    for (const [id, at] of this.completed) {
      if (at > cutoff && this.completed.size <= this.maxCompleted) break;
      this.completed.delete(id);
    }
  }
}
