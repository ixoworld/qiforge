/**
 * Authoring tools. `validate_flow` is a pure compile-without-write.
 * `create_template`/`add_step` go through the editor's compiler (`setupFlowFromBaseUcan`,
 * which manages its own doc and syncs to the room). The remaining mutators are
 * thin wrappers over the tested per-block edit functions (edit.ts).
 *
 * Conditions are applied as a post-pass via the direct `props.conditions` write
 * (setStepConditions) — never through the compiler's `cap.condition`, which
 * never evaluates (translator.ts).
 */
import {
  compileBaseUcanFlow,
  getActionByCan,
  setupFlowFromBaseUcan,
} from '@ixo/editor/core';
import type { MatrixClient } from 'matrix-js-sdk';
import type { Doc as YDoc } from 'yjs';
import { z } from 'zod';
import { tool } from '../../../plugin-api/tool-helper';
import type { PluginTool, RuntimeContext } from '../../../plugin-api/types';
import { getActionDef, isEventCapable } from '../actions';
import {
  checkAssignee,
  checkConditions,
  checkEventTrigger,
  checkStepInputs,
  placeStepBlock,
  requireStep,
  removeStep,
  reorderStep,
  setStepAssignment,
  setStepConditions,
  setStepSemanticGate,
  setStepConfirmation,
  setStepEventTrigger,
  setStepExecution,
  setStepInputs,
  setStepPhase,
  setStepSchedule,
  setStepSkills,
  setStepTrigger,
  updateFlowMeta,
} from '../edit';
import { FlowError, toToolError } from '../errors';
import { MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS } from '../input-policy';
import {
  resolveFlowRef,
  withFlowDoc,
  withFlowsCompileClient,
} from '../flow-doc';
import { readStep } from '../read';
import { flowSpecToBaseUcan } from '../translator';
import {
  flowSpecSchema,
  flowStepSchema,
  semanticGateSchema,
  sizedFlowStepSchema,
  stepIdSchema,
  type Condition,
  type FlowSpecInput,
  type FlowStep,
} from './../types';

const flowSpecTitleSchema = z.string().min(1).max(MAX_NAME_CHARS);
const flowSpecGoalSchema = z.string().max(MAX_DESCRIPTION_CHARS);

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

/**
 * Plan-level checks the compiler does not make: a condition must read a step
 * of this flow, and onEvent must point at an event-capable upstream action.
 * Returns error strings.
 */
