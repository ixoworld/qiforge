import type { PluginTool } from '../plugin-api/types.js';
import type { ManifestRegistry } from '../registries/manifest-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';
import { buildLoadCapabilityTool } from './load-capability.js';
import { buildListCapabilitiesTool } from './list-capabilities.js';

/**
 * Inputs for `buildMetaTools`. The runtime passes its already-collected
 * registries; the meta-tools read manifests and tool descriptors from them.
 */
export interface BuildMetaToolsOptions {
  manifestRegistry: ManifestRegistry;
  toolRegistry: ToolRegistry;
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
  const { manifestRegistry, toolRegistry } = opts;
  return [
    buildLoadCapabilityTool(manifestRegistry, toolRegistry),
    buildListCapabilitiesTool(manifestRegistry),
  ];
}

export { buildLoadCapabilityTool } from './load-capability.js';
export { buildListCapabilitiesTool } from './list-capabilities.js';
