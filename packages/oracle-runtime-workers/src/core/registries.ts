import type { z } from 'zod';
import type { OraclePlugin } from '../plugin-api/oracle-plugin';
import type {
  AgentMiddleware,
  PluginContext,
  PluginManifest,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
  SharedAccessors,
} from '../plugin-api/types';
import {
  mergeManifestOverride,
  validateExamplesAgainstTools,
  type PluginManifestOverride,
} from './manifest';
import { computeSubAgentToolName } from './subagent-as-tool';

/**
 * The six registries the runtime composes. Instances are created per
 * `createRuntimeCore()` call — never at module scope — so an isolate that
 * boots two oracles (tests, or a multi-tenant shell) never shares caches.
 */
export interface Registries {
  tools: ToolRegistry;
  subAgents: SubAgentRegistry;
  middlewares: MiddlewareRegistry;
  manifests: ManifestRegistry;
  configSchema: ConfigSchemaRegistry;
  sharedState: SharedStateRegistry;
}

/** Build a fresh, empty set of registries. */
export function createRegistries(): Registries {
  return {
    tools: new ToolRegistry(),
    subAgents: new SubAgentRegistry(),
    middlewares: new MiddlewareRegistry(),
    manifests: new ManifestRegistry(),
    configSchema: new ConfigSchemaRegistry(),
    sharedState: new SharedStateRegistry(),
  };
}

// ── Tool registry ───────────────────────────────────────────────────────────

/** Log prefix for the registry's own diagnostics. */
const LOG_PREFIX = '[tool-registry]';

/**
 * Render collected tools as `plugin=[toolA, toolB]; other=[toolC]` — the
 * diagnostic that answers "which plugin contributed what on this turn".
 */
export function formatByPlugin(entries: readonly RegisteredTool[]): string {
  const byPlugin = new Map<string, string[]>();
  for (const { pluginName, tool } of entries) {
    const names = byPlugin.get(pluginName);
    if (names) names.push(tool.name);
    else byPlugin.set(pluginName, [tool.name]);
  }
  return Array.from(
    byPlugin,
    ([name, tools]) => `${name}=[${tools.join(', ')}]`,
  ).join('; ');
}

/** A collected tool tagged with the plugin that contributed it. */
export interface RegisteredTool {
  pluginName: string;
  tool: PluginTool;
  /**
   * Which hook produced it — `getTools` (boot, cached for the isolate) or
   * `getRequestTools` (recomputed every turn).
   */
  origin: 'boot' | 'request';
}

/** Name/description slice of a collected tool, tagged with its plugin. */
export interface ToolSummary {
  pluginName: string;
  name: string;
  description: string;
  origin: 'boot' | 'request';
}

/**
 * Stores plugins that contribute tools and resolves them lazily by invoking
 * each plugin's `getTools(buildCtx)` once at collection time.
 *
 * Tools live in a flat namespace — duplicate names across plugins are a
 * boot error caught by `assertNoCollisions()`.
 *
 * Boot-time outputs from `getTools(buildCtx)` are cached after the first
 * `collectBoot(buildCtx)` call. The request hot path only re-runs each
 * plugin's `getRequestTools(rtCtx)`.
 *
 * ## Cache safety / cross-user isolation
 *
 * `PluginContext` holds no user, session, or request data — only
 * `{ config, identity, availablePlugins, logger }`, all oracle-scoped and
 * stable for the isolate lifetime. Cached `PluginTool` objects are therefore
 * safe to share between users: their handlers receive a fresh
 * `RuntimeContext` from `wrapPluginTool` on every invocation.
 */
export class ToolRegistry {
  private readonly plugins: OraclePlugin[] = [];
  private bootCache: RegisteredTool[] | null = null;
  /**
   * Metadata snapshot of the most recent `collect()`. Deliberately NOT the
   * tool objects: request-time tools close over that request's
   * `RuntimeContext`, and retaining them here would pin a full request
   * graph in memory between turns.
   */
  private collectedMeta: ToolSummary[] | null = null;

