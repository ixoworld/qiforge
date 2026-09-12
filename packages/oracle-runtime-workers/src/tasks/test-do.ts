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
import { DoSqliteDatabase } from '../sqlite/database';
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
 * the next call, `fail` is a hard error (never retried).
 */
export type SendMode = 'ok' | 'fail-transient' | 'fail-transient-once' | 'fail';

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

export const TEST_USER_DID = 'did:ixo:taskstestuser';
export const TEST_USER_MATRIX_ID = '@did-ixo-taskstestuser:example.org';
export const TEST_ROOM_ID = '!tasks-test-room:example.org';

export class TasksTestDO extends DurableObject {
  private db: DoSqliteDatabase | undefined;
  private scheduler: TaskScheduler | undefined;
  private store: TasksStore | undefined;

  private sent: SentMessage[] = [];
  private rooms: CreatedRoom[] = [];
  private roomSeq = 0;
  private roomCreation: 'ok' | 'fail' = 'ok';
  private turns: TurnRequest[] = [];
  private alarms: number[] = [];
  private turnMode: 'ok' | 'fail' | 'empty' | 'hang' = 'ok';
  private turnText = 'task run output';
  private roomAvailable = true;
  private eventSeq = 0;
  private sendMode: SendMode = 'ok';
  private sendFailures = 0;
  /** Resolvers of hanging turns (`turnMode = 'hang'`), released by `releaseTurns()`. */
  private hanging: Array<() => void> = [];
  private initOpts: TasksTestInit = {};

  async init(opts: TasksTestInit = {}): Promise<void> {
    if (this.scheduler) return;
    this.initOpts = opts;
    this.db = await DoSqliteDatabase.open(this.ctx, 'tasks-test.db');
    this.store = new TasksStore(this.db);
    this.scheduler = await this.buildScheduler(opts);
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
          if (this.sendMode === 'fail') {
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
          this.sent.push({
            roomId,
            body,
            ...(opts?.txnId ? { txnId: opts.txnId } : {}),
          });
          return Promise.resolve(`$evt-${++this.eventSeq}`);
        },
        resolveUserRoom: () =>
          Promise.resolve(
            this.roomAvailable
              ? { roomId: TEST_ROOM_ID, alias: '#tasks-test:example.org' }
              : null,
          ),
      },
      runTurn: (req: TurnRequest) => {
        this.turns.push(req);
        if (this.turnMode === 'fail') {
          return Promise.reject(new Error('boom: simulated turn failure'));
        }
        const result = {
          sessionId: req.sessionId,
          requestId: req.requestId,
          text: this.turnMode === 'empty' ? '' : this.turnText,
          toolCalls: [],
        };
        if (this.turnMode === 'hang') {
          return new Promise((resolve) => {
            this.hanging.push(() => resolve(result));
          });
        }
        return Promise.resolve(result);
      },
      requestAlarm: (at: number) => {
        this.alarms.push(at);
      },
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

  async cancel(id: string): Promise<OracleTaskRecord> {
    return this.ready().surface.cancel(id);
  }

  async resolveApproval(
    taskId: string,
    decision: 'approve' | 'reject',
    note?: string,
  ): Promise<{ resolved: boolean }> {
    return this.ready().surface.resolveApproval(taskId, decision, note);
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

  async tick(now: number): Promise<void> {
    await this.ready().onAlarm(now);
  }

  async nextWakeAt(): Promise<number | null> {
    return this.ready().nextWakeAt();
  }

  // ── fakes: scripting + inspection ────────────────────────────────────────

  async setTurnBehavior(
    mode: 'ok' | 'fail' | 'empty' | 'hang',
    text?: string,
  ): Promise<void> {
    this.turnMode = mode;
    if (text !== undefined) this.turnText = text;
  }

  /** Let every hanging turn finish (in order). Returns how many were released. */
  async releaseTurns(): Promise<number> {
    const n = this.hanging.length;
    for (const release of this.hanging.splice(0)) release();
    return n;
  }

  async setSendBehavior(mode: SendMode): Promise<void> {
    this.sendMode = mode;
  }

  async sendFailureCount(): Promise<number> {
    return this.sendFailures;
  }

  async openRuns(): Promise<OpenTaskRun[]> {
    return this.ready().openRuns();
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
