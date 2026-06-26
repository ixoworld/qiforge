/**
 * Multi-source read assembler (spec §4.1). The editor stores a flow across
 * three places and per-block props live only in the document fragment, so a
 * single read path is lossy. `readFlowSpec` gathers from all of them:
 *   - the `qi.flow.*` maps -> structure (nodes/order/edges/registryType)
 *   - the `document` XmlFragment -> per-block props (inputs/conditions/trigger)
 *   - the `runtime` map -> per-step status/error/output
 *
 * We read the `qi.flow.*` maps with oracle-runtime's own yjs rather than the
 * editor package's `readCompiledFlowFromYDoc`: the editor bundles a different
 * yjs minor, and its reader does `value instanceof Y.Map` against ITS yjs, which
 * is false for the native nested maps in the plugin's provider doc — so it
 * returns empty nodes cross-version. Reading the maps directly here (reading,
 * never compiling) keeps every doc access on a single yjs instance. Per-block
 * props + runtime are read via the editor plugin's own (same-yjs) helpers.
 */
import type { Doc as YDoc } from 'yjs';
import * as Y from 'yjs';
import {
  collectAllBlocks,
  extractBlockProperties,
  readRuntimeState,
} from '../editor/blocknote-helper.js';
import {
  canToAction,
  nbToFriendlyInputs,
  parseConditionsProp,
} from './translator.js';
import type {
  FlowSpecRead,
  FlowStepRead,
  StepState,
  StepStatus,
} from './types.js';

const STEP_STATES: readonly StepState[] = [
  'idle',
  'running',
  'completed',
  'failed',
  'cancelled',
  'awaiting_readback',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
function asStepState(value: unknown): StepState | undefined {
  return STEP_STATES.includes(value as StepState)
    ? (value as StepState)
    : undefined;
}

/** Parse a value that may be a JSON string (fragment attribute) or already an object. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface FlowNode {
  can: string;
  registryType?: string;
  title?: string;
  description?: string;
}
interface CompiledStructure {
  meta: { title: string; goal?: string };
  nodes: Record<string, FlowNode>;
  order: string[];
  blockIndex: Record<string, string>;
}

/** Read the compiled `qi.flow.*` graph natively (same yjs as the doc). */
function readCompiledStructure(doc: YDoc): CompiledStructure | null {
  const order = doc
    .getArray('qi.flow.order')
    .toArray()
    .filter((v): v is string => typeof v === 'string');
  if (order.length === 0) return null;

  const meta = doc.getMap('qi.flow.meta');
  const nodes: Record<string, FlowNode> = {};
  doc.getMap('qi.flow.nodes').forEach((value, nodeId) => {
    if (!(value instanceof Y.Map)) return;
    const can = asString(value.get('can')) ?? '';
    nodes[nodeId] = {
      can,
      registryType: asString(value.get('registryType')),
      title: asString(value.get('title')),
      description: asString(value.get('description')),
    };
  });

  const blockIndex: Record<string, string> = {};
  doc.getMap('qi.flow.blockIndex').forEach((value, key) => {
    if (typeof value === 'string') blockIndex[key] = value;
  });

  return {
    meta: {
      title: asString(meta.get('title')) ?? '',
      goal: asString(meta.get('goal')),
    },
    nodes,
    order,
    blockIndex,
  };
}

interface TriggerProp {
  type?: string;
  sourceBlockId?: string;
  eventName?: string;
}

/** Parse the `trigger` prop (a JSON-serialized TriggerSpec) the compiler writes. */
function parseTriggerProp(value: unknown): TriggerProp | undefined {
  const obj = asObject(value);
  if (!obj) return undefined;
  return {
    type: asString(obj.type),
    sourceBlockId: asString(obj.sourceBlockId),
    eventName: asString(obj.eventName),
  };
}

/** First authorised actor from the `authorisedActors` prop (a JSON array string). */
function firstActor(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string')
      return parsed[0];
  } catch {
    /* ignore */
  }
  return undefined;
}