function eventCapabilityErrors(flow: FlowSpecInput): string[] {
  const errors: string[] = [];
  const ids = new Set(flow.steps.map((s) => s.id));
  for (const step of flow.steps) {
    for (const condition of conditionsOf(step)) {
      if (!ids.has(condition.fromStep))
        errors.push(
          `Step "${step.id}" has a condition on an unknown step "${condition.fromStep}".`,
        );
    }
  }
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

/**
 * Write what the compiler does not: conditions and the semantic gate (as
 * `props.conditions`, see the module note), the assignee shown by the portal,
 * and the execution boundary and skills. All of it goes into the one document
 * the caller opened, so a tool call loads the flow once for these passes.
 */
function applyPostCompile(doc: YDoc, steps: FlowStep[]): void {
  doc.transact(() => {
    for (const step of steps) {
      const conditions = conditionsOf(step);
      if (conditions.length > 0) setStepConditions(doc, step.id, conditions);
      if (step.semanticGate)
        setStepSemanticGate(doc, step.id, step.semanticGate);
      // The compiler only writes the authorisation list; the assignee the
      // portal shows and nudges lives in `props.assignment`.
      if (step.assignTo) setStepAssignment(doc, step.id, step.assignTo);
      if (step.execution) setStepExecution(doc, step.id, step.execution);
      if (step.skills) setStepSkills(doc, step.id, step.skills);
    }
  });
}

/** Whether any step needs {@link applyPostCompile}. */
function needsPostCompile(steps: FlowStep[]): boolean {
  return steps.some(
    (step) =>
      conditionsOf(step).length > 0 ||
      step.semanticGate !== undefined ||
      step.assignTo !== undefined ||
      step.execution !== undefined ||
      step.skills !== undefined,
  );
}

/** The step ids in `qi.flow.order`. */
function readOrder(doc: YDoc): string[] {
  return doc
    .getArray('qi.flow.order')
    .toArray()
    .filter((v): v is string => typeof v === 'string');
}

/** Whether the room's document already holds a flow. */
function holdsFlow(doc: YDoc): boolean {
  return readOrder(doc).length > 0 || doc.getMap('qi.flow.nodes').size > 0;
}

function metaString(doc: YDoc, key: string): string | undefined {
  const value = doc.getMap('qi.flow.meta').get(key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Allocate the room to author the template into.
 *
 * The Node runtime first asks the user's front-end (over its WS browser-tool
 * channel) to create a dedicated `#template-*` room and invite the oracle.
 * The Workers runtime has no request/response browser-tool channel — its
 * `emit.browserToolCall` is a one-way SSE event — so that path does not exist
 * here: the template is authored into the room the portal already opened
 * (`state.editorRoomId`, or an explicit `flow.ref`). When a round-trip
 * browser-tool channel lands on Workers, restore the Node runtime's
 * `create_template_room` request here.
 */
function allocateTemplateRoom(
  ctx: RuntimeContext,
  flow: FlowSpecInput,
): string {
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
        const { flow } = createTemplateSchema.parse(args);
        const errors = eventCapabilityErrors(flow);
        if (errors.length > 0)
          return {
            ok: false,
            error: { code: 'validation_failed', message: errors.join(' ') },
          };

        const roomId = allocateTemplateRoom(ctx, flow);
        // The compiler's full write clears whatever flow the room holds —
        // template, run state and form answers — so an occupied room is
        // refused; changes to an existing flow go through the edit tools.
        // (withFlowDoc also enforces room membership.)
        const occupied = await withFlowDoc(
          ctx,
          roomId,
          matrixClient,
          async (doc) => holdsFlow(doc),
        );
        if (occupied)
          throw new FlowError(
            'validation_failed',
            'This room already holds a flow. create_template never replaces one — change it with the edit tools ' +
              '(add_step, update_step, set_step_*, remove_step, reorder_step, connect_steps).',
          );

        const flowId = `flow-${crypto.randomUUID().slice(0, 8)}`;
        const plan = flowSpecToBaseUcan(flow, {
          flowId,
          ownerDid: ctx.user.did,
        });
        await withFlowsCompileClient(ctx, matrixClient, (client) =>
          setupFlowFromBaseUcan({
            plan,
            roomId,
            matrixClient: client,
            creatorDid: ctx.user.did,
          }),
        );
        if (needsPostCompile(flow.steps))
          await withFlowDoc(ctx, roomId, matrixClient, async (doc) =>
            applyPostCompile(doc, flow.steps),
          );

        return { ok: true, flowRef: roomId };
      } catch (err) {
        return toToolError(err);
      }
    },
    {
      name: 'create_template',
      description:
        'Create a BRAND-NEW flow template — a reusable blueprint the user instantiates and runs in ' +
        'the portal. Refused when the room already holds a flow. Do NOT use this to change a template that already exists or is currently open — use the editing tools ' +
        '(add_step, update_step, set_step_*, remove_step, reorder_step, connect_steps), which modify the open template in ' +
        'place. Validate first with validate_flow.',
      schema: createTemplateSchema,
    },
  );
}

const addStepSchema = z.object({
  ...base,
  step: sizedFlowStepSchema,
  position: z
    .union([
      z.number().int().nonnegative(),
      z.object({ after: stepIdSchema }),
      z.object({ before: stepIdSchema }),
    ])
    .optional()
    .describe(
      'Where to place the step: a 0-based index, {after: id}, or {before: id}. Omitted = append.',
    ),
});

/** Where `position` puts a new step in `order` (which does not yet hold it). */
function insertionIndex(
  order: readonly string[],
  position: z.infer<typeof addStepSchema>['position'],
): number {
  if (position === undefined) return order.length;
  if (typeof position === 'number') return Math.min(position, order.length);
  const anchor = 'after' in position ? position.after : position.before;
  const at = order.indexOf(anchor);
  if (at < 0)
    throw new FlowError('step_not_found', `No step "${anchor}" in this flow.`);
  return 'after' in position ? at + 1 : at;
}

