import type { z } from 'zod';
import type {
  AgentMiddleware,
  PluginContext,
  PluginManifest,
  PluginSubAgent,
  PluginTool,
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
  getRequestTools?(
    rtCtx: RuntimeContext,
  ): PluginTool[] | Promise<PluginTool[]>;

  /**
   * Request-time sub-agent contributions. Same merge semantics as
   * `getRequestTools` — boot-time `getSubAgents` and request-time
   * `getRequestSubAgents` outputs are both collected.
   */
  getRequestSubAgents?(
    rtCtx: RuntimeContext,
  ): PluginSubAgent[] | Promise<PluginSubAgent[]>;

  /**
   * LangChain middlewares inserted after the four always-on middlewares
   * (tool-validation, retry, page-context, safety-guardrail).
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
}
