import type { DecisionRegistration } from '@ixo/common/ai/decisions';
import type {
  RequestAdmissionContext,
  RequestAdmissionResult,
} from './request-admission';
import type { ChannelEventResult, OracleChannelEvent } from './channel-events';
import type { ModelCallRecord } from '../llm/model-call';
import type { z } from 'zod';
import type { PluginRoute } from '../shell/app';
import type {
  AgentMiddleware,
  AuthExcludedRoute,
  OwnerCallback,
  OwnerCallbackContext,
  OwnerCallbackResult,
  PluginContext,
  PluginManifest,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
  TurnScope,
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

/** Why a channel turn failed, as `channelFailureReply` is told. */
export interface ChannelFailureInfo {
  /**
   * The failure's class: `rate_limit`, `billing`, `auth`, `timeout`,
   * `server`, `network` or `unknown` when the model could not be reached;
   * `empty_reply` when the model answered, twice, with nothing to send.
   */
  kind: string;
  /** The provider's HTTP status, when there was one. */
  status?: number;
}

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

  /**
   * How the agent should work with this plugin once it is in use: the
   * plugin's working rules, as plain text (markdown, starting at a `###`
   * heading). Never part of the manifest, the Tier-1 capability block or
   * `list_capabilities`, so it costs nothing on turns that do not use the
   * plugin. The model has it when it first uses the plugin's tools: in the
   * load result or on the turn's message when the plugin loads on a warm
   * turn, in the system prompt from the next cold turn on, and always there
   * for an `always` plugin the user's delegation can use.
   */
  readonly operatingGuide?: string;

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
   * Bounded semantic decisions contributed by this plugin. Decisions are
   * side-effect-free and are never exposed to the generative agent unless a
   * plugin explicitly wraps one in a tool.
   */
  getDecisions?(ctx: PluginContext): DecisionRegistration[];

  /**
   * Narrow this turn before anything is collected — see {@link TurnScope}.
   * Runs once per `createMainAgent`, before `getRequestTools`. A hook that
   * throws fails CLOSED: the turn is restricted to this plugin's own tools.
   */
  getTurnScope?(rtCtx: RuntimeContext): Promise<TurnScope | undefined>;

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

  /** Per-turn extensions for the ordinary agent; never cached across users. */
  getRequestMiddlewares?(
    ctx: RuntimeContext,
  ): AgentMiddleware[] | Promise<AgentMiddleware[]>;

  /** Runs before agent preparation. Only authorized deterministic reads may be handled. */
  getRequestAdmission?(
    ctx: RequestAdmissionContext,
  ): RequestAdmissionResult | Promise<RequestAdmissionResult>;

  /**
   * An event turn from the channel gateway: the person answered a
   * permission card in their wallet (`permission_answered`), or an identity
   * check at Self went into review, passed or failed
   * (`identity_check_updated`). The runtime asks each plugin in order, in
   * the person's own object when the event's run starts (after any turn
   * already running), with the turn's channel binding in
   * `ctx.session.channel`; the first answer that is not `pass` decides, and
   * an event no plugin claims is ignored. Claim only a card or link this
   * plugin asked for (kept in `ctx.kv`), and read it at the Auth Hub or Self
   * before acting: the event itself proves nothing. A plugin that throws
   * counts as `ignore`. See `src/plugins/credentials/README.md#channel-events`.
   */
  handleChannelEvent?(
    event: OracleChannelEvent,
    ctx: RuntimeContext,
  ): Promise<ChannelEventResult>;

  /**
   * Every platform model call of a turn (any role: the reply, the summary,
   * a sub-agent, a plugin's own `ctx.llm` call), once it ended or failed:
   * requested and served model, provider, whether a fallback answered,
   * tokens, cost, duration and the error's class. For analytics: the record
   * holds no message content, tool arguments or user ids. Called in the
   * background after the call, never delaying the turn; a hook that throws
   * is logged and ignored. `ctx.user` / `ctx.session` are the turn's.
   */
  onModelCall?(
    call: ModelCallRecord,
    ctx: RuntimeContext,
  ): void | Promise<void>;

  /**
   * The short message a channel user (WhatsApp) gets instead of silence
   * when their turn failed because the model could not be reached
   * (provider errors, the platform key's limit, a timeout), e.g. in the
   * language the plugin keeps for the person. The first plugin to return
   * a non-empty text decides; otherwise `CHANNEL_BUSY_REPLY`, else a short
   * English default. Sent at most once per chat per 10 minutes. Must not
   * call a model: the model is what failed. Also asked (`failure.kind`
   * `empty_reply`, no cooldown) when a turn's reply stayed empty after the
   * runtime asked the model once more.
   */
  channelFailureReply?(
    ctx: RuntimeContext,
    failure: ChannelFailureInfo,
  ): string | undefined | Promise<string | undefined>;

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
   * A call one of this plugin's routes forwarded into the owner's user
   * object (the object's `ownerCallback` RPC), run there with the owner's kv
   * rows: for a reply that must be checked against state only the owner's
   * object holds (a verifier's encrypted answer, decrypted with the check's
   * private key). Called only for plugins that define it.
   */
  handleOwnerCallback?(
    call: OwnerCallback,
    ctx: OwnerCallbackContext,
  ): Promise<OwnerCallbackResult>;

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
