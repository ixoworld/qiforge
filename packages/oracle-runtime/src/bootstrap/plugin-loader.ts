import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type { Logger } from '../plugin-api/types.js';

/**
 * Per-feature toggle:
 *  - `true`   — explicit opt-in. If the plugin has an `autoDetect` and it
 *               fails, boot fails.
 *  - `false`  — explicit opt-out.
 *  - `'auto'` — include only if the plugin's `autoDetect` returns true (or
 *               the plugin has no `autoDetect`, in which case it loads).
 */
export type FeatureToggle = boolean | 'auto';

export type ExclusionCause =
  | 'feature_false'
  | 'auto_detect_missing'
  | 'cascaded';

export interface ExcludedPlugin {
  plugin: string;
  reason: string;
  cause: ExclusionCause;
}

export interface SoftDepGap {
  plugin: string;
  missing: string;
}

export interface ResolvePluginsInput {
  features?: Partial<Record<string, FeatureToggle>>;
  bundled: OraclePlugin[];
  userPlugins?: OraclePlugin[];
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export interface ResolvePluginsResult {
  loaded: OraclePlugin[];
  excluded: ExcludedPlugin[];
  softDepGaps: SoftDepGap[];
}

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Resolve the final plugin list for boot.
 *
 *   1. Apply feature toggles + each plugin's `autoDetect` to the bundled list.
 *   2. Combine with always-loaded user plugins.
 *   3. Cascade hard-dep removals (transitive — fixed-point).
 *   4. Topologically sort by `dependsOn`.
 *   5. Log soft-dep gaps.
 */
export function resolvePlugins(
  input: ResolvePluginsInput,
): ResolvePluginsResult {
  const env = input.env ?? process.env;
  const logger = input.logger ?? NOOP_LOGGER;
  const features = input.features ?? {};

  const excluded: ExcludedPlugin[] = [];
  const survivors: OraclePlugin[] = [];

  for (const plugin of input.bundled) {
    const toggle = features[plugin.name];

    if (toggle === false) {
      excluded.push({
        plugin: plugin.name,
        reason: 'feature flag set to false',
        cause: 'feature_false',
      });
      continue;
    }

    const detectOk = plugin.autoDetect ? plugin.autoDetect(env) : true;
    const hint = plugin.autoDetectHint ?? 'auto-detect predicate';

    if (toggle === true && !detectOk) {
      throw new Error(
        `boot.plugin.env_missing: plugin '${plugin.name}' enabled via features but precondition failed (${hint}). ` +
          `Set the required env or disable: features: { ${plugin.name}: false }`,
      );
    }

    if (!detectOk) {
      excluded.push({
        plugin: plugin.name,
        reason: `auto-detect precondition not met (${hint})`,
        cause: 'auto_detect_missing',
      });
      continue;
    }

    survivors.push(plugin);
  }

  const allLoaded = [...survivors, ...(input.userPlugins ?? [])];

  // Transitive cascade — fixed-point. A plugin cascades off if any of its
  // hard deps is excluded for any reason (explicit false, auto-detect, or
  // a previous cascade).
  const kept = new Map(allLoaded.map((p) => [p.name, p]));
  const excludedNames = new Set(excluded.map((e) => e.plugin));

  let changed = true;
  while (changed) {
    changed = false;
    for (const plugin of [...kept.values()]) {
      for (const dep of plugin.dependsOn ?? []) {
        if (kept.has(dep)) continue;
        if (!excludedNames.has(dep)) continue;
        const reason = `cascaded off via ${dep}`;
        excluded.push({ plugin: plugin.name, reason, cause: 'cascaded' });
        excludedNames.add(plugin.name);
        kept.delete(plugin.name);
        logger.warn(
          `[boot] plugin '${plugin.name}' ${reason} (event: boot.plugin.cascaded_off)`,
        );
        changed = true;
        break;
      }
    }
  }

  const ordered = topoSort([...kept.values()]);
  const finalNames = new Set(ordered.map((p) => p.name));

  const softDepGaps: SoftDepGap[] = [];
  for (const plugin of ordered) {
    for (const soft of plugin.softDependsOn ?? []) {
      if (finalNames.has(soft)) continue;
      softDepGaps.push({ plugin: plugin.name, missing: soft });
      logger.log(
        `[boot] plugin '${plugin.name}' soft-depends on '${soft}', which is not loaded (event: boot.plugin.soft_dep_missing)`,
      );
    }
  }

  return { loaded: ordered, excluded, softDepGaps };
}

/**
 * Topologically sort plugins by `dependsOn`. Throws on unmet hard deps
 * (`boot.plugin.dep_missing`) or cycles (`boot.plugin.cycle`, with the
 * cycle path included in the message).
 */
export function topoSort(plugins: OraclePlugin[]): OraclePlugin[] {
  const byName = new Map(plugins.map((p) => [p.name, p]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: OraclePlugin[] = [];

  const visit = (
    name: string,
    requiredBy: string | null,
    path: string[],
  ): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name].join(' -> ');
      throw new Error(
        `boot.plugin.cycle: dependency cycle detected: ${cycle}. ` +
          `Break the cycle by removing one of the dependsOn links.`,
      );
    }
    const plugin = byName.get(name);
    if (!plugin) {
      throw new Error(
        `boot.plugin.dep_missing: plugin '${requiredBy}' requires '${name}', which is not loaded. ` +
          `Add '${name}' to features, or remove '${requiredBy}'.`,
      );
    }

    visiting.add(name);
    for (const dep of plugin.dependsOn ?? []) {
      visit(dep, name, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(plugin);
  };

  for (const p of plugins) visit(p.name, null, []);
  return ordered;
}
