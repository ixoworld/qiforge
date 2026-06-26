/**
 * Action catalog access. Wraps the editor registry (`getAllActions`/`getAction`/
 * `getActionByCan`) and merges the plugin-side metadata overlay (action-metadata.ts)
 * to power discovery (`list_actions`/`describe_action`) and the event-capability
 * validation that `onEvent` relies on (spec §2.3).
 *
 * The `action` identifier exposed to the agent is the registry `type` (e.g.
 * "qi/email.send") — never the `can` (leak guard, §1).
 */
import type { ActionDefinition, OutputSchemaField } from '@ixo/editor/core';
import { getAllActions, getAction, getActionByCan } from '@ixo/editor/core';
import { ACTION_METADATA, type OverlayEntry } from './action-metadata.js';

/** The lifecycle hook types any step can attach via `on` (spec Appendix A.4). */
export const HOOK_TYPES = [
  'sendEmail',
  'addLinkedEntity',
  'sendMatrixDM',
] as const;

export interface ActionSummary {
  action: string;
  summary: string;
  whenToUse: string[];
  tags: string[];
}

export interface ActionField {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
}

export interface ActionEvent {
  name: string;
  displayName?: string;
  description?: string;
}

export interface ActionDescription {
  action: string;
  summary: string;
  whenToUse: string[];
  whenNotToUse: string[];
  inputs: ActionField[];
  /**
   * Whether this action's input requirements are known. False means the field
   * list above is NOT authoritative — the agent must ask the user what the step
   * needs rather than assume it takes no inputs.
   */
  inputsDeclared: boolean;
  outputs: ActionField[];
  events: ActionEvent[];
  hooks: string[];
  isForm: boolean;
  requiresConfirmation: boolean;
}

/** Resolve a friendly `action` (registry type, or a `can`) to its definition. */
export function getActionDef(action: string): ActionDefinition | undefined {
  return getAction(action) ?? getActionByCan(action);
}

function overlayFor(def: ActionDefinition): OverlayEntry {
  return ACTION_METADATA[def.type] ?? {};
}

/** The action's event vocabulary (static `events`, falling back to none). */
export function eventNamesFor(def: ActionDefinition): string[] {
  return (def.events ?? []).map((e: { name: string }) => e.name);
}

/**
 * Whether `onEvent` can target this action as a source (spec §2.3): it must be
 * `eligibleForEventTrigger` AND declare at least one event.
 */
export function isEventCapable(def: ActionDefinition): boolean {
  if (!def.eligibleForEventTrigger) return false;
  return (
    (def.events?.length ?? 0) > 0 || typeof def.getDynamicEvents === 'function'
  );
}

/**
 * Whether a step is a human-form action (`qi/form.submit` / `qi/human.form.submit`
 * and friends). Form steps need special output handling: they emit one bundled
 * `answers` object rather than per-field outputs, so discovery + linkage expand
 * the individual question paths separately (see `formOutputFields`).
 */
export function isFormAction(def: ActionDefinition): boolean {
  return def.can === 'human/form' || /form|survey/i.test(def.type);
}

type InputSchemaShape =
  | {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    }
  | undefined;

/** Whether we have any authoritative input-requirement data for this action. */
function hasDeclaredInputs(
  def: ActionDefinition,
  overlay: OverlayEntry,
): boolean {
  if ((overlay.inputPorts?.length ?? 0) > 0) return true;
  return !!(def.inputSchema as InputSchemaShape)?.properties;
}

/**
 * The action's input fields. The registry's `inputSchema` is the single source
 * of truth for requirements (each action declares its required inputs); the
 * overlay's `inputPorts` are only a fallback for an action that ships none.
 * Empty when neither is present — pair with `hasDeclaredInputs` so callers know
 * the difference between "no inputs" and "inputs unknown".
 */
function inputFields(
  def: ActionDefinition,
  overlay: OverlayEntry,
): ActionField[] {
  const schema = def.inputSchema as InputSchemaShape;
  const props = schema?.properties;
  if (props) {
    const required = new Set(schema?.required ?? []);
    return Object.entries(props).map(([name, spec]) => ({
      name,
      type: typeof spec?.type === 'string' ? spec.type : 'unknown',
      required: required.has(name),
      description: spec?.description,
    }));
  }
  if (overlay.inputPorts && overlay.inputPorts.length > 0) {
    return overlay.inputPorts.map((p) => ({
      name: p.path,
      type: p.portType,
      required: p.required ?? false,
      description: p.description,
    }));
  }
  return [];
}

function outputFields(def: ActionDefinition): ActionField[] {
  const out: OutputSchemaField[] | undefined = def.outputSchema;
  if (!out) return [];
  return out.map((f) => ({
    name: f.path,
    type: f.type,
    description: f.description,
  }));
}

export function listActions(filter?: {
  category?: string;
  tag?: string;
}): ActionSummary[] {
  const result: ActionSummary[] = [];
  for (const def of getAllActions()) {
    const overlay = overlayFor(def);
    if (filter?.tag && !(overlay.tags ?? []).includes(filter.tag)) continue;
    result.push({
      action: def.type,
      summary: overlay.summary ?? '',
      whenToUse: overlay.whenToUse ?? [],
      tags: overlay.tags ?? [],
    });
  }
  return result.sort((a, b) => a.action.localeCompare(b.action));
}

export function describeAction(action: string): ActionDescription | null {
  const def = getActionDef(action);
  if (!def) return null;
  const overlay = overlayFor(def);
  return {
    action: def.type,
    summary: overlay.summary ?? '',
    whenToUse: overlay.whenToUse ?? [],
    whenNotToUse: overlay.whenNotToUse ?? [],
    inputs: inputFields(def, overlay),
    inputsDeclared: hasDeclaredInputs(def, overlay),
    outputs: outputFields(def),
    events: (def.events ?? []).map(
      (e: { name: string; displayName?: string; description?: string }) => ({
        name: e.name,
        displayName: e.displayName,
        description: e.description,
      }),
    ),
    hooks: [...HOOK_TYPES],
    isForm: isFormAction(def),
    requiresConfirmation: def.defaultRequiresConfirmation,
  };
}

/** Sorted list of registry action types — the drift canary's stable surface (§7.0). */
export function actionsSnapshot(): string[] {
  return getAllActions()
    .map((d) => d.type)
    .sort((a, b) => a.localeCompare(b));
}