  /** Add a plugin whose `getTools` will be called at `collect()` time. */
  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
    this.bootCache = null;
    this.collectedMeta = null;
  }

  /**
   * Run every plugin's `getTools(buildCtx)` once and cache the result. Safe
   * to call multiple times — subsequent calls return the cached list.
   */
  async collectBoot(buildCtx: PluginContext): Promise<RegisteredTool[]> {
    if (this.bootCache !== null) return this.bootCache;
    const out: RegisteredTool[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.getTools) continue;
      const tools = await plugin.getTools(buildCtx);
      for (const tool of tools) {
        out.push({ pluginName: plugin.name, tool, origin: 'boot' });
      }
    }
    this.bootCache = out;
    return out;
  }

  /**
   * Run every plugin's `getRequestTools(rtCtx)`. Does NOT touch the boot
   * cache.
   *
   * Hooks run concurrently — several of them open network connections, so
   * serializing them puts every round-trip on the chat hot path
   * back-to-back. Output order stays plugin-registration order regardless of
   * which hook resolves first.
   *
   * Failures are isolated PER PLUGIN: a hook that rejects contributes zero
   * tools and is logged as an error naming the plugin, while every other
   * plugin's tools still resolve.
   */
  async collectRequest(rtCtx: RuntimeContext): Promise<RegisteredTool[]> {
    const perPlugin = await Promise.all(
      this.plugins.map(async (plugin): Promise<RegisteredTool[]> => {
        if (!plugin.getRequestTools) return [];
        try {
          const requestTools = await plugin.getRequestTools(rtCtx);
          return requestTools.map((tool) => ({
            pluginName: plugin.name,
            tool,
            origin: 'request' as const,
          }));
        } catch (error) {
          rtCtx.logger.error(
            `${LOG_PREFIX} plugin "${plugin.name}" getRequestTools failed — it contributes NO tools this turn ` +
              `(other plugins are unaffected): ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
          return [];
        }
      }),
    );
    const out = perPlugin.flat();
    rtCtx.logger.debug?.(
      `${LOG_PREFIX} request tools by plugin: ${formatByPlugin(out) || '∅'}`,
    );
    return out;
  }

  /**
   * Combined boot + request collection used by the main agent build. Uses
   * the cached boot output when present so per-request rebuilds skip the
   * `getTools` invocations that don't depend on runtime state.
   */
  async collect(
    buildCtx: PluginContext,
    rtCtx?: RuntimeContext,
  ): Promise<RegisteredTool[]> {
    const boot = await this.collectBoot(buildCtx);
    const request = rtCtx ? await this.collectRequest(rtCtx) : [];
    const out = [...boot, ...request];
    this.collectedMeta = out.map(({ pluginName, tool, origin }) => ({
      pluginName,
      name: tool.name,
      description: tool.description,
      origin,
    }));
    return out;
  }

  /** Summaries source: the last full collection, else the boot cache. */
  private summaries(): ToolSummary[] {
    if (this.collectedMeta !== null) return this.collectedMeta;
    return (this.bootCache ?? []).map(({ pluginName, tool, origin }) => ({
      pluginName,
      name: tool.name,
      description: tool.description,
      origin,
    }));
  }

  /** The flat list of tool names produced by the most recent `collect()`. */
  toolNames(): string[] {
    return this.summaries().map((entry) => entry.name);
  }

  /**
   * Tool names contributed by a given plugin in the most recent `collect()`
   * (or `collectBoot()` if no full collection has happened yet).
   */
  toolNamesForPlugin(pluginName: string): string[] {
    return this.summaries()
      .filter((entry) => entry.pluginName === pluginName)
      .map((entry) => entry.name);
  }

  /**
   * Name/description of the tools a given plugin contributed in the most
   * recent collection. Summaries, not the tool objects — see `collectedMeta`.
   */
  toolSummariesForPlugin(
    pluginName: string,
  ): Array<{ name: string; description: string }> {
    return this.summaries()
      .filter((entry) => entry.pluginName === pluginName)
      .map(({ name, description }) => ({ name, description }));
  }

  /**
   * Throw if two plugins contribute a tool with the same name. The error
   * message names every colliding plugin pair so the boot log points at the
   * actual conflict.
   */
  assertNoCollisions(): void {
    if (this.collectedMeta === null && this.bootCache === null) {
      throw new Error('ToolRegistry.assertNoCollisions called before collect');
    }
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { pluginName, name } of this.summaries()) {
      const prev = seen.get(name);
      if (prev !== undefined && prev !== pluginName) {
        collisions.push(
          `Tool "${name}" registered by both "${prev}" and "${pluginName}"`,
        );
      } else if (prev === undefined) {
        seen.set(name, pluginName);
      }
    }
    if (collisions.length > 0) {
      throw new Error(
        `ToolRegistry: tool name collisions detected:\n  - ${collisions.join('\n  - ')}`,
      );
    }
  }
}

// ── Sub-agent registry ──────────────────────────────────────────────────────

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
 */
export class SubAgentRegistry {
  private readonly plugins: OraclePlugin[] = [];
  private bootCache: RegisteredSubAgent[] | null = null;
  /** Names-only snapshot of the most recent `collect()` (see ToolRegistry). */
  private collectedNames: Array<{
    pluginName: string;
    subAgentName: string;
  }> | null = null;

  /** Add a plugin whose `getSubAgents` will be called at `collect()` time. */
  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
    this.bootCache = null;
    this.collectedNames = null;
  }

  /** Run every plugin's `getSubAgents(buildCtx)` once and cache the result. */
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
   * cache. Hooks run concurrently; output order stays registration order.
   * Failures are isolated per plugin, mirroring `ToolRegistry.collectRequest`.
   */
  async collectRequest(rtCtx: RuntimeContext): Promise<RegisteredSubAgent[]> {
    const perPlugin = await Promise.all(
      this.plugins.map(async (plugin): Promise<RegisteredSubAgent[]> => {
        if (!plugin.getRequestSubAgents) return [];
        try {
          const requestSubAgents = await plugin.getRequestSubAgents(rtCtx);
          return requestSubAgents.map((subAgent) => ({
            pluginName: plugin.name,
            subAgent,
          }));
        } catch (error) {
          rtCtx.logger.error(
            `[subagent-registry] plugin "${plugin.name}" getRequestSubAgents failed — it contributes NO sub-agents this turn ` +
              `(other plugins are unaffected): ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
          return [];
        }
      }),
    );
    return perPlugin.flat();
  }

  /** Combined boot + request collection used by the main agent build. */
  async collect(
    buildCtx: PluginContext,
    rtCtx?: RuntimeContext,
  ): Promise<RegisteredSubAgent[]> {
    const boot = this.collectBoot(buildCtx);
    const request = rtCtx ? await this.collectRequest(rtCtx) : [];
    const out = [...boot, ...request];
    this.collectedNames = out.map(({ pluginName, subAgent }) => ({
      pluginName,
      subAgentName: subAgent.name,
    }));
    return out;
  }

  /** Names source: the last full collection, else the boot cache. */
  private names(): Array<{ pluginName: string; subAgentName: string }> {
    if (this.collectedNames !== null) return this.collectedNames;
    return (this.bootCache ?? []).map(({ pluginName, subAgent }) => ({
      pluginName,
      subAgentName: subAgent.name,
    }));
  }

  /**
   * The *wrapped* tool names contributed by a given plugin in the most recent
   * collection. Each entry passes through `computeSubAgentToolName` — the
   * same transform `createSubagentAsTool` applies — so the names returned
   * here match what the agent will actually see.
   */
  subAgentNamesForPlugin(pluginName: string): string[] {
    return this.names()
      .filter((entry) => entry.pluginName === pluginName)
      .map((entry) => computeSubAgentToolName(entry.subAgentName));
  }

  /**
   * Throw if two plugins contribute sub-agents with the same name. The error
   * message names both plugin names so the boot log points at the conflict.
   */
  assertNoCollisions(): void {
    if (this.collectedNames === null && this.bootCache === null) {
      throw new Error(
        'SubAgentRegistry.assertNoCollisions called before collect',
      );
    }
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { pluginName, subAgentName } of this.names()) {
      const prev = seen.get(subAgentName);
      if (prev !== undefined && prev !== pluginName) {
        collisions.push(
          `Sub-agent "${subAgentName}" registered by both "${prev}" and "${pluginName}"`,
        );
      } else if (prev === undefined) {
        seen.set(subAgentName, pluginName);
      }
    }
    if (collisions.length > 0) {
      throw new Error(
        `SubAgentRegistry: sub-agent name collisions detected:\n  - ${collisions.join('\n  - ')}`,
      );
    }
  }
}

