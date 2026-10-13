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
 *   - a settled invocation is remembered (bounded by count and age), so a
 *     replayed or late result is recognised and rejected as such;
 *   - pending invocations are never evicted to make room; a full table
 *     refuses new calls instead;
 *   - an invocation whose answer cannot arrive any more — its deadline
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
 * ends the turn that made it (a resumed durable run does not re-run a write
 * that had started — see tool-marks). Finished-call records are lost when
 * the object hibernates; a result for a forgotten id is then rejected as
 * never issued, which is the same outcome.
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
  /** sid of the socket executing it (unset only before it is sent). */
  executorSid?: string;
}

interface Pending extends Omit<PendingFrontendCall, 'executorSid'> {
  executor?: FrontendExecutor;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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

export interface FrontendCallRegistryOptions {
  now?: () => number;
  maxPending?: number;
  maxCompleted?: number;
  completedTtlMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
   * `signal` (the turn's abort signal) ends it early: rejected as not sent
   * before `dispatched`, an unknown outcome after.
   */
  open(
    call: Omit<PendingFrontendCall, 'startedAt' | 'executorSid'>,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const id = call.toolCallId;
    const label = FRONTEND_CALL_LABEL[call.kind];
    this.prune();
    if (this.pending.has(id) || this.completed.has(id))
      throw new Error(`${label} invocation ${id} was already issued`);
    if (this.pending.size >= this.maxPending)
      throw new Error(
        `${label} ${call.toolName} was not sent: ${this.maxPending} frontend calls are already in flight`,
      );
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.complete(id)) resolve(frontendOutcomeUnknown(id));
      }, opts.timeoutMs);
      const entry: Pending = {
        ...call,
        startedAt: this.now(),
        resolve,
        reject,
        timer,
      };
      this.pending.set(id, entry);
      if (opts.signal) {
        // The turn ended (Stop, deadline). Before the call was sent it is a
        // definite failure; once sent, the browser may already have run it.
        const onAbort = () => {
          if (this.pending.get(id) !== entry) return;
          this.complete(id);
          if (entry.executor) resolve(frontendOutcomeUnknown(id));
          else
            reject(
              new Error(
                `${label} ${call.toolName} was not sent: the turn was aborted`,
              ),
            );
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** Whether `toolCallId` is still waiting (an already-aborted call is not). */
  isPending(toolCallId: string): boolean {
    return this.pending.has(toolCallId);
  }

  /** Bind a pending invocation to the one socket it was sent to. */
  dispatched(toolCallId: string, executor: FrontendExecutor): void {
    const entry = this.pending.get(toolCallId);
    if (entry) entry.executor = executor;
  }

  /** End an invocation that never reached a browser: a definite failure. */
  fail(toolCallId: string, error: Error): void {
    const entry = this.pending.get(toolCallId);
    if (!entry || !this.complete(toolCallId)) return;
    entry.reject(error);
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
