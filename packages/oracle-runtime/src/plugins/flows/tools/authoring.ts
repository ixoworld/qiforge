/**
 * Authoring tools (spec §3.3). `validate_flow` is a pure compile-without-write.
 * `create_template`/`add_step` go through the editor's compiler (`setupFlowFromBaseUcan`,
 * which manages its own doc and syncs to the room). The remaining mutators are
 * thin wrappers over the tested per-block edit functions (edit.ts).
 *
 * Conditions are applied as a post-pass via the direct `props.conditions` write
 * (setStepConditions) — never through the compiler's `cap.condition`, which
 * never evaluates (translator.ts).
 */
import { callBrowserTool } from '@ixo/common';
import {
  compileBaseUcanFlow,
  getActionByCan,
  setupFlowFromBaseUcan,
} from '@ixo/editor/core';
import type { MatrixClient } from 'matrix-js-sdk';
import { randomUUID } from 'node:crypto';
import type { Doc as YDoc } from 'yjs';
import { z } from 'zod';
import { tool } from '../../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../../plugin-api/types.js';
import { getActionDef, isEventCapable } from '../actions.js';
import {
  removeStep,
  reorderStep,
  setStepAssignment,
  setStepConditions,
  setStepConfirmation,
  setStepEventTrigger,
  setStepExecution,
  setStepInputs,
  setStepPhase,
  setStepSchedule,
  setStepSkills,
  setStepTrigger,
  updateFlowMeta,
} from '../edit.js';
import { FlowError, toToolError } from '../errors.js';
import {
  requireRoomMembership,
  resolveFlowRef,
  resolveFlowsMatrixClient,
  withFlowDoc,
} from '../flow-doc.js';
import { readStep } from '../read.js';
import { flowSpecToBaseUcan } from '../translator.js';
import {
  flowSpecSchema,
  flowStepSchema,
  type Condition,
  type FlowSpecInput,
  type FlowStep,
} from './../types.js';

const base = {
  flowRef: z
    .string()
    .optional()
    .describe('Which flow. Omit to use the flow that is currently open.'),
};
const ok = { ok: true } as const;

/** All conditions declared on a step (runWhen folded with conditions[]). */
function conditionsOf(step: FlowStep): Condition[] {
  return [...(step.runWhen ? [step.runWhen] : []), ...(step.conditions ?? [])];
}

/** onEvent must point at an event-capable upstream action (spec §2.3). Returns error strings. */
function eventCapabilityErrors(flow: FlowSpecInput): string[] {
  const errors: string[] = [];
  for (const step of flow.steps) {
    if (!step.onEvent) continue;
    const source = flow.steps.find((s) => s.id === step.onEvent?.fromStep);
    if (!source) {
      errors.push(
        `Step "${step.id}" triggers on an unknown step "${step.onEvent.fromStep}".`,
      );
      continue;
    }
    const def = getActionDef(source.action);
    if (def && !isEventCapable(def)) {
      errors.push(
        `Step "${step.id}" auto-triggers on "${source.id}", but its action "${source.action}" cannot emit events. ` +
          'Use ordering (after) + an input reference instead.',
      );
    }
  }
  return errors;
}

const validateSchema = z.object({ flow: flowSpecSchema });

function buildValidateFlowTool(): PluginTool {
  return tool(
    async (args) => {
      try {
        const { flow } = validateSchema.parse(args);
        const errors = eventCapabilityErrors(flow);
        if (errors.length === 0) {
          // Surfaces the compiler's exact messages (duplicate id, unknown action, trigger cycle, ...).
          try {
            compileBaseUcanFlow(
              flowSpecToBaseUcan(flow, { flowId: flow.ref ?? 'validate' }),
              { getActionByCan },
            );
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
          }
        }
        return { ok: errors.length === 0, errors, warnings: [] };
      } catch (err) {
        return toToolError(err);
      }
    },
    {
      name: 'validate_flow',
      description:
        'Check whether a flow is valid without saving it. Returns the exact problems (unknown action, duplicate step id, ' +
        'a non-event-capable auto-trigger, a trigger cycle, etc.) so they can be fixed before creating the flow.',
      schema: validateSchema,
    },
  );
}

/** Apply each step's conditions to an already-authored flow room (post-pass). */
async function applyConditions(
  ctx: RuntimeContext,
  flowRef: string,
  matrixClient: MatrixClient | undefined,
  steps: FlowStep[],
): Promise<void> {
  const withConditions = steps.filter((s) => conditionsOf(s).length > 0);
  if (withConditions.length === 0) return;
  await withFlowDoc(ctx, flowRef, matrixClient, async (doc) => {
    for (const step of withConditions)
      setStepConditions(doc, step.id, conditionsOf(step));
  });
}

