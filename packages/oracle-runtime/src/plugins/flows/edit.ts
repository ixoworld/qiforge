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
import {
  deleteBlock,
  editBlock,
  findParentOf,
} from '../editor/block-actions.js';
import { getActionDef, isEventCapable } from './actions.js';
import { FlowError } from './errors.js';
import { readFlowSpec } from './read.js';
import {
  BLOCK_ID_PREFIX,
  blockIdToStepId,
  buildConditionsProp,
  canToAction,
  friendlyInputsToNb,
  stepIdToBlockId,
} from './translator.js';
import type { Condition } from './types.js';

const DOC = 'document';

function requireStep(doc: YDoc, stepId: string): string {
  if (!doc.getMap('qi.flow.nodes').has(stepId)) {
    throw new FlowError('step_not_found', `No step "${stepId}" in this flow.`);
  }
  return stepIdToBlockId(stepId);
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

export function setStepInputs(
  doc: YDoc,
  stepId: string,
  inputs: Record<string, unknown>,
): void {
  setStepProps(doc, stepId, {
    inputs: JSON.stringify(friendlyInputsToNb(inputs) ?? {}),
  });
}

export function setStepConditions(
  doc: YDoc,
  stepId: string,
  conditions: Condition[],
): void {
  setStepProps(doc, stepId, {
    conditions: conditions.length > 0 ? buildConditionsProp(conditions) : '',
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
  if (onEvent.fromStep.startsWith(BLOCK_ID_PREFIX)) {
    throw new FlowError(
      'validation_failed',
      `"${onEvent.fromStep}" is an internal block id — use the short step id ("${blockIdToStepId(onEvent.fromStep)}").`,
    );
  }
  const sourceBlockId = requireStep(doc, onEvent.fromStep);

  // Same event-capability rule validate_flow enforces at plan level (spec §2.3).
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
    const refsInput = Object.values(step.inputs ?? {}).some(
      (v) =>
        typeof v === 'string' && new RegExp(`\\{\\{\\s*${stepId}\\.`).test(v),
    );
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
      const edge = value as { source?: unknown; target?: unknown } | undefined;
      if (edge && (edge.source === stepId || edge.target === stepId))
        toDelete.push(edgeId);
    });
    for (const edgeId of toDelete) edges.delete(edgeId);
  });

  deleteBlock(doc, { blockId, docName: DOC });
}

/** Reorder a step to a new 0-based index. Sequence is display-only; runtime/edges untouched. */
export function reorderStep(doc: YDoc, stepId: string, toIndex: number): void {
  const blockId = requireStep(doc, stepId);
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
    // Move the fragment block by CLONE (yjs can't reinsert a deleted element).
    const fragment = doc.getXmlFragment(DOC);
    const found = findParentOf(fragment, blockId);
    if (found) {
      const element = found.parent.toArray()[found.index];
      if (element instanceof Y.XmlElement) {
        const clone = element.clone();
        found.parent.delete(found.index, 1);
        found.parent.insert(Math.min(target, found.parent.length), [clone]);
      }
    }
    orderArr.delete(0, orderArr.length);
    orderArr.push(without);
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
