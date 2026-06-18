/**
 * Field references (spec §2.4, the `list_referenceable_fields` discovery tool).
 * Returns the friendly output fields a step can pipe from its upstream steps,
 * so the agent never has to guess a "{{step.output.field}}" string.
 */
import type { Doc as YDoc } from 'yjs';
import { getActionDef } from './actions.js';
import { ACTION_METADATA } from './action-metadata.js';
import { readFlowSpec } from './read.js';

export interface ReferenceableField {
  fromStep: string;
  field: string;
  type: string;
}

/**
 * Output fields available to `stepId` — gathered from every step ahead of it in
 * the flow (their outputs may be produced before this step runs). Uses the
 * action's output schema, enriched by the metadata overlay's output ports.
 */
export function listReferenceableFields(
  doc: YDoc,
  ref: string,
  stepId: string,
): ReferenceableField[] {
  const flow = readFlowSpec(doc, ref);
  if (!flow) return [];

  const index = flow.steps.findIndex((s) => s.id === stepId);
  const upstream =
    index >= 0
      ? flow.steps.slice(0, index)
      : flow.steps.filter((s) => s.id !== stepId);

  const out: ReferenceableField[] = [];
  for (const step of upstream) {
    const def = getActionDef(step.action);
    const overlayPorts = ACTION_METADATA[step.action]?.outputPorts ?? [];
    for (const port of overlayPorts) {
      out.push({ fromStep: step.id, field: port.path, type: port.portType });
    }
    for (const field of def?.outputSchema ?? []) {
      if (!overlayPorts.some((p) => p.path === field.path)) {
        out.push({ fromStep: step.id, field: field.path, type: field.type });
      }
    }
  }
  return out;
}
