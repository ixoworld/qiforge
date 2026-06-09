import { z } from 'zod';
import type {
  PluginTool,
  RuntimeContext,
} from '../../../../plugin-api/types.js';
import { parseSpec, specPath } from '../domain/spec.js';
import { summarizeTrigger } from '../domain/trigger.js';
import { tools } from './shared.js';

const getInputSchema = z.object({
  taskId: z.string().regex(/^task_[a-f0-9]{12}$/),
});

export const getTaskTool: PluginTool = {
  name: 'get_task',
  description:
    'Fetch the full spec for one task — frontmatter, body, last failure (if any), trigger summary.',
  schema: getInputSchema,
  visibility: 'always',
  handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
    const args = getInputSchema.parse(rawArgs);
    const { fs, state } = tools();

    const md = await fs.read(specPath(ctx.user.did, args.taskId));
    if (!md) return { ok: false, error: 'Task not found.' };

    const spec = parseSpec(md);
    const failures = await state.getFailures(args.taskId);

    return {
      ok: true,
      id: spec.frontmatter.id,
      title: spec.frontmatter.title,
      status: spec.frontmatter.status,
      trigger: summarizeTrigger(spec.frontmatter.trigger),
      nextRunAt: spec.frontmatter.stats.nextRunAt,
      delivery: spec.frontmatter.delivery,
      approval: spec.frontmatter.approval,
      modelTier: spec.frontmatter.modelTier,
      body: spec.body,
      ...(failures
        ? {
            lastError: {
              message: failures.lastError,
              failedAt: failures.lastFailedAt,
              consecutiveCount: failures.count,
            },
          }
        : {}),
    };
  },
};
