import type { PluginTool } from '../plugin-api/types.js';
import type { ManifestRegistry } from '../registries/manifest-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';
import { buildFindCapabilityTool } from './find-capability.js';
import { buildLoadCapabilityTool } from './load-capability.js';
import { buildListCapabilitiesTool } from './list-capabilities.js';
import { buildListCapabilityDetailsTool } from './list-capability-details.js';

/**
 * Inputs for `buildMetaTools`. The runtime passes its already-collected
 * registries; the meta-tools read manifests and tool descriptors from them.
 */
export interface BuildMetaToolsOptions {
  manifestRegistry: ManifestRegistry;
  toolRegistry: ToolRegistry;
}

/**
 * Build the four meta-tools the agent always has, regardless of which
 * plugins are loaded:
 *
 *  - `find_capability`         — search manifests by intent/topic
 *  - `load_capability`         — mark a plugin as loaded for this thread
 *  - `list_capabilities`       — list every visible plugin with status flags
 *  - `list_capability_details` — full manifest + tool list for one plugin
 *
 * These tools are internal: registered by the runtime in `createMainAgent`,
 * never exported on the public package surface, and not authorable by
 * plugins.
 */
export function buildMetaTools(opts: BuildMetaToolsOptions): PluginTool[] {
  const { manifestRegistry, toolRegistry } = opts;
  return [
    buildFindCapabilityTool(manifestRegistry),
    buildLoadCapabilityTool(manifestRegistry, toolRegistry),
    buildListCapabilitiesTool(manifestRegistry),
    buildListCapabilityDetailsTool(manifestRegistry, toolRegistry),
  ];
}

export { buildFindCapabilityTool } from './find-capability.js';
export { buildLoadCapabilityTool } from './load-capability.js';
export { buildListCapabilitiesTool } from './list-capabilities.js';
export { buildListCapabilityDetailsTool } from './list-capability-details.js';
