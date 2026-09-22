/**
 * The durable record of every turn the user object runs — HTTP, Matrix room
 * and scheduled task turns alike — in the user's own SQLite, next to the
 * checkpoints. Three tables:
 *
 *   - `turn_runs`: one row per run, written before the first model call and
 *     closed when the run ends. It carries what a later incarnation of the
 *     object needs to resume the run after a reset (the request), how many
 *     recovery attempts were spent without progress, and the checkpoint id
 *     seen at the last attempt (progress resets the counter).
 *   - `turn_run_segments`: the run's output, packed by `RunBuffer` into one
 *     row per flush, so a client can re-join after any cursor and a recovery
 *     can restore exactly what the user had already seen. Deleted at cutover.
 *   - `turn_tool_marks`: one row per tool call, written BEFORE the tool runs
 *     (`started`) and updated when it returns (`done`). This is what makes a
 *     resume safe: a started-but-unfinished write call is never re-executed.
 *   - `turn_write_claims`: one row per write whose outcome is not known yet
 *     (tool-execution.ts), keyed by the fingerprint of the tool name and
 *     arguments. Released by a returned outcome; kept by an abort, a deadline
 *     or a dropped connection, so the same write is not repeated blindly by
 *     a later call — across sessions of the user, until the run retention.
 *
 * Cost shape (SQLite-backed DO storage bills rows written or deleted): a run
 * costs 1 insert + ~2 updates, a segment 1 insert + 1 delete, a tool call
 * 1 insert + 1 update, a write 1 insert + 1 delete more.
 */
import type { DoSqliteDatabase } from '../sqlite/database';
import type { PackedSegment } from './run-buffer';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'recovering'
  | 'finished'
  | 'aborted'
  | 'interrupted'
  | 'failed';

export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'queued',
  'running',
  'recovering',
]);

export type ToolEffect = 'read' | 'write';

export interface RunRecord {
  runId: string;
  sessionId: string;
  requestId: string;
  client: 'portal' | 'matrix';
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  /** JSON: the `TurnRequest` (minus attachments) plus the stream options needed to rebuild the producer. */
  request: string;
  /** Consecutive recovery attempts without progress. */
  attempts: number;
  /**
   * Attempts started for this run, never reset. The frames of attempt `g`
   * are numbered from `attemptSeqBase(g)`, so a client's cursor from an
   * earlier attempt — even one pointing at frames that were never packed
   * before the reset — is below every frame a later attempt produces.
   */
  generation: number;
  /** When the next recovery attempt is due (ms since epoch), while `recovering`. */
  nextAttemptAt: number | null;
  /** Checkpoint id observed when the run (or its last attempt) started. */
  checkpointId: string | null;
  /** Highest frame sequence packed into a segment. */
  lastSeq: number;
  /** The reply so far, kept when the run ends without a committed reply. */
  partialText: string | null;
  /** Final assistant message id, when finished. */
  messageId: string | null;
  error: string | null;
  /** Scheduler run id when this is a task run (delivered after recovery). */
  taskRunId: string | null;
  /** Instance that owns the run — a different instance at boot means an orphan. */
  instanceId: string;
  /** JSON: the turn's budget usage (`TurnUsage`), written once when the run ends. */
  usage: string | null;
}

/**
 * A write whose outcome the ledger still has to account for (tool-execution.ts).
 * `pending`: started, no known outcome yet. `warned`: an identical write was
 * refused since and the model was told; a later turn may run it again.
 */
export interface WriteClaimRecord {
  fingerprint: string;
  toolName: string;
  runId: string;
  sessionId: string;
  startedAt: string;
  state: 'pending' | 'warned';
}

export interface ToolMark {
  runId: string;
  toolCallId: string;
  toolName: string;
  effect: ToolEffect;
  startedAt: string;
  doneAt: string | null;
  /** `ok` | `error` | `interrupted` once done. */
  outcome: string | null;
  /** Executions started for this call id (a read re-run bumps it). */
  attempts: number;
}