function buildAddStepTool(matrixClient: MatrixClient | undefined): PluginTool {
  return tool(
    async (args, ctx: RuntimeContext) => {
      try {
        const { flowRef, step, position } = addStepSchema.parse(args);
        const roomId = resolveFlowRef(ctx, flowRef);

        // What the merge must keep: the compiler's merge rewrites the flow's
        // title and owner from the incoming plan and rebuilds the step order
        // from its node map, so read them first and hand them back.
        const existing = await withFlowDoc(
          ctx,
          roomId,
          matrixClient,
          async (doc) => {
            const order = readOrder(doc);
            if (!holdsFlow(doc))
              throw new FlowError(
                'flow_not_found',
                'There is no flow here yet. Create it with create_template.',
              );
            if (
              doc.getMap('qi.flow.nodes').has(step.id) ||
              order.includes(step.id)
            )
              throw new FlowError(
                'validation_failed',
                `A step "${step.id}" already exists in this flow. Pick another id, or change that step with update_step.`,
              );
            // Everything the post-compile pass will check, checked now: the
            // compile writes the step, so a later refusal would leave it behind.
            if (step.inputs) checkStepInputs(doc, step.inputs, [step.id]);
            checkConditions(doc, conditionsOf(step), [step.id]);
            if (step.onEvent) checkEventTrigger(doc, step.id, step.onEvent);
            return {
              flowId: metaString(doc, 'flowId'),
              title: metaString(doc, 'title'),
              ownerDid: metaString(doc, 'flowOwnerDid'),
              order,
            };
          },
        );
        const order = [...existing.order];
        order.splice(insertionIndex(order, position), 0, step.id);

        const plan = flowSpecToBaseUcan(
          { title: existing.title ?? '', steps: [step] },
          {
            flowId:
              existing.flowId ?? `flow-${crypto.randomUUID().slice(0, 8)}`,
            ownerDid: existing.ownerDid,
          },
        );
        await withFlowsCompileClient(ctx, matrixClient, (client) =>
          setupFlowFromBaseUcan({
            plan,
            roomId,
            matrixClient: client,
            creatorDid: ctx.user.did,
            strategy: 'merge',
          }),
        );

        // One load for every post-compile pass: restore the order (with the
        // new step in place), move its block next to its neighbours, and
        // write what the compiler does not.
        await withFlowDoc(ctx, roomId, matrixClient, async (doc) => {
          doc.transact(() => {
            const orderArr = doc.getArray<string>('qi.flow.order');
            const merged = readOrder(doc);
            // Steps another client added meanwhile stay, after the known ones.
            const restored = [
              ...order.filter((id) => merged.includes(id)),
              ...merged.filter((id) => !order.includes(id)),
            ];
            orderArr.delete(0, orderArr.length);
            orderArr.push(restored);
            placeStepBlock(doc, step.id, restored);
            applyPostCompile(doc, [step]);
          });
        });
        return ok;
      } catch (err) {
        return toToolError(err);
      }
    },
    {
      name: 'add_step',
      description:
        'Add one step to an existing flow without disturbing the others: the title, owner and step order stay as they are. ' +
        'Optionally place it at a position. A step id that already exists is refused.',
      schema: addStepSchema,
    },
  );
}

const removeSchema = z.object({ ...base, stepId: stepIdSchema });
const reorderSchema = z.object({
  ...base,
  stepId: stepIdSchema,
  toIndex: z.number().int().nonnegative(),
});
const metaSchema = z.object({
  ...base,
  title: flowSpecTitleSchema.optional(),
  goal: flowSpecGoalSchema.optional(),
});
const connectSchema = z.object({
  ...base,
  fromStep: stepIdSchema,
  field: z.string().min(1).max(MAX_NAME_CHARS),
  toStep: stepIdSchema,
  input: z.string().min(1).max(MAX_NAME_CHARS),
});
export const stepPatchSchema = flowStepSchema.partial().extend({
  phase: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('Set the step phase, or use null to clear an existing phase.'),
  semanticGate: semanticGateSchema
    .nullable()
    .optional()
    .describe(
      'Set the additional semantic gate, or use null to clear an existing gate.',
    ),
});
const updateStepSchema = z.object({
  ...base,
  stepId: stepIdSchema,
  patch: stepPatchSchema,
});

/** Route an update_step patch to the focused per-block edits. */
export function applyStepPatch(
  doc: YDoc,
  stepId: string,
  patch: z.infer<typeof stepPatchSchema>,
): void {
  // Validate every part before the first change: an edit already made would
  // reach the room even though the tool reports a failure.
  requireStep(doc, stepId);
  if (patch.inputs) checkStepInputs(doc, patch.inputs);
  checkConditions(doc, [
    ...(patch.runWhen ? [patch.runWhen] : []),
    ...(patch.conditions ?? []),
  ]);
  checkAssignee(patch.assignTo);
  if (patch.onEvent !== undefined)
    checkEventTrigger(doc, stepId, patch.onEvent);

  if (patch.inputs) setStepInputs(doc, stepId, patch.inputs);
  if (patch.semanticGate !== undefined)
    setStepSemanticGate(doc, stepId, patch.semanticGate);
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
          'clear an onEvent auto-trigger. Set phase or semanticGate to null to clear it.',
        schema: updateStepSchema,
      },
    ),
  ];
}
