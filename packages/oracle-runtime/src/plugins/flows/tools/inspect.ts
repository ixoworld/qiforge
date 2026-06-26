/**
 * Inspect tools (spec §3.6) — the multi-source read surface. Each connects to
 * the flow room, gathers the FlowSpec from all sources, and returns the
 * friendly projection. Status fields are read-only (§2.6).
 */
import { z } from 'zod';
import type { MatrixClient } from 'matrix-js-sdk';
import { tool } from '../../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../../plugin-api/types.js';
import { FlowError, toToolError } from '../errors.js';
import { explainStep } from '../explain.js';
import { withFlowDoc } from '../flow-doc.js';
import { readFlowSpec, readFlowStatus, readStep } from '../read.js';

const flowRefSchema = z.object({
  flowRef: z
    .string()
    .optional()
    .describe(
      'Which flow to inspect. Omit to use the flow that is currently open.',
    ),
});

const stepRefSchema = flowRefSchema.extend({
  stepId: z.string().min(1).describe('The step to read.'),
});

export function buildReadFlowTool(
  matrixClient: MatrixClient | undefined,
): PluginTool {
  return tool(
    async (args, ctx: RuntimeContext) => {
      try {
        const { flowRef } = flowRefSchema.parse(args);
        return await withFlowDoc(
          ctx,
          flowRef,
          matrixClient,
          async (doc, roomId) => {
            const flow = readFlowSpec(doc, roomId);
            if (!flow)
              throw new FlowError(
                'flow_not_found',
                'That flow does not exist or has no steps yet.',
              );
            return flow;
          },
        );
      } catch (err) {
        return toToolError(err);
      }
    },
    {
      name: 'read_flow',
      description:
        'Read a whole flow as a clean, friendly structure: its title, goal, and every step with inputs, ' +
        'conditions, schedule, assignee, and a read-only status. Use to see the true current state of a flow.',
      schema: flowRefSchema,
    },
  );
}

export function buildGetStepTool(
  matrixClient: MatrixClient | undefined,
): PluginTool {
  return tool(
    async (args, ctx: RuntimeContext) => {
      try {
        const { flowRef, stepId } = stepRefSchema.parse(args);
        return await withFlowDoc(
          ctx,
          flowRef,
          matrixClient,
          async (doc, roomId) => {
            const step = readStep(doc, roomId, stepId);
            if (!step)
              throw new FlowError(
                'step_not_found',
                `No step "${stepId}" in this flow.`,
              );
            return step;
          },
        );
      } catch (err) {
        return toToolError(err);
      }
    },
    {
      name: 'get_step',
      description:
        'Read a single step of a flow, including its read-only runtime status.',
      schema: stepRefSchema,
    },
  );
}

export function buildFlowStatusTool(
  matrixClient: MatrixClient | undefined,
): PluginTool {
  return tool(
    async (args, ctx: RuntimeContext) => {
      try {
        const { flowRef } = flowRefSchema.parse(args);
        return await withFlowDoc(
          ctx,
          flowRef,
          matrixClient,
          async (doc, roomId) => {
            const status = readFlowStatus(doc, roomId);
            if (!status)
              throw new FlowError(
                'flow_not_found',
                'That flow does not exist or has no steps yet.',
              );
            return { steps: status };
          },
        );
      } catch (err) {
        return toToolError(err);
      }
    },
    {
      name: 'flow_status',
      description:
        'Get the per-step status of a flow: which steps are idle, running, completed, or failed (with the error), ' +
        'plus which are blocked and by what. Use to report progress or diagnose why a step failed.',
      schema: flowRefSchema,
    },
  );
}

export function buildExplainStepTool(
  matrixClient: MatrixClient | undefined,
): PluginTool {
  return tool(
    async (args, ctx: RuntimeContext) => {
      try {
        const { flowRef, stepId } = stepRefSchema.parse(args);
        return await withFlowDoc(
          ctx,
          flowRef,
          matrixClient,
          async (doc, roomId) => {
            const explanation = explainStep(doc, roomId, stepId);
            if (!explanation)
              throw new FlowError(
                'step_not_found',
                `No step "${stepId}" in this flow.`,
              );
            return explanation;
          },
        );
      } catch (err) {
        return toToolError(err);
      }
    },
    {
      name: 'explain_step',
      description:
        'Explain in plain language what a step will do and the inputs it will run with, plus its current status. ' +
        'Use to walk the user through a step before they run it.',
      schema: stepRefSchema,
    },
  );
}
