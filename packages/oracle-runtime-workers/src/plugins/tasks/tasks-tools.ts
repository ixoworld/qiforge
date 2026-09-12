/**
 * The 10 main-agent task tools — the Workers port of the Node runtime's
 * tasks toolset. Every handler drives the host scheduler through `ctx.tasks`
 * (`OracleTasksSurface`); there is no Redis, no queue and no preview-token
 * plumbing — the surface itself validates and the Workers preview is a
 * schedule dry-run (next fire times + problems), not an agent execution.
 *
 * All handlers return `{ ok: false, error }` instead of throwing so the
 * model always gets an actionable message.
 */
import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper';
import type {
  OracleTaskRecord,
  OracleTasksSurface,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { summarizeSchedule } from '../../tasks/schedule';
import { TASK_ID_PATTERN, TASK_STATUSES } from '../../tasks/spec';
import { ScheduleInputToScheduleSchema } from '../../tasks/schedule-input';
import { pendingApprovalOf } from '../../tasks/store';

const TASKS_UNAVAILABLE = {
  ok: false,
  error:
    'Task scheduling is not available on this runtime — the host provides no task scheduler.',
} as const;

const taskIdSchema = z.object({
  taskId: z.string().regex(TASK_ID_PATTERN),
});

const APPROVAL_FIELD_DESCRIPTION =
  "How each run behaves. 'never' (default) just does the work and delivers " +
  "the result. 'before-action' is for runs the user should sign off on first " +
  '(a tweet, a message, a ticket, an email, a publish): when such a task ' +
  'fires it does NOT execute — it posts an approval request into the ' +
  "user's oracle room and waits. The user approves or declines by replying " +
  'there; record the decision with `resolve_task_approval` — approval ' +
  'executes the run and delivers its result, a decline drops it.';

const taskInputShape = {
  title: z.string().min(1).max(120),
  intent: z
    .string()
    .min(1)
    .describe(
      'Markdown instructions the run executes. Scheduled runs are BACKGROUND sessions with NO memory of this conversation — put every ID, URL, and name the run needs into this text, never assume the run "knows" anything discussed here.',
    ),
  // Flat at the tool boundary (a `kind` enum + optional per-kind fields),
  // converted to the store's discriminated union on parse — see
  // tasks/schedule-input.ts for why the union itself cannot be the input.
  schedule: ScheduleInputToScheduleSchema,
  approval: z
    .enum(['never', 'before-action'])
    .default('never')
    .describe(APPROVAL_FIELD_DESCRIPTION),
  dedicatedRoom: z
    .enum(['auto', 'yes', 'no'])
    .default('auto')
    .describe(
      "Whether the task gets its own '[Task] <title>' room where each run's result " +
        "(and, for 'before-action' tasks, each approval request) is posted. 'auto' " +
        'creates one for frequent (sub-daily) cron tasks, long intents and ongoing ' +
        'monitor/watch/track tasks; otherwise results go to the main oracle room. ' +
        'Pass yes/no only when the user asked for it.',
    ),
};

function requireTasks(ctx: RuntimeContext): OracleTasksSurface | null {
  return ctx.tasks ?? null;
}

function summarizeRecord(record: OracleTaskRecord): Record<string, unknown> {
  const pendingApprovalAt = pendingApprovalOf(record);
  return {
    taskId: record.id,
    title: record.title,
    status: record.status,
    schedule: summarizeSchedule(record.schedule),
    nextRunAt: record.nextRunAt ?? null,
    approval: record.approval,
    ...(pendingApprovalAt !== undefined && {
      awaitingApprovalSince: pendingApprovalAt,
    }),
  };
}

function failure(err: unknown): { ok: false; error: string } {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

export function createTaskTools(): PluginTool[] {
  return [
    previewTask(),
    createTask(),
    listMyTasks(),
    getTask(),
    updateTask(),
    setStatusTool(
      'pause_task',
      'pause',
      'Pause a task. No runs fire until you resume it; an unanswered approval request is dropped with it.',
    ),
    setStatusTool(
      'resume_task',
      'resume',
      'Resume a paused or failed task. The next run is recomputed from its schedule and the failure counter resets.',
    ),
    setStatusTool(
      'cancel_task',
      'cancel',
      'Cancel a task permanently. The record is kept for the audit trail.',
    ),
    resolveTaskApproval(),
    suggestSpecFix(),
  ];
}

// ── preview_task ────────────────────────────────────────────────────────────

const previewInput = z.object(taskInputShape);

function previewTask(): PluginTool {
  return tool(
    async (rawArgs, ctx) => {
      const args = previewInput.parse(rawArgs);
      const tasks = requireTasks(ctx);
      if (!tasks) return TASKS_UNAVAILABLE;
      try {
        const result = await tasks.preview(args);
        return {
          ...result,
          note: result.ok
            ? 'STOP here. Show the user what the task will do and when it will next run (nextRuns), and ask whether to schedule it. Call create_task with the SAME title/intent/schedule only after they confirm in a new message.'
            : 'The spec has problems — fix them with the user before calling create_task.',
        };
      } catch (err) {
        return failure(err);
      }
    },
    {
      name: 'preview_task',
      description:
        'Validate a candidate task spec and return its next run times WITHOUT creating anything. ALWAYS call this before create_task and show the user the result. IMPORTANT: scheduled runs are fresh background sessions with NO memory of this conversation — put every ID, URL, and name the run needs into the intent text.',
      schema: previewInput,
    },
  );
}

// ── create_task ─────────────────────────────────────────────────────────────

const createInput = z.object(taskInputShape);

function createTask(): PluginTool {
  return tool(
    async (rawArgs, ctx) => {
      const args = createInput.parse(rawArgs);
      const tasks = requireTasks(ctx);
      if (!tasks) return TASKS_UNAVAILABLE;
      try {
        const record = await tasks.create(args);
        return {
          ok: true,
          ...summarizeRecord(record),
          note: "Scheduled. Results are delivered to the user's oracle chat room when the task fires — NOT inline in this conversation — so tell the user where to expect them.",
        };
      } catch (err) {
        return failure(err);
      }
    },
    {
      name: 'create_task',
      description:
        'Schedule a previewed task. Call this ONLY after the user has seen the preview_task output and confirmed in a NEW message — never in the same turn as preview_task. TRIGGER CHOICE: "in 10 minutes", "tomorrow at 5pm" = kind "once" (compute `at` from now) — cron is ONLY for genuinely recurring schedules; `*/10 * * * *` means every-10-minutes-forever, not once-in-10-minutes. Set `approval` to "before-action" when a run would send/post/publish/create anything on the user\'s behalf: each fire then posts an approval request into their room and runs only once they approve. Runs are FRESH background sessions with no memory of this conversation — every ID/URL/name the run needs must be in the intent.',
      schema: createInput,
    },
  );
}

// ── list_my_tasks ───────────────────────────────────────────────────────────

const listInput = z.object({
  status: z.array(z.enum(TASK_STATUSES)).optional(),
});

function listMyTasks(): PluginTool {
  return tool(
    async (rawArgs, ctx) => {
      const args = listInput.parse(rawArgs);
      const tasks = requireTasks(ctx);
      if (!tasks) return TASKS_UNAVAILABLE;
      try {
        const records = await tasks.list();
        const rows = records
          .filter(
            (record) =>
              !args.status?.length || args.status.includes(record.status),
          )
          .map(summarizeRecord)
          .sort((a, b) =>
            String(a.nextRunAt ?? '~').localeCompare(
              String(b.nextRunAt ?? '~'),
            ),
          );
        return { ok: true, tasks: rows, count: rows.length };
      } catch (err) {
        return failure(err);
      }
    },
    {
      name: 'list_my_tasks',
      description:
        "List the user's scheduled tasks — id, title, status, schedule, next run. A task with `awaitingApprovalSince` has an approval request waiting for the user in their room — tell them and point them there. Optionally filter by status.",
      schema: listInput,
    },
  );
}

// ── get_task ────────────────────────────────────────────────────────────────

function getTask(): PluginTool {
  return tool(
    async (rawArgs, ctx) => {
      const { taskId } = taskIdSchema.parse(rawArgs);
      const tasks = requireTasks(ctx);
      if (!tasks) return TASKS_UNAVAILABLE;
      try {
        const record = await tasks.get(taskId);
        if (!record) return { ok: false, error: 'Task not found.' };
        return {
          ok: true,
          ...summarizeRecord(record),
          intent: record.intent,
          lastRunAt: record.lastRunAt ?? null,
          lastResult: record.lastResult ?? null,
          consecutiveFailures: record.consecutiveFailures,
        };
      } catch (err) {
        return failure(err);
      }
    },
    {
      name: 'get_task',
      description:
        'Fetch one task: full intent body, status, schedule, last run result, and the consecutive-failure count if it has been failing.',
      schema: taskIdSchema,
    },
  );
}

// ── update_task ─────────────────────────────────────────────────────────────

const updateInput = z.object({
  taskId: taskIdSchema.shape.taskId,
  title: z.string().min(1).max(120).optional(),
  intent: taskInputShape.intent.optional(),
  schedule: ScheduleInputToScheduleSchema.optional(),
  approval: z
    .enum(['never', 'before-action'])
    .optional()
    .describe(APPROVAL_FIELD_DESCRIPTION),
});

function updateTask(): PluginTool {
  return tool(
    async (rawArgs, ctx) => {
      const args = updateInput.parse(rawArgs);
      const tasks = requireTasks(ctx);
      if (!tasks) return TASKS_UNAVAILABLE;
      const { taskId, ...patch } = args;
      try {
        const record = await tasks.update(taskId, patch);
        return { ok: true, ...summarizeRecord(record) };
      } catch (err) {
        return failure(err);
      }
    },
    {
      name: 'update_task',
      description:
        'Patch a task — title, schedule, approval mode, or intent (what the task does). Changing the intent changes what every future run executes, so show the user the revised intent and get their confirmation first. Changing the schedule reschedules the next run automatically.',
      schema: updateInput,
    },
  );
}

// ── pause / resume / cancel ─────────────────────────────────────────────────

function setStatusTool(
  name: string,
  action: 'pause' | 'resume' | 'cancel',
  description: string,
): PluginTool {
  return tool(
    async (rawArgs, ctx) => {
      const { taskId } = taskIdSchema.parse(rawArgs);
      const tasks = requireTasks(ctx);
      if (!tasks) return TASKS_UNAVAILABLE;
      try {
        const record = await tasks[action](taskId);
        return {
          ok: true,
          taskId: record.id,
          status: record.status,
          nextRunAt: record.nextRunAt ?? null,
        };
      } catch (err) {
        return failure(err);
      }
    },
    { name, description, schema: taskIdSchema },
  );
}

// ── resolve_task_approval ───────────────────────────────────────────────────

const resolveApprovalInput = z.object({
  taskId: taskIdSchema.shape.taskId,
  outcome: z.enum(['approved', 'declined']),
  note: z
    .string()
    .optional()
    .describe(
      "Anything the user asked to change with their approval (e.g. 'fix the title first') — it is passed into the run's instructions.",
    ),
});

function resolveTaskApproval(): PluginTool {
  return tool(
    async (rawArgs, ctx) => {
      const args = resolveApprovalInput.parse(rawArgs);
      const tasks = requireTasks(ctx);
      if (!tasks) return TASKS_UNAVAILABLE;
      try {
        const result = await tasks.resolveApproval(
          args.taskId,
          args.outcome === 'approved' ? 'approve' : 'reject',
          args.note,
        );
        if (!result.resolved) {
          return { ok: false, error: 'No approval is pending for this task.' };
        }
        return {
          ok: true,
          taskId: args.taskId,
          outcome: args.outcome,
          note:
            args.outcome === 'approved'
              ? "Decision recorded and the run was executed — its result was delivered to the user's room. Confirm to the user."
              : 'Decision recorded — the pending run was dropped and nothing was executed.',
        };
      } catch (err) {
        return failure(err);
      }
    },
    {
      name: 'resolve_task_approval',
      description:
        "Record the user's decision on a task run that is waiting for approval. 'approved' EXECUTES the run immediately (the result is delivered to the user's room); 'declined' drops it without running. Call this when the user answers a pending approval request — pass their requested tweaks in `note`.",
      schema: resolveApprovalInput,
    },
  );
}

// ── suggest_spec_fix ────────────────────────────────────────────────────────

function suggestSpecFix(): PluginTool {
  return tool(
    async (rawArgs, ctx) => {
      const { taskId } = taskIdSchema.parse(rawArgs);
      const tasks = requireTasks(ctx);
      if (!tasks) return TASKS_UNAVAILABLE;
      try {
        const record = await tasks.get(taskId);
        if (!record) return { ok: false, error: 'Task not found.' };
        const lastFailure =
          record.lastResult && !record.lastResult.ok
            ? record.lastResult
            : undefined;
        if (!lastFailure && record.consecutiveFailures === 0) {
          return {
            ok: true,
            proposal: null,
            note: 'No recent failures recorded — nothing to fix.',
          };
        }
        return {
          ok: true,
          taskId,
          title: record.title,
          currentIntent: record.intent,
          lastError: lastFailure?.summary ?? 'unknown',
          lastFailedAt: lastFailure?.at ?? null,
          consecutiveFailures: record.consecutiveFailures,
          instruction:
            'Propose a concise revision of currentIntent that addresses lastError and explain the change to the user. Once they confirm: apply it with update_task (and resume_task if the task is failed).',
        };
      } catch (err) {
        return failure(err);
      }
    },
    {
      name: 'suggest_spec_fix',
      description:
        'For a failing task: returns the current intent plus the last error so you can propose a revised intent to the user. Apply the fix with update_task ONLY after the user agrees — never auto-apply.',
      schema: taskIdSchema,
    },
  );
}
