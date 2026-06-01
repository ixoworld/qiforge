import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type { OracleIdentity } from '../plugin-api/types.js';
import type {
  RegisteredConfigSchema,
  RegisteredManifest,
  RegisteredMiddleware,
  RegisteredSharedAccessor,
  RegisteredSubAgent,
  RegisteredTool,
} from '../registries/index.js';
import type { ResolvePluginsResult } from './plugin-loader.js';

/**
 * Already-collected registry entries. The runtime calls each registry's
 * `collect()` once at boot; `inspect()` consumes the cached lists rather
 * than re-collecting (collection is async / context-bound).
 */
export interface CollectedRegistries {
  tools: RegisteredTool[];
  subAgents: RegisteredSubAgent[];
  middlewares: RegisteredMiddleware[];
  manifests: RegisteredManifest[];
  configSchemas: RegisteredConfigSchema[];
  sharedState: RegisteredSharedAccessor[];
}

export interface InspectInput {
  resolved: ResolvePluginsResult;
  collected: CollectedRegistries;
  identity: OracleIdentity;
  runtimeVersion: string;
  /**
   * Names of plugins shipped from the runtime package itself. Anything in
   * `resolved.loaded` not present here is reported as `source: 'user'`.
   * When omitted, every loaded plugin is treated as `'bundled'`.
   */
  bundledPluginNames?: ReadonlySet<string>;
  /**
   * Optional collision/warning lines to surface (e.g. config-schema
   * later-wins warnings). Forwarded verbatim under `warnings`.
   */
  warnings?: string[];
}

export interface InspectPluginEntry {
  name: string;
  version: string;
  source: 'bundled' | 'user';
  dependsOn: string[];
  softDependsOn: string[];
  softDepsResolved: string[];
  softDepsMissing: string[];
  tools: { name: string; visibility?: string }[];
  subAgents: { name: string }[];
  stateFields: string[];
  configFields: string[];
}

export interface InspectOutput {
  schema: 'qiforge.boot.v1';
  runtime: { version: string; node: string };
  identity: OracleIdentity;
  plugins: InspectPluginEntry[];
  topo: string[];
  excluded: { plugin: string; reason: string }[];
  collisions: string[];
  warnings: string[];
}

/**
 * Build the diagnostic JSON dump for `qiforge inspect` and the
 * `/health/plugins` endpoint. Tier-1 prompt + token estimate are deferred
 * to a later phase and intentionally omitted.
 */
export function inspect(input: InspectInput): InspectOutput {
  const {
    resolved,
    collected,
    identity,
    runtimeVersion,
    bundledPluginNames,
    warnings = [],
  } = input;

  const finalNames = new Set(resolved.loaded.map((p) => p.name));

  const toolsByPlugin = groupBy(collected.tools, (e) => e.pluginName);
  const subAgentsByPlugin = groupBy(collected.subAgents, (e) => e.pluginName);
  const stateByPlugin = groupBy(collected.sharedState, (e) => e.pluginName);
  const configByPlugin = groupBy(
    collected.configSchemas.flatMap((entry) =>
      Object.keys(entry.schema.shape).map((key) => ({
        pluginName: entry.pluginName,
        key,
      })),
    ),
    (e) => e.pluginName,
  );

  const plugins: InspectPluginEntry[] = resolved.loaded.map((plugin) =>
    buildPluginEntry({
      plugin,
      finalNames,
      bundledPluginNames,
      tools: toolsByPlugin.get(plugin.name) ?? [],
      subAgents: subAgentsByPlugin.get(plugin.name) ?? [],
      stateEntries: stateByPlugin.get(plugin.name) ?? [],
      configEntries: configByPlugin.get(plugin.name) ?? [],
    }),
  );

  const collisions = detectCollisions(plugins);

  return {
    schema: 'qiforge.boot.v1',
    runtime: { version: runtimeVersion, node: process.version },
    identity,
    plugins,
    topo: resolved.loaded.map((p) => p.name),
    excluded: resolved.excluded,
    collisions,
    warnings,
  };
}

interface BuildPluginEntryArgs {
  plugin: OraclePlugin;
  finalNames: ReadonlySet<string>;
  bundledPluginNames?: ReadonlySet<string>;
  tools: RegisteredTool[];
  subAgents: RegisteredSubAgent[];
  stateEntries: RegisteredSharedAccessor[];
  configEntries: { pluginName: string; key: string }[];
}

function buildPluginEntry(args: BuildPluginEntryArgs): InspectPluginEntry {
  const {
    plugin,
    finalNames,
    bundledPluginNames,
    tools,
    subAgents,
    stateEntries,
    configEntries,
  } = args;

  const softDependsOn = plugin.softDependsOn ?? [];
  const softDepsResolved = softDependsOn.filter((d) => finalNames.has(d));
  const softDepsMissing = softDependsOn.filter((d) => !finalNames.has(d));

  const source: 'bundled' | 'user' =
    bundledPluginNames === undefined || bundledPluginNames.has(plugin.name)
      ? 'bundled'
      : 'user';

  return {
    name: plugin.name,
    version: plugin.version,
    source,
    dependsOn: [...(plugin.dependsOn ?? [])],
    softDependsOn: [...softDependsOn],
    softDepsResolved,
    softDepsMissing,
    tools: tools.map((t) => ({
      name: t.tool.name,
      visibility: t.tool.visibility,
    })),
    subAgents: subAgents.map((s) => ({ name: s.subAgent.name })),
    stateFields: stateEntries.map((e) => e.key),
    configFields: configEntries.map((e) => e.key),
  };
}

function detectCollisions(plugins: InspectPluginEntry[]): string[] {
  const collisions: string[] = [];
  const toolOwners = new Map<string, string>();
  const subAgentOwners = new Map<string, string>();
  const stateOwners = new Map<string, string>();

  for (const p of plugins) {
    for (const t of p.tools) {
      const prev = toolOwners.get(t.name);
      if (prev !== undefined && prev !== p.name) {
        collisions.push(
          `tool '${t.name}' registered by both '${prev}' and '${p.name}'`,
        );
      } else {
        toolOwners.set(t.name, p.name);
      }
    }
    for (const s of p.subAgents) {
      const prev = subAgentOwners.get(s.name);
      if (prev !== undefined && prev !== p.name) {
        collisions.push(
          `sub-agent '${s.name}' registered by both '${prev}' and '${p.name}'`,
        );
      } else {
        subAgentOwners.set(s.name, p.name);
      }
    }
    for (const f of p.stateFields) {
      const prev = stateOwners.get(f);
      if (prev !== undefined && prev !== p.name) {
        collisions.push(
          `shared-state key '${f}' registered by both '${prev}' and '${p.name}'`,
        );
      } else {
        stateOwners.set(f, p.name);
      }
    }
  }

  return collisions;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) {
      bucket.push(item);
    } else {
      out.set(k, [item]);
    }
  }
  return out;
}
