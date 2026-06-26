/**
 * Discovery tools (spec §3.1) — enumerate and describe the available actions.
 * These read only the action catalog, so they never connect to a flow room.
 */
import { z } from 'zod';
import type { MatrixClient } from 'matrix-js-sdk';
import { tool } from '../../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../../plugin-api/types.js';
import { describeAction, listActions } from '../actions.js';
import { toToolError } from '../errors.js';
import { withFlowDoc } from '../flow-doc.js';
import { listReferenceableFields } from '../references.js';

const listActionsSchema = z.object({
  category: z
    .string()
    .optional()
    .describe('Filter to actions in this category.'),
  tag: z.string().optional().describe('Filter to actions carrying this tag.'),
});

const describeActionSchema = z.object({
  action: z.string().min(1).describe('Action name (from list_actions).'),
});

const referenceableSchema = z.object({
  flowRef: z
    .string()
    .optional()
    .describe('Which flow. Omit to use the flow that is currently open.'),
  stepId: z
    .string()
    .min(1)
    .describe(
      'The step you are wiring data INTO (the downstream/consumer step) — NOT the source. ' +
        'Returns the outputs of the steps that run before it. Passing the first step returns nothing (nothing runs before it).',
    ),
});

export function buildListActionsTool(): PluginTool {
  return tool(
    async (args) => {
      try {
        const { category, tag } = listActionsSchema.parse(args);
        return { actions: listActions({ category, tag }) };
      } catch (err) {
        return toToolError(err);
      }
    },
    {
      name: 'list_actions',
      description:
        'List the actions available to use as steps in a flow. Optionally filter by category or tag. ' +
        'Returns each action with a short summary and when to use it.',
      schema: listActionsSchema,
    },
  );
}

export function buildDescribeActionTool(): PluginTool {
  return tool(
    async (args) => {
      try {
        const { action } = describeActionSchema.parse(args);
        const description = describeAction(action);
        if (!description) {
          return {
            ok: false,
            error: {
              code: 'unknown_action',
              message: `Unknown action "${action}".`,
            },
          };
        }
        return description;
      } catch (err) {
        return toToolError(err);
      }
    },
    {
      name: 'describe_action',
      description:
        'Get the full friendly spec of one action: its summary, inputs, outputs, the events it can emit, ' +
        'the lifecycle hooks it supports, and whether it is a form. Use before adding a step to know how to configure it.',
      schema: describeActionSchema,
    },
  );
}

export function buildListReferenceableFieldsTool(
  matrixClient: MatrixClient | undefined,
): PluginTool {
  return tool(
    async (args, ctx: RuntimeContext) => {
      try {
        const { flowRef, stepId } = referenceableSchema.parse(args);
        return await withFlowDoc(
          ctx,
          flowRef,
          matrixClient,
          async (doc, roomId) => ({
            fields: listReferenceableFields(doc, roomId, stepId),
          }),
        );
      } catch (err) {
        return toToolError(err);
      }
    },
    {
      name: 'list_referenceable_fields',
      description:
        'List the outputs a step can pull data FROM. Pass the step that NEEDS the data (the downstream/consumer ' +
        "step) — it returns the output fields of every step before it (e.g. a form's answers like answers.did), so you " +
        'wire the right "{{source.output.field}}" or call connect_steps. Passing the source step returns nothing, since ' +
        'nothing runs before it.',
      schema: referenceableSchema,
    },
  );
}
