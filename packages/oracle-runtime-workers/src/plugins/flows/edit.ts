/**
 * Per-block / delta edit dispatcher (spec §4.2). Every mutation touches only
 * its target step; unrelated steps' data is never rewritten or dropped.
 *
 * All edits run in oracle-runtime's native yjs on the connected provider doc
 * (the editor package's fragment helpers are cross-version-broken here — see
 * read.ts). Value-prop writes reuse the editor plugin's native `editBlock`
 * (which writes the BlockNote shape the portal renders); remove/reorder reuse
 * its native `deleteBlock`/`moveBlock` and we keep the `qi.flow.*` maps in sync.
 *
 * Conditions are written DIRECTLY as `props.conditions` in the FE evaluator's
 * operator vocabulary (never via the compiler's `cap.condition`, which never
 * evaluates — see translator.ts).
 */
import type { Doc as YDoc } from 'yjs';
import * as Y from 'yjs';
import { deleteBlock, editBlock, findParentOf } from './ydoc-helpers';
import { getActionDef, isEventCapable } from './actions';
import { FlowError } from './errors';
import {
  MAX_STEP_INPUTS_BYTES,
  jsonByteLength,
  secretLiteralMessage,
  secretLiteralPaths,
} from './input-policy';
import { readFlowSpec } from './read';
import { referencesId } from './ref-syntax';
import {
  BLOCK_ID_PREFIX,
  blockIdToStepId,
  buildConditionsProp,
  canToAction,
  friendlyInputsToNb,
  stepIdToBlockId,
} from './translator';
import { didSchema, type Condition, type FlowStep } from './types';

const DOC = 'document';

/** The step's block id; throws `step_not_found` when the flow has no such step. */
export function requireStep(doc: YDoc, stepId: string): string {
  if (!doc.getMap('qi.flow.nodes').has(stepId)) {
    throw new FlowError('step_not_found', `No step "${stepId}" in this flow.`);
  }
  return stepIdToBlockId(stepId);
}

/** The ids of the flow's steps, plus `extra` (steps about to be added). */
function stepIdsOf(doc: YDoc, extra: readonly string[]): Set<string> {
  return new Set([...doc.getMap('qi.flow.nodes').keys(), ...extra]);
}

/*
 * Checks. Each throws the error its setter would, without writing, so a tool
 * that makes several edits can validate all of them before the first change
 * (a change already made would still reach the room).
 */

/**
 * Throw unless `inputs` may be stored: no secret outside a reference to a
 * step of this flow (or of `extraStepIds`), and within the size cap. Returns
 * the serialised value to store.
 */
export function checkStepInputs(
  doc: YDoc,
  inputs: Record<string, unknown>,
  extraStepIds: readonly string[] = [],
): string {
  const secrets = secretLiteralPaths(inputs, stepIdsOf(doc, extraStepIds));
  if (secrets.length > 0)
    throw new FlowError('validation_failed', secretLiteralMessage(secrets));
  const nb = friendlyInputsToNb(inputs) ?? {};
  const bytes = jsonByteLength(nb);
  if (bytes > MAX_STEP_INPUTS_BYTES)
    throw new FlowError(
      'validation_failed',
      `A step's inputs may be at most ${MAX_STEP_INPUTS_BYTES} bytes of JSON (got ${bytes}).`,
    );
  return JSON.stringify(nb);
}

/** Throw unless every condition reads a step of this flow (or of `extraStepIds`). */
export function checkConditions(
  doc: YDoc,
  conditions: readonly Condition[],
  extraStepIds: readonly string[] = [],
): void {
  // A condition on a step that is not in the flow can never be evaluated.
  const ids = stepIdsOf(doc, extraStepIds);
  for (const condition of conditions)
    if (!ids.has(condition.fromStep))
      throw new FlowError(
        'step_not_found',
        `No step "${condition.fromStep}" in this flow.`,
      );
}

/** Throw unless `assignTo` is a DID (assigning grants run authority). */
export function checkAssignee(assignTo: string | undefined): void {
  if (assignTo !== undefined && !didSchema.safeParse(assignTo).success)
    throw new FlowError(
      'validation_failed',
      `"${assignTo}" is not a DID. Assigning a step authorises that DID to run it, so it must be a did: value.`,
    );
}

