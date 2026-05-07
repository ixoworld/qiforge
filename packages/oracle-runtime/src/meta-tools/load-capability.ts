import { z } from 'zod';
import { Command } from '@langchain/langgraph';
import { tool } from '../plugin-api/tool-helper.js';
import type { PluginTool } from '../plugin-api/types.js';
import type { ManifestRegistry } from '../registries/manifest-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';

/**
 * Schema accepted by `load_capability`. The agent supplies the plugin name
 * returned by `find_capability` (or `list_capabilities`).
 */
const loadCapabilitySchema = z.object({
  name: z.string(),
});

interface ToolSummary {
  name: string;
  description: string;
}

/**
 * Build the `load_capability` meta-tool.
 *
 * Marks a plugin as loaded for the current thread. The next graph build will
 * include the plugin's tools, making them callable by the agent.
 *
 * Behavior:
 *  - Unknown plugin → throws, instructing the agent to call
 *    `find_capability` first.
 *  - `silent` plugin → throws (silent plugins are not agent-loadable).
 *  - Plugin already loaded, or visibility is `always` → returns
 *    `{ alreadyAvailable: true, tools }` without changing state.
 *  - Otherwise → returns a LangGraph `Command` whose `update.loadedPlugins`
 *    appends the plugin name. The state reducer is a set-union, so duplicate
 *    appends are absorbed.
 */
export function buildLoadCapabilityTool(
  manifestRegistry: ManifestRegistry,
  toolRegistry: ToolRegistry,
): PluginTool {
  return tool(
    async (args, ctx) => {
      const { name } = loadCapabilitySchema.parse(args);

      const entry = manifestRegistry
        .collect()
        .find((m) => m.pluginName === name);

      if (!entry) {
        throw new Error(
          `Capability "${name}" does not exist. Call find_capability first to discover available plugins.`,
        );
      }

      if (entry.manifest.visibility === 'silent') {
        throw new Error(
          `Capability "${name}" is internal and cannot be loaded by the agent. Call find_capability first to discover loadable plugins.`,
        );
      }

      const tools: ToolSummary[] = toolRegistry
        .toolsForPlugin(name)
        .map((t) => ({ name: t.name, description: t.description }));

      const alreadyLoaded = ctx.loadedPlugins?.has(name) === true;
      const alwaysVisible = entry.manifest.visibility === 'always';

      if (alreadyLoaded || alwaysVisible) {
        return { alreadyAvailable: true, tools };
      }

      return new Command({
        update: {
          loadedPlugins: [name],
        },
      });
    },
    {
      name: 'load_capability',
      description:
        "Load a capability for the rest of this conversation. After loading, the capability's tools are usable.",
      schema: loadCapabilitySchema,
    },
  );
}
