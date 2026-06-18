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

function isFormAction(def: ActionDefinition): boolean {
  return def.can === 'human/form' || /form|survey/i.test(def.type);
}

/** Surface a JSON-schema-ish input schema as a flat field list (best-effort). */
function inputFields(def: ActionDefinition): ActionField[] {
  const schema = def.inputSchema as
    | { properties?: Record<string, { type?: string; description?: string }> }
    | undefined;
  const props = schema?.properties;
  if (!props) return [];
  return Object.entries(props).map(([name, spec]) => ({
    name,
    type: typeof spec?.type === 'string' ? spec.type : 'unknown',
    description: spec?.description,
  }));
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
    inputs: inputFields(def),
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
