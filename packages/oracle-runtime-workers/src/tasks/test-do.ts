import { markdownDigest } from './topic-deliverables';
import type { TopicResearchRequest } from './topic-research';
import type {
  TopicDeliverableRequest,
  TopicDeliverableResult,
} from './topic-deliverables';
/**
 * Test-only Durable Object driving the task scheduler against a REAL
 * `DoSqliteDatabase` (wa-sqlite over DO storage) inside workerd. Bound as
 * `TASKS_TEST` by `test/wrangler.test.jsonc`.
 *
 * The Matrix gateway and the agent turn are recording fakes so tests can
 * script success/failure and assert deliveries, turn requests and alarm
 * re-arms; everything else — the store DDL, scheduling math, approval flow,
 * failure backoff — is the production code path.
 *
 * Not part of the runtime.
 */
import { DurableObject } from 'cloudflare:workers';
import type { OracleTaskInput, OracleTaskRecord } from '../plugin-api/types';
import type { TurnRequest } from '../do/contracts';
import { ToolScheduler } from '../core/tool-scheduler';
import {
  DoSqliteDatabase,
  type SqlParam,
  type SqlParams,
  type SqlRow,
} from '../sqlite/database';
import { createTaskScheduler, type TaskScheduler } from './scheduler';
import {
  TasksStore,
  type OpenTaskRun,
  type TaskRunEntry,
  type TaskRunState,
} from './store';

export interface SentMessage {
  roomId: string;
  body: string;
  txnId?: string;
}

/**
 * How the fake gateway answers `sendText`: `fail-transient` looks like a
 * gateway restart (retried by the scheduler), `fail-transient-once` only for
 * the next call, `fail` is a hard error (never retried). `lost-response-once`
 * posts the message and then loses the response (a gateway reset right
 * after the send). Like the homeserver, the fake posts a message only once
 * per transaction id.
 */
export type SendMode =
  | 'ok'
  | 'fail-transient'
  | 'fail-transient-once'
  | 'lost-response-once'
  | 'fail'
  | 'hang-before-send'
  | 'hang';

/**
 * How the fake agent turn behaves: `write-tool` calls one write tool through
 * the object's write lane (a real `ToolScheduler`) and fails if it waits for
 * the slot longer than `WRITE_SLOT_WAIT_MS` — what a held write slot does to
 * a real turn, minus the ten-minute turn timeout.
 */
export type TurnMode = 'ok' | 'fail' | 'empty' | 'hang' | 'write-tool';

const WRITE_SLOT_WAIT_MS = 2_000;

export interface CreatedRoom {
  roomId: string;
  name: string;
  invite: string[];
}

export interface TasksTestInit {
  maxTasksPerUser?: number;
  minCronIntervalSec?: number;
  /** Delivery retry delays; tests keep them at a few ms. */
  deliveryRetryDelaysMs?: number[];
  deliveryRoundBackoffMs?: number[];
}

/** Task run ids whose durable turn run the fake object reports as live. */
const liveTurnRuns = new Set<string>();

export const TEST_USER_DID = 'did:ixo:taskstestuser';
export const TEST_USER_MATRIX_ID = '@did-ixo-taskstestuser:example.org';
export const TEST_ROOM_ID = '!tasks-test-room:example.org';

export class TasksTestDO extends DurableObject {
  private db: DoSqliteDatabase | undefined;
  private scheduler: TaskScheduler | undefined;
  private nextTransactionGate: Promise<void> | undefined;
  private transactionRelease: (() => void) | undefined;
  private transactionBlocked = false;
  private store: TasksStore | undefined;

