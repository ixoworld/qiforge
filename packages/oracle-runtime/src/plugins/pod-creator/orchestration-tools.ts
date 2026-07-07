import { z } from 'zod';
import { computeSubAgentToolName } from '../../graph/subagent-as-tool.js';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import type { BlueprintStore } from './blueprint-store.js';
import {
  SPECIALISTS_FOR_STAGE,
  assembleServicePodBlueprint,
  computeReadiness,
  summarizeSection,
} from './stage.js';

const startSchema = z.object({
  brief: z
    .string()
    .min(1)
    .describe(
      'A concise statement of what the POD should do — the service, who it serves, and the outcome it produces.',
    ),
  restart: z
    .boolean()
    .optional()
    .describe(
      'Discard any existing design in this conversation and start fresh with the new brief.',
    ),
});

const getBlueprintSchema = z.object({
  roles: z
    .array(z.string())
    .optional()
    .describe(
      'Role ids whose full section content to include. Omit for the compact per-section summary.',
    ),
});

const emptySchema = z.object({});

const threadId = (ctx: RuntimeContext): string => ctx.session.id;

/**
 * The conductor's orchestration tools. They own the blueprint lifecycle —
 * starting a session, scoring readiness, and assembling the final
 * `service_pod_blueprint`. Sections are written ONLY by the specialist
 * sub-agents' `submit_section`; the conductor gets no write path, so it cannot
 * self-certify gate verdicts and skip the specialists. Stage and readiness are
 * always derived from the recorded sections, never stored.
 */
export function createOrchestrationTools(store: BlueprintStore): PluginTool[] {
  const startPodDesign = tool(
    async (args, ctx) => {
      const { brief, restart } = startSchema.parse(args);
      if (restart) {
        await store.reset(threadId(ctx));
      }
      const bp = await store.init(threadId(ctx), brief);
      const readiness = computeReadiness(bp);
      return {
        started: true,
        threadId: bp.threadId,
        brief: bp.brief,
        stage: readiness.stage,
        nextSpecialists: SPECIALISTS_FOR_STAGE[readiness.stage].map((id) =>
          computeSubAgentToolName(id),
        ),
      };
    },
    {
      name: 'start_pod_design',
      description:
        'Open a POD design session and initialise the blueprint. Call this first when the user wants to create a POD; pass restart=true to discard the existing design and begin again.',
      schema: startSchema,
    },
  );

  const getBlueprint = tool(
    async (args, ctx) => {
      const { roles } = getBlueprintSchema.parse(args);
      const bp = await store.get(threadId(ctx));
      if (!bp) {
        return {
          started: false,
          message:
            'No POD design session started yet. Call start_pod_design first.',
        };
      }
      const sections = Object.values(bp.sections);
      return {
        started: true,
        ...(bp.brief !== undefined ? { brief: bp.brief } : {}),
        readiness: computeReadiness(bp),
        sections: sections.map(summarizeSection),
        ...(roles !== undefined
          ? {
              content: Object.fromEntries(
                sections
                  .filter((section) => roles.includes(section.role))
                  .map((section) => [section.role, section.content]),
              ),
            }
          : {}),
      };
    },
    {
      name: 'get_blueprint',
      description:
        'Read the POD blueprint: readiness plus a compact per-section summary. Pass roles=[...] to include the full content of specific sections.',
      schema: getBlueprintSchema,
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
    getBlueprint,
    computeReadinessTool,
    assembleBlueprint,
  ];
}
