/**
 * Typed wiring checks (spec §3.2). Powered by the action output schemas + the
 * port-type inference (port-types.ts) and the metadata overlay (§7.5).
 *
 * Input ports aren't shipped by the registry, so `check_link`'s primary job is
 * catching a reference to an output field a step doesn't actually produce; it
 * additionally rejects a type mismatch when both sides resolve to a known core
 * port type (the input side via an overlay entry).
 */
import type { Doc as YDoc } from 'yjs';
import type { ActionDefinition } from '@ixo/editor/core';
import { getAllActions } from '@ixo/editor/core';
import { ACTION_METADATA, type ActionRequirement } from './action-metadata.js';
import { getActionDef, isFormAction } from './actions.js';
import { formOutputFields } from './forms.js';
import { inferPortType, isCorePortType } from './port-types.js';
import { readFlowSpec } from './read.js';

export interface LinkCheck {
  ok: boolean;
  reason?: string;
  warning?: string;
}

export interface CompatibleProducer {
  action: string;
  field: string;
  type: string;
}

/** Output port type for a field of an action: overlay override, else inference. */
function outputPortType(
  def: ActionDefinition,
  field: string,
): string | undefined {
  const overlay = ACTION_METADATA[def.type]?.outputPorts?.find(
    (p) => p.path === field,
  );
  if (overlay) return overlay.portType;
  const out = def.outputSchema?.find(
    (f: { path: string; type: string }) => f.path === field,
  );
  return out ? inferPortType(field, out.type) : undefined;
}

/** Declared input port type for an action's input — only available from the overlay. */
function overlayInputPortType(
  actionType: string,
  input: string,
): string | undefined {
  return ACTION_METADATA[actionType]?.inputPorts?.find((p) => p.path === input)
    ?.portType;
}

/** The port type an input expects: overlay if declared, else inferred from the input name. */
function expectedInputType(actionType: string, input: string): string {
  return overlayInputPortType(actionType, input) ?? inferPortType(input);
}

/** Can `fromStep.field` feed `toStep.input`? */
export function checkLink(
  doc: YDoc,
  ref: string,
  fromStep: string,
  field: string,
  toStep: string,
  input: string,
): LinkCheck {
  const flow = readFlowSpec(doc, ref);
  if (!flow) return { ok: false, reason: 'That flow does not exist.' };

  const from = flow.steps.find((s) => s.id === fromStep);
  const to = flow.steps.find((s) => s.id === toStep);
  if (!from)
    return { ok: false, reason: `No step "${fromStep}" in this flow.` };
  if (!to) return { ok: false, reason: `No step "${toStep}" in this flow.` };

  const fromDef = getActionDef(from.action);
  if (!fromDef)
    return { ok: false, reason: `Step "${fromStep}" has an unknown action.` };

  let outType = outputPortType(fromDef, field);
  // A form step's outputSchema only declares the bundled `answers`/`form.answers`
  // ports, so the individual `answers.<questionName>` paths fall through here.
  // Validate them against the step's actual survey schema and infer the type.
  if (outType === undefined && isFormAction(fromDef)) {
    outType = formOutputFields(doc, fromStep).find(
      (f) => f.field === field,
    )?.type;
  }
  if (outType === undefined) {
    return {
      ok: false,
      reason: `Step "${fromStep}" does not produce an output field "${field}".`,
    };
  }

  // Input side is only typed when the overlay declares it; otherwise accept and note.
  const declaredInput = overlayInputPortType(to.action, input);
  if (declaredInput === undefined) {
    return {
      ok: true,
      warning: `"${input}" has no declared type, so the value type was not verified.`,
    };
  }
  if (outType === declaredInput) return { ok: true };
  if (isCorePortType(outType) && isCorePortType(declaredInput)) {
    return {
      ok: false,
      reason: `Type mismatch: "${field}" is ${outType} but "${input}" expects ${declaredInput}.`,
    };
  }
  return {
    ok: true,
    warning: `Could not confirm ${outType} is compatible with ${declaredInput}.`,
  };
}

/** Actions (and the field) that produce a value compatible with a step's input. */
export function compatibleActions(
  doc: YDoc,
  ref: string,
  stepId: string,
  forInput: string,
): CompatibleProducer[] {
  const flow = readFlowSpec(doc, ref);
  const step = flow?.steps.find((s) => s.id === stepId);
  const wanted = step
    ? expectedInputType(step.action, forInput)
    : inferPortType(forInput);

  const out: CompatibleProducer[] = [];
  for (const def of getAllActions()) {
    for (const f of def.outputSchema ?? []) {
      const type = outputPortType(def, f.path);
      if (type === wanted) out.push({ action: def.type, field: f.path, type });
    }
  }
  return out;
}

/** Declarative prerequisites of an action (overlay-backed). */
export function requirements(action: string): ActionRequirement[] {
  const def = getActionDef(action);
  if (!def) return [];
  return ACTION_METADATA[def.type]?.requires ?? [];
}
