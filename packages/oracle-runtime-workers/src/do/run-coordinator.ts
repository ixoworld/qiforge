/**
 * The runs of one user object, live and recovering (docs/plans/durable-runs.md).
 *
 * The coordinator owns the in-memory side of durability: which runs are in
 * flight in this instance, their output buffers, their abort controllers,
 * the keep-alive that holds the object loaded while a run is active, the
 * per-session multitask rule, re-joins, and the recovery schedule for runs
 * a previous incarnation left behind. The object supplies the host: how to
 * run one attempt, the latest checkpoint of a session, and what to do when
 * a run ends (deliver a task result, close a Matrix card).
 */
import type { ReplyPlan } from '../delivery/types';
import type { Logger } from '../plugin-api/types';
import {
  framesOfSegments,
  partialTextOf,
  RunBuffer,
  type RunFrame,
} from './run-buffer';
import {
  attemptSeqBase,
  decideRecovery,
  patchRunRecord,
  runHasCheckpointed,
  type RunDurabilityConfig,
  type RunPatch,
  type RunRecord,
  type RunStore,
} from './run-store';
import { isImmediateFrame } from './sse-stream';

export interface RunOutcome {
  status: 'finished' | 'aborted' | 'interrupted' | 'failed';
  /** The reply (the last assistant message, or the streamed text so far). */
  text: string;
  /** A finished chat-surface run: the reply as its surface delivers it. */
  plan?: ReplyPlan;
  messageId?: string;
  toolCalls?: Array<{ name: string; status: 'done' | 'error' }>;
  error?: unknown;
  /** The run's usage snapshot (JSON), stored with the terminal status. */
  usage?: string;
}

/**
 * Thrown by `runAttempt` before anything executed, when the attempt cannot
 * start for a transient reason outside the run (an authority it must consult
 * is unreachable). The coordinator schedules the same attempt again with the
 * recovery backoff instead of failing the run; after the recovery cap the
 * run fails with this error.
 */
export class RunAttemptDeferred extends Error {
  override readonly name = 'RunAttemptDeferred';
}

export type AttemptSource = 'begin' | 'dequeue' | 'recovery';

export interface LiveRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly requestId: string;
  record: RunRecord;
  buffer: RunBuffer;
  abort: AbortController;
  /** Set on a resumed attempt: the reply text the user already received. */
  continuation: string | null;
  /** Resolves when the run reaches a terminal state (any outcome). */
  readonly done: Promise<RunOutcome>;
  resolve: (outcome: RunOutcome) => void;
  /** An attempt is executing right now. */
  attemptInFlight: boolean;
  /**
   * What started the current attempt: `begin` (the message that was just
   * admitted, started at once), `dequeue` (it waited behind another run of
   * its session) or `recovery` (a retry after a reset or a deferral).
   * Unset on a run built outside the coordinator.
   */
  attemptSource?: AttemptSource;
}

/** The slice of `RunStore` the coordinator drives (tests supply an in-memory one). */
export type RunCoordinatorStore = Pick<
  RunStore,
  | 'create'
  | 'get'
  | 'update'
  | 'listActive'
  | 'readSegments'
  | 'appendSegment'
  | 'close'
>;

export interface RunCoordinatorHost {
  store: RunCoordinatorStore;
  config: RunDurabilityConfig;
  instanceId: string;
  log: Logger;
  now?: () => number;
  /** Arm the object's multiplexed alarm no later than `at` (ms epoch). */
  requestAlarm: (at: number) => void;
  /**
   * Execute one attempt: build the agent, stream the turn's frames into
   * `live.buffer`, and resolve with the outcome. Never throws for a turn
   * that failed (that is a `failed` outcome); a throw is an internal fault.
   */
  runAttempt: (live: LiveRun, resumed: boolean) => Promise<RunOutcome>;
  /** Latest checkpoint id of a session (progress detection across attempts). */
  checkpointIdOf: (sessionId: string) => Promise<string | null>;
  /** After a run reached a terminal state and its row was closed. */
  onRunEnded?: (record: RunRecord, outcome: RunOutcome) => Promise<void>;
  /** How long a superseded or aborted attempt gets to wind down (default 5 s). */
  supersedeGraceMs?: number;
}