  private sent: SentMessage[] = [];
  private rooms: CreatedRoom[] = [];
  private roomSeq = 0;
  private roomCreation: 'ok' | 'fail' = 'ok';
  private turns: TurnRequest[] = [];
  private alarms: number[] = [];
  private alarmMode: 'ok' | 'fail' | 'hang' = 'ok';
  private hangingAlarms: Array<() => void> = [];
  private aborted: Array<{ sessionId: string; status: string | undefined }> =
    [];
  private turnMode: TurnMode = 'ok';
  private turnText = 'task run output';
  /** Text per task session; other sessions answer `turnText`. */
  private turnTextBySession = new Map<string, string>();
  /** Task sessions whose turns hang until `releaseTurns()`, whatever the mode. */
  private hangingSessions = new Set<string>();
  private roomAvailable = true;
  private eventSeq = 0;
  private sendMode: SendMode = 'ok';
  /** Sends whose body contains this fail hard, whatever the mode. */
  private failingBody: string | null = null;
  private sendFailures = 0;
  /** Event id per transaction id: the homeserver posts a txn id once. */
  private sentTxnIds = new Map<string, string>();
  /** Hanging turns started and not yet released, and the most at once. */
  private turnsInFlight = 0;
  private peakTurnsInFlight = 0;
  /** Resolvers of hanging turns (`turnMode = 'hang'`), released by `releaseTurns()`. */
  private hanging: Array<() => void> = [];
  private hangingSends: Array<() => void> = [];
  private researchAuthorized = true;
  private researchCommits = 0;
  private researchCommitGate: Promise<void> | undefined;
  private releaseResearchCommit: (() => void) | undefined;
  private researchCommitBlocked = false;
  private initOpts: TasksTestInit = {};
  /** The object's write lane, shared by every "tool call" of this fake object. */
  private readonly toolScheduler = new ToolScheduler();
  /** SQL statements issued while recording (`startStatementLog`). */
  private statementLog: Array<{ sql: string; params?: SqlParams }> | null =
    null;

  async init(opts: TasksTestInit = {}): Promise<void> {
    if (this.scheduler) return;
    this.initOpts = opts;
    this.db = await this.openDb();
    this.store = new TasksStore(this.db, console);
    this.scheduler = await this.buildScheduler(opts);
  }

  /**
   * `init` over a file that already holds `statements` — an older schema
   * with its rows, as a user file written by an earlier runtime would.
   */
  async initWith(
    statements: Array<{ sql: string; params?: SqlParam[] }>,
  ): Promise<void> {
    if (this.scheduler) throw new Error('already initialised');
    this.db = await this.openDb();
    for (const statement of statements)
      await this.db.run(statement.sql, statement.params ?? []);
    this.store = new TasksStore(this.db, console);
    this.scheduler = await this.buildScheduler(this.initOpts);
  }

  /** The test database, with every statement recorded while a log is open. */
  private async openDb(): Promise<DoSqliteDatabase> {
    const db = await DoSqliteDatabase.open(this.ctx, 'tasks-test.db');
    const exec = db.exec.bind(db);
    const run = db.run.bind(db);
    const transaction = db.transaction.bind(db);
    db.transaction = async <T>(fn: () => Promise<T>): Promise<T> => {
      const gate = this.nextTransactionGate;
      this.nextTransactionGate = undefined;
      if (gate) {
        this.transactionBlocked = true;
        await gate;
        this.transactionBlocked = false;
      }
      return transaction(fn);
    };
    db.exec = <T extends SqlRow = SqlRow>(sql: string, params?: SqlParams) => {
      this.statementLog?.push({ sql, ...(params ? { params } : {}) });
      return exec<T>(sql, params);
    };
    db.run = (sql: string, params?: SqlParams) => {
      this.statementLog?.push({ sql, ...(params ? { params } : {}) });
      return run(sql, params);
    };
    return db;
  }

  async blockNextTransaction(): Promise<void> {
    this.nextTransactionGate = new Promise<void>((resolve) => {
      this.transactionRelease = resolve;
    });
  }
  async isTransactionBlocked(): Promise<boolean> {
    return this.transactionBlocked;
  }
  async releaseTransaction(): Promise<void> {
    this.transactionRelease?.();
    this.transactionRelease = undefined;
  }

  async startStatementLog(): Promise<void> {
    this.statementLog = [];
  }

  async stopStatementLog(): Promise<
    Array<{ sql: string; params?: SqlParams }>
  > {
    const log = this.statementLog ?? [];
    this.statementLog = null;
    return log;
  }

