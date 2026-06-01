import { z } from 'zod';
import { Command } from '@langchain/langgraph';
import { ToolMessage } from '@langchain/core/messages';
import { tool } from '../plugin-api/tool-helper.js';
import type { PluginManifest, PluginTool } from '../plugin-api/types.js';
import type { ManifestRegistry } from '../registries/manifest-registry.js';
import type { ToolRegistry } from '../registries/tool-registry.js';

/**
 * Schema accepted by `load_capability`. The agent supplies the plugin name
 * returned by `list_capabilities`.
 */
const loadCapabilitySchema = z.object({
  name: z.string(),
});

interface ToolDetail {
  name: string;
  description: string;
}

interface LoadCapabilityResult extends PluginManifest {
  /**
   * `true` when the plugin was already loaded (or has `visibility: 'always'`),
   * `false` when this call moved it into the loaded set. Useful as a hint to
   * the agent — repeated `load_capability` calls are cheap but redundant.
   */
  alreadyAvailable: boolean;
  /** One entry per tool the plugin contributes. */
  tools: ToolDetail[];
}

/**
 * Build the `load_capability` meta-tool.
 *
 * Marks a plugin as loaded for the current thread AND returns its full
 * manifest (whenToUse, examples, …) plus a per-tool description + arg-shape
 * summary. This is the single discovery+load entry point — the agent does
 * not need a separate `list_capability_details` call.
 *
 * Behavior:
 *  - Unknown plugin → throws, instructing the agent to call
 *    `list_capabilities` first.
 *  - `silent` plugin → throws (silent plugins are not agent-loadable).
 *  - Plugin already loaded, or visibility is `always` → returns
 *    `LoadCapabilityResult` directly (no state change).
 *  - Otherwise → returns a LangGraph `Command` whose update both appends the
 *    plugin to `loadedPlugins` AND emits a matching `ToolMessage` carrying
 *    the JSON-encoded `LoadCapabilityResult` so the agent sees the manifest
 *    in conversation history on the same turn.
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
          `Capability "${name}" does not exist. Call list_capabilities first to discover available plugins.`,
        );
      }

      if (entry.manifest.visibility === 'silent') {
        throw new Error(
          `Capability "${name}" is internal and cannot be loaded by the agent. Call list_capabilities first to discover loadable plugins.`,
        );
      }

      const tools: ToolDetail[] = toolRegistry
        .toolsForPlugin(name)
        .map((t) => ({
          name: t.name,
          description: t.description,
        }));

      const alreadyLoaded = ctx.loadedPlugins?.has(name) === true;
      const alwaysVisible = entry.manifest.visibility === 'always';
      const alreadyAvailable = alreadyLoaded || alwaysVisible;

      const detail: LoadCapabilityResult = {
        ...entry.manifest,
        alreadyAvailable,
        tools,
      };

      if (alreadyAvailable) {
        return detail;
      }

      // New load — update state AND emit a ToolMessage so the agent sees the
      // manifest on the same turn. Without a matching tool_call_id LangChain
      // can't satisfy the model's tool-result expectation, so when we don't
      // have one (direct/test invocation) we skip the message and rely on the
      // caller to read state.
      const update: Record<string, unknown> = {
        loadedPlugins: [name],
      };
      if (ctx.toolCallId) {
        update.messages = [
          new ToolMessage({
            content: JSON.stringify(detail),
            tool_call_id: ctx.toolCallId,
          }),
        ];
      }
      return new Command({ update });
    },
    {
      name: 'load_capability',
      description:
        "Load a capability for the rest of this conversation. The response is the plugin's full manifest plus a tool list — after this call, the capability's tools are usable on the next model step.",
      schema: loadCapabilitySchema,
    },
  );
}
