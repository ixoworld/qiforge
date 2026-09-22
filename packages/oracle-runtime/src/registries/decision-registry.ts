import type { DecisionLookup, DecisionRegistration } from '@ixo/common';
import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type { PluginContext } from '../plugin-api/types.js';

export interface RegisteredDecision {
  pluginName: string;
  decision: DecisionRegistration;
}

export class DecisionRegistry implements DecisionLookup {
  private readonly plugins: OraclePlugin[] = [];
  private bootCache: RegisteredDecision[] | null = null;
  /** Name → registration; the first registration of a name wins. */
  private byName: Map<string, RegisteredDecision> | null = null;

  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
    this.bootCache = null;
    this.byName = null;
  }

  collect(buildCtx: PluginContext): RegisteredDecision[] {
    if (this.bootCache !== null) return this.bootCache;

    const out: RegisteredDecision[] = [];
    const byName = new Map<string, RegisteredDecision>();
    for (const plugin of this.plugins) {
      if (!plugin.getDecisions) continue;
      for (const decision of plugin.getDecisions(buildCtx)) {
        const entry: RegisteredDecision = { pluginName: plugin.name, decision };
        out.push(entry);
        if (!byName.has(decision.name)) byName.set(decision.name, entry);
      }
    }
    this.bootCache = out;
    this.byName = byName;
    return out;
  }

  get(name: string): RegisteredDecision | undefined {
    if (this.byName === null) {
      throw new Error('DecisionRegistry.get called before collect');
    }
    return this.byName.get(name);
  }

  namesForPlugin(pluginName: string): string[] {
    if (this.bootCache === null) return [];
    return this.bootCache
      .filter((entry) => entry.pluginName === pluginName)
      .map((entry) => entry.decision.name);
  }

  assertNoCollisions(): void {
    if (this.bootCache === null) {
      throw new Error(
        'DecisionRegistry.assertNoCollisions called before collect',
      );
    }

    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { pluginName, decision } of this.bootCache) {
      const previous = seen.get(decision.name);
      if (previous && previous !== pluginName) {
        collisions.push(
          `Decision "${decision.name}" registered by both "${previous}" and "${pluginName}"`,
        );
      } else if (!previous) {
        seen.set(decision.name, pluginName);
      }
    }

    if (collisions.length > 0) {
      throw new Error(
        `DecisionRegistry: decision name collisions detected:\n  - ${collisions.join('\n  - ')}`,
      );
    }
  }
}
