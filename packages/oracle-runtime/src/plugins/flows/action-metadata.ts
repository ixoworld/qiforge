/**
 * Plugin-side action-metadata overlay (spec §5, §7.5). A map keyed by action
 * `type` that enriches the bare editor registry with friendly descriptions,
 * tags, typed ports, and prerequisites — merged with `getAllActions()` at
 * runtime, never editing `ActionDefinition`.
 *
 * The overlay is seeded against the committed `getAllActions()` snapshot in
 * PR 3 (forms & linkage). Until then it is empty and discovery/linkage fall
 * back to the registry's primitive schemas.
 */
export interface ActionPort {
  path: string;
  portType: string;
  required?: boolean;
}

export interface ActionRequirement {
  kind: string;
  description: string;
}

export interface OverlayEntry {
  summary?: string;
  whenToUse?: string[];
  whenNotToUse?: string[];
  tags?: string[];
  inputPorts?: ActionPort[];
  outputPorts?: ActionPort[];
  requires?: ActionRequirement[];
}

/** Keyed by action `type` (e.g. "qi/email.send"). Seeded in PR 3. */
export const ACTION_METADATA: Record<string, OverlayEntry> = {};
