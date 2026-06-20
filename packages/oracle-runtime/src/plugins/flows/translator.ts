/**
 * The FlowSpec <-> BaseUcanFlow translator — the one module where the editor's
 * internals could leak, so it is small and exhaustively tested. It maps the
 * friendly FlowSpec (types.ts) onto the verified `BaseUcanFlow`/`FlowCapability`
 * shape and back.
 *
 * Two deliberate decisions, both load-bearing (see spec §2.3, §7.1):
 *  - Sequencing is `capabilities[]` ORDER + data references. `after` is ordering
 *    only; `onEvent` is the advanced event-trigger path.
 *  - Conditions are NEVER routed through `capability.condition`. The compiler
 *    writes that operator verbatim and the FE evaluator can't read it, so a
 *    condition authored that way never fires. Instead we build the compiled
 *    `props.conditions` JSON directly, in the evaluator's operator vocabulary,
 *    and the edit layer writes it onto the block. `buildConditionsProp` /
 *    `parseConditionsProp` own that mapping.
 */
import type {
  BaseUcanFlow,
  FlowCapability,
  TriggerSpec,
} from '@ixo/editor/core';
import { typeToCan, canToType, getActionByCan } from '@ixo/editor/core';
import { FlowError } from './errors.js';
import type { Condition, FlowStep, FlowSpecInput } from './types.js';

/** The compiler's block-id convention (verified: `generateBlockId`). */
export const BLOCK_ID_PREFIX = 'flow_block_';
export const stepIdToBlockId = (stepId: string): string =>
  `${BLOCK_ID_PREFIX}${stepId}`;
export const blockIdToStepId = (blockId: string): string =>
  blockId.startsWith(BLOCK_ID_PREFIX)
    ? blockId.slice(BLOCK_ID_PREFIX.length)
    : blockId;

/** Friendly condition operator -> the FE evaluator's exact operator string. */
const OP_TO_EVALUATOR: Record<Condition['is'], string> = {
  equals: 'equals',
  notEquals: 'not_equals',
  greaterThan: 'greater_than',
  lessThan: 'less_than',
  contains: 'contains',
  isEmpty: 'is_empty',
  isNotEmpty: 'is_not_empty',
};
const EVALUATOR_TO_OP: Record<string, Condition['is']> = Object.fromEntries(
  Object.entries(OP_TO_EVALUATOR).map(([friendly, evaluator]) => [
    evaluator,
    friendly as Condition['is'],
  ]),
);

const REF_PATTERN = /^\{\{\s*(.+?)\s*\}\}$/;

/**
 * Data refs cross an id boundary. The agent works in STEP ids
 * ("fill-form.output.answers.did"), but the flow engine resolves a `$ref` by
 * calling `runtime.get(<id>)`, and the runtime is keyed by the BLOCK id
 * (`flow_block_<stepId>`). So the stored `$ref` must carry the block id, or the
 * engine reads `runtime.get("fill-form")` (empty) and the input resolves to
 * nothing. These translate the id half of an "<id>.output.<path>" ref; non-output
 * refs (e.g. `trigger.payload.*`) pass through untouched.
 */
function stepRefToBlockRef(ref: string): string {
  const i = ref.indexOf('.output.');
  if (i <= 0) return ref;
  return `${stepIdToBlockId(ref.slice(0, i))}${ref.slice(i)}`;
}
function blockRefToStepRef(ref: string): string {
  const i = ref.indexOf('.output.');
  if (i <= 0) return ref;
  const id = ref.slice(0, i);
  return id.startsWith(BLOCK_ID_PREFIX)
    ? `${id.slice(BLOCK_ID_PREFIX.length)}${ref.slice(i)}`
    : ref;
}

/** Resolve a friendly action name (registry `type`) to its `can` ability string. */
export function actionToCan(action: string): string {
  const can = typeToCan(action);
  if (can) return can;
  // Tolerate an action that is already a `can` string.
  if (getActionByCan(action)) return action;
  throw new FlowError('unknown_action', `Unknown action "${action}".`);
}

/** Resolve a `can` ability string back to the friendly action name (registry `type`). */
export function canToAction(can: string): string {
  return canToType(can) ?? can;
}

/** A `{ $ref: string }` runtime reference — the only shape the engine resolves. */
function isRuntimeRef(value: unknown): value is { $ref: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    '$ref' in value &&
    typeof (value as { $ref: unknown }).$ref === 'string'
  );
}

/**
 * Convert a single friendly value into its `nb` form, recursing through objects
 * and arrays. A "{{step-id.output.field}}" string becomes a `{ $ref }`; every
 * other value passes through. Recursion matters because the engine's
 * `resolveRuntimeRefs` resolves `$ref` at any depth — a nested mustache string
 * (e.g. inside an email `variables` map) would otherwise ship verbatim.
 */
function friendlyValueToNb(value: unknown): unknown {
  if (typeof value === 'string') {
    const match = REF_PATTERN.exec(value);
    return match?.[1] ? { $ref: stepRefToBlockRef(match[1]) } : value;
  }
  if (Array.isArray(value)) return value.map(friendlyValueToNb);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = friendlyValueToNb(val);
    }
    return out;
  }
  return value;
}

/** Convert a single `nb` value back to its friendly form (reverse + recursive). */
function nbValueToFriendly(value: unknown): unknown {
  if (isRuntimeRef(value)) return `{{${blockRefToStepRef(value.$ref)}}}`;
  if (Array.isArray(value)) return value.map(nbValueToFriendly);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = nbValueToFriendly(val);
    }
    return out;
  }
  return value;
}

