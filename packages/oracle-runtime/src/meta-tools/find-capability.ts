import { z } from 'zod';
import { tool } from '../plugin-api/tool-helper.js';
import type { PluginTool } from '../plugin-api/types.js';
import type { ManifestRegistry } from '../registries/manifest-registry.js';
import {
  buildSearchIndex,
  type SearchEntry,
  type SearchResult,
} from '../manifest/search.js';

/**
 * Schema accepted by `find_capability`. Pure descriptor — the runtime is
 * responsible for converting it into LangChain's tool calling convention.
 */
const findCapabilitySchema = z.object({
  query: z.string(),
  limit: z.number().int().default(5),
});

/**
 * Build the `find_capability` meta-tool.
 *
 * Searches the manifests of plugins with visibility `'always'` or
 * `'on-demand'` (silent plugins are excluded by `buildSearchIndex`) and
 * returns ranked hits. The agent uses these names to call `load_capability`.
 *
 * The search index is constructed once at boot from the registered manifests.
 * Manifests are immutable after boot, so a single index serves every call.
 */
export function buildFindCapabilityTool(
  manifestRegistry: ManifestRegistry,
): PluginTool {
  const entries: SearchEntry[] = manifestRegistry
    .collect()
    .map(({ pluginName, manifest }) => ({ pluginName, manifest }));
  const index = buildSearchIndex(entries);

  return tool(
    async (args) => {
      const { query, limit } = findCapabilitySchema.parse(args);
      const results: SearchResult[] = index.query(query, limit);
      return results;
    },
    {
      name: 'find_capability',
      description:
        'Search for a capability by user intent or topic. Returns ranked plugin matches you can then load with load_capability.',
      schema: findCapabilitySchema,
    },
  );
}
