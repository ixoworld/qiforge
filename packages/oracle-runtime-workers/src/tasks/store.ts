/**
 * `tasks` + `task_runs` table access in the USER'S OWN SQLite database — the
 * Workers replacement for the Node runtime's Redis task store. Tasks live in
 * the owner file, so exporting, pausing or deleting the file carries the
 * tasks with it.
 *
 *   tasks(id PK, title, spec, schedule_json, status, approval, created_at,
 *         updated_at, next_run_at, last_run_at, last_result_json,
 *         consecutive_failures, pending_approval_at)
 *   task_runs(run_id PK, task_id, started_at, finished_at, ok, detail)
 *
 * The `spec` column is the full markdown artifact (gray-matter frontmatter +
 * intent body, see `spec.ts`); the sibling columns are the query index the
 * scheduler reads (`MIN(next_run_at)`, due scans). Timestamps in `*_at` TEXT
 * columns are ISO strings; `next_run_at` is INTEGER ms-epoch so MIN() and
 * `<=` comparisons stay numeric. No statement binds more than 13 parameters
 * (DO SQL caps at 100) and nothing uses LIKE.
 */
import type { DoSqliteDatabase, SqlParam } from '../sqlite/database';
import type {
  OracleTaskRecord,
  OracleTaskSchedule,
  OracleTaskStatus,
} from '../plugin-api/types';
import {
  renderTaskSpec,
  specIntentOf,
  TASK_APPROVALS,
  TASK_STATUSES,
  TaskScheduleSchema,
} from './spec';

/**
 * A stored task. Extends the plugin-api record with the approval marker:
 * a `before-action` task whose run request is waiting on the user carries
 * `pendingApprovalAt` (ISO of when the request was posted).
 */
export interface TaskRecord extends OracleTaskRecord {
  pendingApprovalAt?: string;
}

/**
 * Read the approval marker off any record coming back from the surface.
 * Structural — works for consumers that only know `OracleTaskRecord`.
 */
export function pendingApprovalOf(
  record: OracleTaskRecord,
): string | undefined {
  if (
    'pendingApprovalAt' in record &&
    typeof record.pendingApprovalAt === 'string'
  ) {
    return record.pendingApprovalAt;
  }
  return undefined;
}

/** One audit row per fired run / approval decision. */
export interface TaskRunEntry {
  runId: string;
  taskId: string;
  startedAt: string;
  finishedAt?: string;
  /** true = delivered, false = failed, undefined = no run happened (approval bookkeeping). */
  ok?: boolean;
  detail?: string;
}

type TaskRow = {
  id: string;
  title: string;
  spec: string;
  schedule_json: string;
  status: string;
  approval: string;
  created_at: string;
  updated_at: string;
  next_run_at: number | bigint | null;
  last_run_at: string | null;
  last_result_json: string | null;
  consecutive_failures: number;
  pending_approval_at: string | null;
  delivery_room_id: string | null;
};

type RunRow = {
  run_id: string;
  task_id: string;
  started_at: string;
  finished_at: string | null;
  ok: number | null;
  detail: string | null;
};

const TASK_COLUMNS = `id, title, spec, schedule_json, status, approval, created_at,
  updated_at, next_run_at, last_run_at, last_result_json, consecutive_failures, pending_approval_at,
  delivery_room_id`;

function isTaskStatus(value: string): value is OracleTaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

function isApproval(value: string): value is 'never' | 'before-action' {
  return (TASK_APPROVALS as readonly string[]).includes(value);
}

