/**
 * Per-user task scheduler running on the user object's Durable Object alarm —
 * the Workers replacement for the Node runtime's BullMQ+Redis tasks stack.
 *
 * Contract with `UserOracleDO`:
 *   - `createTaskScheduler(host)` is called once per object boot, AFTER the
 *     user's database is open.
 *   - The returned scheduler is registered as an alarm client: the object
 *     calls `nextWakeAt()` when re-arming its alarm and `onAlarm(now)` on
 *     every alarm tick (the object multiplexes flush/idle/task deadlines onto
 *     the single DO alarm).
 *   - `surface` is exposed to plugins as `ctx.tasks` (see
 *     `OracleTasksSurface` in the plugin API).
 *
 * Task records live in the USER'S OWN SQLite database (`host.db`) so they are
 * part of the owner file the user controls — pausing, exporting or deleting
 * the file carries the tasks with it. A Durable Object is single-threaded, so
 * there are no run locks: `onAlarm` executes due runs serially.
 *
 * A run re-enters the SAME agent through `host.runTurn` — the exact entry the
 * HTTP shell and Matrix gateway use — on a synthetic per-task session
 * (`task:<taskId>`, `client: 'matrix'` so the session row is auto-created),
 * and the result is delivered to the user's oracle room via the Matrix
 * gateway. `before-action` tasks do not execute on fire: the scheduler posts
 * an approval request to the room and waits; `surface.resolveApproval`
 * (driven by the `resolve_task_approval` tool) triggers or drops the actual
 * run.
 */
import type {
  Logger,
  OracleTaskInput,
  OracleTaskRecord,
  OracleTaskSchedule,
  OracleTasksSurface,
} from '../plugin-api/types';
import type { DoSqliteDatabase } from '../sqlite/database';
import type { TurnRequest, TurnResult } from '../do/contracts';
import {
  backoffDelayMs,
  computeNextRunAtMs,
  DEFAULT_MAX_TASKS_PER_USER,
  DEFAULT_MIN_CRON_INTERVAL_SEC,
  MAX_CONSECUTIVE_FAILURES,
  cronIntervalMs,
  previewRuns,
  summarizeSchedule,
  validateSchedule,
} from './schedule';
import { newTaskId } from './spec';
import { TasksStore, type TaskRecord } from './store';

/** Session-id prefix for the synthetic sessions task runs execute on. */
export const TASK_SESSION_PREFIX = 'task:';

/**
 * The slice of the Matrix gateway the scheduler needs. Structural, so the
 * host passes its `DurableObjectStub<MatrixGatewayObject>` unchanged while
 * tests inject a recording fake.
 */
export interface TaskGateway {
  /** Create a private bot-owned room and invite the user (dedicated task rooms). */
  createDedicatedRoom(opts: {
    name: string;
    topic?: string;
    invite: string[];
    userDid: string;
  }): Promise<{ roomId: string }>;
  /** Send a text message to a room; resolves to the new event id. */
  sendText(
    roomId: string,
    body: string,
    opts?: { threadId?: string; formattedBody?: string },
  ): Promise<string>;
  /** Resolve the canonical user↔oracle room for a user DID. */
  resolveUserRoom(
    userDid: string,
  ): Promise<{ roomId: string; alias: string } | null>;
}

export interface TaskSchedulerHost {
  db: DoSqliteDatabase;
  userDid: string;
  oracleDid: string;
  oracleName: string;
  /** The user's Matrix id when known (threaded into run identities). */
  matrixUserId?: string;
  gateway: TaskGateway;
  /** Run one agent turn in this user's object (same entry the HTTP shell uses). */
  runTurn: (req: TurnRequest) => Promise<TurnResult>;
  /** Ask the object to re-arm its alarm no later than `at` (ms epoch). */
  requestAlarm: (at: number) => void;
  log: Logger;
  /** Live-task cap (`TASKS_MAX_PER_USER`). Default 50. */
  maxTasksPerUser?: number;
  /** Minimum seconds between recurring runs (`TASKS_MIN_CRON_INTERVAL_SEC`). Default 300. */
  minCronIntervalSec?: number;
}

export interface TaskScheduler {
  /** Plugin-facing surface, exposed as `ctx.tasks`. */
  surface: OracleTasksSurface;
  /** Earliest pending deadline (ms epoch), or null when nothing is scheduled. */
  nextWakeAt(): Promise<number | null>;
  /** Run everything that is due. Must be safe to call spuriously. */
  onAlarm(now: number): Promise<void>;
}

