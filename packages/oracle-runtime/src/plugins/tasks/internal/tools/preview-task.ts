import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type {
  PluginTool,
  RuntimeContext,
} from '../../../../plugin-api/types.js';
import { specHash } from '../domain/spec.js';
import { tools } from './shared.js';

const PREVIEW_TTL_SEC = 10 * 60;

const previewIntentSchema = z.object({
  whatToDo: z.string().min(1),
  howToReport: z.string().optional(),
  constraints: z.array(z.string()).optional(),
});

const previewInputSchema = z.object({
  title: z.string().min(1).max(120),
  intent: previewIntentSchema,
  modelTier: z.enum(['low', 'medium', 'high']).default('medium'),
});

type PreviewInput = z.infer<typeof previewInputSchema>;

export const previewTaskTool: PluginTool = {
  name: 'preview_task',
  description: [
    'Run a candidate task spec ONCE in dry mode and return the real output.',
    'ALWAYS call this before `create_task` — the returned `previewToken` is',
    'required by `create_task`. The user must see this output before any',
    'task gets scheduled.',
  ].join(' '),
  schema: previewInputSchema,
  visibility: 'always',
  handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
    const args = previewInputSchema.parse(rawArgs);
    const { invoker, state } = tools();

    const message = composeIntent(args);

    // We synthesise a transient runId; nothing persists.
    const runId = randomBytes(8).toString('hex');
    const taskId = `preview_${randomBytes(6).toString('hex')}`;

    const result = await invoker.invoke({
      userDid: ctx.user.did,
      message,
      taskId,
      runId,
      modelTier: args.modelTier,
    });

    const token = randomBytes(12).toString('hex');
    const hash = specHash({
      title: args.title,
      body: message,
      modelTier: args.modelTier,
    });
    await state.putPreviewToken(
      token,
      {
        owner: ctx.user.did,
        hash,
        expiresAt: Date.now() + PREVIEW_TTL_SEC * 1000,
      },
      PREVIEW_TTL_SEC,
    );

    return {
      previewToken: token,
      output: result.output,
      note: 'Preview ran successfully. Show the user the output and ask whether to schedule. If yes, call create_task with this previewToken.',
    };
  },
};

function composeIntent(args: PreviewInput): string {
  const parts: string[] = ['## What to do', args.intent.whatToDo.trim()];
  if (args.intent.howToReport?.trim()) {
    parts.push('', '## How to report', args.intent.howToReport.trim());
  }
  if (args.intent.constraints?.length) {
    parts.push('', '## Constraints');
    for (const c of args.intent.constraints) parts.push(`- ${c}`);
  }
  return parts.join('\n');
}
