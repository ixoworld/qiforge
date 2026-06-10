import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { PluginTool, RuntimeContext } from '../../../plugin-api/types.js';
import { shouldCreateDedicatedRoom } from './delivery.js';
import { requireRuntime, type GetTasksRuntime } from './runtime.js';
import { nextRunAtFor } from './scheduler.js';
import {
  IntentSchema,
  newTaskId,
  renderIntentBody,
  specHash,
  summarizeTrigger,
  TASK_STATUSES,
  TriggerSchema,
  type TaskSpec,
  type TaskStatus,
} from './spec.js';

const PREVIEW_TTL_SEC = 10 * 60;

const taskIdSchema = z.object({
  taskId: z.string().regex(/^task_[a-f0-9]{12}$/),
});

/**
 * The 10 main-agent tools. Created once per plugin instance as closures over
 * the runtime getter (the Nest module binds the runtime in `onModuleInit`).
 */
export function createTaskTools(getRuntime: GetTasksRuntime): PluginTool[] {
  return [
    previewTask(getRuntime),
    createTask(getRuntime),
    listMyTasks(getRuntime),
    getTask(getRuntime),
    updateTask(getRuntime),
    setStatusTool(
      getRuntime,
      'pause_task',
      'paused',
      'Pause a task. Pending runs are cancelled until you resume it.',
    ),
    setStatusTool(
      getRuntime,
      'resume_task',
      'active',
      'Resume a paused or failed-pending-review task. The next run is recomputed from its trigger.',
    ),
    setStatusTool(
      getRuntime,
      'cancel_task',
      'cancelled',
      'Cancel a task permanently. The spec is kept for the audit trail.',
    ),
    suggestSpecFix(getRuntime),
    resolvePendingApproval(getRuntime),
  ];
}

// ── preview_task ────────────────────────────────────────────────────────────

const previewInput = z.object({
  title: z.string().min(1).max(120),
  intent: IntentSchema,
});

function previewTask(getRuntime: GetTasksRuntime): PluginTool {
  return {
    name: 'preview_task',
    description:
      'Run a candidate task spec ONCE, for real, and return the output. ALWAYS call this before create_task — the returned previewToken is required there. The user must see this output before any task is scheduled.',
    schema: previewInput,
    handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
      const args = previewInput.parse(rawArgs);
      const rt = requireRuntime(getRuntime);
      const body = renderIntentBody(args.intent);

      // `runOnce` creates a synthetic session that Matrix never sees, runs
      // one agent turn, and deletes the session. No "New Conversation
      // Started" gets posted into the user's main room.
      const output = await rt.invoker.runOnce({
        did: ctx.user.did,
        message: body,
      });

      const previewToken = randomBytes(12).toString('hex');
      await rt.state.putPreview(
        previewToken,
        { owner: ctx.user.did, hash: specHash(args.title, body) },
        PREVIEW_TTL_SEC,
      );
      return {
        previewToken,
        output,
        note: 'Show this output to the user and ask whether to schedule. On yes, call create_task with this previewToken and the SAME title/intent.',
      };
    },
  };
}

// ── create_task ─────────────────────────────────────────────────────────────

const createInput = z.object({
  previewToken: z.string().min(8),
  title: z.string().min(1).max(120),
  trigger: TriggerSchema,
  intent: IntentSchema,
  approval: z.enum(['never', 'before-delivery']).default('never'),
  dedicatedRoom: z.enum(['auto', 'yes', 'no']).default('auto'),
});

