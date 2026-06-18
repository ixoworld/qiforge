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
import { getFlowTemplate, listTemplateNames } from '../templates.js';

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
    .describe('The step whose available upstream outputs you want.'),
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

const templateSchema = z.object({
  name: z
    .string()
    .optional()
    .describe('Template name. Omit to list the available templates.'),
});

export function buildGetFlowTemplateTool(): PluginTool {
  return tool(
    async (args) => {
      try {
        const { name } = templateSchema.parse(args);
        if (!name) return { templates: listTemplateNames() };
        const flow = getFlowTemplate(name);
        if (!flow) {
          return {
            ok: false,
            error: {
              code: 'flow_not_found',
              message: `No template "${name}". Available: ${listTemplateNames().join(', ')}.`,
            },
          };
        }
        return flow;
      } catch (err) {
        return toToolError(err);
      }
    },
    {
      name: 'get_flow_template',
      description:
        'Get a ready-made starter flow you can tweak and then create. Call with no name to list the available templates.',
      schema: templateSchema,
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
        'List the upstream outputs a step can pipe from, as friendly field paths. Use these to wire inputs ' +
        '("{{step-id.output.field}}") or with connect_steps, instead of guessing field names.',
      schema: referenceableSchema,
    },
  );
}