  /** `EXPLAIN QUERY PLAN` details of one statement. */
  async queryPlan(sql: string, params: SqlParams = []): Promise<string[]> {
    if (!this.db) throw new Error('call init() first');
    const rows = await this.db.exec<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${sql}`,
      params,
    );
    return rows.map((row) => row.detail);
  }

  /** The raw run rows of one task, newest first (columns the store does not expose). */
  async rawRuns(taskId: string): Promise<
    Array<{
      run_id: string;
      state: string | null;
      result_text: string | null;
      retry_at: number | null;
    }>
  > {
    if (!this.db) throw new Error('call init() first');
    return this.db.exec(
      `SELECT run_id, state, result_text, retry_at FROM task_runs WHERE task_id = ?
       ORDER BY started_at DESC, run_id DESC`,
      [taskId],
    );
  }

  /** Write a row the way something other than the surface would (another runtime, a host adapter). */
  async runSql(sql: string, params: SqlParam[] = []): Promise<void> {
    if (!this.db) throw new Error('call init() first');
    await this.db.run(sql, params);
  }

  async isRestrictedSession(sessionId: string): Promise<boolean> {
    return this.ready().isRestrictedSession(sessionId);
  }

  /**
   * A platform reset, as far as the scheduler can tell: a fresh scheduler
   * over the SAME database, with nothing in memory. In-flight fakes are
   * abandoned exactly like the real object's in-flight turns.
   */
  async simulateReset(): Promise<void> {
    if (!this.db) throw new Error('call init() first');
    this.hanging = [];
    this.scheduler = await this.buildScheduler(this.initOpts);
  }

  private buildScheduler(opts: TasksTestInit): Promise<TaskScheduler> {
    if (!this.db) throw new Error('call init() first');
    return createTaskScheduler({
      db: this.db,
      userDid: TEST_USER_DID,
      authorizeResearch: async () => {
        if (!this.researchAuthorized)
          throw new Error('Current authority revoked');
      },
      commitResearch: async (operationId, _request, markdown) => {
        if (!this.researchAuthorized)
          throw new Error('Current authority revoked');
        this.researchCommits += 1;
        if (this.researchCommitGate) {
          this.researchCommitBlocked = true;
          await this.researchCommitGate;
          this.researchCommitBlocked = false;
        }
        return [
          {
            resource: 'ixo:filesystem',
            fileId: `file-${operationId}`,
            version: 1,
            cid: `cid-${operationId}`,
            sha256: await markdownDigest(markdown),
            name: 'report.md',
            path: `/.workspaces/${operationId}/report.md`,
            mediaType: 'text/markdown',
            bytes: new TextEncoder().encode(markdown).byteLength,
          },
        ];
      },
      oracleDid: 'did:ixo:tasksoracle',
      oracleName: 'TasksTestOracle',
      matrixUserId: TEST_USER_MATRIX_ID,
      gateway: {
        createDedicatedRoom: (opts: { name: string; invite: string[] }) => {
          if (this.roomCreation === 'fail') {
            return Promise.reject(
              new Error('boom: simulated createRoom failure'),
            );
          }
          const roomId = `!task-room-${++this.roomSeq}:example.org`;
          this.rooms.push({ roomId, name: opts.name, invite: opts.invite });
          return Promise.resolve({ roomId });
        },
        sendText: (roomId: string, body: string, opts?: { txnId?: string }) => {
          if (this.sendMode === 'hang-before-send')
            return new Promise<string>(() => undefined);
          if (
            this.sendMode === 'fail' ||
            (this.failingBody !== null && body.includes(this.failingBody))
          ) {
            return Promise.reject(
              new Error('boom: simulated hard send failure'),
            );
          }
          if (
            this.sendMode === 'fail-transient' ||
            this.sendMode === 'fail-transient-once'
          ) {
            if (this.sendMode === 'fail-transient-once') this.sendMode = 'ok';
            this.sendFailures += 1;
            return Promise.reject(new Error('Network connection lost'));
          }
          const known = opts?.txnId
            ? this.sentTxnIds.get(opts.txnId)
            : undefined;
          if (known) return Promise.resolve(known);
          const eventId = `$evt-${++this.eventSeq}`;
          if (opts?.txnId) this.sentTxnIds.set(opts.txnId, eventId);
          this.sent.push({
            roomId,
            body,
            ...(opts?.txnId ? { txnId: opts.txnId } : {}),
          });
          if (this.sendMode === 'lost-response-once') {
            this.sendMode = 'ok';
            this.sendFailures += 1;
            return Promise.reject(new Error('Network connection lost'));
          }
          if (this.sendMode === 'hang')
            return new Promise<string>((resolve) =>
              this.hangingSends.push(() => resolve(eventId)),
            );
          return Promise.resolve(eventId);
        },
        resolveUserRoom: () =>
          Promise.resolve(
            this.roomAvailable
              ? { roomId: TEST_ROOM_ID, alias: '#tasks-test:example.org' }
              : null,
          ),
      },
      runTurn: async (req: TurnRequest) => {
        this.turns.push(req);
        if (this.turnMode === 'fail') {
          throw new Error('boom: simulated turn failure');
        }
        const result = {
          sessionId: req.sessionId,
          requestId: req.requestId,
          text:
            this.turnMode === 'empty'
              ? ''
              : (this.turnTextBySession.get(req.sessionId) ?? this.turnText),
          toolCalls: [],
        };
        if (this.turnMode === 'write-tool') {
          await this.toolScheduler.run(
            'write',
            AbortSignal.timeout(WRITE_SLOT_WAIT_MS),
            async () => undefined,
          );
        }
        if (
          this.turnMode === 'hang' ||
          this.hangingSessions.has(req.sessionId)
        ) {
          this.turnsInFlight += 1;
          this.peakTurnsInFlight = Math.max(
            this.peakTurnsInFlight,
            this.turnsInFlight,
          );
          try {
            return await new Promise<typeof result>((resolve) => {
              this.hanging.push(() => resolve(result));
            });
          } finally {
            this.turnsInFlight -= 1;
          }
        }
        return result;
      },
      abortTurn: async (sessionId) => {
        this.aborted.push({
          sessionId,
          status: (await this.store?.get(sessionId.slice(5)))?.status,
        });
        return true;
      },
      requestAlarm: async (at: number) => {
        this.alarms.push(at);
        if (this.alarmMode === 'fail')
          throw new Error('Alarm storage unavailable');
        if (this.alarmMode === 'hang')
          await new Promise<void>((resolve) =>
            this.hangingAlarms.push(resolve),
          );
      },
      turnRunLive: (taskRunId: string) => liveTurnRuns.has(taskRunId),
      log: console,
      ...(opts.maxTasksPerUser !== undefined
        ? { maxTasksPerUser: opts.maxTasksPerUser }
        : {}),
      ...(opts.minCronIntervalSec !== undefined
        ? { minCronIntervalSec: opts.minCronIntervalSec }
        : {}),
      deliveryRetryDelaysMs: opts.deliveryRetryDelaysMs ?? [5, 5],
      deliveryRoundBackoffMs: opts.deliveryRoundBackoffMs ?? [1_000, 2_000],
    });
  }

  private ready(): TaskScheduler {
    if (!this.scheduler) throw new Error('call init() first');
    return this.scheduler;
  }

  // ── surface passthroughs ─────────────────────────────────────────────────

  async setAlarmMode(mode: 'ok' | 'fail' | 'hang'): Promise<void> {
    this.alarmMode = mode;
  }
  async releaseAlarms(): Promise<void> {
    for (const resolve of this.hangingAlarms.splice(0)) resolve();
  }
  async research(
    action: 'start' | 'cancel' | 'read',
    operationId: string,
    request: TopicResearchRequest,
  ) {
    if (action === 'read') return this.ready().readTopicResearch(operationId);
    return action === 'start'
      ? this.ready().startTopicResearch(operationId, request)
      : this.ready().cancelTopicResearch(operationId, request);
  }
  async researchError(operationId: string, request: TopicResearchRequest) {
    try {
      await this.research('start', operationId, request);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  async createResearchError(input: OracleTaskInput) {
    try {
      await this.create(input);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  async setResearchAuthorized(value: boolean) {
    this.researchAuthorized = value;
  }
  async blockResearchCommit() {
    this.researchCommitGate = new Promise<void>((resolve) => {
      this.releaseResearchCommit = resolve;
    });
  }
  async isResearchCommitBlocked() {
    return this.researchCommitBlocked;
  }
  async unblockResearchCommit() {
    this.releaseResearchCommit?.();
    this.researchCommitGate = undefined;
  }
  async researchCommitCount() {
    return this.researchCommits;
  }
  async startTopicError(
    operationId: string,
    request: TopicDeliverableRequest,
  ): Promise<string> {
    try {
      await this.ready().startTopicDeliverable(operationId, request);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async startTopic(
    operationId: string,
    request: TopicDeliverableRequest,
  ): Promise<TopicDeliverableResult> {
    return this.ready().startTopicDeliverable(operationId, request);
  }
  async readTopic(operationId: string): Promise<TopicDeliverableResult> {
    return this.ready().readTopicDeliverable(operationId);
  }
  async cancelTopic(
    operationId: string,
    request: TopicDeliverableRequest,
  ): Promise<TopicDeliverableResult> {
    return this.ready().cancelTopicDeliverable(operationId, request);
  }
  async abortedTurns(): Promise<
    Array<{ sessionId: string; status: string | undefined }>
  > {
    return this.aborted;
  }

  async preview(
    input: OracleTaskInput,
  ): Promise<{ ok: boolean; nextRuns: string[]; problems: string[] }> {
    return this.ready().surface.preview(input);
  }

  async create(input: OracleTaskInput): Promise<OracleTaskRecord> {
    return this.ready().surface.create(input);
  }

  async list(): Promise<OracleTaskRecord[]> {
    return this.ready().surface.list();
  }

  /** Every loadable task row, including the ones the surface hides. */
  async storedTasks(): Promise<OracleTaskRecord[]> {
    if (!this.store) throw new Error('call init() first');
    return this.store.list();
  }

  async get(id: string): Promise<OracleTaskRecord | null> {
    return this.ready().surface.get(id);
  }

  async update(
    id: string,
    patch: Partial<OracleTaskInput>,
  ): Promise<OracleTaskRecord> {
    return this.ready().surface.update(id, patch);
  }

  async pause(id: string): Promise<OracleTaskRecord> {
    return this.ready().surface.pause(id);
  }

  async resume(id: string): Promise<OracleTaskRecord> {
    return this.ready().surface.resume(id);
  }

  async profileError(req: TurnRequest): Promise<string> {
    try {
      await this.ready().assertTurnProfile(req);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async cancel(id: string): Promise<OracleTaskRecord> {
    return this.ready().surface.cancel(id);
  }

  async resolveApproval(
    taskId: string,
    decision: 'approve' | 'reject',
    note?: string,
    approvalRequestId?: string,
  ): Promise<{ resolved: boolean }> {
    const surface = this.ready().surface;
    const requestId =
      approvalRequestId ?? (await surface.get(taskId))?.approvalRequest?.id;
    return surface.resolveApproval(taskId, decision, note, requestId);
  }

  async approvalReceipts(taskId: string) {
    return this.ready().approvalReceipts(taskId);
  }

  /**
   * A trusted host approval action while another caller holds the write slot:
   * it holds the object's single write slot for
   * the whole call.
   */
  async resolveApprovalAsTool(
    taskId: string,
    decision: 'approve' | 'reject',
    note?: string,
  ): Promise<{ resolved: boolean }> {
    const surface = this.ready().surface;
    const requestId = (await surface.get(taskId))?.approvalRequest?.id;
    return this.toolScheduler.run('write', undefined, () =>
      surface.resolveApproval(taskId, decision, note, requestId),
    );
  }

  /**
   * Run a surface call that is EXPECTED to throw and return its message ('' on
   * unexpected success). Throwing across the DO RPC boundary leaves workerd
   * with an uncaught-rejection report even when the test handles it, so
   * error-path assertions go through this instead of `rejects.toThrow`.
   */
  async errorOf(
    op:
      | { kind: 'create'; input: OracleTaskInput }
      | { kind: 'update'; id: string; patch: Partial<OracleTaskInput> }
      | { kind: 'pause'; id: string }
      | { kind: 'resume'; id: string }
      | { kind: 'cancel'; id: string },
  ): Promise<string> {
    const surface = this.ready().surface;
    try {
      switch (op.kind) {
        case 'create':
          await surface.create(op.input);
          break;
        case 'update':
          await surface.update(op.id, op.patch);
          break;
        case 'pause':
          await surface.pause(op.id);
          break;
        case 'resume':
          await surface.resume(op.id);
          break;
        case 'cancel':
          await surface.cancel(op.id);
          break;
      }
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  // ── scheduler passthroughs ───────────────────────────────────────────────

  /** One alarm tick; resolves to the next wake the scheduler computed. */
  async tick(now: number): Promise<number | null> {
    return this.ready().onAlarm(now);
  }

  async nextWakeAt(): Promise<number | null> {
    return this.ready().nextWakeAt();
  }

  async isRunActive(runId: string): Promise<boolean> {
    return this.ready().isRunActive(runId);
  }

  // ── fakes: scripting + inspection ────────────────────────────────────────

  async setTurnBehavior(mode: TurnMode, text?: string): Promise<void> {
    this.turnMode = mode;
    if (text !== undefined) this.turnText = text;
  }

  /** Turns of one task hang until `releaseTurns()`; the others follow the mode. */
  async hangTask(taskId: string): Promise<void> {
    this.hangingSessions.add(`task:${taskId}`);
  }

  /** What the turns of one task answer. */
  async setTurnTextFor(taskId: string, text: string): Promise<void> {
    this.turnTextBySession.set(`task:${taskId}`, text);
  }

  /** Let every hanging turn finish (in order). Returns how many were released. */
  async releaseTurns(): Promise<number> {
    const n = this.hanging.length;
    this.hangingSessions.clear();
    for (const release of this.hanging.splice(0)) release();
    return n;
  }

  /** Turns started and still hanging. */
  async hangingTurnCount(): Promise<number> {
    return this.hanging.length;
  }

  /** The most hanging turns that were in flight at the same time. */
  async peakConcurrentTurns(): Promise<number> {
    return this.peakTurnsInFlight;
  }

  async releaseSends(): Promise<void> {
    for (const release of this.hangingSends.splice(0)) release();
  }

  async setSendBehavior(mode: SendMode): Promise<void> {
    this.sendMode = mode;
  }

  async failSendsContaining(text: string | null): Promise<void> {
    this.failingBody = text;
  }

  async sendFailureCount(): Promise<number> {
    return this.sendFailures;
  }

  async openRuns(): Promise<OpenTaskRun[]> {
    return this.ready().openRuns();
  }

  // ── durable-run recovery (the object's side, faked) ──────────────────────

  /** Mark a task run's turn run as live in the (fake) run coordinator. */
  async setTurnRunLive(taskRunId: string, live: boolean): Promise<void> {
    if (live) liveTurnRuns.add(taskRunId);
    else liveTurnRuns.delete(taskRunId);
  }

  async completeRecoveredRun(runId: string, text: string): Promise<void> {
    await this.ready().completeRecoveredRun(runId, text);
  }

  async failRecoveredRun(runId: string, detail: string): Promise<void> {
    await this.ready().failRecoveredRun(runId, detail);
  }

  /**
   * Plant a ledger row the way a dead incarnation would have left it: a
   * `running` row (turn owned, no result) or a `delivering` row (result
   * stored, schedule already advanced by the caller as needed).
   */
  async injectOpenRun(run: {
    taskId: string;
    state: Extract<TaskRunState, 'running' | 'delivering'>;
    resultText?: string;
    roomId?: string;
    attempts?: number;
    retryAt?: number;
    startedAt?: string;
  }): Promise<string> {
    if (!this.store) throw new Error('call init() first');
    const runId = crypto.randomUUID();
    await this.store.startRun({
      runId,
      taskId: run.taskId,
      startedAt: run.startedAt ?? new Date().toISOString(),
      txnId: `task-${runId}`,
    });
    if (run.state === 'delivering') {
      await this.store.updateRun(runId, {
        state: 'delivering',
        roomId: run.roomId ?? TEST_ROOM_ID,
        resultText: run.resultText ?? 'stored result',
        attempts: run.attempts ?? 0,
        ...(run.retryAt !== undefined ? { retryAt: run.retryAt } : {}),
      });
    }
    return runId;
  }

  async setRoomAvailable(available: boolean): Promise<void> {
    this.roomAvailable = available;
  }

  async setRoomCreation(mode: 'ok' | 'fail'): Promise<void> {
    this.roomCreation = mode;
  }

  async createdRooms(): Promise<CreatedRoom[]> {
    return this.rooms;
  }

  async sentMessages(): Promise<SentMessage[]> {
    return this.sent;
  }

  async turnRequests(): Promise<TurnRequest[]> {
    return this.turns;
  }

  async requestedAlarms(): Promise<number[]> {
    return this.alarms;
  }

  async runsFor(taskId: string): Promise<TaskRunEntry[]> {
    if (!this.store) throw new Error('call init() first');
    return this.store.listRuns(taskId);
  }

  /** Raw spec markdown column for one task (round-trip assertions). */
  async specOf(taskId: string): Promise<string | null> {
    if (!this.db) throw new Error('call init() first');
    const row = await this.db.get<{ spec: string }>(
      'SELECT spec FROM tasks WHERE id = ?',
      [taskId],
    );
    return row?.spec ?? null;
  }
}
