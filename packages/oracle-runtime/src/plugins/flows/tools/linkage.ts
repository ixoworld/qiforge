/**
 * Linkage tools (spec §3.2) — typed wiring checks. `check_link` and
 * `compatible_actions` read the flow; `requirements` is a pure action lookup.
 */
import { z } from 'zod';
import type { MatrixClient } from 'matrix-js-sdk';
import { tool } from '../../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../../plugin-api/types.js';
import { toToolError } from '../errors.js';
import { withFlowDoc } from '../flow-doc.js';
import { checkLink, compatibleActions, requirements } from '../linkage.js';

const flowRef = z
  .string()
  .optional()
  .describe('Which flow. Omit to use the flow that is currently open.');

const checkLinkSchema = z.object({
  flowRef,
  fromStep: z.string().min(1).describe('The step producing the value.'),
  field: z.string().min(1).describe('The output field of fromStep.'),
  toStep: z.string().min(1).describe('The step receiving the value.'),
  input: z.string().min(1).describe('The input of toStep to feed.'),
});

const compatibleSchema = z.object({
  flowRef,
  stepId: z
    .string()
    .min(1)
    .describe('The step whose input you want to satisfy.'),
  forInput: z.string().min(1).describe('The input name you want to fill.'),
});

const requirementsSchema = z.object({
  action: z.string().min(1).describe('Action name (from list_actions).'),
});

export function buildLinkageTools(
  matrixClient: MatrixClient | undefined,
): PluginTool[] {
  return [
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const {
            flowRef: ref,
            fromStep,
            field,
            toStep,
            input,
          } = checkLinkSchema.parse(args);
          return await withFlowDoc(
            ctx,
            ref,
            matrixClient,
            async (doc, roomId) =>
              checkLink(doc, roomId, fromStep, field, toStep, input),
          );
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'check_link',
        description:
          "Check whether one step's output field can feed another step's input. Catches references to outputs a step " +
          "doesn't produce, and flags type mismatches.",
        schema: checkLinkSchema,
      },
    ),
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const {
            flowRef: ref,
            stepId,
            forInput,
          } = compatibleSchema.parse(args);
          return await withFlowDoc(
            ctx,
            ref,
            matrixClient,
            async (doc, roomId) => ({
              producers: compatibleActions(doc, roomId, stepId, forInput),
            }),
          );
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'compatible_actions',
        description:
          'List the actions (and their output field) that produce a value compatible with a given input, so you can ' +
          'pick an upstream step to wire in.',
        schema: compatibleSchema,
      },
    ),
    tool(
      async (args) => {
        try {
          const { action } = requirementsSchema.parse(args);
          return { requires: requirements(action) };
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'requirements',
        description:
          "List an action's prerequisites (e.g. a needed role, connection, or collection) before using it in a flow.",
        schema: requirementsSchema,
      },
    ),
  ];
}