/** Rows of ended runs are kept a week (a re-join that late gets 404). */
export const RUN_RETENTION_MS = 7 * 24 * 3600 * 1000;

/**
 * Sequence-number space of one attempt. A cursor is `after=<seq>`; the
 * next attempt starts numbering at the next multiple of this, above any
 * frame the previous attempt could have handed out (packed or not).
 */
export const SEQ_ATTEMPT_SPAN = 2 ** 32;

/** First sequence number (exclusive) of attempt `generation` (0 = the original attempt). */
export function attemptSeqBase(generation: number): number {
  return Math.max(0, Math.floor(generation)) * SEQ_ATTEMPT_SPAN;
}

export const DEFAULT_RECOVERY_DELAYS_MS: readonly number[] = [
  5_000, 15_000, 30_000, 60_000,
];
export const DEFAULT_RECOVERY_ATTEMPTS = 4;
export const DEFAULT_KEEPALIVE_MS = 20_000;
export const DEFAULT_SEGMENT_FLUSH_MS = 2_000;
export const DEFAULT_SEGMENT_BYTES = 16 * 1024;

export interface RunDurabilityConfig {
  keepAliveMs: number;
  segmentFlushMs: number;
  segmentBytes: number;
  recoveryAttempts: number;
  recoveryDelaysMs: readonly number[];
  multitaskDefault: 'interrupt' | 'enqueue';
}

/** Parse the `RUN_*` / `TURN_MULTITASK_DEFAULT` env knobs (defaults documented in docs/plans/durable-runs.md). */
export function runDurabilityConfig(
  env: Record<string, unknown>,
): RunDurabilityConfig {
  const int = (key: string, fallback: number, min = 1): number => {
    const raw = env[key];
    const n = typeof raw === 'string' ? Number(raw) : Number.NaN;
    return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
  };
  const delaysRaw = env.RUN_RECOVERY_DELAYS_MS;
  const delays =
    typeof delaysRaw === 'string'
      ? delaysRaw
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n >= 0)
      : [];
  const multitask = env.TURN_MULTITASK_DEFAULT;
  return {
    keepAliveMs: int('RUN_KEEPALIVE_MS', DEFAULT_KEEPALIVE_MS, 1000),
    segmentFlushMs: int('RUN_SEGMENT_FLUSH_MS', DEFAULT_SEGMENT_FLUSH_MS, 100),
    segmentBytes: int('RUN_SEGMENT_BYTES', DEFAULT_SEGMENT_BYTES, 1024),
    recoveryAttempts: int(
      'RUN_RECOVERY_ATTEMPTS',
      DEFAULT_RECOVERY_ATTEMPTS,
      0,
    ),
    recoveryDelaysMs: delays.length > 0 ? delays : DEFAULT_RECOVERY_DELAYS_MS,
    multitaskDefault: multitask === 'enqueue' ? 'enqueue' : 'interrupt',
  };
}

export type RecoveryDecision =
  | { action: 'schedule'; at: number; attempts: number }
  | { action: 'interrupt'; attempts: number };

/**
 * What to do with an orphaned run found at boot (or an attempt that just
 * failed). Progress — a checkpoint newer than the one seen at the previous
 * attempt — resets the counter; `attempts` in the result is the number of
 * consecutive no-progress attempts INCLUDING the one being scheduled.
 */
export function decideRecovery(
  run: Pick<RunRecord, 'attempts' | 'checkpointId'>,
  currentCheckpointId: string | null,
  now: number,
  config: Pick<RunDurabilityConfig, 'recoveryAttempts' | 'recoveryDelaysMs'>,
): RecoveryDecision {
  const progressed =
    currentCheckpointId !== null && currentCheckpointId !== run.checkpointId;
  const spent = progressed ? 0 : run.attempts;
  if (spent >= config.recoveryAttempts)
    return { action: 'interrupt', attempts: spent };
  const delays = config.recoveryDelaysMs;
  const delay = delays[Math.min(spent, delays.length - 1)] ?? 0;
  return { action: 'schedule', at: now + delay, attempts: spent + 1 };
}