// ── Middleware registry ─────────────────────────────────────────────────────

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
 * dependency-driven topological reordering before registering plugins here.
 *
 * Middlewares are boot-time-only — there's no per-request hook. The
 * registry caches the first `collect(buildCtx)` result.
 */
export class MiddlewareRegistry {
  private readonly plugins: OraclePlugin[] = [];
  private bootCache: RegisteredMiddleware[] | null = null;

  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
    this.bootCache = null;
  }

  collect(buildCtx: PluginContext): RegisteredMiddleware[] {
    if (this.bootCache !== null) return this.bootCache;
    const out: RegisteredMiddleware[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.getMiddlewares) continue;
      const middlewares = plugin.getMiddlewares(buildCtx);
      for (const middleware of middlewares) {
        out.push({ pluginName: plugin.name, middleware });
      }
    }
    this.bootCache = out;
    return out;
  }

  /** Middlewares have no names, so no collision is possible. */
  assertNoCollisions(): void {
    // Intentional no-op — middleware order is established by the loader.
  }
}

// ── Manifest registry ───────────────────────────────────────────────────────

/** A collected manifest tagged with the plugin that contributed it. */
export interface RegisteredManifest {
  pluginName: string;
  manifest: PluginManifest;
}

/** Result of cross-checking every plugin's example tools against a ToolRegistry. */
export interface ManifestCrossCheckResult {
  errors: string[];
}

