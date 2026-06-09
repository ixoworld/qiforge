import { z } from 'zod';
import type {
  PluginTool,
  RuntimeContext,
} from '../../../../plugin-api/types.js';
import {
  TASK_STATUSES,
  trySpec,
  userTasksPrefix,
  type TaskStatus,
} from '../domain/spec.js';
import { summarizeTrigger } from '../domain/trigger.js';
import { tools } from './shared.js';

const listInputSchema = z.object({
  status: z.array(z.enum(TASK_STATUSES)).optional(),
});

export const listMyTasksTool: PluginTool = {
  name: 'list_my_tasks',
  description:
    "List the current user's tasks, optionally filtered by status. Returns id, title, status, next run time, and trigger summary.",
  schema: listInputSchema,
  visibility: 'always',
  handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
    const args = listInputSchema.parse(rawArgs);
    const { fs } = tools();
    const prefix = userTasksPrefix(ctx.user.did);
    const paths = (await fs.list(prefix)).filter((p) => p.endsWith('/spec.md'));

    const rows: Array<{
      id: string;
      title: string;
      status: TaskStatus;
      nextRunAt: string | null;
      trigger: string;
    }> = [];

    for (const path of paths) {
      const md = await fs.read(path);
      if (!md) continue;
      const spec = trySpec(md);
      if (!spec) continue;
      const status = spec.frontmatter.status;
      if (args.status?.length && !args.status.includes(status)) continue;
      rows.push({
        id: spec.frontmatter.id,
        title: spec.frontmatter.title,
        status,
        nextRunAt: spec.frontmatter.stats.nextRunAt,
        trigger: summarizeTrigger(spec.frontmatter.trigger),
      });
    }
    rows.sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''));
    return { tasks: rows, count: rows.length };
  },
};
