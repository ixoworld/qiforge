import { tool } from '@langchain/core/tools';
import type { StructuredTool } from 'langchain';
import type {
  PluginTool,
  RuntimeContext,
  SharedAccessors,
} from '../plugin-api/types';
import {
  buildRuntimeContext,
  type AmbientServices,
  type RunConfig,
  type RunConfigContext,
  type RuntimeStateInput,
} from './runtime-context';

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
  /**
   * Builds the `ctx.shared` accessor bag for each call. The main-agent build
   * wires the shared-state registry here; ad-hoc callers may omit it.
   */
  sharedFactory?: (ctx: RuntimeContext) => SharedAccessors;
  /**
   * The request's user/session, used when the invocation config carries no
   * `context` channel. The agent is built per request, so the build-time
   * context IS this request's; a caller that also passes `context` to
   * `invoke`/`stream` (the Node runtime does) overrides it.
   */
  fallbackContext?: RunConfigContext;
}

/**
 * Resolve the `RunConfig` a tool call sees: LangChain's `ToolRuntime` when
 * it carries a usable `context`, else the build-time fallback.
 */
export function resolveRunConfig(
  runConfig: unknown,
  fallbackContext: RunConfigContext | undefined,
): RunConfig {
  const raw = (runConfig ?? {}) as Partial<RunConfig>;
  const ctx = raw.context;
  const usable = Boolean(ctx && ctx.user && ctx.session);
  const context = usable ? ctx : fallbackContext;
  if (!context) {
    throw new Error(
      'wrapPluginTool: no run context — pass `context: { user, session }` in the invoke config or supply `fallbackContext`.',
    );
  }
  return { ...raw, context };
}

/**
 * Bridge a `PluginTool` (handler signature `(args, ctx: RuntimeContext)`)
 * into LangChain's `tool()` calling convention `(args, runConfig)`.
 *
 * Per-call, the wrapper synthesises a fresh `RuntimeContext` via
 * `buildRuntimeContext` so handlers see the same shape regardless of where
 * the call originates.
 *
 * The agent-facing description is auto-prefixed with the plugin's
 * `manifest.title` so the agent always knows which plugin a tool belongs to.
 */
export function wrapPluginTool(
  pluginTool: PluginTool,
  options: WrapPluginToolOptions,
): StructuredTool {
  const { ambient, state, pluginTitle, sharedFactory, fallbackContext } =
    options;
  const description = pluginTitle
    ? `[${pluginTitle}] ${pluginTool.description}`
    : pluginTool.description;

  return tool(
    async (args, runConfig) => {
      // LangChain passes the `ToolRuntime` as `runConfig`; its `context`
      // channel carries user/session when the caller supplied one at
      // invocation, otherwise the build-time request context applies.
      const ctx = buildRuntimeContext(
        resolveRunConfig(runConfig, fallbackContext),
        ambient,
        state,
        sharedFactory,
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