/**
 * Stores plugin manifests and wires the cross-tool-reference check that can
 * only run once tool registration is complete.
 */
export class ManifestRegistry {
  private readonly entries: RegisteredManifest[] = [];

  /**
   * Record a plugin's manifest. A fork-supplied `override` is merged shallowly
   * over the plugin's own manifest, so every downstream reader sees the
   * effective manifest.
   */
  register(plugin: OraclePlugin, override?: PluginManifestOverride): void {
    this.entries.push({
      pluginName: plugin.name,
      manifest: mergeManifestOverride(plugin.manifest, override),
    });
  }

  /** Registered manifests in registration order. */
  collect(): RegisteredManifest[] {
    return [...this.entries];
  }

  /**
   * For each registered manifest, validate that every `examples[].tool`
   * reference exists in the supplied registries. Sub-agents are first-class
   * tools to the agent — they get wrapped as `call_<name>` — so the
   * validator unions tool names with sub-agent wrapped names. Both
   * registries MUST have been collected before calling this.
   */
  validateAgainstTools(
    toolRegistry: ToolRegistry,
    subAgentRegistry: SubAgentRegistry,
  ): ManifestCrossCheckResult {
    const errors: string[] = [];
    for (const { pluginName, manifest } of this.entries) {
      const toolNames = [
        ...toolRegistry.toolNamesForPlugin(pluginName),
        ...subAgentRegistry.subAgentNamesForPlugin(pluginName),
      ];
      const result = validateExamplesAgainstTools(
        manifest,
        toolNames,
        pluginName,
      );
      errors.push(...result.errors);
    }
    return { errors };
  }

  /** Manifest title collisions are display-only, so this is a no-op. */
  assertNoCollisions(): void {
    // Intentional no-op.
  }
}

// ── Config-schema registry ──────────────────────────────────────────────────

/** A collected configSchema tagged with the plugin that contributed it. */
export interface RegisteredConfigSchema {
  pluginName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodObject<any>;
}

/**
 * Stores plugin-owned `configSchema` objects in registration order. The
 * actual Zod merge — collision detection, plugin-ownership tracking, env
 * validation — lives in `env.ts` via `composeEnvSchema()`.
 */
export class ConfigSchemaRegistry {
  private readonly entries: RegisteredConfigSchema[] = [];

  register(plugin: OraclePlugin): void {
    if (!plugin.configSchema) return;
    this.entries.push({
      pluginName: plugin.name,
      schema: plugin.configSchema,
    });
  }

  collect(): RegisteredConfigSchema[] {
    return [...this.entries];
  }

  /** Config keys may collide intentionally (later wins, with warning). */
  assertNoCollisions(): void {
    // intentional no-op
  }
}

// ── Shared-state registry ───────────────────────────────────────────────────

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
 * `runCtx.shared`. Key collisions across plugins are a boot error.
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
   * context by invoking each registered accessor lazily as keys are read, so
   * an accessor that throws does not break unrelated `ctx.shared.<key>` reads.
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

  /** Throw if two plugins contribute accessors under the same key. */
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
