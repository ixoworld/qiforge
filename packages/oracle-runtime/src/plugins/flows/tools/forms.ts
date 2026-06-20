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
import { describeForm, fillForm, setFormSchema } from '../forms.js';

const describeSchema = z.object({
  flowRef: z
    .string()
    .optional()
    .describe('Which flow. Omit to use the flow that is currently open.'),
  stepId: z.string().min(1).describe('The form step to describe.'),
});

const questionSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      'The answer key this question produces (referenced downstream as {{step-id.output.<name>}}).',
    ),
  label: z
    .string()
    .optional()
    .describe('The question text shown to the user (defaults to the name).'),
  type: z
    .string()
    .optional()
    .describe(
      'Question type: text (default), comment (multi-line), dropdown, radiogroup, checkbox (multi-select), boolean, rating.',
    ),
  required: z.boolean().optional(),
  choices: z
    .array(z.string())
    .optional()
    .describe('Allowed options for choice questions (dropdown/radiogroup/checkbox).'),
});

const setFormSchemaSchema = z.object({
  flowRef: z
    .string()
    .optional()
    .describe('Which flow. Omit to use the flow that is currently open.'),
  stepId: z.string().min(1).describe('The form step to define the questions for.'),
  questions: z
    .array(questionSchema)
    .min(1)
    .describe('The questions the form should ask, in order.'),
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
          const { flowRef, stepId, questions } =
            setFormSchemaSchema.parse(args);
          return await withFlowDoc(
            ctx,
            flowRef,
            matrixClient,
            async (doc, roomId) => setFormSchema(doc, roomId, stepId, questions),
          );
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'set_form_schema',
        description:
          'Define the questions a form step asks (its survey). REQUIRED for any form step — a form with no questions ' +
          "shows \"Configure Survey Schema JSON\" and cannot run. Give each question a name (the answer key, referenced " +
          'downstream as {{step-id.output.<name>}}), a label, a type, and whether it is required. Call this after adding the form step.',
        schema: setFormSchemaSchema,
      },
    ),
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
