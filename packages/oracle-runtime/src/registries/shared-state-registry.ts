import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type {
  RuntimeContext,
  SharedAccessors,
} from '../plugin-api/types.js';

/** A single read accessor, contributed by a plugin under a unique key. */
type SharedAccessorFn = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any,
  runCtx: RuntimeContext,
) => unknown;

/** A collected accessor tagged with the plugin that contributed it. */
export interface RegisteredSharedAccessor {
  pluginName: string;
  key: string;
  accessor: SharedAccessorFn;
}

/**
 * Stores read-only accessors that plugins expose to other plugins via
 * `runCtx.shared`. Each accessor is keyed by a string and computes a value
 * from graph state plus the live RuntimeContext.
 *
 * Key collisions across plugins are a boot error — the spec forbids two
 * plugins from owning the same `ctx.shared.<key>`.
 */
export class SharedStateRegistry {
  private readonly entries: RegisteredSharedAccessor[] = [];

  /** Record a plugin's shared accessors. Plugins without any are skipped. */
  register(plugin: OraclePlugin): void {
    if (!plugin.getSharedState) return;
    const map = plugin.getSharedState();
    for (const [key, accessor] of Object.entries(map)) {
      this.entries.push({ pluginName: plugin.name, key, accessor });
    }
  }

  /** Return the registered accessors in registration order. */
  collect(): RegisteredSharedAccessor[] {
    return [...this.entries];
  }

  /**
   * Build a `SharedAccessors` snapshot from the supplied state and runtime
   * context by invoking each registered accessor lazily as keys are read.
   *
   * Accessors run on demand (via `Object.defineProperty` getters) so that an
   * accessor that throws does not break unrelated `ctx.shared.<otherKey>`
   * reads.
   */
  build(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state: any,
    runCtx: RuntimeContext,
  ): SharedAccessors {
    const target: Record<string, unknown> = {};
    for (const { key, accessor } of this.entries) {
      Object.defineProperty(target, key, {
        enumerable: true,
        configurable: false,
        get: () => accessor(state, runCtx),
      });
    }
    return target;
  }

  /**
   * Throw if two plugins contribute accessors under the same key. The error
   * message names both plugins.
   */
  assertNoCollisions(): void {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { pluginName, key } of this.entries) {
      const prev = seen.get(key);
      if (prev !== undefined && prev !== pluginName) {
        collisions.push(
          `Shared-state key "${key}" registered by both "${prev}" and "${pluginName}"`,
        );
      } else if (prev === undefined) {
        seen.set(key, pluginName);
      }
    }
    if (collisions.length > 0) {
      throw new Error(
        `SharedStateRegistry: shared-state key collisions detected:\n  - ${collisions.join('\n  - ')}`,
      );
    }
  }
}