/**
 * Throw unless `stepId` may auto-trigger on `onEvent.fromStep`: a step of
 * this flow whose action can emit events. Returns the source's block id.
 */
export function checkEventTrigger(
  doc: YDoc,
  stepId: string,
  onEvent: { fromStep: string; event: string },
): string {
  if (onEvent.fromStep.startsWith(BLOCK_ID_PREFIX)) {
    throw new FlowError(
      'validation_failed',
      `"${onEvent.fromStep}" is an internal block id — use the short step id ("${blockIdToStepId(onEvent.fromStep)}").`,
    );
  }
  const sourceBlockId = requireStep(doc, onEvent.fromStep);

  // Same event-capability rule validate_flow enforces at plan level.
  const source = doc.getMap('qi.flow.nodes').get(onEvent.fromStep);
  const registryType =
    source instanceof Y.Map ? source.get('registryType') : undefined;
  const can = source instanceof Y.Map ? source.get('can') : undefined;
  const action =
    typeof registryType === 'string'
      ? registryType
      : typeof can === 'string'
        ? canToAction(can)
        : undefined;
  const def = action ? getActionDef(action) : undefined;
  if (def && !isEventCapable(def)) {
    throw new FlowError(
      'validation_failed',
      `Step "${stepId}" can't auto-trigger on "${onEvent.fromStep}" — its action "${action}" cannot emit events. ` +
        'Use ordering (after) + an input reference instead.',
    );
  }
  return sourceBlockId;
}

/** Write a set of value props onto a step's block (per-block, lossless). */
export function setStepProps(
  doc: YDoc,
  stepId: string,
  props: Record<string, string>,
): void {
  const blockId = requireStep(doc, stepId);
  editBlock(doc, { blockId, attributes: { props }, docName: DOC });
}

/**
 * Replace a step's inputs. Every path that writes inputs ends here, so the
 * secret and size rules are enforced here as well as in the tool schemas.
 */
export function setStepInputs(
  doc: YDoc,
  stepId: string,
  inputs: Record<string, unknown>,
): void {
  requireStep(doc, stepId);
  const serialized = checkStepInputs(doc, inputs);
  setStepExecutionProps(doc, stepId, { inputs: serialized });
}

export function setStepConditions(
  doc: YDoc,
  stepId: string,
  conditions: Condition[],
): void {
  requireStep(doc, stepId);
  checkConditions(doc, conditions);
  setStepExecutionProps(doc, stepId, {
    conditions: conditions.length > 0 ? buildConditionsProp(conditions) : '',
  });
}

export function setStepSemanticGate(
  doc: YDoc,
  stepId: string,
  gate: FlowStep['semanticGate'] | null,
): void {
  setStepExecutionProps(doc, stepId, {
    semanticGate: gate ? JSON.stringify(gate) : '',
  });
}

function setStepExecutionProps(
  doc: YDoc,
  stepId: string,
  props: Record<string, string>,
): void {
  requireStep(doc, stepId);
  const nodes = doc.getMap('qi.flow.nodes');
  const node = nodes.get(stepId);
  if (!(node instanceof Y.Map))
    throw new FlowError(
      'step_not_found',
      `No compiled step "${stepId}" in this flow.`,
    );
  doc.transact(() => {
    setStepProps(doc, stepId, props);
    const existing: unknown = node.get('props');
    if (existing instanceof Y.Map) {
      for (const [key, value] of Object.entries(props))
        existing.set(key, value);
    } else {
      node.set('props', {
        ...(existing && typeof existing === 'object' && !Array.isArray(existing)
          ? existing
          : {}),
        ...props,
      });
    }
    for (const [key, value] of Object.entries(props)) node.set(key, value);
  });
}

export function setStepSchedule(
  doc: YDoc,
  stepId: string,
  due: { at?: string; within?: string; afterCommitment?: string } | undefined,
  commitTo?: string,
): void {
  setStepProps(doc, stepId, {
    ttlAbsoluteDueDate: due?.at ?? '',
    ttlFromEnablement: due?.within ?? '',
    ttlFromCommitment: commitTo ?? due?.afterCommitment ?? '',
  });
}

