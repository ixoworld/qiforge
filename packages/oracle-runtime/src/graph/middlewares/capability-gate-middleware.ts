import { type AgentMiddleware, createMiddleware } from 'langchain';
import { z } from 'zod';
import { mainAgentRequestContextSchema } from '../main-agent-types.js';
import type { Logger, PluginManifest } from '../../plugin-api/types.js';

type Visibility = NonNullable<PluginManifest['visibility']>;

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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
   * Per-turn capability grants from the semantic router. Request-scoped and
   * never checkpointed — read live on every model call so a route decision
   * expands the visible surface for THIS turn only.
   */
  routedCapabilities?: ReadonlySet<string>;
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

/**
 * Gates on-demand plugin tools (and sub-agents-as-tools) per model call.
 *
 * All plugin tools are bound to the agent at compile time. This middleware
 * runs on every model invocation: it reads `state.loadedPlugins` and trims
 * the request's `tools` array down to what the agent should actually see at
 * this point in the conversation.
 *
 * Why a middleware: `createAgent({ tools })` freezes the bound list, so
 * `load_capability` updating state mid-run would otherwise have no effect
 * until the next request rebuilt the agent. Filtering inside `wrapModelCall`
 * lets a load decision take effect on the very next LLM call.
 */
export const createCapabilityGateMiddleware = (
  options: CapabilityGateMiddlewareOptions,
): AgentMiddleware => {
  const { pluginByToolName, visibilityByToolName, routedCapabilities } =
    options;
  const logger = options.logger ?? NOOP_LOGGER;

  return createMiddleware({
    name: 'CapabilityGateMiddleware',
    stateSchema: z.object({
      loadedPlugins: z.array(z.string()).optional(),
    }),
    contextSchema: mainAgentRequestContextSchema,
    wrapModelCall: (request, handler) => {
      const loaded = new Set<string>(request.state.loadedPlugins ?? []);
      const filtered = request.tools.filter((t) => {
        // LangChain types `tools` as `(ServerTool | ClientTool)[]`, where
        // `ServerTool` is `Record<string, unknown>` — so `t.name` widens to
        // `unknown`. Narrow at runtime; unknown-named tools pass through.
        const name = typeof t.name === 'string' ? t.name : undefined;
        if (!name) return true;
        const plugin = pluginByToolName.get(name);
        if (!plugin) return true;
        const viz = visibilityByToolName.get(name) ?? 'on-demand';
        if (viz === 'always' || viz === 'silent') return true;
        return loaded.has(plugin) || routedCapabilities?.has(plugin) === true;
      });

      if (filtered.length !== request.tools.length) {
        logger.log?.(
          `[CapabilityGateMiddleware] exposed ${filtered.length}/${request.tools.length} tools; loadedPlugins=${Array.from(loaded).join(',') || '∅'}`,
        );
      }

      return handler({ ...request, tools: filtered });
    },
  });
};
