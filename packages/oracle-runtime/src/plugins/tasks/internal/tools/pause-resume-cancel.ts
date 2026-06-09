import { z } from 'zod';
import type {
  PluginTool,
  RuntimeContext,
} from '../../../../plugin-api/types.js';
import {
  parseSpec,
  renderSpec,
  specPath,
  type TaskSpec,
  type TaskStatus,
} from '../domain/spec.js';
import { tools } from './shared.js';

const taskIdSchema = z.object({
  taskId: z.string().regex(/^task_[a-f0-9]{12}$/),
});

async function setStatus(
  ctx: RuntimeContext,
  taskId: string,
  next: TaskStatus,
  options: { keepNextRun?: boolean } = {},
): Promise<
  | { ok: true; taskId: string; status: TaskStatus; nextRunAt: string | null }
  | { ok: false; error: string }
> {
  const { fs, scheduler } = tools();
  const path = specPath(ctx.user.did, taskId);
  const md = await fs.read(path);
  if (!md) return { ok: false, error: 'Task not found.' };

  const spec = parseSpec(md);

  const nextRunAt = options.keepNextRun
    ? spec.frontmatter.stats.nextRunAt
    : next === 'active'
      ? scheduler.nextRunAt(spec.frontmatter.trigger)
      : null;

  const updated: TaskSpec = {
    ...spec,
    frontmatter: {
      ...spec.frontmatter,
      status: next,
      stats: { ...spec.frontmatter.stats, nextRunAt },
    },
  };

  await fs.write(path, renderSpec(updated));

  if (next === 'paused' || next === 'cancelled' || next === 'completed') {
    await scheduler.cancelAllRuns(taskId);
  } else if (next === 'active' && nextRunAt) {
    await scheduler.cancelAllRuns(taskId);
    await scheduler.enqueueNextRun(taskId, ctx.user.did, nextRunAt);
  }

  return { ok: true, taskId, status: next, nextRunAt };
}

export const pauseTaskTool: PluginTool = {
  name: 'pause_task',
  description:
    'Pause a task. Pending and future runs are cancelled until you resume.',
  schema: taskIdSchema,
  visibility: 'always',
  handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
    const { taskId } = taskIdSchema.parse(rawArgs);
    return setStatus(ctx, taskId, 'paused');
  },
};

export const resumeTaskTool: PluginTool = {
  name: 'resume_task',
  description:
    'Resume a paused or failed-pending-review task. The next run is recomputed from the trigger.',
  schema: taskIdSchema,
  visibility: 'always',
  handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
    const { taskId } = taskIdSchema.parse(rawArgs);
    return setStatus(ctx, taskId, 'active');
  },
};

export const cancelTaskTool: PluginTool = {
  name: 'cancel_task',
  description:
    'Cancel a task permanently. No further runs are scheduled. The spec is kept on disk for the audit trail.',
  schema: taskIdSchema,
  visibility: 'always',
  handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
    const { taskId } = taskIdSchema.parse(rawArgs);
    return setStatus(ctx, taskId, 'cancelled');
  },
};
