import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type {
  PluginContext,
  PluginSubAgent,
  RuntimeContext,
} from '../plugin-api/types.js';

/** A collected sub-agent tagged with the plugin that contributed it. */
export interface RegisteredSubAgent {
  pluginName: string;
  subAgent: PluginSubAgent;
}

/**
 * Stores plugins that contribute sub-agents and resolves them by invoking
 * each plugin's `getSubAgents(buildCtx)` at collection time.
 *
 * Sub-agents are wrapped as tools by the runtime, so their names share the
 * tool namespace. Duplicate sub-agent names across plugins are a boot error.
 */
export class SubAgentRegistry {
  private readonly plugins: OraclePlugin[] = [];
  private collected: RegisteredSubAgent[] | null = null;

  /** Add a plugin whose `getSubAgents` will be called at `collect()` time. */
  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
    this.collected = null;
  }

  /**
   * Invoke `getSubAgents(buildCtx)` on every registered plugin in registration
   * order. When `rtCtx` is supplied, also invokes `getRequestSubAgents(rtCtx)`
   * on each plugin that implements it and appends those results — the
   * request-time sub-agents land immediately after the same plugin's
   * boot-time sub-agents.
   *
   * Plugins that implement neither hook contribute nothing.
   */
  async collect(
    buildCtx: PluginContext,
    rtCtx?: RuntimeContext,
  ): Promise<RegisteredSubAgent[]> {
    const out: RegisteredSubAgent[] = [];
    for (const plugin of this.plugins) {
      if (plugin.getSubAgents) {
        const subAgents = plugin.getSubAgents(buildCtx);
        for (const subAgent of subAgents) {
          out.push({ pluginName: plugin.name, subAgent });
        }
      }
      if (rtCtx && plugin.getRequestSubAgents) {
        const requestSubAgents = await plugin.getRequestSubAgents(rtCtx);
        for (const subAgent of requestSubAgents) {
          out.push({ pluginName: plugin.name, subAgent });
        }
      }
    }
    this.collected = out;
    return out;
  }

  /**
   * Throw if two plugins contribute sub-agents with the same name. The error
   * message names both plugin names so the boot log points at the conflict.
   */
  assertNoCollisions(): void {
    if (this.collected === null) {
      throw new Error(
        'SubAgentRegistry.assertNoCollisions called before collect',
      );
    }
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { pluginName, subAgent } of this.collected) {
      const prev = seen.get(subAgent.name);
      if (prev !== undefined && prev !== pluginName) {
        collisions.push(
          `Sub-agent "${subAgent.name}" registered by both "${prev}" and "${pluginName}"`,
        );
      } else if (prev === undefined) {
        seen.set(subAgent.name, pluginName);
      }
    }
    if (collisions.length > 0) {
      throw new Error(
        `SubAgentRegistry: sub-agent name collisions detected:\n  - ${collisions.join('\n  - ')}`,
      );
    }
  }
}
