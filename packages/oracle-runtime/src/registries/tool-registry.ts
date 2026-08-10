import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type {
  PluginContext,
  PluginTool,
  RuntimeContext,
} from '../plugin-api/types.js';

/** Log prefix for the registry's own diagnostics. */
const LOG_PREFIX = '[tool-registry]';

/**
 * Render collected tools as `plugin=[toolA, toolB]; other=[toolC]` — the
 * diagnostic that answers "which plugin contributed what on this turn".
 */
export function formatByPlugin(entries: readonly RegisteredTool[]): string {
  const byPlugin = new Map<string, string[]>();
  for (const { pluginName, tool } of entries) {
    const names = byPlugin.get(pluginName);
    if (names) names.push(tool.name);
    else byPlugin.set(pluginName, [tool.name]);
  }
  return Array.from(
    byPlugin,
    ([name, tools]) => `${name}=[${tools.join(', ')}]`,
  ).join('; ');
}

/** A collected tool tagged with the plugin that contributed it. */
export interface RegisteredTool {
  pluginName: string;
  tool: PluginTool;
  /**
   * Which hook produced it — `getTools` (boot, cached for the process) or
   * `getRequestTools` (recomputed every turn). The per-turn diagnostics need
   * the split: request tools are the ones that can differ between two
   * otherwise identical turns.
   */
  origin: 'boot' | 'request';
}

/**
 * Stores plugins that contribute tools and resolves them lazily by invoking
 * each plugin's `getTools(buildCtx)` once at collection time.
 *
 * Tools live in a flat namespace — duplicate names across plugins are a
 * boot error caught by `assertNoCollisions()`.
 *
 * Boot-time outputs from `getTools(buildCtx)` are cached after the first
 * `collectBoot(buildCtx)` call. The request hot path only re-runs each
 * plugin's `getRequestTools(rtCtx)` — request-time variation lives there.
 *
 * ## Cache safety / cross-user isolation
 *
 * `PluginContext` (the `buildCtx` passed to `getTools`) is **defined by
 * `plugin-api/types.ts` to hold no user, session, or request data** — it
 * only carries `{ config, identity, availablePlugins, logger }`, all
 * oracle-scoped and stable for the process lifetime.
 *
 * Cached `PluginTool` objects are therefore safe to share between users:
 * their handlers receive a fresh `RuntimeContext` from `wrapPluginTool`
 * on every invocation, and that per-request context is what carries
 * `user.did`, `session.id`, `ucanDelegation`, etc. The cache stores
 * static tool definitions; per-request wrapping is always fresh.
 */
export class ToolRegistry {
  private readonly plugins: OraclePlugin[] = [];
  private bootCache: RegisteredTool[] | null = null;
  private collected: RegisteredTool[] | null = null;

  /** Add a plugin whose `getTools` will be called at `collect()` time. */
  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
    this.bootCache = null;
    this.collected = null;
  }

  /**
   * Run every plugin's `getTools(buildCtx)` once and cache the result. Safe
   * to call multiple times — subsequent calls return the cached list.
   */
  async collectBoot(buildCtx: PluginContext): Promise<RegisteredTool[]> {
    if (this.bootCache !== null) return this.bootCache;
    const out: RegisteredTool[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.getTools) continue;
      const tools = await plugin.getTools(buildCtx);
      for (const tool of tools) {
        out.push({ pluginName: plugin.name, tool, origin: 'boot' });
      }
    }
    this.bootCache = out;
    return out;
  }

  /**
   * Run every plugin's `getRequestTools(rtCtx)`. Does NOT touch the boot
   * cache — boot-time tools must be collected via `collectBoot(buildCtx)`
   * before the first request.
   *
   * Hooks run concurrently — several of them open network connections
   * (MCP list-tools, secrets reads), so serializing them puts every
   * round-trip on the chat hot path back-to-back. Output order stays
   * plugin-registration order regardless of which hook resolves first.
   *
   * Failures are isolated PER PLUGIN: a hook that rejects contributes zero
   * tools and is logged as an error naming the plugin, while every other
   * plugin's tools still resolve. Sharing one rejection across the whole
   * fan-out would let a transient upstream blip in one plugin (an MCP server
   * that timed out, a secrets read that 500'd) silently strip the request
   * tools of every plugin — and, because the caller awaits this, fail the
   * turn outright. The runtime degrades the same way for sub-agents.
   */
  async collectRequest(rtCtx: RuntimeContext): Promise<RegisteredTool[]> {
    const perPlugin = await Promise.all(
      this.plugins.map(async (plugin): Promise<RegisteredTool[]> => {
        if (!plugin.getRequestTools) return [];
        try {
          const requestTools = await plugin.getRequestTools(rtCtx);
          return requestTools.map((tool) => ({
            pluginName: plugin.name,
            tool,
            origin: 'request' as const,
          }));
        } catch (error) {
          rtCtx.logger.error(
            `${LOG_PREFIX} plugin "${plugin.name}" getRequestTools failed — it contributes NO tools this turn ` +
              `(other plugins are unaffected): ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
          return [];
        }
      }),
    );
    const out = perPlugin.flat();
    rtCtx.logger.debug?.(
      `${LOG_PREFIX} request tools by plugin: ${formatByPlugin(out) || '∅'}`,
    );
    return out;
  }

  /**
   * Combined boot + request collection used by the main agent build. Uses
   * the cached boot output when present so per-request rebuilds skip the
   * `getTools` invocations that don't depend on runtime state.
   */
  async collect(
    buildCtx: PluginContext,
    rtCtx?: RuntimeContext,
  ): Promise<RegisteredTool[]> {
    const boot = await this.collectBoot(buildCtx);
    const request = rtCtx ? await this.collectRequest(rtCtx) : [];
    const out = [...boot, ...request];
    this.collected = out;
    return out;
  }

  /** The flat list of tool names produced by the most recent `collect()`. */
  toolNames(): string[] {
    return (this.collected ?? this.bootCache ?? []).map(
      (entry) => entry.tool.name,
    );
  }

  /**
   * Tool names contributed by a given plugin in the most recent `collect()`
   * (or `collectBoot()` if no full collection has happened yet).
   */
  toolNamesForPlugin(pluginName: string): string[] {
    return (this.collected ?? this.bootCache ?? [])
      .filter((entry) => entry.pluginName === pluginName)
      .map((entry) => entry.tool.name);
  }

  /**
   * The tools contributed by a given plugin in the most recent collection
   * (boot-only if a full request collection has not yet happened).
   */
  toolsForPlugin(pluginName: string): PluginTool[] {
    return (this.collected ?? this.bootCache ?? [])
      .filter((entry) => entry.pluginName === pluginName)
      .map((entry) => entry.tool);
  }

  /**
   * Throw if two plugins contribute a tool with the same name. The error
   * message names every colliding plugin pair so the boot log points at the
   * actual conflict.
   */
  assertNoCollisions(): void {
    const source = this.collected ?? this.bootCache;
    if (source === null) {
      throw new Error('ToolRegistry.assertNoCollisions called before collect');
    }
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { pluginName, tool } of source) {
      const prev = seen.get(tool.name);
      if (prev !== undefined && prev !== pluginName) {
        collisions.push(
          `Tool "${tool.name}" registered by both "${prev}" and "${pluginName}"`,
        );
      } else if (prev === undefined) {
        seen.set(tool.name, pluginName);
      }
    }
    if (collisions.length > 0) {
      throw new Error(
        `ToolRegistry: tool name collisions detected:\n  - ${collisions.join('\n  - ')}`,
      );
    }
  }
}
