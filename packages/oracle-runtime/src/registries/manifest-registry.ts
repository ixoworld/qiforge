import {
  mergeManifestOverride,
  type PluginManifestOverride,
} from '../manifest/merge-override.js';
import { validateExamplesAgainstTools } from '../manifest/validator.js';
import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type { PluginManifest } from '../plugin-api/types.js';
import type { SubAgentRegistry } from './subagent-registry.js';
import type { ToolRegistry } from './tool-registry.js';

/** A collected manifest tagged with the plugin that contributed it. */
export interface RegisteredManifest {
  pluginName: string;
  manifest: PluginManifest;
}

/** Result of cross-checking every plugin's example tools against a ToolRegistry. */
export interface ManifestCrossCheckResult {
  errors: string[];
}

/**
 * Stores plugin manifests and wires the cross-tool-reference check that can
 * only run once tool registration is complete.
 *
 * Manifest titles can collide (display only); the registry does not block on
 * title duplication.
 */
export class ManifestRegistry {
  private readonly entries: RegisteredManifest[] = [];

  /**
   * Record a plugin's manifest. A fork-supplied `override` is merged shallowly
   * over the plugin's own manifest, so every downstream reader (`collect()`,
   * the Tier-1 renderer, the capability meta-tools, the agent's visibility
   * index) sees the effective manifest — the override is the single source of
   * truth from here on.
   */
  register(plugin: OraclePlugin, override?: PluginManifestOverride): void {
    this.entries.push({
      pluginName: plugin.name,
      manifest: mergeManifestOverride(plugin.manifest, override),
    });
  }

  /**
   * Plain-pass collect — returns the registered manifests in registration
   * order. Manifests are eagerly available on the plugin, so this method
   * accepts no context but matches the registry shape used elsewhere.
   */
  collect(): RegisteredManifest[] {
    return [...this.entries];
  }

  /**
   * For each registered manifest, validate that every `examples[].tool`
   * reference exists in the supplied registries. Sub-agents are first-class
   * tools to the agent — they get wrapped as `call_<name>` StructuredTools —
   * so the validator unions tool names with sub-agent wrapped names. Both
   * registries MUST have been collected and asserted before calling this.
   *
   * Returns the union of all per-plugin error strings — each entry is
   * prefixed with the plugin name and field path (delegated to
   * `validateExamplesAgainstTools`).
   */
  validateAgainstTools(
    toolRegistry: ToolRegistry,
    subAgentRegistry: SubAgentRegistry,
  ): ManifestCrossCheckResult {
    const errors: string[] = [];
    for (const { pluginName, manifest } of this.entries) {
      const toolNames = [
        ...toolRegistry.toolNamesForPlugin(pluginName),
        ...subAgentRegistry.subAgentNamesForPlugin(pluginName),
      ];
      const result = validateExamplesAgainstTools(
        manifest,
        toolNames,
        pluginName,
      );
      errors.push(...result.errors);
    }
    return { errors };
  }

  /**
   * Manifest title collisions are display-only, so this is a no-op. Provided
   * for a uniform registry surface.
   */
  assertNoCollisions(): void {
    // Intentional no-op — title collisions warned at the loader level.
  }
}