/**
 * Convert friendly inputs into capability `nb`. A value written as
 * "{{step-id.output.field}}" becomes a `{ $ref }` (the BaseUcanFlow ref form);
 * everything else passes through as a literal. Nested objects/arrays are walked
 * so refs inside maps (e.g. email `variables`) resolve at execution too.
 */
export function friendlyInputsToNb(
  inputs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!inputs) return undefined;
  const nb: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    nb[key] = friendlyValueToNb(value);
  }
  return nb;
}

/** Reverse of {@link friendlyInputsToNb}: `{ $ref }` -> "{{...}}", recursively. */
export function nbToFriendlyInputs(
  nb: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!nb || Object.keys(nb).length === 0) return undefined;
  const inputs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(nb)) {
    inputs[key] = nbValueToFriendly(value);
  }
  return inputs;
}

/** Build the compiled `props.conditions` JSON string in the FE evaluator's vocabulary. */
export function buildConditionsProp(conditions: Condition[]): string {
  return JSON.stringify({
    enabled: true,
    mode: 'all_must_pass',
    conditions: conditions.map((c) => ({
      id: `cond_${c.fromStep}_${c.field}`,
      name: `Condition from ${c.fromStep}`,
      sourceBlockId: stepIdToBlockId(c.fromStep),
      sourceBlockType: 'action',
      rule: {
        type: 'property_value',
        property: c.field,
        operator: OP_TO_EVALUATOR[c.is],
        value: c.value,
      },
      effect: { action: 'enable' },
    })),
  });
}

/**
 * Parse a compiled `props.conditions` JSON string back into friendly
 * Conditions. Defensive: returns [] on anything unparseable. `blockToStep`
 * maps a source block id back to a step id (falls back to stripping the
 * `flow_block_` prefix).
 */
export function parseConditionsProp(
  raw: unknown,
  blockToStep?: (blockId: string) => string,
): Condition[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (parsed as { conditions?: unknown }).conditions;
  if (!Array.isArray(list)) return [];
  const resolveStep = blockToStep ?? blockIdToStepId;
  const out: Condition[] = [];
  for (const entry of list) {
    const rule = (entry as { rule?: Record<string, unknown> }).rule;
    const sourceBlockId = (entry as { sourceBlockId?: unknown }).sourceBlockId;
    if (!rule || typeof sourceBlockId !== 'string') continue;
    const friendlyOp = EVALUATOR_TO_OP[String(rule.operator)];
    if (!friendlyOp) continue;
    out.push({
      fromStep: resolveStep(sourceBlockId),
      field: String(rule.property),
      is: friendlyOp,
      value: rule.value,
    });
  }
  return out;
}

function triggerForStep(step: FlowStep): TriggerSpec | undefined {
  if (step.onEvent) {
    return {
      type: 'block.event',
      sourceBlockId: step.onEvent.fromStep,
      eventName: step.onEvent.event,
    };
  }
  if (step.trigger === 'flow-start') return { type: 'flow.start' };
  if (step.trigger === 'manual') return { type: 'manual' };
  return undefined;
}

function ttlForStep(step: FlowStep): FlowCapability['ttl'] | undefined {
  if (!step.due) return undefined;
  const ttl: NonNullable<FlowCapability['ttl']> = {};
  if (step.due.at) ttl.absoluteDueDate = step.due.at;
  if (step.due.within) ttl.fromEnablement = step.due.within;
  if (step.due.afterCommitment) ttl.fromCommitment = step.due.afterCommitment;
  if (step.commitTo) ttl.fromCommitment = step.commitTo;
  return Object.keys(ttl).length > 0 ? ttl : undefined;
}

function actorForStep(step: FlowStep): FlowCapability['actor'] | undefined {
  if (!step.assignTo) return undefined;
  return { authorisedActors: [step.assignTo] };
}

/** Translate one step into a FlowCapability (without conditions — see module note). */
export function stepToCapability(
  step: FlowStep,
  flowId: string,
): FlowCapability {
  const cap: FlowCapability = {
    id: step.id,
    can: actionToCan(step.action),
    with: `ixo:flow:${flowId}:${step.id}`,
  };
  const nb = friendlyInputsToNb(step.inputs);
  if (nb) cap.nb = nb;
  if (step.title) cap.title = step.title;
  if (step.description) cap.description = step.description;
  const trigger = triggerForStep(step);
  if (trigger) cap.trigger = trigger;
  const ttl = ttlForStep(step);
  if (ttl) cap.ttl = ttl;
  const actor = actorForStep(step);
  if (actor) cap.actor = actor;
  return cap;
}

/**
 * Translate a FlowSpec into a BaseUcanFlow. Capability order follows step
 * order (the engine's sequencing primitive). Conditions are NOT emitted here;
 * the caller writes `props.conditions` directly via the edit layer.
 */
export function flowSpecToBaseUcan(
  spec: FlowSpecInput,
  opts: { flowId: string; ownerDid?: string },
): BaseUcanFlow {
  const plan: BaseUcanFlow = {
    kind: 'qi.flow.base-ucan',
    version: '1.0',
    flowId: opts.flowId,
    title: spec.title,
    capabilities: spec.steps.map((step) => stepToCapability(step, opts.flowId)),
  };
  if (spec.goal) plan.goal = spec.goal;
  if (opts.ownerDid) plan.meta = { rootIssuer: opts.ownerDid };
  return plan;
}