/** How much of a run's output is kept as `lastResult.summary`. */
const RESULT_SUMMARY_MAX = 500;
/** How much of an error message is kept in bookkeeping / notices. */
const ERROR_MAX = 1024;

/** The instruction message a scheduled run enters the agent with. */
function buildRunMessage(task: TaskRecord, approvalNote?: string): string {
  const lines = [
    `[Scheduled task run — "${task.title}" (${task.id})]`,
    'You are executing a scheduled background task for the user. No user is present in this turn: do the work now and reply with the final result only — your reply is delivered to their chat room as the task result.',
  ];
  if (approvalNote?.trim()) {
    lines.push(
      '',
      `The user approved this run with a note: ${approvalNote.trim()}`,
    );
  }
  lines.push('', 'Task instructions:', task.intent);
  return lines.join('\n');
}

/** Posted to the room when a `before-action` task fires. */
const DAY_MS = 24 * 3600 * 1000;

/**
 * The Node runtime's heuristic for giving a task its own room: an explicit
 * choice wins; otherwise a sub-daily cadence, a long intent, or an ongoing
 * monitor/watch/track intent gets one.
 */
export function shouldCreateDedicatedRoom(args: {
  schedule: OracleTaskSchedule;
  intent: string;
  explicit: 'auto' | 'yes' | 'no';
}): boolean {
  if (args.explicit !== 'auto') return args.explicit === 'yes';
  const { schedule } = args;
  if (schedule.kind === 'cron') {
    const interval = cronIntervalMs(schedule.cron, schedule.timezone);
    if (interval !== null && interval < DAY_MS) return true;
  } else if (schedule.kind === 'interval') {
    if (schedule.everySeconds * 1000 < DAY_MS) return true;
  }
  if (args.intent.length > 800) return true;
  return /\b(monitor|ongoing|watch|track)\b/i.test(args.intent);
}

/** Posted into a freshly created `[Task]` room so the user knows what lives there. */
function taskSummaryMessage(task: TaskRecord): string {
  return [
    `🗓️ **${task.title}** (task \`${task.id}\`)`,
    '',
    `Schedule: ${summarizeSchedule(task.schedule)}`,
    task.approval === 'before-action'
      ? 'Each run asks for your approval here before it acts.'
      : 'Each run posts its result here.',
    '',
    'What it does:',
    task.intent,
  ].join('\n');
}

function approvalRequestMessage(task: TaskRecord): string {
  return [
    `⏳ **${task.title}** is ready to run and needs your approval before it acts (task \`${task.id}\`).`,
    '',
    'What it will do:',
    task.intent,
    '',
    "Reply here to approve or decline — I'll run it only once you approve.",
  ].join('\n');
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX);
}

class AlarmTaskScheduler implements TaskScheduler {
  readonly surface: OracleTasksSurface;
  private readonly maxTasksPerUser: number;
  private readonly minCronIntervalSec: number;

  constructor(
    private readonly host: TaskSchedulerHost,
    private readonly store: TasksStore,
  ) {
    this.maxTasksPerUser = host.maxTasksPerUser ?? DEFAULT_MAX_TASKS_PER_USER;
    this.minCronIntervalSec =
      host.minCronIntervalSec ?? DEFAULT_MIN_CRON_INTERVAL_SEC;
    this.surface = {
      preview: (input) => this.preview(input),
      create: (input) => this.create(input),
      list: () => this.store.list(),
      get: (id) => this.store.get(id),
      update: (id, patch) => this.update(id, patch),
      pause: (id) => this.pause(id),
      resume: (id) => this.resume(id),
      cancel: (id) => this.cancel(id),
      resolveApproval: (taskId, decision, note) =>
        this.resolveApproval(taskId, decision, note),
    };
  }

  // ── alarm client ─────────────────────────────────────────────────────────

  async nextWakeAt(): Promise<number | null> {
    return this.store.minNextRunAt();
  }

