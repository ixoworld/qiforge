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
} from '../domain/spec.js';
import { TriggerSchema } from '../domain/trigger.js';
import { tools } from './shared.js';

const updateInputSchema = z.object({
  taskId: z.string().regex(/^task_[a-f0-9]{12}$/),
  title: z.string().min(1).max(120).optional(),
  trigger: TriggerSchema.optional(),
  body: z.string().min(1).optional(),
  approval: z.enum(['never', 'before-delivery']).optional(),
  modelTier: z.enum(['low', 'medium', 'high']).optional(),
});

export const updateTaskTool: PluginTool = {
  name: 'update_task',
  description:
    'Patch fields on an existing task. Pass only the fields you want to change. If you change the `trigger`, the next run is recomputed automatically.',
  schema: updateInputSchema,
  visibility: 'always',
  handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
    const args = updateInputSchema.parse(rawArgs);
    const { fs, scheduler } = tools();

    const path = specPath(ctx.user.did, args.taskId);
    const md = await fs.read(path);
    if (!md) return { ok: false, error: 'Task not found.' };

    const spec = parseSpec(md);

    const triggerChanged = args.trigger !== undefined;
    const nextRunAt = triggerChanged
      ? scheduler.nextRunAt(args.trigger ?? spec.frontmatter.trigger)
      : spec.frontmatter.stats.nextRunAt;

    const updated: TaskSpec = {
      ...spec,
      frontmatter: {
        ...spec.frontmatter,
        ...(args.title !== undefined && { title: args.title }),
        ...(args.trigger !== undefined && { trigger: args.trigger }),
        ...(args.approval !== undefined && { approval: args.approval }),
        ...(args.modelTier !== undefined && { modelTier: args.modelTier }),
        stats: { ...spec.frontmatter.stats, nextRunAt },
      },
      ...(args.body !== undefined && { body: args.body }),
    };

    await fs.write(path, renderSpec(updated));

    if (triggerChanged) {
      await scheduler.cancelAllRuns(args.taskId);
      if (nextRunAt && updated.frontmatter.status === 'active') {
        await scheduler.enqueueNextRun(args.taskId, ctx.user.did, nextRunAt);
      }
    }

    return {
      ok: true,
      taskId: updated.frontmatter.id,
      nextRunAt,
      status: updated.frontmatter.status,
    };
  },
};
