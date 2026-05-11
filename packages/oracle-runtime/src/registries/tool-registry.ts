import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type {
  PluginContext,
  PluginTool,
  RuntimeContext,
} from '../plugin-api/types.js';

/** A collected tool tagged with the plugin that contributed it. */
export interface RegisteredTool {
  pluginName: string;
  tool: PluginTool;
}

/**
 * Stores plugins that contribute tools and resolves them lazily by invoking
 * each plugin's `getTools(buildCtx)` once at collection time.
 *
 * Tools live in a flat namespace — duplicate names across plugins are a
 * boot error caught by `assertNoCollisions()`.
 */
export class ToolRegistry {
  private readonly plugins: OraclePlugin[] = [];
  private collected: RegisteredTool[] | null = null;

  /** Add a plugin whose `getTools` will be called at `collect()` time. */
  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
    this.collected = null;
  }

  /**
   * Invoke `getTools(buildCtx)` on every registered plugin in registration
   * order and return the flattened list with plugin attribution.
   *
   * When `rtCtx` is supplied, also invokes `getRequestTools(rtCtx)` on each
   * plugin that implements it and appends those results — the request-time
   * tools land immediately after the same plugin's boot-time tools.
   *
   * Plugins that implement neither hook contribute nothing.
   */
  async collect(
    buildCtx: PluginContext,
    rtCtx?: RuntimeContext,
  ): Promise<RegisteredTool[]> {
    const out: RegisteredTool[] = [];
    for (const plugin of this.plugins) {
      if (plugin.getTools) {
        const tools = await plugin.getTools(buildCtx);
        for (const tool of tools) {
          out.push({ pluginName: plugin.name, tool });
        }
      }
      if (rtCtx && plugin.getRequestTools) {
        const requestTools = await plugin.getRequestTools(rtCtx);
        for (const tool of requestTools) {
          out.push({ pluginName: plugin.name, tool });
        }
      }
    }
    this.collected = out;
    return out;
  }

  /** The flat list of tool names produced by the most recent `collect()`. */
  toolNames(): string[] {
    return (this.collected ?? []).map((entry) => entry.tool.name);
  }

  /**
   * Tool names contributed by a given plugin in the most recent `collect()`.
   * Returns `[]` if the plugin contributed nothing or if `collect()` has not
   * yet been called.
   */
  toolNamesForPlugin(pluginName: string): string[] {
    return (this.collected ?? [])
      .filter((entry) => entry.pluginName === pluginName)
      .map((entry) => entry.tool.name);
  }

  /**
   * The tools contributed by a given plugin in the most recent `collect()`.
   * Returns the cached `PluginTool` objects so callers can read descriptions
   * and schemas without re-invoking the plugin's `getTools`.
   *
   * Returns `[]` if the plugin contributed nothing or if `collect()` has not
   * yet been called.
   */
  toolsForPlugin(pluginName: string): PluginTool[] {
    return (this.collected ?? [])
      .filter((entry) => entry.pluginName === pluginName)
      .map((entry) => entry.tool);
  }

  /**
   * Throw if two plugins contribute a tool with the same name. The error
   * message names every colliding plugin pair so the boot log points at the
   * actual conflict.
   */
  assertNoCollisions(): void {
    if (this.collected === null) {
      throw new Error('ToolRegistry.assertNoCollisions called before collect');
    }
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { pluginName, tool } of this.collected) {
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
