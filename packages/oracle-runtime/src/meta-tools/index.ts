import type { PluginTool } from '../plugin-api/types.js';
import type { ManifestRegistry } from '../registries/manifest-registry.js';
import type { RegisteredTool } from '../registries/tool-registry.js';
import { buildLoadCapabilityTool } from './load-capability.js';
import { buildListCapabilitiesTool } from './list-capabilities.js';

/**
 * Inputs for `buildMetaTools`. The manifests come from the boot-scoped
 * registry; the tool descriptors are THIS REQUEST's collected list, passed
 * as a value so one user's request-time tools can never leak into another
 * user's `load_capability` listing through shared registry state.
 */
export interface BuildMetaToolsOptions {
  manifestRegistry: ManifestRegistry;
  collectedTools: readonly RegisteredTool[];
}

/**
 * Build the two meta-tools the agent always has, regardless of which
 * plugins are loaded:
 *
 *  - `load_capability`   — mark a plugin as loaded for this thread; returns
 *                          the plugin's full manifest + tool list, so the
 *                          agent gets discovery + load in one call.
 *  - `list_capabilities` — list every visible plugin with status flags.
 *
 * These tools are internal: registered by the runtime in `createMainAgent`,
 * never exported on the public package surface, and not authorable by
 * plugins.
 */
export function buildMetaTools(opts: BuildMetaToolsOptions): PluginTool[] {
  const { manifestRegistry, collectedTools } = opts;
  return [
    buildLoadCapabilityTool(manifestRegistry, collectedTools),
    buildListCapabilitiesTool(manifestRegistry),
  ];
}

export { buildLoadCapabilityTool } from './load-capability.js';
export { buildListCapabilitiesTool } from './list-capabilities.js';
