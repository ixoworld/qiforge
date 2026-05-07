import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type {
  AgentMiddleware,
  PluginContext,
} from '../plugin-api/types.js';

/** A collected middleware tagged with the plugin that contributed it. */
export interface RegisteredMiddleware {
  pluginName: string;
  middleware: AgentMiddleware;
}

/**
 * Stores plugins that contribute middlewares and resolves them by invoking
 * each plugin's `getMiddlewares(buildCtx)` at collection time.
 *
 * Order is preserved as registration order — the loader applies any
 * dependency-driven topological reordering before registering plugins here,
 * so the registry just preserves the order it gets.
 */
export class MiddlewareRegistry {
  private readonly plugins: OraclePlugin[] = [];

  /**
   * Add a plugin whose `getMiddlewares` will be called at `collect()` time.
   * Plugins are stored in the order they are registered.
   */
  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
  }

  /**
   * Invoke `getMiddlewares(buildCtx)` on every registered plugin in
   * registration order and return the flattened list. Skips plugins that do
   * not implement `getMiddlewares`.
   */
  collect(buildCtx: PluginContext): RegisteredMiddleware[] {
    const out: RegisteredMiddleware[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.getMiddlewares) continue;
      const middlewares = plugin.getMiddlewares(buildCtx);
      for (const middleware of middlewares) {
        out.push({ pluginName: plugin.name, middleware });
      }
    }
    return out;
  }

  /**
   * Middlewares have no names, so no collision is possible. Method exists for
   * a uniform registry surface.
   */
  assertNoCollisions(): void {
    // Intentional no-op — middleware order is established by the loader.
  }
}
