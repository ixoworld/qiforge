import { ToolMessage } from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import { z } from 'zod';
import type { Logger, PluginManifest } from '../../plugin-api/types';
import { NOOP_LOGGER } from '../utils';

type Visibility = NonNullable<PluginManifest['visibility']>;

/** `response_metadata` key the gate sets on its refusals (never sent to a provider). */
const REFUSED = 'capabilityGateRefused';

/**
 * A ToolMessage the gate produced instead of running the tool. The tool never
 * ran, so it is not a failure: the repetition guard must let the same call
 * through once the capability is loaded.
 */
export function isCapabilityGateRefusal(message: ToolMessage): boolean {
  return message.response_metadata?.[REFUSED] === true;
}

export interface CapabilityGateMiddlewareOptions {
  /**
   * Tool name → contributing plugin name. Tools absent from this map
   * (meta-tools like `list_capabilities`/`load_capability`, ad-hoc tools
   * registered outside the plugin pipeline) are always passed through.
   */
  pluginByToolName: Map<string, string>;
  /**
   * Tool name → effective visibility. Per-tool override wins over the
   * plugin's manifest visibility; the caller pre-resolves this so the
   * middleware does not need access to the registries at runtime.
   */
  visibilityByToolName: Map<string, Visibility>;
  /**
   * Plugins the capability router preloaded for this turn. Their on-demand
   * tools pass the gate as if loaded, without touching `state.loadedPlugins`.
   */
  preloadedPlugins?: ReadonlySet<string>;
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

/**
 * Gates on-demand plugin tools (and sub-agents-as-tools) on both sides of
 * the model.
 *
 * All plugin tools are bound to the agent at compile time. On every model
 * invocation this middleware reads `state.loadedPlugins` and trims the
 * request's `tools` array down to what the agent should see at this point
 * in the conversation. Because they are all bound, the tool node would still
 * run a call to a hidden tool — one named from an earlier thread, guessed,
 * or planted by injected text — so every tool call is checked against the
 * same rule before it runs, and a hidden one is answered with an error
 * instead of executing.
 *
 * Why a middleware: `createAgent({ tools })` freezes the bound list, so
 * `load_capability` updating state mid-run would otherwise have no effect
 * until the next request rebuilt the agent. Filtering inside `wrapModelCall`
 * lets a load decision take effect on the very next LLM call.
 *
 * This is capability discovery, not authorization: any non-silent plugin can
 * be loaded with `load_capability`. What the gate guarantees is that an
 * on-demand tool runs only after that load (or the turn's preload) is
 * visible in the thread.
 */
export const createCapabilityGateMiddleware = (
  options: CapabilityGateMiddlewareOptions,
): AgentMiddleware => {
  const { pluginByToolName, visibilityByToolName, preloadedPlugins } = options;
  const logger = options.logger ?? NOOP_LOGGER;

  /** The plugin that has to be loaded before `toolName` may be seen or run; null when it is open. */
  const gatingPlugin = (
    toolName: string,
    loaded: ReadonlySet<string>,
  ): string | null => {
    const plugin = pluginByToolName.get(toolName);
    if (!plugin) return null;
    const viz = visibilityByToolName.get(toolName) ?? 'on-demand';
    if (viz === 'always' || viz === 'silent') return null;
    if (loaded.has(plugin) || preloadedPlugins?.has(plugin) === true)
      return null;
    return plugin;
  };

  return createMiddleware({
    name: 'CapabilityGateMiddleware',
    stateSchema: z.object({
      loadedPlugins: z.array(z.string()).optional(),
    }),
    // No `contextSchema`: the gate reads only `state.loadedPlugins`, and
    // declaring one would make LangChain reject every invocation that omits
    // `context` — the tool wrapper already carries the request context.
    wrapModelCall: (request, handler) => {
      const loaded = new Set<string>(request.state.loadedPlugins ?? []);
      const filtered = request.tools.filter((t) => {
        // LangChain types `tools` as `(ServerTool | ClientTool)[]`, where
        // `ServerTool` is `Record<string, unknown>` — so `t.name` widens to
        // `unknown`. Narrow at runtime; unknown-named tools pass through.
        const name = typeof t.name === 'string' ? t.name : undefined;
        if (!name) return true;
        return gatingPlugin(name, loaded) === null;
      });

      if (filtered.length !== request.tools.length) {
        logger.log(
          `[CapabilityGateMiddleware] exposed ${filtered.length}/${request.tools.length} tools; loadedPlugins=${Array.from(loaded).join(',') || '∅'}` +
            (preloadedPlugins?.size
              ? ` preloadedPlugins=${Array.from(preloadedPlugins).join(',')}`
              : ''),
        );
      }

      return handler({ ...request, tools: filtered });
    },
    // The state here is the one the tool node runs with, so a load made by
    // an earlier step of this run counts; a `load_capability` issued in the
    // same model response as the gated call does not (both run on the state
    // from before either), and the model is told to call again.
    wrapToolCall: (request, handler) => {
      const name = request.toolCall.name;
      const plugin = gatingPlugin(
        name,
        new Set<string>(request.state.loadedPlugins ?? []),
      );
      if (plugin === null) return handler(request);
      logger.warn(
        `[CapabilityGateMiddleware] refused a call to ${name}: capability '${plugin}' is not loaded in this thread`,
      );
      return new ToolMessage({
        content:
          `Tool "${name}" is not available: it belongs to the "${plugin}" capability, which is not loaded in this conversation, so the call was not run. ` +
          `If the user's request needs it, call load_capability with names ["${plugin}"] first, then call the tool again.`,
        tool_call_id: request.toolCall.id ?? '',
        name,
        status: 'error',
        response_metadata: { [REFUSED]: true },
      });
    },
  });
};