  async onAlarm(now: number): Promise<void> {
    const due = await this.store.due(now);
    for (const stale of due) {
      // Re-load: a tool call awaited between iterations may have paused,
      // cancelled or rescheduled the task since the due scan.
      const task = await this.store.get(stale.id);
      if (!task || task.status !== 'active' || task.nextRunAt === undefined) {
        continue;
      }
      if (Date.parse(task.nextRunAt) > now) continue;
      try {
        if (task.approval === 'before-action') {
          await this.requestApproval(task, now);
        } else {
          await this.executeRun(task, now);
        }
      } catch (err) {
        // `executeRun`/`requestApproval` do their own failure bookkeeping —
        // reaching here means the BOOKKEEPING failed (storage trouble). Log
        // and move on; the 1s re-arm floor below prevents a hot loop.
        this.host.log.error(
          `[tasks] run bookkeeping crashed for ${task.id}: ${errorMessage(err)}`,
        );
      }
    }
    const next = await this.store.minNextRunAt();
    if (next !== null) this.host.requestAlarm(Math.max(next, now + 1000));
  }

  // ── surface: preview / create ────────────────────────────────────────────

  private async problemsFor(input: OracleTaskInput): Promise<string[]> {
    const problems: string[] = [];
    if (input.title.trim().length === 0)
      problems.push('Title must not be empty.');
    if (input.title.trim().length > 120) {
      problems.push('Title must be at most 120 characters.');
    }
    if (input.intent.trim().length === 0) {
      problems.push('Intent must not be empty.');
    }
    problems.push(...validateSchedule(input.schedule, this.minCronIntervalSec));
    const live = await this.store.countLive();
    if (live >= this.maxTasksPerUser) {
      problems.push(
        `Task limit reached (${this.maxTasksPerUser}). Cancel an existing task first.`,
      );
    }
    return problems;
  }

  private async preview(
    input: OracleTaskInput,
  ): Promise<{ ok: boolean; nextRuns: string[]; problems: string[] }> {
    const problems = await this.problemsFor(input);
    const nextRuns = previewRuns(input.schedule, 3, Date.now());
    if (problems.length === 0 && nextRuns.length === 0) {
      problems.push('Schedule has no future run time.');
    }
    return { ok: problems.length === 0, nextRuns, problems };
  }

  private async create(input: OracleTaskInput): Promise<OracleTaskRecord> {
    const problems = await this.problemsFor(input);
    if (problems.length > 0) throw new Error(problems.join(' '));
    const nowMs = Date.now();
    const nextMs = computeNextRunAtMs(input.schedule, nowMs);
    if (nextMs === null) throw new Error('Schedule has no future run time.');
    const title = input.title.trim();
    const nowIso = new Date(nowMs).toISOString();
    const record: TaskRecord = {
      id: newTaskId(title),
      title,
      intent: input.intent.trim(),
      schedule: input.schedule,
      status: 'active',
      approval: input.approval ?? 'never',
      createdAt: nowIso,
      updatedAt: nowIso,
      nextRunAt: new Date(nextMs).toISOString(),
      consecutiveFailures: 0,
    };
    // A `before-action` task ALWAYS needs its own room: that is where each
    // run posts its approval request and the user answers. Without one the
    // approval conversation has nowhere to happen, so a failure is fatal.
    if (record.approval === 'before-action') {
      const roomId = await this.createDedicatedRoom(record);
      if (!roomId) {
        throw new Error(
          'Could not create the task room needed for approval — try again.',
        );
      }
      record.deliveryRoomId = roomId;
    } else if (
      shouldCreateDedicatedRoom({
        schedule: record.schedule,
        intent: record.intent,
        explicit: input.dedicatedRoom ?? 'auto',
      })
    ) {
      const roomId = await this.createDedicatedRoom(record);
      if (roomId) record.deliveryRoomId = roomId;
    }
    await this.store.insert(record);
    this.host.requestAlarm(nextMs);
    this.host.log.log(
      `[tasks] created ${record.id} — ${summarizeSchedule(record.schedule)}; next run ${record.nextRunAt}`,
    );
    return record;
  }

  // ── surface: update / lifecycle ──────────────────────────────────────────

  private async load(id: string): Promise<TaskRecord> {
    const task = await this.store.get(id);
    if (!task) throw new Error('Task not found.');
    return task;
  }

