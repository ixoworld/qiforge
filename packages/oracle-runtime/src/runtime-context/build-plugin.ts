import type {
  Logger,
  MergedConfig,
  OracleIdentity,
  PluginContext,
} from '../plugin-api/types.js';

export interface BuildPluginContextInput<TConfig = MergedConfig> {
  /** Merged Zod-validated env (core + every loaded plugin's `configSchema`). */
  config: TConfig;
  /** Identity of this oracle, set by the fork at `createOracleApp`. */
  identity: OracleIdentity;
  /** Names of the plugins resolved at boot. */
  availablePlugins: ReadonlySet<string>;
  /** Base logger; auto-bound to the calling plugin's name when supported. */
  logger: Logger;
  /** Plugin name used to scope the logger. */
  pluginName: string;
}

/**
 * Build the boot-time PluginContext passed to plugin methods that produce
 * tools, sub-agents and middlewares. Lives once per request build — holds no
 * user, no session, no live socket, no request data.
 */
export function buildPluginContext<TConfig = MergedConfig>(
  input: BuildPluginContextInput<TConfig>,
): PluginContext<TConfig> {
  const scopedLogger = input.logger.child
    ? input.logger.child({ plugin: input.pluginName })
    : input.logger;

  return {
    config: input.config,
    identity: input.identity,
    availablePlugins: input.availablePlugins,
    logger: scopedLogger,
  };
}