/**
 * Apply each step's assignee to an already-authored flow room (post-pass).
 * The compiler only writes the authorization whitelist; the assignee the portal
 * shows + nudges lives in `props.assignment`, written by setStepAssignment.
 */
async function applyAssignments(
  ctx: RuntimeContext,
  flowRef: string,
  matrixClient: MatrixClient | undefined,
  steps: FlowStep[],
): Promise<void> {
  const withAssignee = steps.filter((s) => s.assignTo);
  if (withAssignee.length === 0) return;
  await withFlowDoc(ctx, flowRef, matrixClient, async (doc) => {
    for (const step of withAssignee)
      setStepAssignment(doc, step.id, step.assignTo);
  });
}

/** Apply Flow Agent execution boundaries and governed skill matching metadata. */
async function applyExecutionPolicy(
  ctx: RuntimeContext,
  flowRef: string,
  matrixClient: MatrixClient | undefined,
  steps: FlowStep[],
): Promise<void> {
  const configured = steps.filter(
    (step) => step.execution !== undefined || step.skills !== undefined,
  );
  if (configured.length === 0) return;
  await withFlowDoc(ctx, flowRef, matrixClient, async (doc) => {
    for (const step of configured) {
      if (step.execution) setStepExecution(doc, step.id, step.execution);
      if (step.skills) setStepSkills(doc, step.id, step.skills);
    }
  });
}

/** The room id a `create_template_room` browser tool returned. */
function extractRoomId(result: unknown): string | undefined {
  if (result && typeof result === 'object') {
    const roomId = (result as { roomId?: unknown }).roomId;
    if (typeof roomId === 'string' && roomId.length > 0) return roomId;
  }
  return undefined;
}

/**
 * Allocate the room to author the template into. Primary path: ask the user's
 * front-end to create a dedicated `#template-*` room and invite the oracle,
 * over the WS browser-tool channel. Fallback (non-portal client): author into
 * the room the portal already opened (`state.editorRoomId`).
 *
 * The runtime never handles a space id. The FRONT-END owns space resolution
 * entirely: `personalSpace` false (default) → the domain the user is viewing;
 * true → their personal flows space. `oracleUserId` is the oracle's own
 * identity, taken from its `MATRIX_ORACLE_ADMIN_USER_ID` config (trusted, not
 * the LLM) so the FE can grant it power 50 at room creation.
 */
async function allocateTemplateRoom(
  ctx: RuntimeContext,
  flow: FlowSpecInput,
  client: MatrixClient,
  personalSpace: boolean,
): Promise<string> {
  const cfg = ctx.config as Record<string, unknown>;
  const oracleUserId = cfg.MATRIX_ORACLE_ADMIN_USER_ID;
  if (ctx.session.id) {
    try {
      const result = await callBrowserTool({
        sessionId: ctx.session.id,
        toolCallId: `tc-${ctx.session.requestId ?? 'template'}-create-room`,
        toolName: 'create_template_room',
        args: {
          title: flow.title,
          // The FE owns space resolution: `personalSpace` false → the domain the
          // user is currently viewing; true → their personal flows space. We send
          // no space id at all.
          personalSpace,
          oracleUserId:
            typeof oracleUserId === 'string' ? oracleUserId : undefined,
        },
      });
      const roomId = extractRoomId(result);
      if (roomId) {
        // The FE invited us — join so we can author into the room.
        try {
          await client.joinRoom(roomId);
        } catch {
          /* already joined, or the join races sync — setup retries the connection */
        }
        return roomId;
      }
    } catch {
      // FE not reachable (e.g. a Matrix/Slack client, not the portal) — fall back.
    }
  }
  return resolveFlowRef(ctx, flow.ref);
}

