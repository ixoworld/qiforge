import type { DynamicModule, Type } from '@nestjs/common';
import type { z } from 'zod';
import type {
  AgentMiddleware,
  AuthExcludedRoute,
  PluginContext,
  PluginManifest,
  PluginPromptContribution,
  PluginSubAgent,
  PluginTool,
  PromptContributionInfo,
  RuntimeContext,
} from './types.js';

export abstract class OraclePlugin {
  /** Unique plugin identifier (kebab-case by convention). */
  abstract readonly name: string;

  /** Plugin version. */
  abstract readonly version: string;

  /** The agent's structured interface to this plugin. */
  abstract readonly manifest: PluginManifest;

  /** Hard dependencies — boot fails if any is missing. */
  readonly dependsOn?: string[];

  /** Soft dependencies — plugin loads either way; branches on availability. */
  readonly softDependsOn?: string[];

  /** Plugin-owned env vars. Merged into the runtime's Zod schema at boot. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly configSchema?: z.ZodObject<any>;

  /**
   * Predicate the loader runs against `process.env` when the plugin is
   * left at `'auto'` (or has no explicit toggle). Returning `false` skips
   * the plugin. Plugins without an `autoDetect` are on-by-default.
   */
  autoDetect?(env: NodeJS.ProcessEnv): boolean;

  /**
   * Human-readable description of what `autoDetect` checks (e.g. the env
   * var name). Surfaced in boot-error messages so operators see exactly
   * why the plugin was skipped.
   */
  readonly autoDetectHint?: string;

  /** Tools the main agent can call. Called once per request build. */
  getTools?(ctx: PluginContext): PluginTool[] | Promise<PluginTool[]>;

  /** Sub-agents the runtime auto-wraps as tools. */
  getSubAgents?(ctx: PluginContext): PluginSubAgent[];

  /**
   * Request-time tool contributions. Called once per `createMainAgent`
   * invocation with the full per-request `RuntimeContext`, so the plugin
   * can decide which tools to expose based on live state (e.g. AG-UI
   * actions in `state.agActions`).
   *
   * Results are merged with `getTools(ctx)` — both can fire on the same
   * build. Plugins should pick whichever hook fits: boot-time when only
   * config/identity matters; request-time when state/user/session matters.
   */
  getRequestTools?(rtCtx: RuntimeContext): PluginTool[] | Promise<PluginTool[]>;

  /**
   * Request-time sub-agent contributions. Same merge semantics as
   * `getRequestTools` — boot-time `getSubAgents` and request-time
   * `getRequestSubAgents` outputs are both collected.
   */
  getRequestSubAgents?(
    rtCtx: RuntimeContext,
  ): PluginSubAgent[] | Promise<PluginSubAgent[]>;

  /**
   * Request-time prompt contributions. Called once per `createMainAgent`
   * build AFTER tools and sub-agents are bound, so the plugin can see
   * whether its surface actually attached (`info.boundToolNames`) and which
   * capabilities this thread has loaded (`info.loadedPlugins`), and react —
   * contribute a richer operational mode, a mode section, custom
   * instructions, or stub tools explaining a refusal.
   *
   * The runtime composes contributions generically; it knows nothing about
   * any specific plugin's modes.
   */
  getPromptContribution?(
    rtCtx: RuntimeContext,
    info: PromptContributionInfo,
  ):
    | PluginPromptContribution
    | undefined
    | Promise<PluginPromptContribution | undefined>;

  /**
   * LangChain middlewares inserted after the four always-on middlewares
   * (tool-validation, retry, page-context, safety-guardrail).
   */
  getMiddlewares?(ctx: PluginContext): AgentMiddleware[];

  /**
   * Middlewares that must ALSO run inside every sub-agent's inner loop —
   * not just the main agent's. Metering is the canonical case: a credit
   * gate that only guards the outer loop is a gate the outer loop can walk
   * around by delegating. Keep these self-contained (they receive the same
   * forwarded runtime context sub-agent invocations carry).
   */
  getSubAgentMiddlewares?(ctx: PluginContext): AgentMiddleware[];

  /**
   * Read-only accessors this plugin exposes to other plugins via `ctx.shared`.
   * Pattern: this plugin computes/owns some derived value from state; others
   * read it.
   */
  getSharedState?(): Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (state: any, runCtx: RuntimeContext) => unknown
  >;

  /**
   * Consumer allow-lists for `getSharedState` keys. A key listed here is
   * readable only by the named plugins (and its producer); keys not listed
   * stay readable by every plugin. Declare this when a shared value carries
   * anything another plugin shouldn't casually read.
   */
  readonly sharedStateVisibility?: Record<string, readonly string[]>;

  /**
   * NestJS modules the plugin contributes. Spread into `RuntimeAppModule.imports`,
   * so the module gets full DI access to Tier-0 services (Sessions, Messages,
   * Cache, etc.) and can declare its own Controllers, providers, and
   * `OnModuleInit` / `OnModuleDestroy` lifecycle hooks.
   *
   * Returns either plain module classes or `DynamicModule` configs (from
   * `Module.register(...)` / `forRoot(...)` style helpers).
   *
   * Use this for plugins that need a long-lived NestJS service (Slack socket,
   * BullMQ workers) or HTTP Controllers (Calls REST API).
   *
   * `ctx` carries the validated merged config + identity + logger so
   * module-construction code can read env without going through `process.env`.
   * The optional arg keeps existing plugins source-compatible —
   * implementations that ignore it work unchanged.
   */
  getNestModules?(ctx?: PluginContext): Array<Type | DynamicModule>;

  /**
   * Routes owned by this plugin's `getNestModules()` controllers that MUST NOT
   * pass through `AuthHeaderMiddleware`. Use for webhooks, OAuth callbacks,
   * public probes — anything that doesn't authenticate via UCAN. Returning an
   * empty array (or omitting the method) keeps every plugin route auth-locked.
   *
   * The returned `path` is matched against the request URL the same way
   * `MiddlewareConsumer.exclude(...)` matches — leading slash is optional and
   * the value should be the full path the controller mounts at (e.g.
   * `weather/now`, not just `now`).
   */
  getAuthExcludedRoutes?(): AuthExcludedRoute[];
}