export function setStepAssignment(
  doc: YDoc,
  stepId: string,
  assignTo: string | undefined,
): void {
  // The portal shows + nudges the assignee from `props.assignment`; the
  // `authorisedActors` whitelist also lets that actor run the step. Write both
  // so the assignee is visible AND authorized; clear both when unassigned.
  // Because this grants run authority, only a well-formed DID is accepted.
  checkAssignee(assignTo);
  setStepProps(doc, stepId, {
    assignment: assignTo
      ? JSON.stringify({ assignedActor: { did: assignTo } })
      : '',
    authorisedActors: assignTo ? JSON.stringify([assignTo]) : '',
  });
}

export function setStepConfirmation(
  doc: YDoc,
  stepId: string,
  requireConfirmation: boolean,
): void {
  setStepProps(doc, stepId, {
    requiresConfirmation: requireConfirmation ? 'true' : '',
  });
}

/** Update the stable semantic phase stored on the compiled Flow node. */
export function setStepPhase(
  doc: YDoc,
  stepId: string,
  phase: string | undefined,
): void {
  requireStep(doc, stepId);
  const node = doc.getMap('qi.flow.nodes').get(stepId);
  if (!(node instanceof Y.Map)) {
    throw new FlowError('step_not_found', `No step "${stepId}" in this flow.`);
  }
  doc.transact(() => {
    if (phase) node.set('phase', phase);
    else node.delete('phase');
  });
}

/** Persist the human-only versus agent-capable execution boundary. */
export function setStepExecution(
  doc: YDoc,
  stepId: string,
  execution: 'human-only' | 'agent-capable',
): void {
  setStepProps(doc, stepId, {
    flowAgentExecutionMode:
      execution === 'human-only' ? 'human-only' : 'saved-input',
  });
}

/** Persist governed skill requirements used by Flow Agent actor matching. */
export function setStepSkills(
  doc: YDoc,
  stepId: string,
  skills: string[],
): void {
  setStepProps(doc, stepId, {
    requiredSkill: skills[0] ?? '',
    requiredSkills: skills.length > 0 ? JSON.stringify(skills) : '',
  });
}

/**
 * Set a step's trigger to `manual` (default) or `flow-start`. Writes the same
 * `trigger`/`triggerMode` props the compiler would. Event triggers are written
 * by {@link setStepEventTrigger}; setting `manual` here clears one.
 */
export function setStepTrigger(
  doc: YDoc,
  stepId: string,
  trigger: 'manual' | 'flow-start',
): void {
  const type = trigger === 'flow-start' ? 'flow.start' : 'manual';
  setStepProps(doc, stepId, {
    trigger: trigger === 'flow-start' ? JSON.stringify({ type }) : '',
    triggerMode: type,
  });
}

/**
 * Auto-trigger a step when an upstream step emits an event. Writes the same
 * `trigger`/`triggerMode` props the compiler would for a `block.event` trigger.
 * The stored `sourceBlockId` carries the BLOCK id (`flow_block_<stepId>`) —
 * that is what the FE reconciler matches against the source block's real `.id`
 * — while callers keep passing the friendly step id.
 */
export function setStepEventTrigger(
  doc: YDoc,
  stepId: string,
  onEvent: { fromStep: string; event: string },
): void {
  const sourceBlockId = checkEventTrigger(doc, stepId, onEvent);
  setStepProps(doc, stepId, {
    trigger: JSON.stringify({
      type: 'block.event',
      sourceBlockId,
      eventName: onEvent.event,
    }),
    triggerMode: 'block.event',
  });
}

/** Steps that depend on `stepId` (via an input ref or a condition source). */
function referrersOf(doc: YDoc, ref: string, stepId: string): string[] {
  const flow = readFlowSpec(doc, ref);
  if (!flow) return [];
  const referrers: string[] = [];
  for (const step of flow.steps) {
    if (step.id === stepId) continue;
    // Inputs nest (an email's `variables` map, arrays of recipients), and a
    // reference may sit inside a longer template string.
    const refsInput = referencesId(step.inputs ?? {}, stepId);
    const conds = [
      ...(step.runWhen ? [step.runWhen] : []),
      ...(step.conditions ?? []),
    ];
    const refsCondition = conds.some((c) => c.fromStep === stepId);
    const refsEvent = step.onEvent?.fromStep === stepId;
    if (refsInput || refsCondition || refsEvent) referrers.push(step.id);
  }
  return referrers;
}