/** The assignee DID from the `assignment` prop (`{ assignedActor: { did } }` JSON). */
function assigneeFrom(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      const actor = (parsed as { assignedActor?: unknown }).assignedActor;
      if (actor && typeof actor === 'object') {
        const did = (actor as { did?: unknown }).did;
        if (typeof did === 'string' && did.length > 0) return did;
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Collect the upstream step ids this step refers to via "{{step.output.*}}" inputs. */
function referencedSteps(
  inputs: Record<string, unknown> | undefined,
): string[] {
  if (!inputs) return [];
  const refs = new Set<string>();
  for (const value of Object.values(inputs)) {
    if (typeof value === 'string') {
      const match = /^\{\{\s*([^.}\s]+)\./.exec(value);
      if (match?.[1]) refs.add(match[1]);
    }
  }
  return [...refs];
}

/** Derive a step's read-only status from its runtime entry + its dependencies' states. */
function computeStatus(
  runtime: Record<string, unknown> | undefined,
  dependencies: { referenced: string[]; after: string[] },
  stateByStepId: Map<string, StepState>,
): StepStatus {
  const state = asStepState(runtime?.state) ?? 'idle';
  const status: StepStatus = { state };

  const error = isRecord(runtime?.error) ? runtime.error : undefined;
  if (error && typeof error.message === 'string') {
    status.error = {
      message: error.message,
      code: asString(error.code),
      at: asNumber(error.at),
    };
  }
  const executedAt = asNumber(runtime?.executedAt);
  if (executedAt !== undefined) status.lastRunAt = executedAt;

  const blockedBy = new Set<string>();
  for (const dep of [...dependencies.referenced, ...dependencies.after]) {
    const depState = stateByStepId.get(dep);
    const isReferenced = dependencies.referenced.includes(dep);
    if (depState === 'failed' || (isReferenced && depState !== 'completed')) {
      blockedBy.add(dep);
    }
  }
  if (blockedBy.size > 0) status.blockedBy = [...blockedBy];

  // Completed without a proof receipt -> flag as stale so the agent doesn't trust it.
  if (state === 'completed') {
    const output = isRecord(runtime?.output) ? runtime.output : {};
    const hasProof =
      typeof output.transactionHash === 'string' ||
      typeof output.claimId === 'string' ||
      typeof runtime?.claimId === 'string';
    if (!hasProof) status.stale = true;
  }
  return status;
}

/**
 * Assemble a FlowSpec from a connected flow-room Y.Doc. Returns null when the
 * doc holds no compiled flow (caller surfaces `flow_not_found`).
 */
export function readFlowSpec(doc: YDoc, ref: string): FlowSpecRead | null {
  const compiled = readCompiledStructure(doc);
  if (!compiled) return null;

  // Per-block props, keyed by block id.
  const fragment = doc.getXmlFragment('document');
  const propsByBlockId = new Map<string, Record<string, unknown>>();
  for (const block of collectAllBlocks(fragment)) {
    propsByBlockId.set(block.id, extractBlockProperties(block));
  }

  const runtimeByBlockId = readRuntimeState(doc);
  const blockToStep = new Map<string, string>();
  for (const [nodeId, blockId] of Object.entries(compiled.blockIndex)) {
    blockToStep.set(blockId, nodeId);
  }
  const resolveStep = (blockId: string): string =>
    blockToStep.get(blockId) ?? blockId;

  // First pass: assemble each step (without status) + record raw runtime state.
  const steps: FlowStepRead[] = [];
  const runtimeByStep = new Map<string, Record<string, unknown> | undefined>();
  const dependenciesByStep = new Map<
    string,
    { referenced: string[]; after: string[] }
  >();
  const stateByStepId = new Map<string, StepState>();

  for (const nodeId of compiled.order) {
    const node = compiled.nodes[nodeId];
    if (!node) continue;
    const blockId = compiled.blockIndex[nodeId];
    const props = (blockId && propsByBlockId.get(blockId)) || {};
    const runtime = blockId ? runtimeByBlockId[blockId] : undefined;

    const inputs = nbToFriendlyInputs(asObject(props.inputs));
    const conditions = parseConditionsProp(props.conditions, resolveStep);

    const step: FlowStepRead = {
      id: nodeId,
      action: node.registryType ?? canToAction(node.can),
    };
    if (node.title && node.title !== node.can) step.title = node.title;
    if (node.description) step.description = node.description;
    if (inputs) step.inputs = inputs;
    if (conditions.length === 1 && conditions[0]) step.runWhen = conditions[0];
    else if (conditions.length > 1) step.conditions = conditions;

    const trigger = parseTriggerProp(props.trigger);
    if (
      trigger?.type === 'block.event' &&
      trigger.sourceBlockId &&
      trigger.eventName
    ) {
      step.onEvent = {
        fromStep: trigger.sourceBlockId,
        event: trigger.eventName,
      };
    } else if (trigger?.type === 'flow.start') {
      step.trigger = 'flow-start';
    }

    const due: { at?: string; within?: string } = {};
    const at = asString(props.ttlAbsoluteDueDate);
    const within = asString(props.ttlFromEnablement);
    if (at) due.at = at;
    if (within) due.within = within;
    if (Object.keys(due).length > 0) step.due = due;
    const commitTo = asString(props.ttlFromCommitment);
    if (commitTo) step.commitTo = commitTo;

    // The assignee lives in props.assignment (what the portal reads); fall back
    // to the authorisedActors whitelist for flows authored before that split.
    const assignTo =
      assigneeFrom(props.assignment) ?? firstActor(props.authorisedActors);
    if (assignTo) step.assignTo = assignTo;

    if (
      props.requiresConfirmation === 'true' ||
      props.requiresConfirmation === true
    ) {
      step.requireConfirmation = true;
    }

    steps.push(step);
    runtimeByStep.set(nodeId, runtime);
    stateByStepId.set(nodeId, asStepState(runtime?.state) ?? 'idle');
    dependenciesByStep.set(nodeId, {
      referenced: referencedSteps(inputs),
      after: [],
    });
  }

  // Second pass: now that every step's state is known, compute status.
  for (const step of steps) {
    step.status = computeStatus(
      runtimeByStep.get(step.id),
      dependenciesByStep.get(step.id) ?? { referenced: [], after: [] },
      stateByStepId,
    );
  }

  const result: FlowSpecRead = { ref, title: compiled.meta.title, steps };
  if (compiled.meta.goal) result.goal = compiled.meta.goal;
  return result;
}

/** Read a single step (with status) from a connected doc. */
export function readStep(
  doc: YDoc,
  ref: string,
  stepId: string,
): FlowStepRead | null {
  const flow = readFlowSpec(doc, ref);
  return flow?.steps.find((s) => s.id === stepId) ?? null;
}

/** Read just the per-step status (the `flow_status` projection). */
export function readFlowStatus(
  doc: YDoc,
  ref: string,
): Array<{ id: string } & StepStatus> | null {
  const flow = readFlowSpec(doc, ref);
  if (!flow) return null;
  return flow.steps.map((s) => ({
    id: s.id,
    ...(s.status ?? { state: 'idle' as const }),
  }));
}
