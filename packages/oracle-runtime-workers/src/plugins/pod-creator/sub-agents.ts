import { ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { createMiddleware, type AgentMiddleware } from 'langchain';
import { z } from 'zod';
import { turnStart } from '../../core/middlewares/turn-boundary';
import { computeSubAgentToolName } from '../../core/subagent-as-tool';
import { isToolNotRun, toolNotRunMessage } from '../../core/tool-not-run';
import { tool } from '../../plugin-api/tool-helper';
import type {
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import type { BlueprintSection, PodBlueprint } from './blueprint-types';
import type { BlueprintStore, BlueprintStoreFor } from './blueprint-store';
import type { CapsuleContentClient } from './capsule-content-client';
import {
  DESIGN_POD_ROLES,
  type DesignPodRole,
  type DesignPodStage,
} from './design-pod-roles';
import { deriveStage, isStageAfter, nextStep, sectionsView } from './stage';

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

/** Built-in prompt used when no registry instructions are loaded for the role. */
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
    '(Operating from the built-in summary of this role; its registry-published instructions are not loaded.)',
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
function roleTools(
  role: DesignPodRole,
  storeFor: BlueprintStoreFor,
): PluginTool[] {
  const readBlueprint = tool(
    async (args, ctx) => {
      const { roles } = readSchema.parse(args);
      const bp = await storeFor(ctx).get(ctx.session.id);
      if (!bp) {
        return { brief: undefined, sections: [] };
      }
      return { brief: bp.brief, ...sectionsView(bp, roles) };
    },
    {
      name: 'read_blueprint',
      description:
        'Read the POD brief and a compact summary of the sections recorded so far. Pass roles=[...] to include the full content of specific sections.',
      schema: readSchema,
      effect: 'read',
    },
  );

  const submitSection = tool(
    async (args, ctx) => {
      const input = submitSchema.parse(args);
      const store = storeFor(ctx);
      const current = await store.get(ctx.session.id);
      // A specialist of a stage already passed has nothing left to record:
      // overwriting its section would only re-open the design behind the
      // pipeline. A failed gate verdict re-opens its own stage, so a re-run
      // of that role is never refused here.
      if (
        current?.sections[role.id] !== undefined &&
        isStageAfter(deriveStage(current), role.stage)
      ) {
        return {
          submitted: false,
          message: `The ${role.stage} stage is already complete; this specialist has nothing to do. Stop and tell the user to continue.`,
        };
      }
      const section: BlueprintSection = {
        role: role.id,
        stage: role.stage,
        content: input.content,
        recordedAt: new Date().toISOString(),
        ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
        ...(input.blockers !== undefined ? { blockers: input.blockers } : {}),
      };
      const bp = await store.putSection(ctx.session.id, section);
      return {
        submitted: role.id,
        stage: role.stage,
        message:
          input.verdict === 'fail'
            ? 'Section recorded with a fail verdict: this specialist is done. Tell the user its blockers and stop; it can run again after the user changes the design in their next message.'
            : `Section recorded: this specialist is done, do not call it again for this stage. ${nextStep(bp)}`,
      };
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
  const markdown = await capsules.getSkillMarkdown(role.capsule, rt);
  return markdown === undefined
    ? fallbackPrompt(role)
    : composePrompt(role, markdown);
}

async function buildSubAgent(
  role: DesignPodRole,
  rt: RuntimeContext,
  storeFor: BlueprintStoreFor,
  capsules: CapsuleContentClient,
): Promise<PluginSubAgent> {
  return {
    name: role.id,
    description: role.description,
    systemPrompt: await resolvePrompt(role, rt, capsules),
    tools: roleTools(role, storeFor),
    model: 'subagent',
    // Only the write is forwarded (shown in the chat as the specialist's
    // recorded section). Its `read_blueprint` reads stay inside the
    // specialist: forwarded, each full-section read (often over 60 KB) landed
    // in the main thread, was capped and saved, and the main model paged
    // through it with read_result.
    forwardTools: ['submit_section'],
  };
}

/**
 * Build the specialist sub-agents for the current request, gated to the
 * blueprint's current stage. Returns only that stage's specialist(s) — never
 * all twelve — so the conductor's tool surface stays small and the pipeline
 * order is enforced, and none at all before a blueprint exists. Each
 * sub-agent's system prompt is the role's registry `SKILL.md`, fetched via the
 * capsule client, with a built-in fallback when there is no fetcher or the
 * registry is unavailable.
 *
 * The specialists' tools resolve the store from THEIR call's context (the
 * sub-agent runs later in the turn), never from the `rt` that built them.
 */
export async function buildStageSubAgents(
  rt: RuntimeContext,
  storeFor: BlueprintStoreFor,
  capsules: CapsuleContentClient,
): Promise<PluginSubAgent[]> {
  const store: BlueprintStore = storeFor(rt);
  const bp = await store.get(rt.session.id);
  // No design in this thread: nothing to offer. This hook runs on every turn
  // of every user whether or not the capability is loaded, so it must stay a
  // single local read until `start_pod_design` has opened a blueprint (the
  // qualify specialist appears on the following turn).
  if (!bp) return [];
  const stage = deriveStage(bp);
  const roles = DESIGN_POD_ROLES.filter((role) => role.stage === stage);
  return Promise.all(
    roles.map((role) => buildSubAgent(role, rt, storeFor, capsules)),
  );
}

/**
 * Build every specialist sub-agent for a thread with a design, and none for a
 * thread without one (a single local read, like {@link buildStageSubAgents}).
 *
 * The plugin binds all of them and lets {@link createSpecialistStageMiddleware}
 * show the model only the current stage's on each model call: a stage passed
 * during a turn hands over to the next stage's specialists on the very next
 * model call. Bound only per stage at turn start, they were missing for the
 * rest of that turn; a model that called them got "no such tool" and went on
 * telling the user they did not exist after they were offered.
 */
export async function buildSpecialistSubAgents(
  rt: RuntimeContext,
  storeFor: BlueprintStoreFor,
  capsules: CapsuleContentClient,
): Promise<PluginSubAgent[]> {
  const bp = await storeFor(rt).get(rt.session.id);
  if (!bp) return [];
  return Promise.all(
    DESIGN_POD_ROLES.map((role) => buildSubAgent(role, rt, storeFor, capsules)),
  );
}

/** The specialist role each `call_<role>_agent` tool runs. */
const ROLE_BY_TOOL_NAME: ReadonlyMap<string, DesignPodRole> = new Map(
  DESIGN_POD_ROLES.map((role) => [computeSubAgentToolName(role.id), role]),
);

/**
 * Shows the conductor only the current stage's specialists and refuses a
 * call to another stage's specialist with the next step instead of running
 * it. When the blueprint cannot be read, no specialist is shown or run (a
 * specialist cannot record without it either).
 *
 * Two rules hold within a turn, because the next stage's specialists are
 * reachable in the same turn:
 * - A gate specialist (evaluate or gate stage) that recorded a fail in this
 *   turn is not shown or run again in it: nothing in the design changed, so
 *   a re-run only repeats the verdict. It runs again after the user's next
 *   message.
 * - `start_pod_design` with `restart` is refused once a specialist ran in
 *   this turn: a restart discards that work and is for a user who asks for
 *   one, not a way round a failed check. Whether one ran is read from the
 *   turn's own messages, so it holds across a run recovered mid-turn.
 * Other tools pass through untouched. Refusals are "not run" results, so the
 * repetition guard lets the same call through once the step is right.
 *
 * One instance serves one attempt of one turn. The blueprint is read once and
 * again only after a call that can change it (a specialist or
 * `start_pod_design`); a recovered attempt starts with a fresh read and an
 * empty fail list (a failed gate may then run once more).
 */
export function createSpecialistStageMiddleware(
  rt: RuntimeContext,
  storeFor: BlueprintStoreFor,
): AgentMiddleware {
  /** The last read of the thread's design; `undefined` until read or after a change. */
  let cached: PodBlueprint | null | undefined;
  /** The thread's design, or null when it has none or it cannot be read. */
  const readBlueprint = async (): Promise<PodBlueprint | null> => {
    if (cached !== undefined) return cached;
    try {
      cached = (await storeFor(rt).get(rt.session.id)) ?? null;
    } catch (error) {
      rt.logger.warn(
        `[pod-creator] blueprint unreadable; no specialist is offered this step: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Not cached: the next step tries again.
      return null;
    }
    return cached;
  };
  /** Gate roles that recorded a fail in this turn. */
  const failedThisTurn = new Set<string>();

  const refusal = (
    request: { toolCall: { id?: string; name: string } },
    content: string,
  ): ToolMessage =>
    toolNotRunMessage({
      toolCallId: request.toolCall.id ?? '',
      name: request.toolCall.name,
      content,
    });

  /** Whether a specialist answered in this turn (a refusal does not count). */
  const specialistRanThisTurn = (messages: readonly BaseMessage[]): boolean =>
    messages
      .slice(turnStart(messages))
      .some(
        (message) =>
          ToolMessage.isInstance(message) &&
          typeof message.name === 'string' &&
          ROLE_BY_TOOL_NAME.has(message.name) &&
          !isToolNotRun(message),
      );

  return createMiddleware({
    name: 'PodCreatorSpecialistStageMiddleware',
    wrapModelCall: async (request, handler) => {
      const isSpecialist = (name: unknown): boolean =>
        typeof name === 'string' && ROLE_BY_TOOL_NAME.has(name);
      if (!request.tools.some((t) => isSpecialist(t.name)))
        return handler(request);
      const bp = await readBlueprint();
      const stage = bp ? deriveStage(bp) : null;
      const tools = request.tools.filter((t) => {
        if (!isSpecialist(t.name)) return true;
        const role = ROLE_BY_TOOL_NAME.get(String(t.name));
        return role?.stage === stage && !failedThisTurn.has(role.id);
      });
      return handler({ ...request, tools });
    },
    wrapToolCall: async (request, handler) => {
      const name = request.toolCall.name;
      if (name === 'start_pod_design') {
        const args: unknown = request.toolCall.args;
        const restart =
          typeof args === 'object' &&
          args !== null &&
          'restart' in args &&
          args.restart === true;
        if (restart && specialistRanThisTurn(request.state.messages))
          return refusal(
            request,
            'Not restarted: specialists already ran in this turn, and a restart discards their work. Restart only when the user asks for it in their message. Tell the user where the design stands and what blocks it.',
          );
        cached = undefined;
        try {
          return await handler(request);
        } finally {
          cached = undefined;
        }
      }
      const role = ROLE_BY_TOOL_NAME.get(name);
      if (!role) return handler(request);
      const bp = await readBlueprint();
      if (!bp)
        return refusal(
          request,
          `${name} was not run: this conversation has no readable POD design. Call start_pod_design first.`,
        );
      if (deriveStage(bp) !== role.stage)
        return refusal(
          request,
          `${name} was not run: it belongs to the ${role.stage} stage, and the design is at the ${deriveStage(bp)} stage. ${nextStep(bp)}`,
        );
      if (failedThisTurn.has(role.id))
        return refusal(
          request,
          `${name} was not run again: it failed its check in this turn and nothing in the design has changed since, so it would only repeat the verdict. Tell the user its blockers and stop; it runs again after the user's next message.`,
        );
      const recordedBefore = bp.sections[role.id]?.recordedAt;
      try {
        return await handler(request);
      } finally {
        cached = undefined;
        if (role.stage === 'evaluate' || role.stage === 'gate') {
          const section = (await readBlueprint())?.sections[role.id];
          // Only a fail this call recorded: an older one says nothing new.
          if (
            section?.verdict === 'fail' &&
            section.recordedAt !== recordedBefore
          )
            failedThisTurn.add(role.id);
        }
      }
    },
  });
}
