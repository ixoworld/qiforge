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
 * The automated refusal retry is only permitted for sub-agents whose entire
 * toolset is declared non-mutating. Enforced at collection time (boot for
 * `getSubAgents`, per-request for `getRequestSubAgents`) so a mis-declared
 * plugin fails loudly instead of silently gaining a retry on write tools.
 */
function assertValidRefusalPolicy(
  pluginName: string,
  subAgent: PluginSubAgent,
): void {
  if (subAgent.onRefusal === 'retry-once' && subAgent.readOnly !== true) {
    throw new Error(
      `Sub-agent "${subAgent.name}" (plugin "${pluginName}") sets onRefusal 'retry-once' ` +
        `without readOnly: true — the automated retry is only permitted for read-only sub-agents.`,
    );
  }
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

  /** Add a plugin whose `getSubAgents` will be called at `collect()` time. */
  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
    this.bootCache = null;
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
        assertValidRefusalPolicy(plugin.name, subAgent);
        out.push({ pluginName: plugin.name, subAgent });
      }
    }
    this.bootCache = out;
    return out;
  }

  /**
   * Run every plugin's `getRequestSubAgents(rtCtx)`. Does NOT touch the boot
   * cache.
   *
   * Hooks run concurrently (they can involve Matrix membership checks and
   * sub-agent builds); output order stays plugin-registration order and a
   * hook rejection still fails the whole collection.
   */
  async collectRequest(rtCtx: RuntimeContext): Promise<RegisteredSubAgent[]> {
    const perPlugin = await Promise.all(
      this.plugins.map(async (plugin) => {
        if (!plugin.getRequestSubAgents) return [];
        const requestSubAgents = await plugin.getRequestSubAgents(rtCtx);
        for (const subAgent of requestSubAgents) {
          assertValidRefusalPolicy(plugin.name, subAgent);
        }
        return requestSubAgents.map((subAgent) => ({
          pluginName: plugin.name,
          subAgent,
        }));
      }),
    );
    return perPlugin.flat();
  }

  /**
   * Combined boot + request collection used by the main agent build.
   *
   * The merged list is RETURNED, never stored — request-time sub-agents are
   * per-user and writing them onto this boot-scoped singleton let concurrent
   * requests observe each other's entries.
   */
  async collect(
    buildCtx: PluginContext,
    rtCtx?: RuntimeContext,
  ): Promise<RegisteredSubAgent[]> {
    const boot = this.collectBoot(buildCtx);
    const request = rtCtx ? await this.collectRequest(rtCtx) : [];
    return [...boot, ...request];
  }

  /**
   * The *wrapped* tool names contributed by a given plugin at boot. Mirrors
   * `ToolRegistry.toolNamesForPlugin` so the manifest validator can treat
   * sub-agents as the tools they become to the agent. Request-time
   * sub-agents are per-request values and never appear here.
   *
   * Each entry passes through `computeSubAgentToolName` — the same transform
   * `createSubagentAsTool` applies when building the StructuredTool — so the
   * names returned here match what the agent will actually see.
   */
  subAgentNamesForPlugin(pluginName: string): string[] {
    return (this.bootCache ?? [])
      .filter((entry) => entry.pluginName === pluginName)
      .map((entry) => computeSubAgentToolName(entry.subAgent.name));
  }

  /**
   * Throw if two plugins contribute sub-agents with the same name. The error
   * message names both plugin names so the boot log points at the conflict.
   */
  assertNoCollisions(): void {
    const source = this.bootCache;
    if (source === null) {
      throw new Error(
        'SubAgentRegistry.assertNoCollisions called before collectBoot',
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
