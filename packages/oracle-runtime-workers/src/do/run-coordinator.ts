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
  type RunDurabilityConfig,
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
}

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
  | 'deleteSegments'
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

export interface JoinResult {
  record: RunRecord;
  /** Frames after the cursor, from the segments and the live tail. */
  replay: RunFrame[];
  /** The live buffer, when the run is still producing (or waiting to). */
  buffer?: RunBuffer;
}

export class RunCoordinator {
  private readonly live = new Map<string, LiveRun>();

  private keepAliveArmedUntil = 0;

  private readonly now: () => number;

  constructor(private readonly host: RunCoordinatorHost) {
    this.now = host.now ?? (() => Date.now());
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
   */
  async begin(
    input: BeginRunInput,
  ): Promise<{ live: LiveRun; queued: boolean }> {
    const active = this.activeForSession(input.sessionId);
    let queued = false;
    if (active) {
      if (input.multitask === 'enqueue') {
        queued = true;
      } else {
        this.host.log.log(
          `[runs] ${input.sessionId}: new message supersedes ${active.runId} (${active.record.status})`,
        );
        for (const run of [...this.live.values()])
          if (
            run.sessionId === input.sessionId &&
            run.record.status === 'queued'
          )
            await this.cancelQueued(run, 'superseded');
        if (active.record.status !== 'queued') {
          this.abortRun(active, 'superseded');
          await Promise.race([
            active.done,
            new Promise((r) => setTimeout(r, SUPERSEDE_GRACE_MS)),
          ]);
        }
      }
    }
    const checkpointId = await this.host.checkpointIdOf(input.sessionId);
    await this.host.store.create({
      runId: input.runId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      client: input.client,
      status: queued ? 'queued' : 'running',
      request: input.request,
      checkpointId,
      taskRunId: input.taskRunId ?? null,
      instanceId: this.host.instanceId,
    });
    const record = (await this.host.store.get(input.runId))!;
    const live = this.open(record);
    if (!queued) void this.startAttempt(live, false);
    return { live, queued };
  }

  /** Abort the session's active run (`POST /messages/abort`). */
  abortSession(sessionId: string): boolean {
    const active = this.activeForSession(sessionId);
    if (!active) return false;
    if (active.record.status === 'queued') {
      void this.cancelQueued(active, 'aborted');
      return true;
    }
    this.abortRun(active, 'aborted');
    return true;
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
    live.buffer.push('done', { runId: live.runId, aborted: true });
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
    const live = this.live.get(runId);
    const segments = await this.host.store.readSegments(runId, after);
    const replay = framesOfSegments(segments, after);
    const lastReplayed =
      replay.length > 0 ? replay[replay.length - 1]!.seq : after;
    if (!live) return { record, replay };
    // No await between reading the tail and subscribing (the caller
    // subscribes synchronously on the returned buffer), so no frame slips
    // between the two.
    replay.push(...live.buffer.tailAfter(lastReplayed));
    return { record, replay, buffer: live.buffer };
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

  private async startAttempt(live: LiveRun, resumed: boolean): Promise<void> {
    live.attemptInFlight = true;
    this.touchKeepAlive();
    let outcome: RunOutcome;
    try {
      outcome = await this.host.runAttempt(live, resumed);
    } catch (error) {
      outcome = {
        status: 'failed',
        text: live.continuation ?? '',
        error,
      };
      this.host.log.error(
        `[runs] ${live.runId}: attempt crashed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    live.attemptInFlight = false;
    await this.finalize(live, outcome);
  }

  private async finalize(live: LiveRun, outcome: RunOutcome): Promise<void> {
    if (!this.live.has(live.runId)) return;
    this.live.delete(live.runId);
    const { runId } = live;
    try {
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
      await this.host.store.update(runId, {
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
      });
      // Cutover: the reply (or the partial text) is in the row/transcript.
      await this.host.store.deleteSegments(runId);
      live.record = (await this.host.store.get(runId)) ?? live.record;
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
    for (const run of this.live.values()) {
      if (run.sessionId !== sessionId || run.record.status !== 'queued')
        continue;
      await this.host.store.update(run.runId, {
        status: 'running',
        instanceId: this.host.instanceId,
        checkpointId: await this.host.checkpointIdOf(sessionId),
      });
      run.record = (await this.host.store.get(run.runId)) ?? run.record;
      this.host.log.log(`[runs] ${run.runId}: dequeued for ${sessionId}`);
      void this.startAttempt(run, false);
      return;
    }
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
        await this.host.store.update(record.runId, { generation });
        const live = this.open(record, startSeq);
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
      await this.host.store.update(record.runId, {
        status: 'recovering',
        attempts: decision.attempts,
        generation,
        nextAttemptAt: decision.at,
        checkpointId: current,
        instanceId: this.host.instanceId,
      });
      const refreshed = (await this.host.store.get(record.runId)) ?? record;
      const live = this.open(refreshed, startSeq);
      live.continuation = partialTextOf(frames) || null;
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
      await this.host.store.update(run.runId, {
        status: 'running',
        nextAttemptAt: null,
      });
      run.record = (await this.host.store.get(run.runId)) ?? run.record;
      // `partialLength` is the reply text this attempt continues from (all
      // packed `message` frames). A client that received more than that
      // before the reset truncates to it, so the continuation never
      // duplicates text the runtime lost with the unpacked tail.
      run.buffer.push('run', {
        runId: run.runId,
        sessionId: run.sessionId,
        requestId: run.requestId,
        resumed: true,
        attempt: run.record.attempts,
        partialLength: run.continuation?.length ?? 0,
      });
      this.host.log.log(
        `[runs] ${run.runId}: resuming (attempt ${run.record.attempts})`,
      );
      void this.startAttempt(run, true);
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