type RunRow = {
  run_id: string;
  session_id: string;
  request_id: string;
  client: string;
  status: string;
  started_at: string;
  updated_at: string;
  request: string;
  attempts: number;
  generation: number;
  next_attempt_at: number | null;
  checkpoint_id: string | null;
  last_seq: number;
  partial_text: string | null;
  message_id: string | null;
  error: string | null;
  task_run_id: string | null;
  instance_id: string;
  usage: string | null;
} & Record<string, string | number | null>;

type ClaimRow = {
  fingerprint: string;
  tool_name: string;
  run_id: string;
  session_id: string;
  started_at: string;
  state: string;
} & Record<string, string | number | null>;

type MarkRow = {
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  effect: string;
  started_at: string;
  done_at: string | null;
  outcome: string | null;
  attempts: number;
} & Record<string, string | number | null>;

type SegmentRow = {
  seq_from: number;
  seq_to: number;
  payload: string;
} & Record<string, string | number | null>;

const RUN_COLUMNS =
  'run_id, session_id, request_id, client, status, started_at, updated_at, request, attempts, generation, next_attempt_at, checkpoint_id, last_seq, partial_text, message_id, error, task_run_id, instance_id, usage';

function toRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    client: row.client === 'matrix' ? 'matrix' : 'portal',
    status: row.status as RunStatus,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    request: row.request,
    attempts: Number(row.attempts),
    generation: Number(row.generation),
    nextAttemptAt:
      row.next_attempt_at === null ? null : Number(row.next_attempt_at),
    checkpointId: row.checkpoint_id,
    lastSeq: Number(row.last_seq),
    partialText: row.partial_text,
    messageId: row.message_id,
    error: row.error,
    taskRunId: row.task_run_id,
    instanceId: row.instance_id,
    usage: row.usage,
  };
}

function toClaim(row: ClaimRow): WriteClaimRecord {
  return {
    fingerprint: row.fingerprint,
    toolName: row.tool_name,
    runId: row.run_id,
    sessionId: row.session_id,
    startedAt: row.started_at,
    state: row.state === 'warned' ? 'warned' : 'pending',
  };
}

function toMark(row: MarkRow): ToolMark {
  return {
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    effect: row.effect === 'read' ? 'read' : 'write',
    startedAt: row.started_at,
    doneAt: row.done_at,
    outcome: row.outcome,
    attempts: Number(row.attempts),
  };
}

export class RunStore {
  private setupPromise: Promise<void> | undefined;

