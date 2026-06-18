/**
 * Settings mutators (spec §3.4) — one focused tool per setting, each a
 * per-block / delta edit (§4.2). Every tool resolves the flow, runs its edit
 * against the connected doc, and returns `{ ok: true }`.
 */
import { z } from 'zod';
import type { MatrixClient } from 'matrix-js-sdk';
import { tool } from '../../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../../plugin-api/types.js';
import { toToolError } from '../errors.js';
import { withFlowDoc } from '../flow-doc.js';
import {
  setStepAssignment,
  setStepConditions,
  setStepConfirmation,
  setStepInputs,
  setStepSchedule,
} from '../edit.js';
import { conditionSchema, dueSchema } from '../types.js';

const base = {
  flowRef: z
    .string()
    .optional()
    .describe('Which flow. Omit to use the flow that is currently open.'),
};

const inputsSchema = z.object({
  ...base,
  stepId: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()),
});
const conditionsSchema = z.object({
  ...base,
  stepId: z.string().min(1),
  conditions: z.array(conditionSchema),
});
const scheduleSchema = z.object({
  ...base,
  stepId: z.string().min(1),
  due: dueSchema.optional(),
  commitTo: z.string().optional(),
});
const assignmentSchema = z.object({
  ...base,
  stepId: z.string().min(1),
  assignTo: z.string().nullable().optional(),
});
const confirmationSchema = z.object({
  ...base,
  stepId: z.string().min(1),
  requireConfirmation: z.boolean(),
});

const ok = { ok: true } as const;

export function buildSettingsTools(
  matrixClient: MatrixClient | undefined,
): PluginTool[] {
  return [
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const { flowRef, stepId, inputs } = inputsSchema.parse(args);
          await withFlowDoc(ctx, flowRef, matrixClient, async (doc) =>
            setStepInputs(doc, stepId, inputs),
          );
          return ok;
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'set_step_inputs',
        description:
          'Set a step\'s inputs. A value may reference an upstream output as "{{step-id.output.field}}". Replaces the step\'s inputs.',
        schema: inputsSchema,
      },
    ),
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const { flowRef, stepId, conditions } = conditionsSchema.parse(args);
          await withFlowDoc(ctx, flowRef, matrixClient, async (doc) =>
            setStepConditions(doc, stepId, conditions),
          );
          return ok;
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'set_step_conditions',
        description:
          'Set the activation conditions on a step (all must pass). Conditions gate on an upstream step’s configured value. Pass an empty list to clear them.',
        schema: conditionsSchema,
      },
    ),
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const { flowRef, stepId, due, commitTo } = scheduleSchema.parse(args);
          await withFlowDoc(ctx, flowRef, matrixClient, async (doc) =>
            setStepSchedule(doc, stepId, due, commitTo),
          );
          return ok;
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'set_step_schedule',
        description:
          'Set when a step is due (an absolute date and/or a duration after it becomes active).',
        schema: scheduleSchema,
      },
    ),
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const { flowRef, stepId, assignTo } = assignmentSchema.parse(args);
          await withFlowDoc(ctx, flowRef, matrixClient, async (doc) =>
            setStepAssignment(doc, stepId, assignTo ?? undefined),
          );
          return ok;
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'set_step_assignment',
        description:
          'Set who is meant to run a step (a DID or known alias). This is metadata only — it grants nothing.',
        schema: assignmentSchema,
      },
    ),
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const { flowRef, stepId, requireConfirmation } =
            confirmationSchema.parse(args);
          await withFlowDoc(ctx, flowRef, matrixClient, async (doc) =>
            setStepConfirmation(doc, stepId, requireConfirmation),
          );
          return ok;
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'set_step_confirmation',
        description:
          'Set whether the portal should force a confirmation before this step runs.',
        schema: confirmationSchema,
      },
    ),
  ];
}
