import type { AgAction } from '../../hooks/use-ag-action.js';

/** Add `action`, or replace the registered action of the same name in place. */
export function upsertAgAction(
  actions: readonly AgAction[],
  action: AgAction,
): AgAction[] {
  return actions.some((a) => a.name === action.name)
    ? actions.map((a) => (a.name === action.name ? action : a))
    : [...actions, action];
}

/**
 * The registered actions the agent may see: the ones sent with each turn as
 * `agActions`. An action registered with `exposeToAgent: false` stays
 * executable over the socket but is left out here.
 */
export function agentVisibleAgActions(
  actions: readonly AgAction[],
): AgAction[] {
  return actions.filter((action) => action.exposeToAgent !== false);
}
