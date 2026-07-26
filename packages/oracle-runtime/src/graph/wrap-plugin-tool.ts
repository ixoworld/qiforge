import { tool } from '@langchain/core/tools';
import type { StructuredTool } from 'langchain';
import type { PluginTool } from '../plugin-api/types.js';
import type { AmbientServices } from '../runtime-context/ambient.js';
import {
  buildRuntimeContext,
  type RunConfig,
  type RuntimeStateInput,
} from '../runtime-context/build-runtime.js';

/**
 * What `wrapPluginTool` needs at each call: the captured ambient bag, the
 * current graph state, and the plugin title used for the description prefix.
 */
export interface WrapPluginToolOptions {
  ambient: AmbientServices;
  /** Snapshot of the graph state for the in-flight build. */
  state: RuntimeStateInput;
  /** Plugin manifest title used to auto-prefix the description. */
  pluginTitle?: string;
}

/**
 * Bridge a `PluginTool` (handler signature `(args, ctx: RuntimeContext)`)
 * into LangChain's `tool()` calling convention `(args, runConfig)`.
 *
 * Per-call, the wrapper synthesises a fresh `RuntimeContext` via
 * `buildRuntimeContext` so handlers see the same shape regardless of where
 * the call originates (HTTP, WS, scheduled task).
 *
 * The agent-facing description is auto-prefixed with the plugin's
 * `manifest.title` so the agent always knows which plugin a tool belongs to.
 */
export function wrapPluginTool(
  pluginTool: PluginTool,
  options: WrapPluginToolOptions,
): StructuredTool {
  const { ambient, state, pluginTitle } = options;
  const description = pluginTitle
    ? `[${pluginTitle}] ${pluginTool.description}`
    : pluginTool.description;

  return tool(
    async (args, runConfig) => {
      // LangChain passes the runtime as `runConfig` — cast to the shape we
      // depend on. The framework always provides a `context` channel with the
      // user/session payload established by the request middleware.
      const ctx = buildRuntimeContext(
        runConfig as unknown as RunConfig,
        ambient,
        state,
      );
      return pluginTool.handler(args, ctx);
    },
    {
      name: pluginTool.name,
      description,
      schema: pluginTool.schema,
    },
  );
}