export interface BeginRunInput {
  runId: string;
  sessionId: string;
  requestId: string;
  client: 'portal' | 'matrix' | 'channel';
  /** JSON the host needs to rebuild the attempt (see `StoredRunRequest`). */
  request: string;
  multitask: 'interrupt' | 'enqueue';
  taskRunId?: string;
}

/** How long a superseded run gets to wind down before the next one starts. */
const SUPERSEDE_GRACE_MS = 5_000;

/** Shown when a run ends failed without its attempt having said why. */
const RUN_FAILED_MESSAGE =
  'Something went wrong while answering. Please try again.';

/**
 * A `begin` that has not opened its run yet. A later `interrupt` message of
 * the same session (or `abortAllForSession`) supersedes it: it then records
 * its run as aborted and never starts an attempt.
 */
interface PendingBegin {
  superseded: boolean;
  /** Resolves when superseded, so a wait on the previous run is cut short. */
  readonly woken: Promise<void>;
  wake: () => void;
}

/**
 * Wait for `promise`, at most `ms`, and never leave the timer behind (a
 * pending timer keeps a Durable Object resident).
 */
async function withinGrace(
  ms: number,
  ...promises: Array<Promise<unknown>>
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ...promises,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface JoinResult {
  record: RunRecord;
  /** Frames after the cursor, from the segments and the live tail. */
  replay: RunFrame[];
  /** The live buffer, when the run is still producing (or waiting to). */
  buffer?: RunBuffer;
}

export class RunCoordinator {
  private readonly live = new Map<string, LiveRun>();

  /** Per session: the tail of the chain `begin` calls run on, one at a time. */
  private readonly sessionTurns = new Map<string, Promise<void>>();

  /** Per session: the `begin` calls that have not opened their run yet. */
  private readonly pendingBegins = new Map<string, Set<PendingBegin>>();

  /**
   * Runs queued only because the run their message superseded outlived the
   * grace: the message is the session's current one, so Stop ends it too.
   */
  private readonly queuedBehindSuperseded = new WeakSet<LiveRun>();

  private keepAliveArmedUntil = 0;

  private readonly now: () => number;

  private readonly graceMs: number;

  constructor(private readonly host: RunCoordinatorHost) {
    this.now = host.now ?? (() => Date.now());
    this.graceMs = host.supersedeGraceMs ?? SUPERSEDE_GRACE_MS;
  }

  // ── lookups ─────────────────────────────────────────────────────────────

  get(runId: string): LiveRun | undefined {
    return this.live.get(runId);
  }

  /** The run this session is executing or about to (running/recovering first). */
  activeForSession(sessionId: string): LiveRun | undefined {
    let candidate: LiveRun | undefined;
    for (const run of this.live.values()) {
      if (run.sessionId !== sessionId) continue;
      if (run.record.status === 'running' || run.record.status === 'recovering')
        return run;
      if (run.record.status === 'queued' && !candidate) candidate = run;
    }
    return candidate;
  }

  byRequestId(requestId: string): LiveRun | undefined {
    for (const run of this.live.values())
      if (run.requestId === requestId) return run;
    return undefined;
  }

  byTaskRunId(taskRunId: string): LiveRun | undefined {
    for (const run of this.live.values())
      if (run.record.taskRunId === taskRunId) return run;
    return undefined;
  }

  /** Attempts executing right now. */
  get activeCount(): number {
    let n = 0;
    for (const run of this.live.values()) if (run.attemptInFlight) n += 1;
    return n;
  }

  get size(): number {
    return this.live.size;
  }

  // ── keep-alive ──────────────────────────────────────────────────────────

  /**
   * Hold the object loaded while attempts execute: the alarm is re-armed
   * only when it is within a quarter of the horizon of expiring (one
   * storage write per ~15 s of active turn, coalesced across runs).
   */
  touchKeepAlive(): void {
    if (this.activeCount === 0) return;
    const now = this.now();
    const horizon = this.host.config.keepAliveMs;
    if (this.keepAliveArmedUntil - now > horizon / 4) return;
    this.keepAliveArmedUntil = now + horizon;
    this.host.requestAlarm(this.keepAliveArmedUntil);
  }

  /** The alarm deadline the keep-alive needs, if anything is executing. */
  keepAliveDeadline(now: number): number | null {
    if (this.activeCount === 0) return null;
    this.keepAliveArmedUntil = now + this.host.config.keepAliveMs;
    return this.keepAliveArmedUntil;
  }

  // ── begin / queue / abort ───────────────────────────────────────────────

  /**
   * Record a run and start it, or queue it behind the session's active run
   * under the `enqueue` rule. Under `interrupt` (the default) the active run
   * of the session is aborted first — and any run queued behind it.
   *
   * The `begin` calls of one session take turns, so each decides on the
   * session as the previous one left it, and at most one attempt executes
   * per session. A message superseded by a later `interrupt` message while
   * it waited for its turn (or for the run it supersedes to wind down) is
   * recorded and closed as aborted without an attempt; its `live` comes
   * back with the buffer already closed on its `done` frame. A run that
   * outlives the supersede grace keeps executing; the new message is then
   * queued behind it instead of running beside it.
   */
  async begin(
    input: BeginRunInput,
  ): Promise<{ live: LiveRun; queued: boolean }> {
    const { sessionId } = input;
    if (input.multitask === 'interrupt') this.supersedePending(sessionId);
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const ticket: PendingBegin = { superseded: false, woken, wake };
    let pending = this.pendingBegins.get(sessionId);
    if (!pending) {
      pending = new Set();
      this.pendingBegins.set(sessionId, pending);
    }
    pending.add(ticket);
    try {
      return await this.inSessionTurn(sessionId, () =>
        this.beginInTurn(input, ticket),
      );
    } finally {
      pending.delete(ticket);
      if (pending.size === 0 && this.pendingBegins.get(sessionId) === pending)
        this.pendingBegins.delete(sessionId);
    }
  }

  /** Run `fn` after every earlier `inSessionTurn` call of the session settled. */
  private inSessionTurn<T>(
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionTurns.get(sessionId) ?? Promise.resolve();
    const result = previous.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.sessionTurns.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionTurns.get(sessionId) === tail)
        this.sessionTurns.delete(sessionId);
    });
    return result;
  }

  /** Supersede the session's waiting `begin` calls; whether there were any. */
  private supersedePending(sessionId: string): boolean {
    let any = false;
    for (const ticket of this.pendingBegins.get(sessionId) ?? []) {
      ticket.superseded = true;
      ticket.wake();
      any = true;
    }
    return any;
  }

  private async beginInTurn(
    input: BeginRunInput,
    ticket: PendingBegin,
  ): Promise<{ live: LiveRun; queued: boolean }> {
    const { sessionId } = input;
    let queued = false;
    let behindSuperseded = false;
    const active = ticket.superseded
      ? undefined
      : this.activeForSession(sessionId);
    if (active) {
      if (input.multitask === 'enqueue') {
        queued = true;
      } else {
        this.host.log.log(
          `[runs] ${sessionId}: new message supersedes ${active.runId} (${active.record.status})`,
        );
        for (const run of [...this.live.values()])
          if (run.sessionId === sessionId && run.record.status === 'queued')
            await this.cancelQueued(run, 'superseded');
        const running = this.activeForSession(sessionId);
        if (running) {
          this.abortRun(running, 'superseded');
          await withinGrace(this.graceMs, running.done, ticket.woken);
        }
        // Still winding down past the grace: wait behind it.
        if (!ticket.superseded && this.activeForSession(sessionId)) {
          queued = true;
          behindSuperseded = true;
        }
      }
    }
    const checkpointId = await this.host.checkpointIdOf(sessionId);
    const record = await this.host.store.create({
      runId: input.runId,
      sessionId,
      requestId: input.requestId,
      client: input.client,
      status: queued || ticket.superseded ? 'queued' : 'running',
      request: input.request,
      checkpointId,
      taskRunId: input.taskRunId ?? null,
      instanceId: this.host.instanceId,
    });
    // No await from this check to the attempt's start: a supersede that
    // lands later finds the run open and aborts it like any other.
    if (ticket.superseded) {
      const live = this.open({ ...record, status: 'queued' });
      await this.cancelQueued(live, 'superseded');
      return { live, queued: false };
    }
    const live = this.open(record);
    if (!queued) {
      void this.startAttempt(live, false, 'begin');
      return { live, queued };
    }
    if (behindSuperseded) this.queuedBehindSuperseded.add(live);
    // The run ahead may have ended during the awaits above, before this
    // one was open to be dequeued.
    await this.startNextQueued(sessionId);
    return { live, queued: live.record.status === 'queued' };
  }

  /**
   * Stop the session's current message (`POST /messages/abort`): its active
   * run, and a message still waiting in `begin` or queued behind the run it
   * superseded. Runs enqueued behind the active one still start after it.
   */
  abortSession(sessionId: string): boolean {
    let stopped = this.supersedePending(sessionId);
    for (const run of [...this.live.values()])
      if (
        run.sessionId === sessionId &&
        run.record.status === 'queued' &&
        this.queuedBehindSuperseded.has(run)
      ) {
        void this.cancelQueued(run, 'aborted');
        stopped = true;
      }
    const active = this.activeForSession(sessionId);
    if (!active) return stopped;
    if (active.record.status === 'queued') {
      void this.cancelQueued(active, 'aborted');
      return true;
    }
    this.abortRun(active, 'aborted');
    return true;
  }

  /**
   * End every run of the session: the executing attempt is aborted, queued
   * runs and runs waiting for a recovery attempt are closed, and messages
   * still waiting in `begin` are closed without an attempt — each ends
   * `aborted`, with its `done` frame. Resolves once the executing attempt
   * ended, or after the supersede grace. Safe when nothing runs.
   */
  async abortAllForSession(sessionId: string): Promise<void> {
    this.supersedePending(sessionId);
    const runs = [...this.live.values()].filter(
      (run) => run.sessionId === sessionId,
    );
    if (runs.length === 0) return;
    this.host.log.log(
      `[runs] ${sessionId}: aborting all ${runs.length} run(s)`,
    );
    // Queued runs first, so an attempt that ends below dequeues none.
    for (const run of runs)
      if (run.record.status === 'queued')
        void this.cancelQueued(run, 'aborted');
    for (const run of runs)
      if (run.record.status !== 'queued') this.abortRun(run, 'aborted');
    await withinGrace(this.graceMs, Promise.all(runs.map((run) => run.done)));
  }

  private abortRun(live: LiveRun, reason: 'aborted' | 'superseded'): void {
    live.abort.abort(new Error(`run aborted (${reason})`));
    if (!live.attemptInFlight) {
      // Recovering and not yet re-attempted: nothing is running to notice
      // the signal; close it here.
      void this.finalize(live, {
        status: 'aborted',
        text: live.continuation ?? '',
      });
    }
  }

  private async cancelQueued(
    live: LiveRun,
    reason: 'aborted' | 'superseded',
  ): Promise<void> {
    this.host.log.log(`[runs] ${live.runId} ${reason} while queued`);
    await this.finalize(live, { status: 'aborted', text: '' });
  }

  // ── join ────────────────────────────────────────────────────────────────

  /**
   * Everything a client needs to (re-)attach after `after`: the packed
   * segments, the unflushed tail, and the live buffer. A run that already
   * ended replays what is left (usually nothing: segments are dropped at
   * cutover) with no buffer.
   */
  async join(runId: string, after = 0): Promise<JoinResult | undefined> {
    const record =
      this.live.get(runId)?.record ?? (await this.host.store.get(runId));
    if (!record) return undefined;
    const before = this.live.get(runId);
    const segments = await this.host.store.readSegments(runId, after);
    const replay = framesOfSegments(segments, after);
    const lastReplayed =
      replay.length > 0 ? replay[replay.length - 1]!.seq : after;
    const live = this.live.get(runId);
    if (!live) {
      if (!before) return { record, replay };
      // The run ended during the read: answer as for an ended run, from its
      // closed row (the caller's trailer carries the final status and text),
      // with the frames after the cursor that the read or the buffer still
      // held, less the `done` the trailer replaces.
      await before.done;
      replay.push(...before.buffer.tailAfter(lastReplayed));
      return {
        record: before.record,
        replay: replay.filter((frame) => frame.event !== 'done'),
      };
    }
    // The tail includes the frames whose segment write is still pending
    // (the read above may have been queued before it). No await between
    // reading the tail and subscribing (the caller subscribes synchronously
    // on the returned buffer), so no frame slips between the two.
    replay.push(...live.buffer.tailAfter(lastReplayed));
    return { record: live.record, replay, buffer: live.buffer };
  }

  // ── attempts ────────────────────────────────────────────────────────────

  private open(record: RunRecord, startSeq = 0): LiveRun {
    let resolve!: (outcome: RunOutcome) => void;
    const done = new Promise<RunOutcome>((r) => {
      resolve = r;
    });
    const live: LiveRun = {
      runId: record.runId,
      sessionId: record.sessionId,
      requestId: record.requestId,
      record,
      buffer: this.makeBuffer(record.runId, startSeq),
      abort: new AbortController(),
      continuation: null,
      done,
      resolve,
      attemptInFlight: false,
      attemptSource: 'begin',
    };
    this.live.set(record.runId, live);
    return live;
  }

  private makeBuffer(runId: string, startSeq: number): RunBuffer {
    return new RunBuffer({
      flushMs: this.host.config.segmentFlushMs,
      flushBytes: this.host.config.segmentBytes,
      immediate: isImmediateFrame,
      startSeq,
      onPack: (segment) => this.host.store.appendSegment(runId, segment),
      onPackError: (error) =>
        this.host.log.warn(
          `[runs] ${runId}: segment not persisted: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
  }

  private async startAttempt(
    live: LiveRun,
    resumed: boolean,
    source: AttemptSource,
  ): Promise<void> {
    live.attemptInFlight = true;
    live.attemptSource = source;
    this.touchKeepAlive();
    let outcome: RunOutcome;
    try {
      outcome = await this.host.runAttempt(live, resumed);
    } catch (error) {
      if (error instanceof RunAttemptDeferred) {
        const deferred = await this.defer(live, error).catch(
          (storeError: unknown) => {
            this.host.log.error(
              `[runs] ${live.runId}: could not reschedule the attempt: ${storeError instanceof Error ? storeError.message : String(storeError)}`,
            );
            return false;
          },
        );
        if (deferred) return;
      } else {
        this.host.log.error(
          `[runs] ${live.runId}: attempt crashed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      outcome = live.abort.signal.aborted
        ? { status: 'aborted', text: live.continuation ?? '' }
        : { status: 'failed', text: live.continuation ?? '', error };
    }
    live.attemptInFlight = false;
    await this.finalize(live, outcome);
  }

  /**
   * Put a deferred attempt back on the recovery schedule. The attempt did
   * not touch the checkpoint, so every deferral counts against the recovery
   * cap; `false` when the cap is spent (or the run was aborted meanwhile)
   * and the caller closes the run instead. The attempt stays in flight
   * until the run is rescheduled, so an abort meanwhile only signals.
   */
  private async defer(
    live: LiveRun,
    error: RunAttemptDeferred,
  ): Promise<boolean> {
    if (live.abort.signal.aborted) return false;
    const decision = decideRecovery(
      live.record,
      live.record.checkpointId,
      this.now(),
      this.host.config,
    );
    if (decision.action === 'interrupt') {
      this.host.log.warn(
        `[runs] ${live.runId}: deferred ${decision.attempts} time(s) (${error.message}); failing the run`,
      );
      return false;
    }
    await this.write(live, {
      status: 'recovering',
      attempts: decision.attempts,
      nextAttemptAt: decision.at,
    });
    if (live.abort.signal.aborted) return false;
    live.attemptInFlight = false;
    this.host.log.warn(
      `[runs] ${live.runId}: attempt deferred (${error.message}); retry ${decision.attempts} in ${Math.round((decision.at - this.now()) / 1000)} s`,
    );
    this.host.requestAlarm(decision.at);
    return true;
  }

  /**
   * The frames a run's subscribers need to finish, when its attempt did not
   * push them (it crashed, was never started, or was closed while waiting):
   * an `error` frame for a failure, then `done`.
   */
  private pushClosingFrames(live: LiveRun, outcome: RunOutcome): void {
    if (live.buffer.isClosed || live.buffer.hasDone) return;
    if (outcome.status === 'failed')
      live.buffer.push('error', {
        error: RUN_FAILED_MESSAGE,
        kind: 'unknown',
        source: 'platform',
        retryable: true,
        sessionId: live.sessionId,
        requestId: live.requestId,
        runId: live.runId,
        timestamp: new Date(this.now()).toISOString(),
      });
    live.buffer.push('done', {
      runId: live.runId,
      ...(outcome.messageId ? { messageId: outcome.messageId } : {}),
      ...(outcome.status === 'finished' ? {} : { [outcome.status]: true }),
    });
  }

  /** Write `patch` to the run's row and keep `live.record` in step with it. */
  private async write(live: LiveRun, patch: RunPatch): Promise<void> {
    const updatedAt = await this.host.store.update(live.runId, patch);
    live.record = patchRunRecord(live.record, patch, updatedAt);
  }

  private async finalize(live: LiveRun, outcome: RunOutcome): Promise<void> {
    if (this.live.get(live.runId) !== live) return;
    this.live.delete(live.runId);
    const { runId } = live;
    try {
      this.pushClosingFrames(live, outcome);
      await live.buffer.close();
      const partialText =
        outcome.status === 'finished'
          ? live.record.client === 'channel'
            ? outcome.text
            : null
          : outcome.text ||
            partialTextOf([
              ...framesOfSegments(await this.host.store.readSegments(runId)),
            ]);
      // One transaction: the terminal row, and the cutover (the reply, or
      // the partial text, is in the row and the transcript now).
      const patch: RunPatch = {
        status: outcome.status,
        lastSeq: live.buffer.lastSeq,
        messageId: outcome.messageId ?? null,
        partialText,
        error:
          outcome.error === undefined
            ? null
            : outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error),
        nextAttemptAt: null,
        ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
      };
      const updatedAt = await this.host.store.close(runId, patch);
      live.record = patchRunRecord(live.record, patch, updatedAt);
      this.host.log.log(
        `[runs] ${runId} ${outcome.status} (${live.record.client}, session ${live.sessionId}, ${live.buffer.lastSeq} frames)`,
      );
    } catch (error) {
      this.host.log.error(
        `[runs] ${runId}: could not close the run row: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    live.resolve(outcome);
    try {
      await this.host.onRunEnded?.(live.record, outcome);
    } catch (error) {
      this.host.log.error(
        `[runs] ${runId}: onRunEnded failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.startNextQueued(live.sessionId);
  }

  private async startNextQueued(sessionId: string): Promise<void> {
    // A running turn, or one waiting for its recovery attempt, keeps the
    // queue waiting: the session's turns stay strictly ordered.
    const active = this.activeForSession(sessionId);
    if (active && active.record.status !== 'queued') return;
    let run: LiveRun | undefined;
    for (const candidate of this.live.values())
      if (
        candidate.sessionId === sessionId &&
        candidate.record.status === 'queued'
      ) {
        run = candidate;
        break;
      }
    if (!run) return;
    // Taken before the awaits below: the session is busy from here on, and
    // an abort meanwhile only signals (the run is closed here).
    run.attemptInFlight = true;
    run.record = { ...run.record, status: 'running' };
    try {
      // The run's input is written from this checkpoint on: its start.
      const checkpointId = await this.host.checkpointIdOf(sessionId);
      await this.write(run, {
        status: 'running',
        instanceId: this.host.instanceId,
        checkpointId,
        startCheckpointId: checkpointId,
      });
    } catch (error) {
      run.attemptInFlight = false;
      await this.finalize(
        run,
        run.abort.signal.aborted
          ? { status: 'aborted', text: '' }
          : { status: 'failed', text: '', error },
      );
      return;
    }
    if (run.abort.signal.aborted) {
      run.attemptInFlight = false;
      await this.finalize(run, { status: 'aborted', text: '' });
      return;
    }
    this.host.log.log(`[runs] ${run.runId}: dequeued for ${sessionId}`);
    void this.startAttempt(run, false, 'dequeue');
  }

  // ── recovery ────────────────────────────────────────────────────────────

  /**
   * Runs a previous incarnation left `queued`/`running`/`recovering`. Every
   * boot is a new instance, so anything active that this coordinator does
   * not hold is an orphan: queued runs are re-opened (and started when
   * their session is idle); running ones get a recovery attempt scheduled
   * with the backoff, or are closed as interrupted after the cap.
   */
  async recoverOrphans(): Promise<void> {
    const active = await this.host.store.listActive();
    const now = this.now();
    let earliest: number | null = null;
    for (const record of active) {
      if (this.live.has(record.runId)) continue;
      if (record.status === 'queued') {
        this.open(record, record.lastSeq);
        continue;
      }
      const current = await this.host.checkpointIdOf(record.sessionId);
      const decision = decideRecovery(record, current, now, this.host.config);
      // Everything packed so far: the cursor continues after it (the row's
      // `lastSeq` is only written when a run ends) and the continuation note
      // shows the model what the user already read.
      const segments = await this.host.store.readSegments(record.runId);
      const frames = framesOfSegments(segments);
      const lastPacked = Math.max(
        record.lastSeq,
        segments.length > 0 ? segments[segments.length - 1]!.seqTo : 0,
      );
      // The frames of the previous attempt that were still unpacked at the
      // reset are gone, but a client may hold a cursor pointing past them:
      // this attempt numbers from the next attempt base so that cursor
      // stays below everything it emits.
      const generation = record.generation + 1;
      const startSeq = Math.max(lastPacked, attemptSeqBase(generation));
      if (decision.action === 'interrupt') {
        this.host.log.warn(
          `[runs] ${record.runId}: ${decision.attempts} recovery attempt(s) without progress; closing as interrupted`,
        );
        const updatedAt = await this.host.store.update(record.runId, {
          generation,
        });
        const live = this.open(
          patchRunRecord(record, { generation }, updatedAt),
          startSeq,
        );
        live.continuation = partialTextOf(frames) || null;
        live.buffer.push('error', {
          error:
            'Something went wrong while answering and the reply could not be completed. Please try again.',
          kind: 'interrupted',
          retryable: true,
          sessionId: record.sessionId,
          requestId: record.requestId,
          runId: record.runId,
          timestamp: new Date(now).toISOString(),
        });
        live.buffer.push('done', { runId: record.runId, interrupted: true });
        await this.finalize(live, {
          status: 'interrupted',
          text: live.continuation ?? '',
        });
        continue;
      }
      const patch: RunPatch = {
        status: 'recovering',
        attempts: decision.attempts,
        generation,
        nextAttemptAt: decision.at,
        checkpointId: current,
        instanceId: this.host.instanceId,
      };
      const updatedAt = await this.host.store.update(record.runId, patch);
      const live = this.open(
        patchRunRecord(record, patch, updatedAt),
        startSeq,
      );
      // A run the graph never checkpointed is retried fresh (resumeDue):
      // there is no reply to continue from.
      live.continuation = runHasCheckpointed(record, current)
        ? partialTextOf(frames) || null
        : null;
      this.host.log.log(
        `[runs] ${record.runId}: attempt ${decision.attempts} in ${Math.round((decision.at - now) / 1000)} s (${frames.length} frames restored)`,
      );
      earliest =
        earliest === null ? decision.at : Math.min(earliest, decision.at);
    }
    // Queued runs of idle sessions.
    for (const run of [...this.live.values()])
      if (run.record.status === 'queued')
        await this.startNextQueued(run.sessionId);
    if (earliest !== null) this.host.requestAlarm(earliest);
  }

  /** Start every recovery attempt that is due (from the alarm). */
  async resumeDue(now: number): Promise<void> {
    for (const run of [...this.live.values()]) {
      if (run.record.status !== 'recovering' || run.attemptInFlight) continue;
      if (run.record.nextAttemptAt !== null && run.record.nextAttemptAt > now)
        continue;
      // Taken before the awaits below: an abort meanwhile only signals, and
      // the run is closed here instead of being attempted.
      run.attemptInFlight = true;
      let resumed: boolean;
      try {
        await this.write(run, { status: 'running', nextAttemptAt: null });
        // Resume only when the graph persisted something for this run;
        // otherwise it never saw the input and the attempt runs fresh with
        // it. Derived from the stored start checkpoint, so it holds across a
        // restart (recoverOrphans) as well as for a deferral in this instance.
        resumed = runHasCheckpointed(
          run.record,
          await this.host.checkpointIdOf(run.sessionId),
        );
      } catch (error) {
        run.attemptInFlight = false;
        if (!run.abort.signal.aborted) throw error;
        await this.finalize(run, {
          status: 'aborted',
          text: run.continuation ?? '',
        });
        continue;
      }
      if (run.abort.signal.aborted) {
        run.attemptInFlight = false;
        await this.finalize(run, {
          status: 'aborted',
          text: run.continuation ?? '',
        });
        continue;
      }
      if (!resumed) run.continuation = null;
      // `partialLength` is the reply text this attempt continues from (all
      // packed `message` frames). A client that received more than that
      // before the reset truncates to it, so the continuation never
      // duplicates text the runtime lost with the unpacked tail.
      if (resumed)
        run.buffer.push('run', {
          runId: run.runId,
          sessionId: run.sessionId,
          requestId: run.requestId,
          resumed: true,
          attempt: run.record.attempts,
          partialLength: run.continuation?.length ?? 0,
        });
      this.host.log.log(
        `[runs] ${run.runId}: ${resumed ? 'resuming' : 'retrying'} (attempt ${run.record.attempts})`,
      );
      void this.startAttempt(run, resumed, 'recovery');
    }
  }

  /** Earliest pending recovery attempt, for the alarm multiplexer. */
  nextRecoveryAt(): number | null {
    let at: number | null = null;
    for (const run of this.live.values()) {
      if (
        run.record.status !== 'recovering' ||
        run.record.nextAttemptAt === null
      )
        continue;
      at =
        at === null
          ? run.record.nextAttemptAt
          : Math.min(at, run.record.nextAttemptAt);
    }
    return at;
  }

  /** Diagnostics. */
  snapshot(): Array<{
    runId: string;
    sessionId: string;
    status: string;
    attemptInFlight: boolean;
    generation: number;
    lastSeq: number;
    packedSeq: number;
    subscribers: number;
    nextAttemptAt: number | null;
  }> {
    return [...this.live.values()].map((run) => ({
      runId: run.runId,
      sessionId: run.sessionId,
      status: run.record.status,
      attemptInFlight: run.attemptInFlight,
      generation: run.record.generation,
      lastSeq: run.buffer.lastSeq,
      packedSeq: run.buffer.packedSeq,
      subscribers: run.buffer.subscriberCount,
      nextAttemptAt: run.record.nextAttemptAt,
    }));
  }
}