  constructor(
    readonly db: DoSqliteDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  setup(): Promise<void> {
    this.setupPromise ??= this.doSetup().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  private async doSetup(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS turn_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        client TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        request TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        checkpoint_id TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        partial_text TEXT,
        message_id TEXT,
        error TEXT,
        task_run_id TEXT,
        instance_id TEXT NOT NULL
      )`);
    // Columns added after the table first shipped (CREATE TABLE IF NOT
    // EXISTS leaves an existing table as it was).
    const columns = await this.db.exec<{ name: string }>(
      `PRAGMA table_info(turn_runs)`,
    );
    if (!columns.some((c) => c.name === 'generation'))
      await this.db.run(
        `ALTER TABLE turn_runs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0`,
      );
    if (!columns.some((c) => c.name === 'usage'))
      await this.db.run(`ALTER TABLE turn_runs ADD COLUMN usage TEXT`);
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_turn_runs_session ON turn_runs(session_id, started_at)`,
    );
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS turn_run_segments (
        run_id TEXT NOT NULL,
        seq_from INTEGER NOT NULL,
        seq_to INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (run_id, seq_from)
      ) WITHOUT ROWID`);
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS turn_tool_marks (
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        effect TEXT NOT NULL,
        started_at TEXT NOT NULL,
        done_at TEXT,
        outcome TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (run_id, tool_call_id)
      ) WITHOUT ROWID`);
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS turn_write_claims (
        fingerprint TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
      ) WITHOUT ROWID`);
    // Ended runs older than the retention window: their segments are gone
    // already (cutover); drop the rows and marks in one pass per boot.
    const cutoff = new Date(this.now() - RUN_RETENTION_MS).toISOString();
    await this.db.run(`DELETE FROM turn_write_claims WHERE started_at < ?`, [
      cutoff,
    ]);
    const stale = await this.db.exec<{ run_id: string }>(
      `SELECT run_id FROM turn_runs WHERE status IN ('finished','aborted','interrupted','failed') AND updated_at < ?`,
      [cutoff],
    );
    for (const row of stale) {
      await this.db.run(`DELETE FROM turn_tool_marks WHERE run_id = ?`, [
        row.run_id,
      ]);
      await this.db.run(`DELETE FROM turn_run_segments WHERE run_id = ?`, [
        row.run_id,
      ]);
      await this.db.run(`DELETE FROM turn_runs WHERE run_id = ?`, [row.run_id]);
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // ── runs ────────────────────────────────────────────────────────────────

  async create(input: {
    runId: string;
    sessionId: string;
    requestId: string;
    client: 'portal' | 'matrix';
    status: 'queued' | 'running';
    request: string;
    checkpointId: string | null;
    taskRunId?: string | null;
    instanceId: string;
  }): Promise<void> {
    await this.setup();
    const at = this.iso();
    await this.db.run(
      `INSERT INTO turn_runs (${RUN_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, 0, NULL, NULL, NULL, ?, ?, NULL)`,
      [
        input.runId,
        input.sessionId,
        input.requestId,
        input.client,
        input.status,
        at,
        at,
        input.request,
        input.checkpointId,
        input.taskRunId ?? null,
        input.instanceId,
      ],
    );
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    await this.setup();
    const row = await this.db.get<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM turn_runs WHERE run_id = ?`,
      [runId],
    );
    return row ? toRecord(row) : undefined;
  }

  async getByRequestId(requestId: string): Promise<RunRecord | undefined> {
    await this.setup();
    const row = await this.db.get<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM turn_runs WHERE request_id = ? ORDER BY started_at DESC LIMIT 1`,
      [requestId],
    );
    return row ? toRecord(row) : undefined;
  }

  /** The run a session is busy with (running/recovering), or the oldest queued one. */
  async activeForSession(sessionId: string): Promise<RunRecord | undefined> {
    await this.setup();
    const row = await this.db.get<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM turn_runs
       WHERE session_id = ? AND status IN ('running','recovering','queued')
       ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'recovering' THEN 1 ELSE 2 END, started_at ASC
       LIMIT 1`,
      [sessionId],
    );
    return row ? toRecord(row) : undefined;
  }

  /** Every run that is not over, oldest first. */
  async listActive(): Promise<RunRecord[]> {
    await this.setup();
    const rows = await this.db.exec<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM turn_runs
       WHERE status IN ('running','recovering','queued') ORDER BY started_at ASC`,
    );
    return rows.map(toRecord);
  }

  /** Queued runs of one session, oldest first. */
  async queuedForSession(sessionId: string): Promise<RunRecord[]> {
    await this.setup();
    const rows = await this.db.exec<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM turn_runs
       WHERE session_id = ? AND status = 'queued' ORDER BY started_at ASC`,
      [sessionId],
    );
    return rows.map(toRecord);
  }

  /** Recent runs (any status), newest first — the debug view. */
  async listRecent(limit = 50): Promise<RunRecord[]> {
    await this.setup();
    const rows = await this.db.exec<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM turn_runs ORDER BY started_at DESC LIMIT ?`,
      [limit],
    );
    return rows.map(toRecord);
  }

  async update(
    runId: string,
    patch: Partial<
      Pick<
        RunRecord,
        | 'status'
        | 'attempts'
        | 'generation'
        | 'nextAttemptAt'
        | 'checkpointId'
        | 'lastSeq'
        | 'partialText'
        | 'messageId'
        | 'error'
        | 'taskRunId'
        | 'instanceId'
        | 'usage'
      >
    >,
  ): Promise<void> {
    await this.setup();
    const sets: string[] = ['updated_at = ?'];
    const params: Array<string | number | null> = [this.iso()];
    const column: Record<string, string> = {
      status: 'status',
      attempts: 'attempts',
      generation: 'generation',
      nextAttemptAt: 'next_attempt_at',
      checkpointId: 'checkpoint_id',
      lastSeq: 'last_seq',
      partialText: 'partial_text',
      messageId: 'message_id',
      error: 'error',
      taskRunId: 'task_run_id',
      instanceId: 'instance_id',
      usage: 'usage',
    };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(`${column[key]} = ?`);
      params.push(value);
    }
    params.push(runId);
    await this.db.run(
      `UPDATE turn_runs SET ${sets.join(', ')} WHERE run_id = ?`,
      params,
    );
  }

  // ── segments ────────────────────────────────────────────────────────────

  async appendSegment(runId: string, segment: PackedSegment): Promise<void> {
    await this.setup();
    await this.db.run(
      `INSERT OR REPLACE INTO turn_run_segments (run_id, seq_from, seq_to, payload) VALUES (?, ?, ?, ?)`,
      [runId, segment.seqFrom, segment.seqTo, segment.payload],
    );
  }

  /** Segments whose last frame is after `after`, in order. */
  async readSegments(runId: string, after = 0): Promise<PackedSegment[]> {
    await this.setup();
    const rows = await this.db.exec<SegmentRow>(
      `SELECT seq_from, seq_to, payload FROM turn_run_segments
       WHERE run_id = ? AND seq_to > ? ORDER BY seq_from ASC`,
      [runId, after],
    );
    return rows.map((row) => ({
      seqFrom: Number(row.seq_from),
      seqTo: Number(row.seq_to),
      payload: row.payload,
    }));
  }

  async countSegments(runId: string): Promise<number> {
    await this.setup();
    const row = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM turn_run_segments WHERE run_id = ?`,
      [runId],
    );
    return Number(row?.n ?? 0);
  }

  /** Cutover: the reply is in the transcript, the segments are not needed. */
  async deleteSegments(runId: string): Promise<void> {
    await this.setup();
    await this.db.run(`DELETE FROM turn_run_segments WHERE run_id = ?`, [
      runId,
    ]);
  }

  // ── tool marks ──────────────────────────────────────────────────────────

  /**
   * Record that a tool call is about to execute. Returns the existing mark
   * when the call id was seen before (a resume), so the caller can apply the
   * re-run policy; `undefined` means this is the first execution.
   */
  async startMark(input: {
    runId: string;
    toolCallId: string;
    toolName: string;
    effect: ToolEffect;
  }): Promise<ToolMark | undefined> {
    await this.setup();
    const existing = await this.getMark(input.runId, input.toolCallId);
    if (existing) return existing;
    await this.db.run(
      `INSERT OR IGNORE INTO turn_tool_marks (run_id, tool_call_id, tool_name, effect, started_at, attempts)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [input.runId, input.toolCallId, input.toolName, input.effect, this.iso()],
    );
    return undefined;
  }

  /** A read-only call re-executed on resume: count the execution, keep the row open. */
  async bumpMark(runId: string, toolCallId: string): Promise<void> {
    await this.setup();
    await this.db.run(
      `UPDATE turn_tool_marks SET attempts = attempts + 1, started_at = ?, done_at = NULL, outcome = NULL
       WHERE run_id = ? AND tool_call_id = ?`,
      [this.iso(), runId, toolCallId],
    );
  }

  async finishMark(
    runId: string,
    toolCallId: string,
    outcome: 'ok' | 'error' | 'interrupted',
  ): Promise<void> {
    await this.setup();
    await this.db.run(
      `UPDATE turn_tool_marks SET done_at = ?, outcome = ? WHERE run_id = ? AND tool_call_id = ?`,
      [this.iso(), outcome, runId, toolCallId],
    );
  }

  async getMark(
    runId: string,
    toolCallId: string,
  ): Promise<ToolMark | undefined> {
    await this.setup();
    const row = await this.db.get<MarkRow>(
      `SELECT run_id, tool_call_id, tool_name, effect, started_at, done_at, outcome, attempts
       FROM turn_tool_marks WHERE run_id = ? AND tool_call_id = ?`,
      [runId, toolCallId],
    );
    return row ? toMark(row) : undefined;
  }

  async listMarks(runId: string): Promise<ToolMark[]> {
    await this.setup();
    const rows = await this.db.exec<MarkRow>(
      `SELECT run_id, tool_call_id, tool_name, effect, started_at, done_at, outcome, attempts
       FROM turn_tool_marks WHERE run_id = ? ORDER BY started_at ASC`,
      [runId],
    );
    return rows.map(toMark);
  }

  // ── write claims ────────────────────────────────────────────────────────

  /**
   * Claim a write before it runs. `claimed` when no identical write is
   * outstanding. `blocked` when one is: a `pending` claim becomes `warned`
   * (owned by this run, so the same turn stays blocked); a claim already
   * `warned` by an earlier run is released to this run — the user was told
   * and asked again.
   */
  async claimWrite(input: {
    fingerprint: string;
    toolName: string;
    runId: string;
    sessionId: string;
  }): Promise<
    | { status: 'claimed' }
    | { status: 'blocked'; toolName: string; since: string }
  > {
    await this.setup();
    const inserted = await this.db.run(
      `INSERT OR IGNORE INTO turn_write_claims (fingerprint, tool_name, run_id, session_id, started_at, state)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [
        input.fingerprint,
        input.toolName,
        input.runId,
        input.sessionId,
        this.iso(),
      ],
    );
    if (inserted.changes === 1) return { status: 'claimed' };
    const existing = await this.getClaim(input.fingerprint);
    if (!existing) return { status: 'claimed' };
    if (existing.state === 'warned' && existing.runId !== input.runId) {
      await this.db.run(
        `UPDATE turn_write_claims SET run_id = ?, session_id = ?, started_at = ?, state = 'pending' WHERE fingerprint = ?`,
        [input.runId, input.sessionId, this.iso(), input.fingerprint],
      );
      return { status: 'claimed' };
    }
    if (existing.state === 'pending')
      await this.db.run(
        `UPDATE turn_write_claims SET state = 'warned', run_id = ? WHERE fingerprint = ? AND state = 'pending'`,
        [input.runId, input.fingerprint],
      );
    return {
      status: 'blocked',
      toolName: existing.toolName,
      since: existing.startedAt,
    };
  }

  /** The write returned an outcome (or a known failure): nothing to account for. */
  async releaseWrite(fingerprint: string, runId: string): Promise<void> {
    await this.setup();
    await this.db.run(
      `DELETE FROM turn_write_claims WHERE fingerprint = ? AND run_id = ?`,
      [fingerprint, runId],
    );
  }

  async getClaim(fingerprint: string): Promise<WriteClaimRecord | undefined> {
    await this.setup();
    const row = await this.db.get<ClaimRow>(
      `SELECT fingerprint, tool_name, run_id, session_id, started_at, state
       FROM turn_write_claims WHERE fingerprint = ?`,
      [fingerprint],
    );
    return row ? toClaim(row) : undefined;
  }

  /** Outstanding claims, oldest first (operator inspection). */
  async listClaims(): Promise<WriteClaimRecord[]> {
    await this.setup();
    const rows = await this.db.exec<ClaimRow>(
      `SELECT fingerprint, tool_name, run_id, session_id, started_at, state
       FROM turn_write_claims ORDER BY started_at ASC`,
    );
    return rows.map(toClaim);
  }
}