function createTask(getRuntime: GetTasksRuntime): PluginTool {
  return {
    name: 'create_task',
    description:
      'Schedule a previewed task. Requires a fresh previewToken from preview_task whose title/intent match exactly — if the user edited anything after the preview, re-run preview_task first.',
    schema: createInput,
    handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
      const args = createInput.parse(rawArgs);
      const rt = requireRuntime(getRuntime);
      const owner = ctx.user.did;
      const body = renderIntentBody(args.intent);

      // ── Validate everything BEFORE doing anything destructive ────────
      // The preview token is checked non-destructively (`peek`); we only
      // delete it once the spec is saved, so a validation failure here
      // doesn't burn the user's preview.

      const claim = await rt.state.peekPreview(args.previewToken);
      if (!claim || claim.owner !== owner) {
        return {
          ok: false,
          error: 'Preview token invalid or expired — run preview_task again.',
        };
      }
      if (claim.hash !== specHash(args.title, body)) {
        return {
          ok: false,
          error:
            'The spec changed since the preview — run preview_task again so the user sees the new output.',
        };
      }

      const live = (await rt.store.list(owner)).filter(
        (t) =>
          t.frontmatter.status !== 'cancelled' &&
          t.frontmatter.status !== 'completed',
      );
      if (live.length >= rt.config.maxTasksPerUser) {
        return {
          ok: false,
          error: `Task limit reached (${rt.config.maxTasksPerUser}). Cancel an existing task first.`,
        };
      }

      const nextRunAt = nextRunAtFor(args.trigger);
      if (!nextRunAt) {
        return {
          ok: false,
          error: 'Trigger has no future run time — adjust it and try again.',
        };
      }

      // ── Commit ───────────────────────────────────────────────────────

      const taskId = newTaskId();
      const spec: TaskSpec = {
        frontmatter: {
          id: taskId,
          owner,
          title: args.title,
          trigger: args.trigger,
          delivery: { roomId: 'main' },
          approval: args.approval,
          status: 'active',
          stats: { nextRunAt },
        },
        body,
      };

      if (
        shouldCreateDedicatedRoom({
          trigger: args.trigger,
          intentBody: body,
          explicit: args.dedicatedRoom,
        })
      ) {
        const dedicatedRoomId = await rt.delivery.createDedicatedRoom(
          spec,
          ctx.user.matrixUserId,
        );
        if (dedicatedRoomId) spec.frontmatter.delivery.roomId = dedicatedRoomId;
      }

      await rt.store.save(spec);
      await rt.scheduler.enqueueRun(taskId, owner, nextRunAt);
      // Only now consume the token — every preceding step that could fail
      // has succeeded.
      await rt.state.deletePreview(args.previewToken);

      return {
        ok: true,
        taskId,
        title: args.title,
        trigger: summarizeTrigger(args.trigger),
        nextRunAt,
        roomId: spec.frontmatter.delivery.roomId,
        approval: args.approval,
      };
    },
  };
}

// ── list_my_tasks ───────────────────────────────────────────────────────────

const listInput = z.object({
  status: z.array(z.enum(TASK_STATUSES)).optional(),
});

function listMyTasks(getRuntime: GetTasksRuntime): PluginTool {
  return {
    name: 'list_my_tasks',
    description:
      "List the user's scheduled tasks — id, title, status, trigger, next run. Optionally filter by status.",
    schema: listInput,
    handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
      const args = listInput.parse(rawArgs);
      const rt = requireRuntime(getRuntime);
      const tasks = (await rt.store.list(ctx.user.did))
        .filter(
          (t) =>
            !args.status?.length || args.status.includes(t.frontmatter.status),
        )
        .map((t) => ({
          id: t.frontmatter.id,
          title: t.frontmatter.title,
          status: t.frontmatter.status,
          trigger: summarizeTrigger(t.frontmatter.trigger),
          nextRunAt: t.frontmatter.stats.nextRunAt,
        }))
        .sort((a, b) => (a.nextRunAt ?? '~').localeCompare(b.nextRunAt ?? '~'));
      return { tasks, count: tasks.length };
    },
  };
}

// ── get_task ────────────────────────────────────────────────────────────────

function getTask(getRuntime: GetTasksRuntime): PluginTool {
  return {
    name: 'get_task',
    description:
      'Fetch one task: full spec body, status, trigger, delivery room, and the last error if it has been failing.',
    schema: taskIdSchema,
    handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
      const { taskId } = taskIdSchema.parse(rawArgs);
      const rt = requireRuntime(getRuntime);
      const spec = await rt.store.load(ctx.user.did, taskId);
      if (!spec) return { ok: false, error: 'Task not found.' };
      const failures = await rt.state.getFailures(taskId);
      return {
        ok: true,
        // Curated — internal fields (owner, raw trigger) aren't useful to
        // the agent and only inflate the response.
        taskId: spec.frontmatter.id,
        title: spec.frontmatter.title,
        status: spec.frontmatter.status,
        trigger: summarizeTrigger(spec.frontmatter.trigger),
        nextRunAt: spec.frontmatter.stats.nextRunAt,
        approval: spec.frontmatter.approval,
        roomId: spec.frontmatter.delivery.roomId,
        body: spec.body,
        lastError: failures
          ? {
              message: failures.lastError,
              failedAt: failures.lastFailedAt,
              consecutiveCount: failures.count,
            }
          : null,
      };
    },
  };
}

// ── update_task ─────────────────────────────────────────────────────────────

const updateInput = z.object({
  taskId: taskIdSchema.shape.taskId,
  title: z.string().min(1).max(120).optional(),
  trigger: TriggerSchema.optional(),
  body: z.string().min(1).optional(),
  approval: z.enum(['never', 'before-delivery']).optional(),
});

