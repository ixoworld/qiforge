/**
 * Fresh invocations for the work the Matrix gateway hands to a user object.
 *
 * Cloudflare refuses a call once a chain of Worker / Durable Object
 * invocations has looped back into the Workers runtime 16 times (the "loop
 * limit"; the refusal reads "Subrequest depth limit exceeded. This request
 * looped back into the Workers runtime too many times."). A Durable Object's
 * outgoing calls are charged to its NEWEST in-flight incoming request,
 * whichever code makes them (workerd: `IoContext::getIoChannelFactory()` uses
 * `getCurrentIncomingRequest()`, the front of `incomingRequests`, and every
 * newly delivered request becomes the front). An object that still has work
 * pending keeps its last request current until the next one arrives.
 *
 * The gateway and the user objects call each other, so their budgets ratchet
 * down: a turn's call into the gateway (a status-card post) becomes the
 * gateway's current request; the gateway's next dispatch into the user
 * object is charged to it, one hop lower; that turn's calls into the gateway
 * arrive lower again; closing the card (gateway → user → gateway) costs two
 * more. About four hops per Matrix turn: a user who keeps chatting in a room
 * ran out after three or four quick turns, and the turn's model call,
 * memory lookups and gateway calls were refused in milliseconds.
 *
 * An alarm is a top-level event with the full budget. Work the gateway hands
 * over waits here until an alarm invocation of this object has been
 * delivered: from then on the work's calls are charged to the alarm, not to
 * the gateway's call, so a turn always starts from a full budget whatever
 * chain delivered it. The alarm handler keeps each lease's work alive with
 * `waitUntil`, which keeps the alarm's request current while the work runs
 * (until a newer request arrives — and a newer request from the gateway goes
 * through this gate itself).
 */

/** Matches the loop-limit refusal (the runtime gives it no code or flag). */
export const LOOP_LIMIT_MESSAGE = 'Subrequest depth limit exceeded';

/**
 * The same refusal as an HTTP answer: a fetch to a Worker-backed host
 * (OpenRouter, the memory engine) gets `503` with this body.
 */
export const LOOP_LIMIT_HTTP_BODY = 'error code: 1019';

function messagesOf(err: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (current instanceof Error) messages.push(current.message);
    else if (typeof current === 'string') messages.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages;
}

/** Whether `err` — or a cause in its chain — is the loop-limit refusal of a DO / service call. */
export function isLoopLimitError(err: unknown): boolean {
  return messagesOf(err).some((m) => m.includes(LOOP_LIMIT_MESSAGE));
}

/**
 * Whether a failure was caused by the loop limit in either form (an RPC
 * refusal or a `503 error code: 1019` from a Worker-backed host). For logs:
 * the HTTP form may come from deep inside a call that already did work, so
 * it never justifies a retry.
 */
export function mentionsLoopLimit(err: unknown): boolean {
  return messagesOf(err).some(
    (m) => m.includes(LOOP_LIMIT_MESSAGE) || m.includes(LOOP_LIMIT_HTTP_BODY),
  );
}

/** How long a caller waits for the alarm before it carries on where it is. */
export const FRESH_INVOCATION_TIMEOUT_MS = 3000;

/**
 * Upper bound on how long one lease holds the alarm invocation open, so a
 * lease that is never ended cannot pin the object for ever.
 */
export const FRESH_LEASE_MAX_MS = 30 * 60_000;

export interface FreshLease {
  /** The work now runs under an alarm invocation (false: the wait timed out). */
  readonly fresh: boolean;
  /** The work has ended; the alarm invocation may finish. Idempotent. */
  end(): void;
}

export interface FreshInvocationOptions {
  /** Arm the object's (multiplexed) alarm for now. */
  armNow: () => Promise<void>;
  /** Hold the current invocation open until `work` settles (`ctx.waitUntil`). */
  keepAlive: (work: Promise<unknown>) => void;
  /**
   * An alarm handler of this object is running: no new alarm can be
   * delivered until it returns, so waiting would only cost the timeout.
   */
  alarmRunning?: () => boolean;
  warn?: (message: string) => void;
  timeoutMs?: number;
  maxLeaseMs?: number;
}

function carriesStream(args: readonly unknown[]): boolean {
  return args.some(
    (arg) =>
      typeof arg === 'object' &&
      arg !== null &&
      typeof Reflect.get(arg, 'getReader') === 'function',
  );
}

/**
 * Wrap an RPC handle so a call the loop limit refused is retried once from a
 * fresh invocation. Only the methods `retryable` admits are retried — reads,
 * and sends that carry a transaction id — because the refusal can also come
 * back from a call the target itself made after it had started work. Calls
 * carrying a stream are never retried (the stream may already be consumed),
 * nor is `fetch`; other properties pass through untouched.
 */