function buildCreateTemplateTool(
  matrixClient: MatrixClient | undefined,
): PluginTool {
  const createTemplateSchema = z.object({
    flow: flowSpecSchema,

    personalSpace: z
      .boolean()
      .optional()
      .describe(
        'Where to put the template. Default false = the domain the user is currently viewing. ' +
          'Set true only when the user explicitly asks for their personal/private flows space.',
      ),
  });
  return tool(
    async (args, ctx: RuntimeContext) => {
      try {
        const { flow, personalSpace } = createTemplateSchema.parse(args);
        const errors = eventCapabilityErrors(flow);
        if (errors.length > 0)
          return {
            ok: false,
            error: { code: 'validation_failed', message: errors.join(' ') },
          };

        // Room allocation: ask the FE to create a dedicated #template-* room
        // over the WS browser-tool channel (create_template_room), falling back
        // to the room the portal already opened. The user owns the room either way.
        const client = await resolveFlowsMatrixClient(ctx, matrixClient);
        const roomId = await allocateTemplateRoom(
          ctx,
          flow,
          client,
          personalSpace ?? false,
        );
        await requireRoomMembership(ctx, roomId);

        const flowId = `flow-${randomUUID().slice(0, 8)}`;
        const plan = flowSpecToBaseUcan(flow, {
          flowId,
          ownerDid: ctx.user.did,
        });
        await setupFlowFromBaseUcan({
          plan,
          roomId,
          matrixClient: client,
          creatorDid: ctx.user.did,
        });
        await applyConditions(ctx, roomId, matrixClient, flow.steps);
        await applyAssignments(ctx, roomId, matrixClient, flow.steps);
        await applyExecutionPolicy(ctx, roomId, matrixClient, flow.steps);

        return { ok: true, flowRef: roomId };
      } catch (err) {
        return toToolError(err);
      }
    },
    {
      name: 'create_template',
      description:
        'Create a BRAND-NEW flow template in its own new room — a reusable blueprint the user instantiates and runs in ' +
        'the portal. Do NOT use this to change a template that already exists or is currently open — use the editing tools ' +
        '(add_step, update_step, set_step_*, remove_step, reorder_step, connect_steps), which modify the open template in ' +
        'place. Validate first with validate_flow.',
      schema: createTemplateSchema,
    },
  );
}

const addStepSchema = z.object({
  ...base,
  step: flowStepSchema,
  position: z
    .union([
      z.number().int().nonnegative(),
      z.object({ after: z.string() }),
      z.object({ before: z.string() }),
    ])
    .optional()
    .describe(
      'Where to place the step: a 0-based index, {after: id}, or {before: id}. Omitted = append.',
    ),
});

function buildAddStepTool(matrixClient: MatrixClient | undefined): PluginTool {
  return tool(
    async (args, ctx: RuntimeContext) => {
      try {
        const { flowRef, step, position } = addStepSchema.parse(args);
        const roomId = resolveFlowRef(ctx, flowRef);
        await requireRoomMembership(ctx, roomId);
        const client = await resolveFlowsMatrixClient(ctx, matrixClient);

        // Read the existing flow id so the merge targets the same document.
        const flowId = await withFlowDoc(
          ctx,
          flowRef,
          matrixClient,
          async (doc) => {
            const value = doc.getMap('qi.flow.meta').get('flowId');
            return typeof value === 'string' && value.length > 0
              ? value
              : `flow-${randomUUID().slice(0, 8)}`;
          },
        );

        const plan = flowSpecToBaseUcan(
          { title: '', steps: [step] },
          { flowId, ownerDid: ctx.user.did },
        );
        await setupFlowFromBaseUcan({
          plan,
          roomId,
          matrixClient: client,
          creatorDid: ctx.user.did,
          strategy: 'merge',
        });
        await applyConditions(ctx, roomId, matrixClient, [step]);
        await applyAssignments(ctx, roomId, matrixClient, [step]);
        await applyExecutionPolicy(ctx, roomId, matrixClient, [step]);

        if (typeof position === 'number') {
          await withFlowDoc(ctx, flowRef, matrixClient, async (doc) =>
            reorderStep(doc, step.id, position),
          );
        } else if (position) {
          await withFlowDoc(ctx, flowRef, matrixClient, async (doc) => {
            const order = doc
              .getArray('qi.flow.order')
              .toArray()
              .filter((v): v is string => typeof v === 'string');
            const anchor =
              'after' in position ? position.after : position.before;
            const idx = order.indexOf(anchor);
            if (idx >= 0)
              reorderStep(doc, step.id, 'after' in position ? idx + 1 : idx);
          });
        }
        return ok;
      } catch (err) {
        return toToolError(err);
      }
    },
    {
      name: 'add_step',
      description:
        'Add one step to an existing flow without disturbing the others. Optionally place it at a position.',
      schema: addStepSchema,
    },
  );
}

const removeSchema = z.object({ ...base, stepId: z.string().min(1) });
const reorderSchema = z.object({
  ...base,
  stepId: z.string().min(1),
  toIndex: z.number().int().nonnegative(),
});
const metaSchema = z.object({
  ...base,
  title: z.string().optional(),
  goal: z.string().optional(),
});
const connectSchema = z.object({
  ...base,
  fromStep: z.string().min(1),
  field: z.string().min(1),
  toStep: z.string().min(1),
  input: z.string().min(1),
});
const stepPatchSchema = flowStepSchema.partial().extend({
  phase: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('Set the step phase, or use null to clear an existing phase.'),
});
const updateStepSchema = z.object({
  ...base,
  stepId: z.string().min(1),
  patch: stepPatchSchema,
});