function updateTask(getRuntime: GetTasksRuntime): PluginTool {
  return {
    name: 'update_task',
    description:
      'Patch a task — title, trigger, markdown body, or approval mode. Changing the trigger reschedules the next run automatically.',
    schema: updateInput,
    handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
      const args = updateInput.parse(rawArgs);
      const rt = requireRuntime(getRuntime);
      const owner = ctx.user.did;

      const spec = await rt.store.load(owner, args.taskId);
      if (!spec) return { ok: false, error: 'Task not found.' };

      const trigger = args.trigger ?? spec.frontmatter.trigger;
      const nextRunAt = args.trigger
        ? nextRunAtFor(trigger)
        : spec.frontmatter.stats.nextRunAt;

      const updated: TaskSpec = {
        frontmatter: {
          ...spec.frontmatter,
          title: args.title ?? spec.frontmatter.title,
          trigger,
          approval: args.approval ?? spec.frontmatter.approval,
          stats: { nextRunAt },
        },
        body: args.body ?? spec.body,
      };
      await rt.store.save(updated);

      if (args.trigger) {
        await rt.scheduler.cancelRuns(args.taskId);
        if (nextRunAt && updated.frontmatter.status === 'active') {
          await rt.scheduler.enqueueRun(args.taskId, owner, nextRunAt);
        }
      }
      return {
        ok: true,
        taskId: args.taskId,
        nextRunAt,
        status: updated.frontmatter.status,
      };
    },
  };
}

// ── pause / resume / cancel ─────────────────────────────────────────────────

function setStatusTool(
  getRuntime: GetTasksRuntime,
  name: string,
  status: TaskStatus,
  description: string,
): PluginTool {
  return {
    name,
    description,
    schema: taskIdSchema,
    handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
      const { taskId } = taskIdSchema.parse(rawArgs);
      const rt = requireRuntime(getRuntime);
      const owner = ctx.user.did;

      const current = await rt.store.load(owner, taskId);
      if (!current) return { ok: false, error: 'Task not found.' };
      if (status === 'active' && current.frontmatter.status === 'cancelled') {
        return {
          ok: false,
          error: 'Cancelled tasks cannot be resumed — create a new one.',
        };
      }

      const nextRunAt =
        status === 'active' ? nextRunAtFor(current.frontmatter.trigger) : null;
      await rt.store.setStatus(owner, taskId, status, nextRunAt);
      await rt.scheduler.cancelRuns(taskId);
      if (status === 'active') {
        if (!nextRunAt) {
          return {
            ok: false,
            error: 'Trigger has no future run time — update the trigger first.',
          };
        }
        await rt.scheduler.enqueueRun(taskId, owner, nextRunAt);
        await rt.state.resetFailures(taskId);
      }
      return { ok: true, taskId, status, nextRunAt };
    },
  };
}

// ── suggest_spec_fix ────────────────────────────────────────────────────────

function suggestSpecFix(getRuntime: GetTasksRuntime): PluginTool {
  return {
    name: 'suggest_spec_fix',
    description:
      'For a failing task: returns the current spec body plus the last error so you can propose a revised body to the user. Apply the fix with update_task ONLY after the user agrees — never auto-apply.',
    schema: taskIdSchema,
    handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
      const { taskId } = taskIdSchema.parse(rawArgs);
      const rt = requireRuntime(getRuntime);
      const spec = await rt.store.load(ctx.user.did, taskId);
      if (!spec) return { ok: false, error: 'Task not found.' };
      const failures = await rt.state.getFailures(taskId);
      if (!failures) {
        return {
          ok: true,
          proposal: null,
          note: 'No recent failures recorded — nothing to fix.',
        };
      }
      return {
        ok: true,
        taskId,
        title: spec.frontmatter.title,
        currentBody: spec.body,
        lastError: failures.lastError,
        consecutiveFailures: failures.count,
        instruction:
          'Propose a concise revision of currentBody that addresses lastError. Explain the change to the user; call update_task with the new body (and resume_task if the task is paused) only once they confirm.',
      };
    },
  };
}

// ── resolve_pending_approval ────────────────────────────────────────────────

const resolveInput = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().optional(),
});

function resolvePendingApproval(getRuntime: GetTasksRuntime): PluginTool {
  return {
    name: 'resolve_pending_approval',
    description:
      "Resolve the pending task-approval in this conversation when the user's reply addresses it (e.g. 'looks good, send it' / 'no, the numbers are off'). Clear yes/no replies are handled automatically — use this for everything in between.",
    schema: resolveInput,
    handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
      const args = resolveInput.parse(rawArgs);
      const rt = requireRuntime(getRuntime);
      const roomId = ctx.session.roomId;
      if (!roomId)
        return {
          ok: false,
          error: 'No room on this session — nothing pending here.',
        };
      const taskId = await rt.state.getPendingTaskForRoom(roomId);
      if (!taskId)
        return {
          ok: false,
          error: 'No approval is pending in this conversation.',
        };

      const resolved =
        args.decision === 'approve'
          ? await rt.approval.approve(taskId)
          : await rt.approval.reject(taskId, args.reason);
      if (!resolved) return { ok: false, error: 'Already resolved.' };
      return {
        ok: true,
        taskId,
        decision: args.decision,
        note:
          args.decision === 'approve'
            ? 'Result delivered to the room.'
            : 'Pending result discarded.',
      };
    },
  };
}
