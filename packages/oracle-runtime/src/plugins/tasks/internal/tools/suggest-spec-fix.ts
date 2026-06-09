import { z } from 'zod';
import type {
  PluginTool,
  RuntimeContext,
} from '../../../../plugin-api/types.js';
import { parseSpec, specPath } from '../domain/spec.js';
import { tools } from './shared.js';

const inputSchema = z.object({
  taskId: z.string().regex(/^task_[a-f0-9]{12}$/),
});

export const suggestSpecFixTool: PluginTool = {
  name: 'suggest_spec_fix',
  description: [
    'For a task in `failed-pending-review` (or one with repeated failures),',
    'read the last error and propose a markdown diff to the spec. You then',
    'paraphrase the proposal to the user and apply via `update_task` if they',
    'agree. Never auto-apply.',
  ].join(' '),
  schema: inputSchema,
  visibility: 'always',
  handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
    const { taskId } = inputSchema.parse(rawArgs);
    const { fs, state } = tools();

    const md = await fs.read(specPath(ctx.user.did, taskId));
    if (!md) return { ok: false, error: 'Task not found.' };

    const spec = parseSpec(md);
    const failures = await state.getFailures(taskId);

    if (!failures || failures.count === 0) {
      return {
        ok: true,
        proposal: null,
        note: 'No recent failures recorded — nothing to fix.',
      };
    }

    return {
      ok: true,
      taskId: spec.frontmatter.id,
      title: spec.frontmatter.title,
      currentBody: spec.body,
      lastError: failures.lastError,
      consecutiveFailures: failures.count,
      instruction:
        'You (the agent) should now: (1) read the currentBody and the lastError; (2) propose a concise revision of the body that addresses the failure; (3) explain the proposed change to the user; (4) only call `update_task` with the new body once the user confirms.',
    };
  },
};
