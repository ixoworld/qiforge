import { z } from 'zod';
import { tool } from '../plugin-api/tool-helper.js';
import type { PluginManifest, PluginTool } from '../plugin-api/types.js';
import type { ManifestRegistry } from '../registries/manifest-registry.js';

/**
 * Schema accepted by `list_capabilities`.
 *
 * `includeOnDemand` defaults `true` because the agent normally wants to see
 * everything it could load. `includeSilent` defaults `false` because silent
 * plugins are not loadable and are kept out of the agent's view.
 */
const listCapabilitiesSchema = z.object({
  includeOnDemand: z.boolean().default(true),
  includeSilent: z.boolean().default(false),
});

interface CapabilityListing {
  name: string;
  summary: string;
  visibility: NonNullable<PluginManifest['visibility']>;
  loaded: boolean;
  category?: PluginManifest['category'];
  tags: string[];
}

/**
 * Build the `list_capabilities` meta-tool.
 *
 * Returns one entry per loaded plugin, with a `loaded` flag that combines
 * the boot-time always-on plugins (`visibility === 'always'`) with the set
 * of plugins the agent has explicitly loaded for this thread (the
 * `loadedPlugins` state field).
 */
export function buildListCapabilitiesTool(
  manifestRegistry: ManifestRegistry,
): PluginTool {
  return tool(
    async (args, ctx) => {
      const { includeOnDemand, includeSilent } =
        listCapabilitiesSchema.parse(args);

      const loadedSet = ctx.loadedPlugins ?? new Set<string>();

      const out: CapabilityListing[] = [];
      for (const { pluginName, manifest } of manifestRegistry.collect()) {
        const visibility: NonNullable<PluginManifest['visibility']> =
          manifest.visibility ?? 'on-demand';

        if (visibility === 'silent' && !includeSilent) continue;
        if (visibility === 'on-demand' && !includeOnDemand) continue;

        out.push({
          name: pluginName,
          summary: manifest.summary,
          visibility,
          loaded: visibility === 'always' || loadedSet.has(pluginName),
          category: manifest.category,
          tags: manifest.tags ?? [],
        });
      }
      if (ctx.logger && typeof ctx.logger.debug === 'function') {
        ctx.logger.debug(
          `[listCapabilities] includeOnDemand: ${includeOnDemand} | includeSilent: ${includeSilent} | loadedSet: ${Array.from(loadedSet).join(', ')} | results: ${out.length}`,
        );
      }

      return out;
    },
    {
      name: 'list_capabilities',
      description: 'List all available capabilities and their summaries.',
      schema: listCapabilitiesSchema,
    },
  );
}
