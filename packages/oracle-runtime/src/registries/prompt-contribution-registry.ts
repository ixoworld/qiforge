import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type {
  PluginPromptContribution,
  PromptContributionInfo,
  RuntimeContext,
} from '../plugin-api/types.js';

/** A collected contribution tagged with the plugin that produced it. */
export interface RegisteredPromptContribution {
  pluginName: string;
  contribution: PluginPromptContribution;
}

/**
 * Stores plugins that contribute prompt material and resolves them by
 * invoking each plugin's `getPromptContribution(rtCtx, info)` per request.
 *
 * Request-time only — contributions depend on live state (what bound, what's
 * loaded), so nothing is cached. A plugin whose hook throws contributes
 * nothing for that request; the error is logged by the caller's context
 * logger and the build continues, matching the sub-agent collection policy
 * (one faulty plugin must not take the whole agent down).
 */
export class PromptContributionRegistry {
  private readonly plugins: OraclePlugin[] = [];

  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
  }

  async collect(
    rtCtx: RuntimeContext,
    info: PromptContributionInfo,
  ): Promise<RegisteredPromptContribution[]> {
    const out: RegisteredPromptContribution[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.getPromptContribution) continue;
      try {
        const contribution = await plugin.getPromptContribution(rtCtx, info);
        if (contribution) {
          out.push({ pluginName: plugin.name, contribution });
        }
      } catch (error) {
        rtCtx.logger.error(
          `[prompt-contribution] plugin '${plugin.name}' threw — skipping its contribution: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return out;
  }

  /** Contributions are unnamed; method exists for a uniform registry surface. */
  assertNoCollisions(): void {
    // Intentional no-op — merge conflicts are resolved (and logged) by the
    // agent builder, which owns precedence.
  }
}
