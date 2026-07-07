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
import {
  DESIGN_POD_ROLES,
  type DesignPodRole,
  type DesignPodStage,
} from './design-pod-roles.js';
import { deriveStage, summarizeSection } from './stage.js';

const isGateRole = (role: DesignPodRole): boolean =>
  role.stage === 'evaluate' || role.stage === 'gate';

/** What each lifecycle stage is accountable for, for the fallback prompts. */
const STAGE_DUTIES: Record<DesignPodStage, string> = {
  qualify:
    'Score the incoming service intent for viability and fit, and give a clear go / no-go rationale the later stages can rely on.',
  architect:
    'Design the POD structure for your discipline — service roles, workspaces and services, claim schemas and the UDID model, or the UCAN rights model — precisely enough for the build stage to implement without guessing.',
  build:
    'Produce the executable artifacts for your discipline — Flow pages for the workflow and UX, or the operating playbooks and rule cards — grounded in the architect sections.',
  evaluate:
    'Judge the recorded design from your lens (automation feasibility, governance and risk, or the outcome contract). Be adversarial: name what breaks, and fail the gate when the blueprint does not hold up.',
  package:
    'Package the POD for the market — the commercial offer and marketplace listing draft, or a runnable demo — from the completed design sections.',
  gate: 'Run final QA across every prior section and issue the launch-readiness verdict. Pass only a blueprint you would stand behind going on-chain.',
};

function sectionInstruction(role: DesignPodRole): string {
  const verdict = isGateRole(role)
    ? ' Include a pass|fail verdict (and blockers when failing).'
    : '';
  return `Use read_blueprint for the sections recorded so far (pass roles=[...] when you need a section's full content), then call submit_section exactly once with your section content.${verdict}`;
}

/** The role's registry instructions, framed for the pipeline. */
function composePrompt(role: DesignPodRole, skillMarkdown: string): string {
  return `${skillMarkdown}\n\n---\nYou are the \`${role.id}\` specialist in the POD design pipeline (stage: ${role.stage}). ${sectionInstruction(role)}`;
}

/** Built-in prompt used when the registry instructions can't be fetched. */
function fallbackPrompt(role: DesignPodRole): string {
  return [
    `You are the \`${role.id}\` specialist in the POD design pipeline (stage: ${role.stage}).`,
    role.description,
    '',
    STAGE_DUTIES[role.stage],
    'Ground everything in the POD brief and the sections recorded before yours; produce concrete, structured content — not commentary.',
    '',
    sectionInstruction(role),
    '',
    '(The registry-published instructions for this role were unavailable; operating from the built-in summary.)',
  ].join('\n');
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

const readSchema = z.object({
  roles: z
    .array(z.string())
    .optional()
    .describe(
      'Role ids whose full section content to include. Omit for the compact per-section summary.',
    ),
});

/** The narrow tool set each specialist gets: read prior context, submit once. */
function roleTools(role: DesignPodRole, store: BlueprintStore): PluginTool[] {
  const readBlueprint = tool(
    async (args, ctx) => {
      const { roles } = readSchema.parse(args);
      const bp = await store.get(ctx.session.id);
      if (!bp) {
        return { brief: undefined, sections: [] };
      }
      const sections = Object.values(bp.sections);
      return {
        brief: bp.brief,
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
      name: 'read_blueprint',
      description:
        'Read the POD brief and a compact summary of the sections recorded so far. Pass roles=[...] to include the full content of specific sections.',
      schema: readSchema,
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
    name: role.id,
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
