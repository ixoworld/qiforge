import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type {
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import type { BlueprintSection } from './blueprint-types.js';
import type { BlueprintStore } from './blueprint-store.js';
import type { CapsuleContentClient } from './capsule-content-client.js';
import { DESIGN_POD_ROLES, type DesignPodRole } from './design-pod-roles.js';
import { deriveStage } from './stage.js';

const isGateRole = (role: DesignPodRole): boolean =>
  role.stage === 'evaluate' || role.stage === 'gate';

function sectionInstruction(role: DesignPodRole): string {
  const verdict = isGateRole(role)
    ? ' Include a pass|fail verdict (and blockers when failing).'
    : '';
  return `Use read_blueprint for the sections recorded so far, then call submit_section exactly once with your section content.${verdict}`;
}

/** The role's registry instructions, framed for the pipeline. */
function composePrompt(role: DesignPodRole, skillMarkdown: string): string {
  return `${skillMarkdown}\n\n---\nYou are the \`${role.id}\` specialist in the POD design pipeline (stage: ${role.stage}). ${sectionInstruction(role)}`;
}

/** Built-in prompt used when the registry instructions can't be fetched. */
function fallbackPrompt(role: DesignPodRole): string {
  return `You are the \`${role.id}\` specialist in the POD design pipeline (stage: ${role.stage}).\n${role.description}\n\n${sectionInstruction(role)}\n\n(The registry-published instructions for this role were unavailable; operating from the built-in summary.)`;
}

const submitSchema = z.object({
  content: z
    .unknown()
    .describe('Your section content to record into the POD blueprint.'),
  verdict: z
    .enum(['pass', 'fail'])
    .optional()
    .describe('For gate roles, your gate verdict.'),
  blockers: z
    .array(z.string())
    .optional()
    .describe('Blocking issues to surface when your verdict is fail.'),
});

/** The narrow tool set each specialist gets: read prior context, submit once. */
function roleTools(role: DesignPodRole, store: BlueprintStore): PluginTool[] {
  const readBlueprint = tool(
    async (_args, ctx) => {
      const bp = await store.get(ctx.session.id);
      if (!bp) {
        return { brief: undefined, sections: {} };
      }
      return { brief: bp.brief, sections: bp.sections };
    },
    {
      name: 'read_blueprint',
      description:
        'Read the POD brief and the sections recorded so far, for context.',
      schema: z.object({}),
    },
  );

  const submitSection = tool(
    async (args, ctx) => {
      const input = submitSchema.parse(args);
      const section: BlueprintSection = {
        role: role.id,
        stage: role.stage,
        content: input.content,
        recordedAt: new Date().toISOString(),
        ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
        ...(input.blockers !== undefined ? { blockers: input.blockers } : {}),
      };
      await store.putSection(ctx.session.id, section);
      return { submitted: role.id, stage: role.stage };
    },
    {
      name: 'submit_section',
      description: `Record your (${role.id}) section into the POD blueprint. Call exactly once.`,
      schema: submitSchema,
    },
  );

  return [readBlueprint, submitSection];
}

async function resolvePrompt(
  role: DesignPodRole,
  rt: RuntimeContext,
  capsules: CapsuleContentClient,
): Promise<string> {
  try {
    const markdown = await capsules.getSkillMarkdown(role.capsule, rt);
    return composePrompt(role, markdown);
  } catch (error) {
    rt.logger.warn(
      `pod-creator: registry instructions for "${role.capsule}" unavailable (${String(
        error,
      )}); using the built-in fallback prompt.`,
    );
    return fallbackPrompt(role);
  }
}

async function buildSubAgent(
  role: DesignPodRole,
  rt: RuntimeContext,
  store: BlueprintStore,
  capsules: CapsuleContentClient,
): Promise<PluginSubAgent> {
  return {
    name: `call_${role.id}`,
    description: role.description,
    systemPrompt: await resolvePrompt(role, rt, capsules),
    tools: roleTools(role, store),
    model: 'subagent',
    forwardTools: true,
  };
}

/**
 * Build the specialist sub-agents for the current request, gated to the
 * blueprint's current stage. Returns only that stage's specialist(s) — never
 * all twelve — so the conductor's tool surface stays small and the pipeline
 * order is enforced. Each sub-agent's system prompt is the role's registry
 * `SKILL.md`, fetched via the capsule client, with a built-in fallback when the
 * registry is unavailable.
 */
export async function buildStageSubAgents(
  rt: RuntimeContext,
  store: BlueprintStore,
  capsules: CapsuleContentClient,
): Promise<PluginSubAgent[]> {
  const bp = await store.get(rt.session.id);
  const stage = bp ? deriveStage(bp) : 'qualify';
  const roles = DESIGN_POD_ROLES.filter((role) => role.stage === stage);
  return Promise.all(
    roles.map((role) => buildSubAgent(role, rt, store, capsules)),
  );
}
