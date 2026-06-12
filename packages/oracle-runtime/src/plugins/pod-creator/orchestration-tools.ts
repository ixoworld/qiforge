import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import type { BlueprintSection } from './blueprint-types.js';
import type { BlueprintStore } from './blueprint-store.js';
import { DESIGN_POD_ROLES, type DesignPodStage } from './design-pod-roles.js';
import {
  SPECIALISTS_FOR_STAGE,
  assembleServicePodBlueprint,
  computeReadiness,
} from './stage.js';

const ROLE_STAGE: Map<string, DesignPodStage> = new Map(
  DESIGN_POD_ROLES.map((role): [string, DesignPodStage] => [
    role.id,
    role.stage,
  ]),
);

const ROLE_ID_LIST = DESIGN_POD_ROLES.map((role) => role.id).join(', ');

const startSchema = z.object({
  brief: z
    .string()
    .min(1)
    .describe(
      'A concise statement of what the POD should do — the service, who it serves, and the outcome it produces.',
    ),
});

const recordSchema = z.object({
  role: z
    .string()
    .refine((value) => ROLE_STAGE.has(value), {
      message: `unknown design-pod role id; expected one of: ${ROLE_ID_LIST}`,
    })
    .describe('The specialist role id that produced this section.'),
  content: z
    .unknown()
    .describe('The structured section content the specialist produced.'),
  verdict: z
    .enum(['pass', 'fail'])
    .optional()
    .describe(
      'For gate-bearing roles (the evaluate oracles and qa_launch_readiness_oracle), the gate verdict.',
    ),
  blockers: z
    .array(z.string())
    .optional()
    .describe('Blocking issues to surface when the verdict is fail.'),
});

const emptySchema = z.object({});

const threadId = (ctx: RuntimeContext): string => ctx.session.id;

/**
 * The conductor's orchestration tools. They own the blueprint lifecycle —
 * starting a session, recording the specialists' sections, scoring readiness,
 * and assembling the final `service_pod_blueprint`. Stage and readiness are
 * always derived from the recorded sections, never stored.
 */
export function createOrchestrationTools(store: BlueprintStore): PluginTool[] {
  const startPodDesign = tool(
    async (args, ctx) => {
      const { brief } = startSchema.parse(args);
      const bp = await store.init(threadId(ctx), brief);
      const readiness = computeReadiness(bp);
      return {
        started: true,
        threadId: bp.threadId,
        stage: readiness.stage,
        nextSpecialists: SPECIALISTS_FOR_STAGE[readiness.stage],
      };
    },
    {
      name: 'start_pod_design',
      description:
        'Open a POD design session and initialise the blueprint. Call this first when the user wants to create a POD.',
      schema: startSchema,
    },
  );

  const recordBlueprintSection = tool(
    async (args, ctx) => {
      const input = recordSchema.parse(args);
      const stage = ROLE_STAGE.get(input.role);
      if (stage === undefined) {
        throw new Error(`Unknown design-pod role: ${input.role}`);
      }
      const section: BlueprintSection = {
        role: input.role,
        stage,
        content: input.content,
        recordedAt: new Date().toISOString(),
        ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
        ...(input.blockers !== undefined ? { blockers: input.blockers } : {}),
      };
      const bp = await store.putSection(threadId(ctx), section);
      const readiness = computeReadiness(bp);
      return {
        recorded: input.role,
        stage: readiness.stage,
        complete: readiness.complete,
        score: readiness.score,
        blockers: readiness.blockers,
      };
    },
    {
      name: 'record_blueprint_section',
      description:
        "Persist a specialist sub-agent's returned section into the blueprint. Pass the role id, the section content, and — for evaluate/gate roles — a pass|fail verdict.",
      schema: recordSchema,
    },
  );

  const getBlueprint = tool(
    async (_args, ctx) => {
      const bp = await store.get(threadId(ctx));
      if (!bp) {
        return {
          started: false,
          message:
            'No POD design session started yet. Call start_pod_design first.',
        };
      }
      return { started: true, blueprint: bp, readiness: computeReadiness(bp) };
    },
    {
      name: 'get_blueprint',
      description: 'Read the current POD blueprint and its readiness.',
      schema: emptySchema,
    },
  );

  const computeReadinessTool = tool(
    async (_args, ctx) => {
      const bp = await store.get(threadId(ctx));
      if (!bp) {
        return {
          started: false,
          message: 'No POD design session started yet.',
        };
      }
      return computeReadiness(bp);
    },
    {
      name: 'compute_readiness',
      description:
        "Score the blueprint's launch readiness and list the blockers that remain.",
      schema: emptySchema,
    },
  );

  const assembleBlueprint = tool(
    async (_args, ctx) => {
      const bp = await store.get(threadId(ctx));
      if (!bp) {
        throw new Error(
          'No POD design session started yet. Call start_pod_design first.',
        );
      }
      const readiness = computeReadiness(bp);
      if (!readiness.complete) {
        return {
          assembled: false,
          stage: readiness.stage,
          blockers: readiness.blockers,
          message:
            'Launch-readiness gate not passed. Resolve the blockers before assembling.',
        };
      }
      return {
        assembled: true,
        blueprint: assembleServicePodBlueprint(bp),
      };
    },
    {
      name: 'assemble_blueprint',
      description:
        'Assemble the final service_pod_blueprint once the launch-readiness gate passes.',
      schema: emptySchema,
    },
  );

  return [
    startPodDesign,
    recordBlueprintSection,
    getBlueprint,
    computeReadinessTool,
    assembleBlueprint,
  ];
}
