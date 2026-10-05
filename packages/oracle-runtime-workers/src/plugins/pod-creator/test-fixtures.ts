/**
 * Shared fixtures for the pod-creator test suites. Not part of the public
 * surface (excluded from the published files).
 */
import type { PluginTool } from '../../plugin-api/types';
import type { BlueprintStore } from './blueprint-store';
import type { BlueprintSection } from './blueprint-types';
import { DESIGN_POD_ROLES } from './design-pod-roles';

export const ISO = '2026-06-12T00:00:00.000Z';

/** The default thread of `makeRuntimeContext()`. */
export const THREAD = 'session-1';

/** The default user of `makeRuntimeContext()`. */
export const USER = 'did:ixo:user1';

export function byName(tools: readonly PluginTool[], name: string): PluginTool {
  const found = tools.find((t) => t.name === name);
  if (!found) {
    throw new Error(`tool ${name} not found`);
  }
  return found;
}

/**
 * Seed sections the way production does — through the specialists' write
 * path. Every listed role passes unless named in `failing`.
 */
export async function seedRoles(
  store: BlueprintStore,
  thread: string,
  roleIds: readonly string[],
  failing: readonly string[] = [],
): Promise<void> {
  for (const role of DESIGN_POD_ROLES) {
    if (!roleIds.includes(role.id)) {
      continue;
    }
    const section: BlueprintSection = {
      role: role.id,
      stage: role.stage,
      content: { ok: true },
      recordedAt: ISO,
      verdict: failing.includes(role.id) ? 'fail' : 'pass',
    };
    await store.putSection(thread, section);
  }
}

/** Every role id, in catalogue order. */
export const ALL_ROLE_IDS: readonly string[] = DESIGN_POD_ROLES.map(
  (role) => role.id,
);