export function withLoopLimitRetry<T extends object>(
  handle: T,
  opts: {
    name: string;
    refresh: (label: string) => Promise<FreshLease>;
    warn: (message: string) => void;
    /**
     * Whether a call may be repeated: a read, or a send that carries a
     * transaction id (the homeserver deduplicates it). Defaults to none.
     */
    retryable?: (method: string, args: readonly unknown[]) => boolean;
  },
): T {
  return new Proxy(handle, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (
        typeof prop !== 'string' ||
        typeof value !== 'function' ||
        prop === 'fetch' ||
        prop === 'then'
      )
        return value;
      return async (...args: unknown[]): Promise<unknown> => {
        const call = (): Promise<unknown> =>
          (
            Reflect.get(target, prop, target) as (
              ...a: unknown[]
            ) => Promise<unknown>
          )(...args);
        try {
          return await call();
        } catch (err) {
          if (
            !isLoopLimitError(err) ||
            carriesStream(args) ||
            !(opts.retryable?.(prop, args) ?? false)
          )
            throw err;
          opts.warn(
            `[loop-limit] ${opts.name}.${prop} was refused by Cloudflare's loop limit; retrying once from a fresh invocation`,
          );
          const lease = await opts.refresh(`${opts.name}.${prop} retry`);
          try {
            return await call();
          } finally {
            lease.end();
          }
        }
      };
    },
  });
}

interface Waiter {
  resolve: (fresh: boolean) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Settles when the lease ends (or after `maxLeaseMs`). */
  held: Promise<void>;
}

export class FreshInvocationGate {
  private readonly waiting = new Set<Waiter>();

  private readonly timeoutMs: number;

  private readonly maxLeaseMs: number;

  constructor(private readonly opts: FreshInvocationOptions) {
    this.timeoutMs = opts.timeoutMs ?? FRESH_INVOCATION_TIMEOUT_MS;
    this.maxLeaseMs = opts.maxLeaseMs ?? FRESH_LEASE_MAX_MS;
  }

  /** Callers waiting for the next alarm. */
  get pending(): number {
    return this.waiting.size;
  }

  /**
   * Wait until an alarm invocation of this object has been delivered, then
   * run the work under it. Never throws: when the alarm cannot be armed or
   * does not arrive within the timeout, the lease is not fresh and the work
   * carries on in the caller's invocation (as before this gate existed).
   */
  async enter(label: string): Promise<FreshLease> {
    if (this.opts.alarmRunning?.()) {
      this.opts.warn?.(
        `[loop-limit] an alarm handler is running; ${label} runs in the invocation that delivered it`,
      );
      return { fresh: false, end: () => undefined };
    }
    let ended = false;
    let endLease: () => void = () => undefined;
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    const held = new Promise<void>((resolve) => {
      endLease = () => {
        if (leaseTimer !== undefined) clearTimeout(leaseTimer);
        resolve();
      };
    });
    let settle!: (fresh: boolean) => void;
    const freshPromise = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const waiter: Waiter = { resolve: settle, timer: undefined, held };
    this.waiting.add(waiter);
    waiter.timer = setTimeout(() => {
      if (!this.waiting.delete(waiter)) return;
      this.opts.warn?.(
        `[loop-limit] no alarm within ${this.timeoutMs} ms for ${label}; it runs in the invocation that delivered it`,
      );
      settle(false);
    }, this.timeoutMs);
    try {
      await this.opts.armNow();
    } catch (err) {
      if (this.waiting.delete(waiter)) {
        clearTimeout(waiter.timer);
        this.opts.warn?.(
          `[loop-limit] could not arm the alarm for ${label} (${err instanceof Error ? err.message : String(err)}); it runs in the invocation that delivered it`,
        );
        settle(false);
      }
    }
    const fresh = await freshPromise;
    if (fresh)
      leaseTimer = setTimeout(() => {
        this.opts.warn?.(
          `[loop-limit] lease for ${label} held over ${Math.round(this.maxLeaseMs / 1000)} s; releasing the alarm invocation`,
        );
        endLease();
      }, this.maxLeaseMs);
    return {
      fresh,
      end: () => {
        if (ended) return;
        ended = true;
        endLease();
      },
    };
  }

  /**
   * Call first thing in `alarm()`: every waiter now runs under this alarm
   * invocation, which stays open (`keepAlive`) until its lease ends.
   * Returns how many waiters were released.
   */
  release(): number {
    const waiters = [...this.waiting];
    this.waiting.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      this.opts.keepAlive(waiter.held);
      waiter.resolve(true);
    }
    return waiters.length;
  }
}