function parseLastResult(
  json: string,
): OracleTaskRecord['lastResult'] | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'ok' in parsed &&
      typeof parsed.ok === 'boolean' &&
      'summary' in parsed &&
      typeof parsed.summary === 'string' &&
      'at' in parsed &&
      typeof parsed.at === 'string'
    ) {
      return { ok: parsed.ok, summary: parsed.summary, at: parsed.at };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function rowToRecord(row: TaskRow): TaskRecord {
  if (!isTaskStatus(row.status)) {
    throw new Error(`task ${row.id} has unknown status '${row.status}'`);
  }
  if (!isApproval(row.approval)) {
    throw new Error(`task ${row.id} has unknown approval '${row.approval}'`);
  }
  const schedule: OracleTaskSchedule = TaskScheduleSchema.parse(
    JSON.parse(row.schedule_json),
  );
  const record: TaskRecord = {
    id: row.id,
    title: row.title,
    intent: specIntentOf(row.spec),
    schedule,
    status: row.status,
    approval: row.approval,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    consecutiveFailures: row.consecutive_failures,
  };
  if (row.next_run_at !== null) {
    record.nextRunAt = new Date(Number(row.next_run_at)).toISOString();
  }
  if (row.last_run_at !== null) record.lastRunAt = row.last_run_at;
  if (row.last_result_json !== null) {
    const lastResult = parseLastResult(row.last_result_json);
    if (lastResult) record.lastResult = lastResult;
  }
  if (row.pending_approval_at !== null) {
    record.pendingApprovalAt = row.pending_approval_at;
  }
  if (row.delivery_room_id !== null) {
    record.deliveryRoomId = row.delivery_room_id;
  }
  return record;
}

function recordParams(record: TaskRecord): SqlParam[] {
  return [
    record.title,
    renderTaskSpec(record),
    JSON.stringify(record.schedule),
    record.status,
    record.approval,
    record.createdAt,
    record.updatedAt,
    record.nextRunAt !== undefined ? Date.parse(record.nextRunAt) : null,
    record.lastRunAt ?? null,
    record.lastResult !== undefined ? JSON.stringify(record.lastResult) : null,
    record.consecutiveFailures,
    record.pendingApprovalAt ?? null,
    record.deliveryRoomId ?? null,
  ];
}

export class TasksStore {
  private setupPromise: Promise<void> | undefined;

  constructor(readonly db: DoSqliteDatabase) {}

  /** Create both tables + indexes. Idempotent, cached like `SessionsStore`. */
  setup(): Promise<void> {
    this.setupPromise ??= this.doSetup().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  private async doSetup(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        spec TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        status TEXT NOT NULL,
        approval TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        next_run_at INTEGER,
        last_run_at TEXT,
        last_result_json TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        pending_approval_at TEXT,
        delivery_room_id TEXT
      )`);
    // Files created before dedicated task rooms existed lack the column.
    const columns = await this.db.exec<{ name: string }>(
      `PRAGMA table_info(tasks)`,
    );
    if (!columns.some((c) => c.name === 'delivery_room_id')) {
      await this.db.run(`ALTER TABLE tasks ADD COLUMN delivery_room_id TEXT`);
    }
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(status, next_run_at)`,
    );
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS task_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        ok INTEGER,
        detail TEXT
      )`);
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at)`,
    );
  }

  async insert(record: TaskRecord): Promise<void> {
    await this.setup();
    await this.db.run(
      `INSERT INTO tasks (${TASK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, ...recordParams(record)],
    );
  }

  /** Full-row rewrite keyed by id. The spec markdown is re-rendered on every save. */
  async save(record: TaskRecord): Promise<void> {
    await this.setup();
    const { changes } = await this.db.run(
      `UPDATE tasks SET title = ?, spec = ?, schedule_json = ?, status = ?, approval = ?,
         created_at = ?, updated_at = ?, next_run_at = ?, last_run_at = ?,
         last_result_json = ?, consecutive_failures = ?, pending_approval_at = ?,
         delivery_room_id = ?
       WHERE id = ?`,
      [...recordParams(record), record.id],
    );
    if (changes === 0) {
      throw new Error(`task ${record.id} not found`);
    }
  }

  async get(id: string): Promise<TaskRecord | null> {
    await this.setup();
    const row = await this.db.get<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`,
      [id],
    );
    return row === undefined ? null : rowToRecord(row);
  }

  /** Every task, oldest first (stable listing for tools). */
  async list(): Promise<TaskRecord[]> {
    await this.setup();
    const rows = await this.db.exec<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks ORDER BY created_at, id`,
    );
    return rows.map(rowToRecord);
  }

  /** Live tasks count toward the per-user cap: active or paused. */
  async countLive(): Promise<number> {
    await this.setup();
    const row = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tasks WHERE status IN ('active', 'paused')`,
    );
    return row?.n ?? 0;
  }

  /** Earliest pending deadline (ms epoch) over active tasks, or null. */
  async minNextRunAt(): Promise<number | null> {
    await this.setup();
    const row = await this.db.get<{ next: number | bigint | null }>(
      `SELECT MIN(next_run_at) AS next FROM tasks WHERE status = 'active' AND next_run_at IS NOT NULL`,
    );
    if (row === undefined || row.next === null) return null;
    return Number(row.next);
  }

  /** Active tasks whose next run is due at or before `nowMs`, earliest first. */
  async due(nowMs: number): Promise<TaskRecord[]> {
    await this.setup();
    const rows = await this.db.exec<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at, id`,
      [nowMs],
    );
    return rows.map(rowToRecord);
  }

  async recordRun(entry: TaskRunEntry): Promise<void> {
    await this.setup();
    await this.db.run(
      `INSERT INTO task_runs (run_id, task_id, started_at, finished_at, ok, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        entry.runId,
        entry.taskId,
        entry.startedAt,
        entry.finishedAt ?? null,
        entry.ok === undefined ? null : entry.ok,
        entry.detail ?? null,
      ],
    );
  }

  /** Audit trail for one task, newest first. */
  async listRuns(taskId: string, limit = 20): Promise<TaskRunEntry[]> {
    await this.setup();
    const rows = await this.db.exec<RunRow>(
      `SELECT run_id, task_id, started_at, finished_at, ok, detail
       FROM task_runs WHERE task_id = ? ORDER BY started_at DESC, run_id DESC LIMIT ?`,
      [taskId, limit],
    );
    return rows.map((row) => {
      const entry: TaskRunEntry = {
        runId: row.run_id,
        taskId: row.task_id,
        startedAt: row.started_at,
      };
      if (row.finished_at !== null) entry.finishedAt = row.finished_at;
      if (row.ok !== null) entry.ok = row.ok !== 0;
      if (row.detail !== null) entry.detail = row.detail;
      return entry;
    });
  }
}
