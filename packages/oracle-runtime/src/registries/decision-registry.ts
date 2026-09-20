import type { DecisionRegistration } from '@ixo/common';
import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type { PluginContext } from '../plugin-api/types.js';

export interface RegisteredDecision {
  pluginName: string;
  decision: DecisionRegistration;
}

export class DecisionRegistry {
  private readonly plugins: OraclePlugin[] = [];
  private bootCache: RegisteredDecision[] | null = null;

  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
    this.bootCache = null;
  }

  collect(buildCtx: PluginContext): RegisteredDecision[] {
    if (this.bootCache !== null) return this.bootCache;

    const out: RegisteredDecision[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.getDecisions) continue;
      for (const decision of plugin.getDecisions(buildCtx)) {
        out.push({ pluginName: plugin.name, decision });
      }
    }
    this.bootCache = out;
    return out;
  }

  get(name: string): RegisteredDecision | undefined {
    if (this.bootCache === null) {
      throw new Error('DecisionRegistry.get called before collect');
    }
    return this.bootCache.find((entry) => entry.decision.name === name);
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
      if (previous) {
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
