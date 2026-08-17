import { z } from 'zod';
import { Command } from '@langchain/langgraph';
import { ToolMessage } from '@langchain/core/messages';
import { tool } from '../plugin-api/tool-helper.js';
import type { PluginManifest, PluginTool } from '../plugin-api/types.js';
import type { ManifestRegistry } from '../registries/manifest-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';
import { acquireToolLock } from '../utils/tool-lock.js';

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