  private async update(
    id: string,
    patch: Partial<OracleTaskInput>,
  ): Promise<OracleTaskRecord> {
    const task = await this.load(id);
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new Error(
        `A ${task.status} task cannot be updated — create a new one.`,
      );
    }
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title.length === 0 || title.length > 120) {
        throw new Error('Title must be 1–120 characters.');
      }
      task.title = title;
    }
    if (patch.intent !== undefined) {
      const intent = patch.intent.trim();
      if (intent.length === 0) throw new Error('Intent must not be empty.');
      task.intent = intent;
    }
    if (patch.approval !== undefined) {
      task.approval = patch.approval;
      // A task no longer gated on approval cannot keep a pending request.
      if (patch.approval === 'never') delete task.pendingApprovalAt;
    }
    let nextMs: number | null = null;
    if (patch.schedule !== undefined) {
      const problems = validateSchedule(
        patch.schedule,
        this.minCronIntervalSec,
      );
      if (problems.length > 0) throw new Error(problems.join(' '));
      task.schedule = patch.schedule;
      if (task.status === 'active') {
        nextMs = computeNextRunAtMs(patch.schedule, Date.now());
        if (nextMs === null) {
          throw new Error(
            'Schedule has no future run time — adjust it and try again.',
          );
        }
        task.nextRunAt = new Date(nextMs).toISOString();
      } else {
        // Paused/failed: resume recomputes the next run from the new schedule.
        delete task.nextRunAt;
      }
    }
    task.updatedAt = new Date().toISOString();
    await this.store.save(task);
    if (nextMs !== null) this.host.requestAlarm(nextMs);
    return task;
  }

  private async pause(id: string): Promise<OracleTaskRecord> {
    const task = await this.load(id);
    if (task.status === 'paused') return task;
    if (task.status !== 'active') {
      throw new Error(`A ${task.status} task cannot be paused.`);
    }
    task.status = 'paused';
    delete task.nextRunAt;
    // Pausing drops an unanswered approval request with it.
    delete task.pendingApprovalAt;
    task.updatedAt = new Date().toISOString();
    await this.store.save(task);
    return task;
  }

  private async resume(id: string): Promise<OracleTaskRecord> {
    const task = await this.load(id);
    if (task.status === 'active') return task;
    if (task.status !== 'paused' && task.status !== 'failed') {
      throw new Error(
        `A ${task.status} task cannot be resumed — create a new one.`,
      );
    }
    const nextMs = computeNextRunAtMs(task.schedule, Date.now());
    if (nextMs === null) {
      throw new Error(
        'Schedule has no future run time — update the schedule first.',
      );
    }
    task.status = 'active';
    task.nextRunAt = new Date(nextMs).toISOString();
    task.consecutiveFailures = 0;
    // Resuming skips any stale unanswered approval request.
    delete task.pendingApprovalAt;
    task.updatedAt = new Date().toISOString();
    await this.store.save(task);
    this.host.requestAlarm(nextMs);
    return task;
  }

  private async cancel(id: string): Promise<OracleTaskRecord> {
    const task = await this.load(id);
    if (task.status === 'cancelled') return task;
    if (task.status === 'completed') {
      throw new Error('A completed task cannot be cancelled.');
    }
    task.status = 'cancelled';
    delete task.nextRunAt;
    delete task.pendingApprovalAt;
    task.updatedAt = new Date().toISOString();
    await this.store.save(task);
    this.host.log.log(`[tasks] cancelled ${task.id}`);
    return task;
  }

  // ── approval flow ────────────────────────────────────────────────────────

  /**
   * A `before-action` fire does NOT execute: post the approval request and
   * wait. The cadence continues regardless — a later fire of a recurring task
   * supersedes an unanswered request (the marker is simply overwritten). A
   * one-shot clears its `nextRunAt` and sits waiting on the decision.
   */
  private async requestApproval(
    task: TaskRecord,
    nowMs: number,
  ): Promise<void> {
    const startedAt = new Date(nowMs).toISOString();
    try {
      const roomId = await this.resolveDeliveryRoom(task);
      if (!roomId) {
        throw new Error(
          'Could not resolve a delivery room for the approval request',
        );
      }
      await this.host.gateway.sendText(roomId, approvalRequestMessage(task));
      task.pendingApprovalAt = startedAt;
      if (task.schedule.kind === 'once') {
        delete task.nextRunAt;
      } else {
        const nextMs = computeNextRunAtMs(
          task.schedule,
          Math.max(nowMs, Date.now()),
        );
        if (nextMs !== null) task.nextRunAt = new Date(nextMs).toISOString();
        else delete task.nextRunAt;
      }
      task.updatedAt = new Date().toISOString();
      await this.host.db.transaction(async () => {
        await this.store.save(task);
        await this.store.recordRun({
          runId: crypto.randomUUID(),
          taskId: task.id,
          startedAt,
          finishedAt: new Date().toISOString(),
          detail: 'approval requested',
        });
      });
      this.host.log.log(`[tasks] approval requested for ${task.id}`);
    } catch (err) {
      await this.recordFailure(task, nowMs, startedAt, err);
    }
  }

  private async resolveApproval(
    taskId: string,
    decision: 'approve' | 'reject',
    note?: string,
  ): Promise<{ resolved: boolean }> {
    const task = await this.store.get(taskId);
    if (
      !task ||
      task.status !== 'active' ||
      task.pendingApprovalAt === undefined
    ) {
      return { resolved: false };
    }
    // Clear the marker FIRST (and persist) so a concurrent resolve is a
    // no-op instead of a double execution.
    delete task.pendingApprovalAt;
    task.updatedAt = new Date().toISOString();

    if (decision === 'reject') {
      if (task.schedule.kind === 'once') {
        // A declined one-shot has nothing left to run.
        task.status = 'cancelled';
        delete task.nextRunAt;
      }
      await this.host.db.transaction(async () => {
        await this.store.save(task);
        await this.store.recordRun({
          runId: crypto.randomUUID(),
          taskId: task.id,
          startedAt: task.updatedAt,
          finishedAt: task.updatedAt,
          detail: note?.trim() ? `declined: ${note.trim()}` : 'declined',
        });
      });
      this.host.log.log(`[tasks] approval declined for ${task.id}`);
      return { resolved: true };
    }

    await this.store.save(task);
    this.host.log.log(`[tasks] approval granted for ${task.id} — running now`);
    await this.executeRun(task, Date.now(), { approvalNote: note });
    return { resolved: true };
  }

  // ── run execution ────────────────────────────────────────────────────────

  /** The task's dedicated room when it has one, else the user's main room. */
  private async resolveDeliveryRoom(task: TaskRecord): Promise<string | null> {
    if (task.deliveryRoomId) return task.deliveryRoomId;
    const room = await this.host.gateway
      .resolveUserRoom(this.host.userDid)
      .catch(() => null);
    return room?.roomId ?? null;
  }

  /**
   * Create the `[Task] <title>` room and post the task summary into it —
   * the Node runtime's `DeliveryService.createDedicatedRoom`. Returns null
   * (never throws) when the user has no known Matrix id or the gateway
   * fails; the caller decides whether that is fatal.
   */
  private async createDedicatedRoom(task: TaskRecord): Promise<string | null> {
    const userMatrixId = this.host.matrixUserId;
    if (!userMatrixId) {
      this.host.log.warn(
        `[tasks] no Matrix id known for ${this.host.userDid}; ${task.id} delivers to the main room`,
      );
      return null;
    }
    try {
      const { roomId } = await this.host.gateway.createDedicatedRoom({
        name: `[Task] ${task.title}`,
        topic: `Scheduled task: ${task.title}`,
        invite: [userMatrixId],
        userDid: this.host.userDid,
      });
      await this.host.gateway
        .sendText(roomId, taskSummaryMessage(task))
        .catch((err: unknown) => {
          this.host.log.warn(
            `[tasks] summary for ${task.id} not posted to ${roomId}: ${errorMessage(err)}`,
          );
        });
      return roomId;
    } catch (err) {
      this.host.log.warn(
        `[tasks] dedicated room for ${task.id} could not be created: ${errorMessage(err)}`,
      );
      return null;
    }
  }

  /**
   * The hot path: run the agent turn on the task's synthetic session, deliver
   * the output to the user's room, then advance the schedule. Any throw —
   * turn, empty output, delivery — lands in `recordFailure`.
   *
   * `opts.approvalNote` marks an approval-triggered run: the schedule was
   * already advanced when the request was posted, so only a one-shot's
   * completion is recorded here.
   */
  private async executeRun(
    task: TaskRecord,
    nowMs: number,
    opts: { approvalNote?: string } = {},
  ): Promise<void> {
    const approvalRun = task.approval === 'before-action';
    const startedAt = new Date(nowMs).toISOString();
    try {
      const roomId = await this.resolveDeliveryRoom(task);
      if (!roomId) throw new Error('Could not resolve a delivery room');
      const result = await this.host.runTurn({
        identity: {
          userDid: this.host.userDid,
          ...(this.host.matrixUserId
            ? { matrixUserId: this.host.matrixUserId }
            : {}),
        },
        sessionId: `${TASK_SESSION_PREFIX}${task.id}`,
        message: buildRunMessage(task, opts.approvalNote),
        client: 'matrix',
        roomId,
        requestId: crypto.randomUUID(),
      });
      const text = result.text.trim();
      if (text.length === 0) throw new Error('Agent returned no output');
      // A delivery failure IS a run failure — a silent log-and-continue would
      // mean "task succeeded" while the user never saw the result.
      await this.host.gateway.sendText(
        roomId,
        `🕒 **${task.title}**\n\n${text}`,
      );

      const finishedAt = new Date().toISOString();
      task.lastRunAt = startedAt;
      task.lastResult = {
        ok: true,
        summary: text.slice(0, RESULT_SUMMARY_MAX),
        at: finishedAt,
      };
      task.consecutiveFailures = 0;
      if (task.schedule.kind === 'once') {
        task.status = 'completed';
        delete task.nextRunAt;
      } else if (!approvalRun) {
        // Advance from real time (a long run must not produce a next fire in
        // the past). Approval runs already advanced when the request posted.
        const nextMs = computeNextRunAtMs(
          task.schedule,
          Math.max(nowMs, Date.now()),
        );
        if (nextMs !== null) task.nextRunAt = new Date(nextMs).toISOString();
        else delete task.nextRunAt;
      }
      task.updatedAt = finishedAt;
      await this.host.db.transaction(async () => {
        await this.store.save(task);
        await this.store.recordRun({
          runId: crypto.randomUUID(),
          taskId: task.id,
          startedAt,
          finishedAt,
          ok: true,
          detail: task.lastResult?.summary,
        });
      });
      this.host.log.log(
        `[tasks] run delivered for ${task.id} (${text.length} chars)`,
      );
    } catch (err) {
      await this.recordFailure(task, nowMs, startedAt, err);
    }
  }

  /**
   * Failure bookkeeping. A one-shot has no next occurrence to retry into, so
   * any failure stops it as `failed` — loudly. A recurring task retries at
   * the LATER of its own next fire and the exponential backoff, and stops as
   * `failed` at the consecutive-failure threshold.
   */
  private async recordFailure(
    task: TaskRecord,
    nowMs: number,
    startedAt: string,
    err: unknown,
  ): Promise<void> {
    const message = errorMessage(err);
    const finishedAt = new Date().toISOString();
    task.consecutiveFailures += 1;
    task.lastRunAt = startedAt;
    task.lastResult = { ok: false, summary: message, at: finishedAt };
    task.updatedAt = finishedAt;

    const oneShot = task.schedule.kind === 'once';
    const exhausted =
      oneShot || task.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
    let stopped = false;
    if (exhausted) {
      task.status = 'failed';
      delete task.nextRunAt;
      delete task.pendingApprovalAt;
      stopped = true;
    } else {
      const scheduleNext = computeNextRunAtMs(
        task.schedule,
        Math.max(nowMs, Date.now()),
      );
      if (scheduleNext === null) {
        task.status = 'failed';
        delete task.nextRunAt;
        delete task.pendingApprovalAt;
        stopped = true;
      } else {
        const retryAt = Math.max(
          scheduleNext,
          Math.max(nowMs, Date.now()) +
            backoffDelayMs(task.consecutiveFailures),
        );
        task.nextRunAt = new Date(retryAt).toISOString();
      }
    }
    await this.host.db.transaction(async () => {
      await this.store.save(task);
      await this.store.recordRun({
        runId: crypto.randomUUID(),
        taskId: task.id,
        startedAt,
        finishedAt,
        ok: false,
        detail: message,
      });
    });
    this.host.log.warn(
      `[tasks] run failed for ${task.id} (${task.consecutiveFailures} consecutive${stopped ? ', stopped' : ''}): ${message}`,
    );
    if (stopped) {
      // Best-effort notice — the failure bookkeeping above is already saved.
      const roomId = await this.resolveDeliveryRoom(task);
      if (roomId) {
        const text = oneShot
          ? `🛑 Your scheduled task \`${task.id}\` failed and is stopped: ${message.slice(0, 200)}\n\nAsk me to **suggest a fix** when you're ready.`
          : `🛑 Task \`${task.id}\` failed ${task.consecutiveFailures} times in a row and is stopped. Ask me to **suggest a fix** when you're ready.`;
        await this.host.gateway
          .sendText(roomId, text)
          .catch((postErr: unknown) => {
            this.host.log.warn(
              `[tasks] failure notice for ${task.id} could not be posted: ${errorMessage(postErr)}`,
            );
          });
      }
    }
  }
}

export async function createTaskScheduler(
  host: TaskSchedulerHost,
): Promise<TaskScheduler> {
  const store = new TasksStore(host.db);
  await store.setup();
  return new AlarmTaskScheduler(host, store);
}
