import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { PluginTool, RuntimeContext } from '../../../plugin-api/types.js';
import { acquireToolLock } from '../../../utils/tool-lock.js';
import { cronIntervalMs, shouldCreateDedicatedRoom } from './delivery.js';
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
  type Trigger,
} from './spec.js';

const logger = new Logger('TasksTools');

const PREVIEW_TTL_SEC = 30 * 60;

const taskIdSchema = z.object({
  taskId: z.string().regex(/^task_[a-z0-9][a-z0-9-]*_[a-f0-9]{8}$/),
});

const APPROVAL_FIELD_DESCRIPTION =
  "How each run behaves. 'never' (default) just does the work and delivers " +
  "the result. 'before-action' is for runs that perform something the user " +
  'should sign off on first (a tweet, a message, a ticket, an email, a ' +
  'publish) — choose it with the user whenever a run would send, post, ' +
  "publish, or create something on their behalf. With 'before-action' the " +
  'task runs in its own [Task] room: each run does the work, PREPARES the ' +
  'action, and posts a draft asking the user to approve — it does NOT perform ' +
  'the irreversible action yet. The user approves by simply REPLYING in that ' +
  'room (e.g. "yes" / "go ahead", or "change X"); the agent then performs the ' +
  'action, revises, or stops. Write the task body to do the work and prepare ' +
  "the action (e.g. 'Draft the post and propose it for approval'); the " +
  'approval wording is added automatically. Tell the user to expect the draft ' +
  'in the [Task] room and to reply there.';

/** Non-null when a cron trigger fires more often than the configured floor. */
function cronTooFrequentError(
  trigger: Trigger,
  minIntervalSec: number,
): string | null {
  if (trigger.type !== 'time.cron') return null;
  const interval = cronIntervalMs(trigger.pattern, trigger.tz);
  if (interval === null || interval >= minIntervalSec * 1000) return null;
  return `That cron schedule fires every ${Math.round(interval / 1000)}s — the minimum interval between runs is ${minIntervalSec}s. Pick a less frequent schedule.`;
}

