import { z } from 'zod';
import type {
  PluginTool,
  RuntimeContext,
} from '../../../../plugin-api/types.js';
import { buildSpec, renderSpec, specHash, specPath } from '../domain/spec.js';
import { TriggerSchema } from '../domain/trigger.js';
import { tools } from './shared.js';

const createInputSchema = z.object({
  previewToken: z.string().min(8),
  title: z.string().min(1).max(120),
  trigger: TriggerSchema,
  intent: z.object({
    whatToDo: z.string().min(1),
    howToReport: z.string().optional(),
    constraints: z.array(z.string()).optional(),
  }),
  delivery: z
    .object({
      roomId: z.union([z.literal('main'), z.string().min(1)]).optional(),
      format: z.enum(['message', 'report', 'json']).optional(),
    })
    .optional(),
  approval: z.enum(['never', 'before-delivery']).default('never'),
  modelTier: z.enum(['low', 'medium', 'high']).default('medium'),
  dedicatedRoom: z.enum(['auto', 'yes', 'no']).default('auto'),
});

export const createTaskTool: PluginTool = {
  name: 'create_task',
  description: [
    'Schedule a task to run on its trigger. REQUIRES a fresh `previewToken`',
    'from `preview_task` whose spec hash matches what you commit here. If',
    'the user edits anything after preview, re-run `preview_task` first.',
  ].join(' '),
  schema: createInputSchema,
  visibility: 'always',
  handler: async (rawArgs: unknown, ctx: RuntimeContext) => {
    const args = createInputSchema.parse(rawArgs);
    const { fs, scheduler, roomResolver, dedicatedRoom } = tools();

    // Validate the preview token + spec hash.
    const { state } = tools();
    const tokenPayload = await state.consumePreviewToken(args.previewToken);
    if (!tokenPayload) {
      return {
        ok: false,
        error: 'Preview token invalid or expired. Run preview_task again.',
      };
    }
    if (tokenPayload.owner !== ctx.user.did) {
      return {
        ok: false,
        error: 'Preview token does not belong to this user.',
      };
    }

    const intentBody = composeIntentBody(args.intent);
    const hash = specHash({
      title: args.title,
      body: intentBody,
      modelTier: args.modelTier,
    });
    if (hash !== tokenPayload.hash) {
      return {
        ok: false,
        error:
          'The spec changed since the preview. Re-run preview_task to verify the new output.',
      };
    }

    const nextRunAt = scheduler.nextRunAt(args.trigger);
    if (!nextRunAt) {
      return {
        ok: false,
        error:
          'Trigger has no future run time (one-shot in the past?). Adjust and try again.',
      };
    }

    const tmpSpec = buildSpec(
      {
        owner: ctx.user.did,
        title: args.title,
        trigger: args.trigger,
        intent: args.intent,
        delivery: { format: args.delivery?.format },
        approval: args.approval,
        modelTier: args.modelTier,
      },
      nextRunAt,
    );

    // Resolve the delivery room — dedicated or main.
    let resolvedRoomId: 'main' | string;
    if (args.delivery?.roomId && args.delivery.roomId !== 'main') {
      resolvedRoomId = args.delivery.roomId;
    } else if (
      roomResolver.shouldCreateDedicatedRoom({
        trigger: args.trigger,
        intentBody,
        explicit: args.dedicatedRoom,
      })
    ) {
      const room = await dedicatedRoom.createForTask({
        title: args.title,
        userMatrixId: ctx.user.matrixUserId,
        spec: tmpSpec,
      });
      resolvedRoomId = room ?? 'main';
    } else {
      resolvedRoomId = 'main';
    }

    const spec = {
      ...tmpSpec,
      frontmatter: {
        ...tmpSpec.frontmatter,
        delivery: { ...tmpSpec.frontmatter.delivery, roomId: resolvedRoomId },
      },
    };

    await fs.write(
      specPath(ctx.user.did, spec.frontmatter.id),
      renderSpec(spec),
    );
    await scheduler.enqueueNextRun(
      spec.frontmatter.id,
      ctx.user.did,
      nextRunAt,
    );

    return {
      ok: true,
      taskId: spec.frontmatter.id,
      title: spec.frontmatter.title,
      roomId: resolvedRoomId,
      nextRunAt,
      approval: spec.frontmatter.approval,
    };
  },
};

function composeIntentBody(intent: {
  whatToDo: string;
  howToReport?: string;
  constraints?: string[];
}): string {
  const parts: string[] = ['## What to do', intent.whatToDo.trim()];
  if (intent.howToReport?.trim()) {
    parts.push('', '## How to report', intent.howToReport.trim());
  }
  if (intent.constraints?.length) {
    parts.push('', '## Constraints');
    for (const c of intent.constraints) parts.push(`- ${c}`);
  }
  return parts.join('\n');
}
