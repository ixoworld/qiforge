import type { DecisionRegistration } from '@ixo/common/ai/decisions';
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
 * The seven registries the runtime composes. Instances are created per
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
  decisions: DecisionRegistry;
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
    decisions: new DecisionRegistry(),
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

/** Where `load_capability` reads the tools a plugin contributes. */
export interface ToolSummarySource {
  toolSummariesForPlugin(
    pluginName: string,
  ): Array<{ name: string; description: string }>;
}

/**
 * One turn's view of its own collected tools (boot and request-time), in
 * collection order — never another turn's.
 */
export function turnToolSummaries(
  tools: ReadonlyArray<{ pluginName: string; tool: PluginTool }>,
): ToolSummarySource {
  return {
    toolSummariesForPlugin: (pluginName) =>
      tools
        .filter((entry) => entry.pluginName === pluginName)
        .map(({ tool }) => ({
          name: tool.name,
          description: tool.description,
        })),
  };
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

  /** Add a plugin whose `getTools` will be called at `collect()` time. */
  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
    this.bootCache = null;
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
   *
   * The request-time part is returned to the caller only, never kept: the
   * registry is shared by every turn of the isolate, so nothing one user's
   * turn collected may be read back by another (`turnToolSummaries` gives a
   * turn its own view).
   */
  async collect(
    buildCtx: PluginContext,
    rtCtx?: RuntimeContext,
  ): Promise<RegisteredTool[]> {
    const boot = await this.collectBoot(buildCtx);
    const request = rtCtx ? await this.collectRequest(rtCtx) : [];
    return rtCtx
      ? withoutShadowingRequestTools([...boot, ...request], rtCtx.logger)
      : boot;
  }

  /** Summaries of the boot-time tools (the boot checks read these). */
  private summaries(): ToolSummary[] {
    return (this.bootCache ?? []).map(({ pluginName, tool, origin }) => ({
      pluginName,
      name: tool.name,
      description: tool.description,
      origin,
    }));
  }

  /** The flat list of boot-time tool names. */
  toolNames(): string[] {
    return this.summaries().map((entry) => entry.name);
  }

  /** Boot-time tool names contributed by a given plugin. */
  toolNamesForPlugin(pluginName: string): string[] {
    return this.summaries()
      .filter((entry) => entry.pluginName === pluginName)
      .map((entry) => entry.name);
  }

  /**
   * Name/description of the boot-time tools a given plugin contributed.
   * Summaries, not the tool objects. A turn that also has request-time tools
   * reads its own collection instead (`turnToolSummaries`).
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
    if (this.bootCache === null) {
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

/**
 * A request-time tool (most of them declared by the client in the turn body,
 * such as the Portal's browser tools) may not take a name another tool of the
 * turn already has: the model would call one name while the runtime ran
 * either tool. The colliding request tool is dropped for this turn with one
 * warning — the server tool (or the first request tool of that name) stays,
 * and the turn runs. Failing the turn instead would break every turn of a
 * client release that happens to declare a clashing name. Boot-time
 * collisions are `assertNoCollisions`' job; the names the registry cannot
 * see (the meta-tools, the runtime's per-turn tools, sub-agent tool names)
 * are reserved by `dropShadowingRequestEntries` when the agent is built.
 */
function withoutShadowingRequestTools(
  tools: readonly RegisteredTool[],
  logger: { warn(message: string): void },
): RegisteredTool[] {
  const owner = new Map<string, string>();
  const out: RegisteredTool[] = [];
  for (const entry of tools) {
    const { pluginName, tool, origin } = entry;
    const previous = owner.get(tool.name);
    if (previous !== undefined && origin === 'request') {
      logger.warn(
        `${LOG_PREFIX} request tool "${tool.name}" of plugin "${pluginName}" dropped for this turn: the name is already taken by plugin "${previous}"`,
      );
      continue;
    }
    if (previous === undefined) owner.set(tool.name, pluginName);
    out.push(entry);
  }
  return out;
}

/**
 * Drop the request-time tools and sub-agents whose name is already taken.
 * Request-time contributions are recomputed every turn and some carry names
 * a client declared (browser tools, AG-UI actions), so none of them may stand
 * in for a tool the server owns: a name in `reservedNames` (the turn's
 * boot-time tools and sub-agents, the meta-tools and the runtime's per-turn
 * tools), or one an earlier request-time entry of the same turn already
 * claimed, is dropped with one warning naming the plugin. Sub-agents are
 * compared by the tool name they are bound under. Boot-time entries pass
 * through untouched (their collisions are a boot error, `assertNoCollisions`)
 * unless they take one of `runtimeNames`: tools the runtime binds only on
 * some turns (so no boot check can see them), which win over a plugin tool
 * of either origin.
 */
export function dropShadowingRequestEntries(opts: {
  tools: readonly RegisteredTool[];
  requestSubAgents: readonly RegisteredSubAgent[];
  reservedNames: Iterable<string>;
  /** Names the runtime binds this turn; reserved against boot-time tools too. */
  runtimeNames?: Iterable<string>;
  logger: { warn(message: string): void };
}): { tools: RegisteredTool[]; requestSubAgents: RegisteredSubAgent[] } {
  const runtime = new Set(opts.runtimeNames);
  const taken = new Set([...opts.reservedNames, ...runtime]);
  const drop = (pluginName: string, name: string, kind: string): void =>
    opts.logger.warn(
      `${LOG_PREFIX} plugin "${pluginName}" request-time ${kind} "${name}" dropped: the name is already taken this turn`,
    );
  const tools: RegisteredTool[] = [];
  for (const entry of opts.tools) {
    if (entry.origin === 'boot' && runtime.has(entry.tool.name)) {
      opts.logger.warn(
        `${LOG_PREFIX} plugin "${entry.pluginName}" tool "${entry.tool.name}" dropped for this turn: the runtime binds a tool of that name`,
      );
      continue;
    }
    if (entry.origin === 'request') {
      if (taken.has(entry.tool.name)) {
        drop(entry.pluginName, entry.tool.name, 'tool');
        continue;
      }
      taken.add(entry.tool.name);
    }
    tools.push(entry);
  }
  const requestSubAgents: RegisteredSubAgent[] = [];
  for (const entry of opts.requestSubAgents) {
    const toolName = computeSubAgentToolName(entry.subAgent.name);
    if (taken.has(toolName)) {
      drop(entry.pluginName, toolName, 'sub-agent');
      continue;
    }
    taken.add(toolName);
    requestSubAgents.push(entry);
  }
  return { tools, requestSubAgents };
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

  /** Add a plugin whose `getSubAgents` will be called at `collect()` time. */
  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
    this.bootCache = null;
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

  /**
   * Combined boot + request collection used by the main agent build. As
   * with `ToolRegistry.collect`, the request-time part is not kept.
   */
  async collect(
    buildCtx: PluginContext,
    rtCtx?: RuntimeContext,
  ): Promise<RegisteredSubAgent[]> {
    const boot = this.collectBoot(buildCtx);
    const request = rtCtx ? await this.collectRequest(rtCtx) : [];
    return [...boot, ...request];
  }

  /** Names of the boot-time sub-agents (the boot checks read these). */
  private names(): Array<{ pluginName: string; subAgentName: string }> {
    return (this.bootCache ?? []).map(({ pluginName, subAgent }) => ({
      pluginName,
      subAgentName: subAgent.name,
    }));
  }

  /**
   * The *wrapped* tool names of the boot-time sub-agents a given plugin
   * contributes. Each entry passes through `computeSubAgentToolName` — the
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
    if (this.bootCache === null) {
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

  async collectRequest(ctx: RuntimeContext): Promise<RegisteredMiddleware[]> {
    const entries = await Promise.all(
      this.plugins.map(async (plugin) =>
        ((await plugin.getRequestMiddlewares?.(ctx)) ?? []).map(
          (middleware) => ({ pluginName: plugin.name, middleware }),
        ),
      ),
    );
    return entries.flat();
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
  /** Plugin name → `operatingGuide`, kept apart from the manifests (never rendered with them). */
  private readonly guides = new Map<string, string>();

  /**
   * Record a plugin's manifest. A fork-supplied `override` is merged shallowly
   * over the plugin's own manifest, so every downstream reader sees the
   * effective manifest. A non-blank `operatingGuide` is recorded beside it.
   */
  register(plugin: OraclePlugin, override?: PluginManifestOverride): void {
    this.entries.push({
      pluginName: plugin.name,
      manifest: mergeManifestOverride(plugin.manifest, override),
    });
    const guide = plugin.operatingGuide?.trim();
    if (guide) this.guides.set(plugin.name, guide);
  }

  /** The plugin's operating guide, trimmed; `undefined` when it has none. */
  operatingGuide(pluginName: string): string | undefined {
    return this.guides.get(pluginName);
  }

  /** Every registered operating guide, by plugin name in code-point order. */
  operatingGuides(): Array<{ pluginName: string; guide: string }> {
    return [...this.guides]
      .map(([pluginName, guide]) => ({ pluginName, guide }))
      .sort((a, b) =>
        a.pluginName < b.pluginName ? -1 : a.pluginName > b.pluginName ? 1 : 0,
      );
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

// ── Decision registry ───────────────────────────────────────────────────────

/** A collected decision tagged with the plugin that contributed it. */
export interface RegisteredDecision {
  pluginName: string;
  decision: DecisionRegistration;
}

interface DecisionBootCache {
  entries: RegisteredDecision[];
  /** First registration per name; duplicates surface in `assertNoCollisions`. */
  byName: Map<string, RegisteredDecision>;
}

/**
 * Stores the bounded semantic decisions plugins contribute through
 * `getDecisions(ctx)`. Collected once per isolate (in `warm()`); the
 * `DecisionRuntime` resolves `evaluateByName` through `get`. Name collisions
 * across plugins are a boot error.
 */
export class DecisionRegistry {
  private readonly plugins: OraclePlugin[] = [];
  private bootCache: DecisionBootCache | null = null;

  register(plugin: OraclePlugin): void {
    this.plugins.push(plugin);
    this.bootCache = null;
  }

  /** Collect every plugin's decisions once; later calls return the cache. */
  collect(buildCtx: PluginContext): RegisteredDecision[] {
    if (this.bootCache !== null) return this.bootCache.entries;

    const entries: RegisteredDecision[] = [];
    const byName = new Map<string, RegisteredDecision>();
    for (const plugin of this.plugins) {
      if (!plugin.getDecisions) continue;
      for (const decision of plugin.getDecisions(buildCtx)) {
        const entry: RegisteredDecision = { pluginName: plugin.name, decision };
        entries.push(entry);
        if (!byName.has(decision.name)) byName.set(decision.name, entry);
      }
    }
    this.bootCache = { entries, byName };
    return entries;
  }

  get(name: string): RegisteredDecision | undefined {
    if (this.bootCache === null) {
      throw new Error('DecisionRegistry.get called before collect');
    }
    return this.bootCache.byName.get(name);
  }

  namesForPlugin(pluginName: string): string[] {
    if (this.bootCache === null) return [];
    return this.bootCache.entries
      .filter((entry) => entry.pluginName === pluginName)
      .map((entry) => entry.decision.name);
  }

  /** Throw if two plugins contribute decisions under the same name. */
  assertNoCollisions(): void {
    if (this.bootCache === null) {
      throw new Error(
        'DecisionRegistry.assertNoCollisions called before collect',
      );
    }

    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { pluginName, decision } of this.bootCache.entries) {
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
