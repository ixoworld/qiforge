/**
 * Form tools (spec §3.5). `describe_form` returns a step's fillable questions
 * with their exact allowed values; `fill_form` pre-fills answers (never submits).
 */
import { z } from 'zod';
import type { MatrixClient } from 'matrix-js-sdk';
import { tool } from '../../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../../plugin-api/types.js';
import { toToolError } from '../errors.js';
import { withFlowDoc } from '../flow-doc.js';
import { describeForm, fillForm } from '../forms.js';

const describeSchema = z.object({
  flowRef: z
    .string()
    .optional()
    .describe('Which flow. Omit to use the flow that is currently open.'),
  stepId: z.string().min(1).describe('The form step to describe.'),
});

const fillSchema = describeSchema.extend({
  answers: z
    .record(z.string(), z.unknown())
    .describe(
      'Answers keyed by question name. Choice questions need the underlying value, not the label.',
    ),
  merge: z
    .boolean()
    .optional()
    .describe('Merge with existing answers (default true).'),
});

export function buildFormTools(
  matrixClient: MatrixClient | undefined,
): PluginTool[] {
  return [
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const { flowRef, stepId } = describeSchema.parse(args);
          return await withFlowDoc(ctx, flowRef, matrixClient, async (doc) =>
            describeForm(doc, stepId),
          );
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'describe_form',
        description:
          'Read the questions of a form step — their names, types, whether they are required, and the exact allowed ' +
          'values for choice questions — so you can fill it correctly.',
        schema: describeSchema,
      },
    ),
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const { flowRef, stepId, answers, merge } = fillSchema.parse(args);
          return await withFlowDoc(ctx, flowRef, matrixClient, async (doc) =>
            fillForm(doc, stepId, answers, merge ?? true),
          );
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'fill_form',
        description:
          'Pre-fill a form step with answers. Does NOT submit — the user reviews and submits in the portal. ' +
          'Returns which answers applied, which were rejected, and any still-required questions.',
        schema: fillSchema,
      },
    ),
  ];
}