/**
 * The 9 main-agent tools. Created once per plugin instance as closures over
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
      'Run a candidate task spec ONCE, for real, and return the output. ALWAYS call this before create_task — the returned previewToken is required there. The user must see this output before any task is scheduled. After calling this, STOP and reply to the user — do not call create_task in the same turn.',
    schema: previewInput,
    handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
      const args = previewInput.parse(rawArgs);
      const release = acquireToolLock(`${ctx.session.id}:preview_task`);
      try {
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
          {
            owner: ctx.user.did,
            hash: specHash(args.title, body),
            requestId: ctx.session.requestId,
          },
          PREVIEW_TTL_SEC,
        );
        return {
          previewToken,
          output,
          note: "STOP here. Show this exact output to the user and ask whether to schedule it. Do NOT call create_task in this same turn — wait for the user to confirm in a new message. If the task runs more than once a day or is a monitor/watch, also ask whether they want a dedicated room. If the task would send, post, publish, or create anything on the user's behalf, ask whether they want to approve each run before it acts (approval: 'before-action'): the run will draft the action in its own [Task] room and the user approves by replying there. On confirmation, call create_task with this previewToken and the SAME title/intent.",
        };
      } finally {
        release();
      }
    },
  };
}

// ── create_task ─────────────────────────────────────────────────────────────

const createInput = z.object({
  previewToken: z.string().min(8),
  title: z.string().min(1).max(120),
  trigger: TriggerSchema,
  intent: IntentSchema,
  approval: z
    .enum(['never', 'before-action'])
    .default('never')
    .describe(APPROVAL_FIELD_DESCRIPTION),
  dedicatedRoom: z.enum(['auto', 'yes', 'no']).default('auto'),
});

function createTask(getRuntime: GetTasksRuntime): PluginTool {
  return {
    name: 'create_task',
    description:
      'Schedule a previewed task. Call this ONLY after the user has seen the preview output and confirmed in a NEW message — never in the same turn as preview_task. Requires a fresh previewToken from preview_task whose title/intent match exactly (re-preview if anything changed). dedicatedRoom: "auto" (default) puts the task in its own [Task] room when it runs more than once a day, has a long body, or mentions monitor/watch/track/ongoing; otherwise it delivers into the main room. For frequent or monitoring tasks, ask the user first and pass "yes"/"no" explicitly rather than relying on "auto". Set `approval` to "before-action" when a run would send/post/publish/create anything or the user wants to vet it first — such tasks always get their own [Task] room where each run drafts the action and the user approves by replying there (see the approval field). Scheduled runs are background work: each result is delivered to the user\'s oracle chat room (or the dedicated [Task] room shown in `roomId`) in their IXO app when it fires — NOT inline in this conversation — so always tell the user where to expect results.',
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
      // Force a turn break: a token minted in THIS turn means the agent
      // chained preview → create without letting the user confirm. Make it
      // stop, show the preview, and wait for the user's reply.
      if (
        claim.requestId &&
        ctx.session.requestId &&
        claim.requestId === ctx.session.requestId
      ) {
        return {
          ok: false,
          error:
            'Do not schedule yet — you just previewed this in the current turn. Show the user the preview output, ask whether to schedule it (and whether they want a dedicated room for a frequent/monitoring task), then call create_task only after they reply in a new message.',
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

      const intervalError = cronTooFrequentError(
        args.trigger,
        rt.config.minCronIntervalSec,
      );
      if (intervalError) {
        return { ok: false, error: intervalError };
      }

      const nextRunAt = nextRunAtFor(args.trigger);
      if (!nextRunAt) {
        return {
          ok: false,
          error: 'Trigger has no future run time — adjust it and try again.',
        };
      }

      // ── Commit ───────────────────────────────────────────────────────

      const taskId = newTaskId(args.title);
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

      // A `before-action` task ALWAYS needs its own room: that's where each
      // run drafts the action and the user replies to approve. The heuristic
      // is bypassed, and a creation failure is fatal — without a room the
      // approval conversation has nowhere to happen.
      if (args.approval === 'before-action') {
        const dedicatedRoomId = await rt.delivery.createDedicatedRoom(
          spec,
          ctx.user.matrixUserId,
        );
        if (!dedicatedRoomId) {
          return {
            ok: false,
            error:
              'Could not create the task room needed for approval — try again.',
          };
        }
        spec.frontmatter.delivery.roomId = dedicatedRoomId;
      } else if (
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
      logger.log(`create_task ${taskId} — ${summarizeTrigger(args.trigger)}`);

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
      const specs = (await rt.store.list(ctx.user.did)).filter(
        (t) =>
          !args.status?.length || args.status.includes(t.frontmatter.status),
      );
      const tasks = specs
        .map((t) => ({
          id: t.frontmatter.id,
          title: t.frontmatter.title,
          status: t.frontmatter.status,
          trigger: summarizeTrigger(t.frontmatter.trigger),
          nextRunAt: t.frontmatter.stats.nextRunAt,
          approval: t.frontmatter.approval,
          roomId: t.frontmatter.delivery.roomId,
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
  intent: IntentSchema.optional(),
  previewToken: z.string().min(8).optional(),
  approval: z
    .enum(['never', 'before-action'])
    .optional()
    .describe(APPROVAL_FIELD_DESCRIPTION),
});

function updateTask(getRuntime: GetTasksRuntime): PluginTool {
  return {
    name: 'update_task',
    description:
      'Patch a task — title, trigger, approval mode, or intent (what the task does). Changing the intent requires a fresh previewToken from preview_task run with the new title/intent, so the user has seen the revised output. Changing the trigger reschedules the next run automatically.',
    schema: updateInput,
    handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
      const args = updateInput.parse(rawArgs);
      const rt = requireRuntime(getRuntime);
      const owner = ctx.user.did;

      const spec = await rt.store.load(owner, args.taskId);
      if (!spec) return { ok: false, error: 'Task not found.' };

      if (args.trigger) {
        const intervalError = cronTooFrequentError(
          args.trigger,
          rt.config.minCronIntervalSec,
        );
        if (intervalError) {
          return { ok: false, error: intervalError };
        }
      }

      const title = args.title ?? spec.frontmatter.title;
      let body = spec.body;
      if (args.intent) {
        if (!args.previewToken) {
          return {
            ok: false,
            error:
              'Changing what the task does requires a fresh preview — run preview_task with the revised title/intent and pass the returned previewToken here.',
          };
        }
        const newBody = renderIntentBody(args.intent);
        const claim = await rt.state.peekPreview(args.previewToken);
        if (
          !claim ||
          claim.owner !== owner ||
          claim.hash !== specHash(title, newBody)
        ) {
          return {
            ok: false,
            error:
              'Preview token invalid, expired, or for different content — re-run preview_task with this exact title and intent.',
          };
        }
        body = newBody;
      }

      const trigger = args.trigger ?? spec.frontmatter.trigger;
      const nextRunAt = args.trigger
        ? nextRunAtFor(trigger)
        : spec.frontmatter.stats.nextRunAt;

      const updated: TaskSpec = {
        frontmatter: {
          ...spec.frontmatter,
          title,
          trigger,
          approval: args.approval ?? spec.frontmatter.approval,
          stats: { nextRunAt },
        },
        body,
      };
      await rt.store.save(updated);
      // Consume the token only after the save succeeded.
      if (args.intent && args.previewToken) {
        await rt.state.deletePreview(args.previewToken);
      }

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

      // Validate the whole transition before any write, so a rejected
      // resume can't leave the task half-updated.
      const current = await rt.store.load(owner, taskId);
      if (!current) return { ok: false, error: 'Task not found.' };

      if (status === 'active') {
        if (
          current.frontmatter.status === 'cancelled' ||
          current.frontmatter.status === 'completed'
        ) {
          return {
            ok: false,
            error: `A ${current.frontmatter.status} task cannot be resumed — create a new one.`,
          };
        }
        const nextRunAt = nextRunAtFor(current.frontmatter.trigger);
        if (!nextRunAt) {
          return {
            ok: false,
            error: 'Trigger has no future run time — update the trigger first.',
          };
        }
        await rt.store.setStatus(owner, taskId, status, nextRunAt);
        await rt.scheduler.cancelRuns(taskId);
        await rt.scheduler.enqueueRun(taskId, owner, nextRunAt);
        await rt.state.resetFailures(taskId);
        return { ok: true, taskId, status, nextRunAt };
      }

      await rt.store.setStatus(owner, taskId, status, null);
      await rt.scheduler.cancelRuns(taskId);
      if (status === 'cancelled') logger.log(`cancel_task ${taskId}`);
      return { ok: true, taskId, status, nextRunAt: null };
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
          'Propose a concise revision of currentBody that addresses lastError and explain the change to the user. Once they confirm: run preview_task with the revised intent, then update_task with the returned previewToken (and resume_task if the task is paused).',
      };
    },
  };
}
