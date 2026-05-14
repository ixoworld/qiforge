import { computeSubAgentToolName } from '../graph/subagent-as-tool.js';
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
 *
 * Like `ToolRegistry`, boot-time outputs are cached on the first
 * `collectBoot(buildCtx)` call so per-request builds only re-run the
 * request-time hook.
 */
export class SubAgentRegistry {
  private readonly plugins: OraclePlugin[] = [];
  private bootCache: RegisteredSubAgent[] | null = null;
  private collected: RegisteredSubAgent[] | null = null;

  /** Add a plugin whose `getSubAgents` will be called at `collect()` time. */
  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
    this.bootCache = null;
    this.collected = null;
  }

  /**
   * Run every plugin's `getSubAgents(buildCtx)` once and cache the result.
   */
  collectBoot(buildCtx: PluginContext): RegisteredSubAgent[] {
    if (this.bootCache !== null) return this.bootCache;
    const out: RegisteredSubAgent[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.getSubAgents) continue;
      const subAgents = plugin.getSubAgents(buildCtx);
      for (const subAgent of subAgents) {
        out.push({ pluginName: plugin.name, subAgent });
      }
    }
    this.bootCache = out;
    return out;
  }

  /**
   * Run every plugin's `getRequestSubAgents(rtCtx)`. Does NOT touch the boot
   * cache.
   */
  async collectRequest(
    rtCtx: RuntimeContext,
  ): Promise<RegisteredSubAgent[]> {
    const out: RegisteredSubAgent[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.getRequestSubAgents) continue;
      const requestSubAgents = await plugin.getRequestSubAgents(rtCtx);
      for (const subAgent of requestSubAgents) {
        out.push({ pluginName: plugin.name, subAgent });
      }
    }
    return out;
  }

  /**
   * Combined boot + request collection used by the main agent build.
   */
  async collect(
    buildCtx: PluginContext,
    rtCtx?: RuntimeContext,
  ): Promise<RegisteredSubAgent[]> {
    const boot = this.collectBoot(buildCtx);
    const request = rtCtx ? await this.collectRequest(rtCtx) : [];
    const out = [...boot, ...request];
    this.collected = out;
    return out;
  }

  /**
   * The *wrapped* tool names contributed by a given plugin in the most recent
   * collection (boot-only if a full request collection has not yet happened).
   * Mirrors `ToolRegistry.toolNamesForPlugin` so the manifest validator can
   * treat sub-agents as the tools they become to the agent.
   *
   * Each entry passes through `computeSubAgentToolName` — the same transform
   * `createSubagentAsTool` applies when building the StructuredTool — so the
   * names returned here match what the agent will actually see.
   */
  subAgentNamesForPlugin(pluginName: string): string[] {
    return (this.collected ?? this.bootCache ?? [])
      .filter((entry) => entry.pluginName === pluginName)
      .map((entry) => computeSubAgentToolName(entry.subAgent.name));
  }

  /**
   * Throw if two plugins contribute sub-agents with the same name. The error
   * message names both plugin names so the boot log points at the conflict.
   */
  assertNoCollisions(): void {
    const source = this.collected ?? this.bootCache;
    if (source === null) {
      throw new Error(
        'SubAgentRegistry.assertNoCollisions called before collect',
      );
    }
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { pluginName, subAgent } of source) {
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