/** Remove a step entirely: fragment block + every `qi.flow.*` trace + runtime. Rejects if referenced. */
export function removeStep(doc: YDoc, ref: string, stepId: string): void {
  const blockId = requireStep(doc, stepId);
  const referrers = referrersOf(doc, ref, stepId);
  if (referrers.length > 0) {
    throw new FlowError(
      'referenced',
      `Can't remove "${stepId}" — it is used by ${referrers.join(', ')}. Update those steps first.`,
    );
  }

  doc.transact(() => {
    doc.getMap('qi.flow.nodes').delete(stepId);
    doc.getMap('qi.flow.blockIndex').delete(stepId);
    doc.getMap('runtime').delete(blockId);

    const order = doc.getArray<string>('qi.flow.order');
    const idx = order.toArray().indexOf(stepId);
    if (idx >= 0) order.delete(idx, 1);

    const edges = doc.getMap('qi.flow.edges');
    const toDelete: string[] = [];
    edges.forEach((value, edgeId) => {
      // The compiler stores each edge as a Y.Map; plain objects are tolerated.
      const endpoint = (key: 'source' | 'target'): unknown =>
        value instanceof Y.Map
          ? value.get(key)
          : value && typeof value === 'object'
            ? Object.getOwnPropertyDescriptor(value, key)?.value
            : undefined;
      if (endpoint('source') === stepId || endpoint('target') === stepId)
        toDelete.push(edgeId);
    });
    for (const edgeId of toDelete) edges.delete(edgeId);
  });

  deleteBlock(doc, { blockId, docName: DOC });
}

/**
 * Move a step's block in the document so it sits next to its neighbours in
 * `order`: right before the next step's block, or right after the previous
 * one's. The document also holds headings and notes between step blocks, so
 * an index taken from `order` would land in the wrong place.
 *
 * Yjs has no move operation: the block is cloned and the original deleted, so
 * an edit another client makes to the original at the same moment is lost.
 * The block is left alone when it already sits between the right neighbours.
 */
export function placeStepBlock(
  doc: YDoc,
  stepId: string,
  order: readonly string[],
): void {
  const fragment = doc.getXmlFragment(DOC);
  const found = findParentOf(fragment, stepIdToBlockId(stepId));
  if (!found) return;
  const { parent } = found;
  const siblings = parent.toArray();
  // A neighbour's index among the same siblings, or -1 when it has no block
  // or its block lives under a different parent.
  const indexIn = (id: string | undefined): number => {
    if (id === undefined) return -1;
    const located = findParentOf(fragment, stepIdToBlockId(id));
    return located && located.parent === parent ? located.index : -1;
  };
  const at = order.indexOf(stepId);
  const before = indexIn(order[at - 1]);
  const after = indexIn(order[at + 1]);
  const current = found.index;
  if ((before < 0 || before < current) && (after < 0 || current < after))
    return;

  const element = siblings[current];
  if (!(element instanceof Y.XmlElement)) return;
  // Position in the sibling list once the original is removed.
  const shift = (index: number): number =>
    index > current ? index - 1 : index;
  const target =
    after >= 0 ? shift(after) : before >= 0 ? shift(before) + 1 : current;
  doc.transact(() => {
    const clone = element.clone();
    parent.delete(current, 1);
    parent.insert(target, [clone]);
  });
}

/** Reorder a step to a new 0-based index. Sequence is display-only; runtime/edges untouched. */
export function reorderStep(doc: YDoc, stepId: string, toIndex: number): void {
  requireStep(doc, stepId);
  const orderArr = doc.getArray<string>('qi.flow.order');
  const current = orderArr.toArray();
  const from = current.indexOf(stepId);
  if (from < 0)
    throw new FlowError('step_not_found', `No step "${stepId}" in this flow.`);

  const target = Math.max(0, Math.min(toIndex, current.length - 1));
  if (target === from) return;

  const without = current.filter((id) => id !== stepId);
  without.splice(target, 0, stepId);

  doc.transact(() => {
    orderArr.delete(0, orderArr.length);
    orderArr.push(without);
    placeStepBlock(doc, stepId, without);
  });
}

/** Update flow-level metadata (title / goal). */
export function updateFlowMeta(
  doc: YDoc,
  patch: { title?: string; goal?: string },
): void {
  const meta = doc.getMap('qi.flow.meta');
  doc.transact(() => {
    if (patch.title !== undefined) meta.set('title', patch.title);
    if (patch.goal !== undefined) meta.set('goal', patch.goal);
  });
}