/** Route an update_step patch to the focused per-block edits. */
export function applyStepPatch(
  doc: YDoc,
  stepId: string,
  patch: z.infer<typeof stepPatchSchema>,
): void {
  if (patch.inputs) setStepInputs(doc, stepId, patch.inputs);
  if (patch.runWhen !== undefined || patch.conditions !== undefined) {
    setStepConditions(doc, stepId, [
      ...(patch.runWhen ? [patch.runWhen] : []),
      ...(patch.conditions ?? []),
    ]);
  }
  if (patch.due !== undefined || patch.commitTo !== undefined)
    setStepSchedule(doc, stepId, patch.due, patch.commitTo);
  if (patch.assignTo !== undefined)
    setStepAssignment(doc, stepId, patch.assignTo);
  if (patch.requireConfirmation !== undefined)
    setStepConfirmation(doc, stepId, patch.requireConfirmation);
  if (patch.phase !== undefined)
    setStepPhase(doc, stepId, patch.phase ?? undefined);
  if (patch.execution !== undefined)
    setStepExecution(doc, stepId, patch.execution);
  if (patch.skills !== undefined) setStepSkills(doc, stepId, patch.skills);
  // Both write the same trigger props; onEvent is the more specific intent.
  if (patch.onEvent !== undefined)
    setStepEventTrigger(doc, stepId, patch.onEvent);
  else if (patch.trigger !== undefined)
    setStepTrigger(doc, stepId, patch.trigger);
}

export function buildAuthoringTools(
  matrixClient: MatrixClient | undefined,
): PluginTool[] {
  return [
    buildValidateFlowTool(),
    buildCreateTemplateTool(matrixClient),
    buildAddStepTool(matrixClient),
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const { flowRef, stepId } = removeSchema.parse(args);
          await withFlowDoc(ctx, flowRef, matrixClient, async (doc, roomId) =>
            removeStep(doc, roomId, stepId),
          );
          return ok;
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'remove_step',
        description:
          'Remove a step from a flow. Rejected if another step still references it (the referrers are named).',
        schema: removeSchema,
      },
    ),
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const { flowRef, stepId, toIndex } = reorderSchema.parse(args);
          await withFlowDoc(ctx, flowRef, matrixClient, async (doc) =>
            reorderStep(doc, stepId, toIndex),
          );
          return ok;
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'reorder_step',
        description: 'Move a step to a new 0-based position in the flow.',
        schema: reorderSchema,
      },
    ),
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const { flowRef, title, goal } = metaSchema.parse(args);
          await withFlowDoc(ctx, flowRef, matrixClient, async (doc) =>
            updateFlowMeta(doc, { title, goal }),
          );
          return ok;
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'update_flow_meta',
        description: "Update a flow's title and/or goal.",
        schema: metaSchema,
      },
    ),
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const { flowRef, fromStep, field, toStep, input } =
            connectSchema.parse(args);
          await withFlowDoc(ctx, flowRef, matrixClient, async (doc, roomId) => {
            const current = readStep(doc, roomId, toStep);
            if (!current)
              throw new FlowError(
                'step_not_found',
                `No step "${toStep}" in this flow.`,
              );
            setStepInputs(doc, toStep, {
              ...(current.inputs ?? {}),
              [input]: `{{${fromStep}.output.${field}}}`,
            });
          });
          return ok;
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'connect_steps',
        description:
          "Wire one step's output into another step's input (a data reference).",
        schema: connectSchema,
      },
    ),
    tool(
      async (args, ctx: RuntimeContext) => {
        try {
          const { flowRef, stepId, patch } = updateStepSchema.parse(args);
          await withFlowDoc(ctx, flowRef, matrixClient, async (doc) =>
            applyStepPatch(doc, stepId, patch),
          );
          return ok;
        } catch (err) {
          return toToolError(err);
        }
      },
      {
        name: 'update_step',
        description:
          "Update any subset of a step's settings in one call (phase, execution boundary, required skills, inputs, conditions, schedule, assignee, confirmation, " +
          'trigger, onEvent). onEvent takes precedence over trigger when both are given; set trigger to "manual" to ' +
          'clear an onEvent auto-trigger. Set phase to null to clear an existing phase.',
        schema: updateStepSchema,
      },
    ),
  ];
}
