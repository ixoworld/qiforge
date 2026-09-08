import type { z } from 'zod';
import type { PluginRoute } from '../shell/app';
import type {
  AgentMiddleware,
  AuthExcludedRoute,
  PluginContext,
  PluginManifest,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from './types';

/**
 * The environment the plugin loader hands to `autoDetect`. On Workers this
 * is the `env` bindings object (secrets, vars, and — for keys a plugin never
 * reads — Durable Object namespaces), never `process.env`. Values are typed
 * `unknown` because bindings are not all strings; a plugin checking for a
 * secret should test `typeof env.MY_KEY === 'string' && env.MY_KEY.length > 0`.
 */
export type PluginEnv = Record<string, unknown>;

/**
 * A route contributed by a plugin — `{ method, path, handler(request, env) }`,
 * the exact shape the Hono shell mounts (`src/shell/app.ts` owns the type).
 * `path` is mounted as given (leading slash optional) with the shell's router
 * syntax, so `:param` segments work. Routes are auth-locked unless the same
 * plugin lists them in `getAuthExcludedRoutes()`.
 */
export type { PluginRoute };

/** HTTP methods a plugin route can be mounted on. */
export type PluginRouteMethod = PluginRoute['method'];

/**
 * Base class every plugin implements. Identical to the Node runtime's contract
 * except for two Workers-driven changes:
 *
 *  - `autoDetect` receives the Worker `env` bindings object (`PluginEnv`)
 *    rather than `NodeJS.ProcessEnv`. A Node plugin whose predicate only reads
 *    string keys compiles unchanged (method parameters are bivariant).
 *  - `getNestModules` is replaced by `getRoutes`, which returns plain
 *    `{ method, path, handler }` records the Hono shell mounts. There is no
 *    dependency-injection container on Workers; plugins that need long-lived
 *    state hold it on the instance (the instance lives as long as the isolate).
 */
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
   * Predicate the loader runs against the Worker `env` bindings when the
   * plugin is left at `'auto'` (or has no explicit toggle). Returning `false`
   * skips the plugin. Plugins without an `autoDetect` are on-by-default.
   */
  autoDetect?(env: PluginEnv): boolean;

  /**
   * Human-readable description of what `autoDetect` checks (e.g. the env
   * var name). Surfaced in boot-error messages so operators see exactly
   * why the plugin was skipped.
   */
  readonly autoDetectHint?: string;

  /** Tools the main agent can call. Called once per isolate (boot-cached). */
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
   * LangChain middlewares inserted after the runtime's always-on middlewares
   * (summarization, capability gate, tool validation, repetition guard, retry).
   */
  getMiddlewares?(ctx: PluginContext): AgentMiddleware[];

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
   * HTTP routes the plugin contributes. The Hono shell mounts every returned
   * route under the Worker's root; handlers receive the raw `Request` and the
   * Worker `env`. Use for webhooks, public probes, or plugin-owned REST
   * endpoints. Replaces the Node runtime's `getNestModules`.
   *
   * `ctx` carries the validated merged config + identity + logger so handlers
   * can close over config without reading `env` themselves.
   */
  getRoutes?(ctx: PluginContext): PluginRoute[];

  /**
   * Routes owned by this plugin's `getRoutes()` that MUST NOT pass through
   * the shell's UCAN auth middleware. Use for webhooks, OAuth callbacks,
   * public probes — anything that doesn't authenticate via UCAN. Returning an
   * empty array (or omitting the method) keeps every plugin route auth-locked.
   *
   * The returned `path` is matched against the request URL with the leading
   * slash optional and should be the full mounted path (e.g. `weather/now`).
   */
  getAuthExcludedRoutes?(): AuthExcludedRoute[];
}
