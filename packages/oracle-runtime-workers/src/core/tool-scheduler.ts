/**
 * Bounded tool concurrency for one user object, shared by every session and
 * every turn that object runs:
 *
 *   - `write`: one at a time across every session (a mutation never races
 *     another mutation of the same user's data, even from two simultaneous
 *     sessions);
 *   - `read`: up to `maxReads` at a time across every session;
 *   - `frontend:<sessionId>`: a tool that acts in the user's browser
 *     (`PluginTool.surface: 'frontend'`), one at a time per session and
 *     never in the user-wide lanes above, so a call parked while its chat
 *     has no tab holds no slot another chat needs;
 *   - `subagent:<sessionId>`: sub-agent dispatches, up to `maxSubagents` at
 *     a time per session, in their own lane so a child waiting for one of
 *     the parent's slots can never deadlock the parent, and a dispatch
 *     waiting in one chat (an inner frontend call parked) never holds up
 *     another chat's.
 *
 * The per-session lanes are created on demand and removed once idle (no
 * call in flight or queued), so only busy ones exist.
 *
 * A wait is cancelled by the turn's abort signal: the waiter leaves the
 * queue and the signal's reason is thrown, so an aborted turn never holds a
 * slot it will not use.
 */
export type ToolLane = 'read' | 'write' | 'frontend' | 'subagent';

/** The lanes kept per session (`frontend:<sessionId>`, `subagent:<sessionId>`). */
export type SessionToolLane = Extract<ToolLane, 'frontend' | 'subagent'>;

const isSessionLane = (lane: ToolLane): lane is SessionToolLane =>
  lane === 'frontend' || lane === 'subagent';

/** The key of a per-session lane: `frontend:<sessionId>` or `subagent:<sessionId>`. */
export function sessionLaneKey(
  lane: SessionToolLane,
  sessionId: string,
): string {
  return `${lane}:${sessionId}`;
}

export interface LaneOccupancy {
  inFlight: number;
  queued: number;
}

export interface ToolSchedulerSnapshot {
  read: LaneOccupancy;
  write: LaneOccupancy;
  /** Summed over every session's frontend lane. */
  frontend: LaneOccupancy;
  /** Summed over every session's sub-agent lane. */
  subagent: LaneOccupancy;
  /**
   * Per-session lanes by key (`sessionLaneKey`); only lanes with a call in
   * flight or queued exist.
   */
  sessionLanes: Record<string, LaneOccupancy>;
}

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

  get idle(): boolean {
    return this.active === 0 && this.waiting.length === 0;
  }

  get occupancy(): LaneOccupancy {
    return { inFlight: this.active, queued: this.waiting.length };
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
  private readonly read: Lane;
  private readonly write = new Lane(1);
  private readonly maxSubagents: number;
  /** Per-session lanes by `sessionLaneKey`; an idle lane is removed. */
  private readonly sessionLanes = new Map<
    string,
    { kind: SessionToolLane; lane: Lane }
  >();

  constructor(options: ToolSchedulerOptions = {}) {
    this.read = new Lane(options.maxReads ?? 4);
    this.maxSubagents = options.maxSubagents ?? 4;
  }

  /**
   * Run `action` once a slot of `lane` is free. `sessionId` keys the
   * per-session lanes (`frontend`, `subagent`) and is required for them; the
   * user-wide `read` and `write` lanes ignore it.
   */
  async run<T>(
    lane: ToolLane,
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
    sessionId?: string,
  ): Promise<T> {
    const key = isSessionLane(lane)
      ? sessionLaneKey(lane, requireSessionId(lane, sessionId))
      : undefined;
    const slot = this.laneFor(lane, key);
    try {
      await slot.acquire(signal);
    } catch (error) {
      this.dropIfIdle(key, slot);
      throw error;
    }
    try {
      return await action();
    } finally {
      slot.release();
      this.dropIfIdle(key, slot);
    }
  }

  /** Occupancy per lane (diagnostics: `GET /debug/runs`). */
  snapshot(): ToolSchedulerSnapshot {
    const sessionLanes: Record<string, LaneOccupancy> = {};
    const summed: Record<SessionToolLane, LaneOccupancy> = {
      frontend: { inFlight: 0, queued: 0 },
      subagent: { inFlight: 0, queued: 0 },
    };
    for (const [key, { kind, lane }] of this.sessionLanes) {
      sessionLanes[key] = lane.occupancy;
      summed[kind].inFlight += lane.inFlight;
      summed[kind].queued += lane.queued;
    }
    return {
      read: this.read.occupancy,
      write: this.write.occupancy,
      frontend: summed.frontend,
      subagent: summed.subagent,
      sessionLanes,
    };
  }

  private laneFor(lane: ToolLane, key: string | undefined): Lane {
    if (!isSessionLane(lane) || key === undefined)
      return lane === 'read' ? this.read : this.write;
    const existing = this.sessionLanes.get(key);
    if (existing) return existing.lane;
    const created = new Lane(lane === 'frontend' ? 1 : this.maxSubagents);
    this.sessionLanes.set(key, { kind: lane, lane: created });
    return created;
  }

  private dropIfIdle(key: string | undefined, slot: Lane): void {
    if (key === undefined || !slot.idle) return;
    if (this.sessionLanes.get(key)?.lane === slot)
      this.sessionLanes.delete(key);
  }
}

function requireSessionId(
  lane: SessionToolLane,
  sessionId: string | undefined,
): string {
  if (sessionId === undefined)
    throw new TypeError(
      `ToolScheduler.run: the ${lane} lane is kept per session; pass the call's sessionId.`,
    );
  return sessionId;
}
