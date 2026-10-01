/**
 * Bounded tool concurrency for one user object, shared by every session and
 * every turn that object runs:
 *
 *   - writes run one at a time (a mutation never races another mutation of
 *     the same user's data, even from two simultaneous sessions);
 *   - reads run up to `maxReads` at a time;
 *   - sub-agent dispatches run up to `maxSubagents` at a time, in their own
 *     lane so a child waiting for one of the parent's slots can never
 *     deadlock the parent.
 *
 * A wait is cancelled by the turn's abort signal: the waiter leaves the
 * queue and the signal's reason is thrown, so an aborted turn never holds a
 * slot it will not use.
 */
export type ToolLane = 'read' | 'write' | 'subagent';

class Lane {
  private active = 0;
  private readonly waiting: Array<{
    resolve: () => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(private readonly capacity: number) {}

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: (typeof this.waiting)[number] = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiting.indexOf(waiter);
          if (index !== -1) this.waiting.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiting.push(waiter);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (!next) {
      this.active -= 1;
      return;
    }
    // The slot passes straight to the next waiter (`active` is unchanged).
    if (next.signal && next.onAbort)
      next.signal.removeEventListener('abort', next.onAbort);
    next.resolve();
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }
}

/** The signal's reason as an Error (an aborter may pass any value). */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(
    reason === undefined
      ? 'The turn was aborted while waiting for a tool slot.'
      : String(reason),
  );
  error.name = 'AbortError';
  return error;
}

export interface ToolSchedulerOptions {
  maxReads?: number;
  maxSubagents?: number;
}

export class ToolScheduler {
  private readonly lanes: Record<ToolLane, Lane>;

  constructor(options: ToolSchedulerOptions = {}) {
    this.lanes = {
      write: new Lane(1),
      read: new Lane(options.maxReads ?? 4),
      subagent: new Lane(options.maxSubagents ?? 4),
    };
  }

  async run<T>(
    lane: ToolLane,
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    const slot = this.lanes[lane];
    await slot.acquire(signal);
    try {
      return await action();
    } finally {
      slot.release();
    }
  }

  /** Occupancy per lane (diagnostics). */
  snapshot(): Record<ToolLane, { inFlight: number; queued: number }> {
    const entry = (lane: Lane) => ({
      inFlight: lane.inFlight,
      queued: lane.queued,
    });
    return {
      read: entry(this.lanes.read),
      write: entry(this.lanes.write),
      subagent: entry(this.lanes.subagent),
    };
  }
}
