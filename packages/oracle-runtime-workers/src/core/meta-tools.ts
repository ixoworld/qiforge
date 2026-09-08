import { z } from 'zod';
import { Command } from '@langchain/langgraph';
import { ToolMessage } from '@langchain/core/messages';
import { tool } from '../plugin-api/tool-helper';
import type { PluginManifest, PluginTool } from '../plugin-api/types';
import type { ManifestRegistry, ToolRegistry } from './registries';
import { acquireToolLock } from './utils';

// ── list_capabilities ───────────────────────────────────────────────────────

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
 * of plugins the agent has explicitly loaded for this thread.
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
      ctx.logger.debug?.(
        `[listCapabilities] includeOnDemand: ${includeOnDemand} | includeSilent: ${includeSilent} | loadedSet: ${Array.from(loadedSet).join(', ')} | results: ${out.length}`,
      );

      // Return a JSON string — LangChain's `tool()` mis-handles a raw array
      // return (the `[content, artifact]` heuristic can drop the content).
      return JSON.stringify(out);
    },
    {
      name: 'list_capabilities',
      description: 'List all available capabilities and their summaries.',
      schema: listCapabilitiesSchema,
    },
  );
}

// ── load_capability ─────────────────────────────────────────────────────────

const loadCapabilitySchema = z.object({
  names: z
    .array(z.string())
    .min(1)
    .describe(
      'One or more capability names to load, as returned by list_capabilities.',
    ),
});

interface ToolDetail {
  name: string;
  description: string;
}

interface LoadCapabilityResult extends PluginManifest {
  /**
   * `true` when the plugin was already loaded (or has `visibility: 'always'`),
   * `false` when this call moved it into the loaded set.
   */
  alreadyAvailable: boolean;
  /** One entry per tool the plugin contributes. */
  tools: ToolDetail[];
}

/**
 * Build the `load_capability` meta-tool.
 *
 * Accepts an array of plugin names so the agent can batch all needed
 * capabilities into a single call. A per-session lock ensures the tool
 * cannot be invoked in parallel — concurrent calls throw immediately.
 *
 * Behavior per name:
 *  - Unknown plugin → throws, instructing the agent to call
 *    `list_capabilities` first.
 *  - `silent` plugin → throws (silent plugins are not agent-loadable).
 *  - Plugin already loaded, or visibility is `always` → included in result
 *    with `alreadyAvailable: true` (no state change for that plugin).
 *  - Otherwise → added to the `loadedPlugins` state update.
 *
 * Return value:
 *  - If all requested plugins were already available: returns the result
 *    array directly (no state change).
 *  - If any are new: returns a LangGraph `Command` whose update appends
 *    all new plugins to `loadedPlugins` AND emits a `ToolMessage` carrying
 *    the full result array so the agent sees it on the same turn.
 */
export function buildLoadCapabilityTool(
  manifestRegistry: ManifestRegistry,
  toolRegistry: ToolRegistry,
): PluginTool {
  return tool(
    async (args, ctx) => {
      const { names } = loadCapabilitySchema.parse(args);

      const releaseLock = acquireToolLock(`${ctx.session.id}:load_capability`);
      try {
        const results: LoadCapabilityResult[] = [];
        const newToLoad: string[] = [];

        for (const name of names) {
          const entry = manifestRegistry
            .collect()
            .find((m) => m.pluginName === name);

          if (!entry) {
            throw new Error(
              `Capability "${name}" does not exist. Call list_capabilities first to discover available plugins.`,
            );
          }

          if (entry.manifest.visibility === 'silent') {
            throw new Error(
              `Capability "${name}" is internal and cannot be loaded by the agent. Call list_capabilities first to discover loadable plugins.`,
            );
          }

          const tools: ToolDetail[] = toolRegistry
            .toolSummariesForPlugin(name)
            .map((t) => ({
              name: t.name,
              description: t.description,
            }));

          const alreadyLoaded = ctx.loadedPlugins?.has(name) === true;
          const alwaysVisible = entry.manifest.visibility === 'always';
          const alreadyAvailable = alreadyLoaded || alwaysVisible;

          results.push({ ...entry.manifest, alreadyAvailable, tools });

          if (!alreadyAvailable) {
            newToLoad.push(name);
          }
        }

        if (newToLoad.length === 0) {
          return results;
        }

        const update: Record<string, unknown> = {
          loadedPlugins: newToLoad,
        };
        if (ctx.toolCallId) {
          update.messages = [
            new ToolMessage({
              content: JSON.stringify(results),
              tool_call_id: ctx.toolCallId,
            }),
          ];
        }
        return new Command({ update });
      } finally {
        releaseLock();
      }
    },
    {
      name: 'load_capability',
      description:
        "Load one or more capabilities for the rest of this conversation. Pass all capabilities you need in a single call — batching is preferred over multiple calls. The response is an array of plugin manifests plus tool lists; after this call, the new capabilities' tools are usable on the next model step.",
      schema: loadCapabilitySchema,
    },
  );
}

// ── Bundle ──────────────────────────────────────────────────────────────────

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
 *                          the plugin's full manifest + tool list.
 *  - `list_capabilities` — list every visible plugin with status flags.
 */
export function buildMetaTools(opts: BuildMetaToolsOptions): PluginTool[] {
  const { manifestRegistry, toolRegistry } = opts;
  return [
    buildLoadCapabilityTool(manifestRegistry, toolRegistry),
    buildListCapabilitiesTool(manifestRegistry),
  ];
}
