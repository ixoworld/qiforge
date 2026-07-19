/**
 * Integration test harness — real ambient services + real Nest boot.
 *
 *  - `createIntegrationOracle()` boots the full Nest app on an ephemeral
 *    port. Tier B tests drive it via `ChatClient`. This is the sibling of
 *    `createOracleApp()` — same boot path, same Matrix init, same graceful
 *    shutdown. The only differences are: ephemeral port (`port: 0`) and
 *    captured lifecycle events. There are intentionally no
 *    `skipMatrixInit` / `skipGracefulShutdown` flags — integration tests
 *    boot the same stack production does. If Matrix is unreachable, the
 *    test fails; that failure IS the signal (spec §6, §11 #10).
 *
 *  - `createIntegrationRuntime()` builds a real `RuntimeContext` against
 *    real ambient services and lets a test invoke a plugin's tool / sub-
 *    agent / middleware directly — no Nest, no HTTP, no model. This is
 *    the sibling of `createTestRuntime()`, with `mockLlm`/`mockMatrix`
 *    swapped for the production adapters.
 *
 * Both surfaces deliberately reuse `resolvePlugins` / registry population
 * from the unit-test runtime so they validate the same wiring code that
 * production goes through.
 */
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { type DynamicModule, type Type } from '@nestjs/common';
// import { Logger } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import {
  createOracleApp,
  type OracleApp,
  type PluginStatusChangeEvent,
} from '../../bootstrap/create-oracle-app.js';
import {
  resolvePlugins,
  type FeatureToggle,
} from '../../bootstrap/plugin-loader.js';
import type { MainAgentHooks } from '../../graph/main-agent-types.js';
import { getProviderChatModel } from '../../llm/llm-provider.js';
import { buildMetaTools } from '../../meta-tools/index.js';
import type { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  AuthExcludedRoute,
  ChatOpenAIFields,
  ModelRole,
  OracleConfig,
  OracleIdentity,
  Logger as PluginLogger,
  ReadonlyState,
  RuntimeContext,
  UcanDelegation,
} from '../../plugin-api/types.js';
import {
  ConfigSchemaRegistry,
  ManifestRegistry,
  MiddlewareRegistry,
  SharedStateRegistry,
  SubAgentRegistry,
  ToolRegistry,
} from '../../registries/index.js';
import type {
  AmbientServices,
  BlobStoreAdapter,
  EmitAdapter,
  LlmAdapter,
  MatrixAdapter,
  SecretsAdapter,
  UcanAdapter,
} from '../../runtime-context/ambient.js';
import { mockBlobStore } from '../mocks.js';
import { buildPluginContext } from '../../runtime-context/build-plugin.js';
import {
  buildRuntimeContext,
  type RunConfig,
} from '../../runtime-context/build-runtime.js';

/**
 * Capability shape exposed to tests on the `RuntimeContext`. Matches the
 * `{ resource, action }` pair the production `UcanAdapter` reads.
 */
export interface IntegrationCapability {
  resource: string;
  action: string;
}

/** Options for `createIntegrationOracle`. */
export interface CreateIntegrationOracleOptions {
  /**
   * App-level plugins. Defaults to `[]` so the harness can boot the
   * minimum oracle (just core modules). Bundled plugins are independent —
   * they come in via `bundledPlugins`.
   */
  plugins?: OraclePlugin[];
  /**
   * Override the bundled plugin set. `[]` keeps the canonical bundled
   * catalog out of the test boot — useful for hello-world / health
   * checks that shouldn't drag in real upstreams.
   */
  bundledPlugins?: OraclePlugin[];
  /**
   * Same shape as `createOracleApp`. Defaults to `{ name: '...' }` from
   * `IDENTITY_DEFAULTS` below — override for plugins that read identity
   * config (`prompt.opening`, …).
   */
  config?: OracleConfig;
  /** Feature toggles. Identical to `createOracleApp.features`. */
  features?: Partial<Record<string, FeatureToggle>>;
  /** Host-declared Nest modules. */
  nestModules?: Array<Type | DynamicModule>;
  /** Host-declared auth-excluded routes (e.g. `/version` in qiforge-example). */
  authExcludedRoutes?: AuthExcludedRoute[];
  /** Override `process.env` for the boot. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Bind port — `0` (default) means "OS picks an ephemeral port". The
   * actual port shows up in `result.baseUrl` after `listen()`.
   */
  port?: number;
  /** Override the bootstrap logger. Defaults to a captured `Logger`. */
  logger?: PluginLogger;
  /**
   * Override / extend the main-agent hooks. The harness always installs a
   * default `resolveModel` that swaps the production model map to the
   * PR-tier test model map (spec §7) — `main` → `moonshotai/kimi-k2.5`,
   * `subagent` → `openai/gpt-oss-120b`. Caller-supplied hooks merge on top
   * (caller wins per-key).
   */
  hooks?: MainAgentHooks;
}

/**
 * Default test model overrides (spec §7 PR-tier).
 *
 *   - `main`     → `moonshotai/kimi-k2.5` (production *subagent* model — proven
 *                  to call tools in this codebase; cheaper than the production
 *                  `main` model `kimi-k2.6`)
 *   - `subagent` → `openai/gpt-oss-120b` (cheaper sub-agent for tests)
 *
 * Roles not in this map fall through to `getProviderChatModel(role)` — the
 * production resolver — so `routing`, `guard`, `session-title`, `vision`,
 * `skills`, etc. all behave exactly like production.
 */
const TEST_MODEL_OVERRIDES: Partial<Record<string, string>> = {
  main: 'moonshotai/kimi-k2.6',
  subagent: 'openai/gpt-oss-120b',
};

/**
 * Build the default `resolveModel` hook installed by `createIntegrationOracle`.
 *
 * Honors the test model overrides above for the roles the spec calls out;
 * everything else falls through to `getProviderChatModel(role, params)`
 * unchanged.
 */
function buildTestResolveModel(): NonNullable<MainAgentHooks['resolveModel']> {
  return (role: ModelRole, params?: ChatOpenAIFields) => {
    const override = TEST_MODEL_OVERRIDES[role];
    if (override === undefined) {
      return getProviderChatModel(role, params);
    }
    return getProviderChatModel(role, { ...(params ?? {}), model: override });
  };
}

/** Public surface of a booted integration oracle. */
export interface IntegrationOracle {
  /** `http://127.0.0.1:<port>` of the running Nest app. */
  baseUrl: string;
  /** The `OracleApp` handle from `createOracleApp`. */
  app: OracleApp;
  /** Captured plugin lifecycle events + boot errors. */
  events: {
    statusChanges: PluginStatusChangeEvent[];
    errors: Array<{ err: Error; source: string }>;
  };
  /** Snapshot of plugin loader state. */
  status: () => ReturnType<OracleApp['plugins']['status']>;
  /** Stop the HTTP server + close Nest. Idempotent. */
  close: () => Promise<void>;
}

/** Minimum config baseline that satisfies `createOracleApp`'s validator. */
const IDENTITY_DEFAULTS: OracleConfig = {
  name: 'IXO Active Agent',
  org: 'IXO',
  description:
    'A proactive, agentic personal assistant who autonomously engages, anticipates needs, and takes initiative to help users accomplish goals with minimal explicit direction.',
  prompt: {
    opening:
      "You are IXO, a proactive, agentic personal assistant. Your mission is to anticipate the user's needs, take initiative to suggest helpful actions or insights, and continuously engage to drive progress even when the user is passive. Don't wait for direct instructions—foresee tasks, flag important developments, and collaborate actively as an empowered agent.",
    capabilities:
      '- Autonomously identify relevant tasks, reminders, or information the user may need\n- Propose helpful actions or follow-ups without waiting for user prompts\n- Summarize ongoing context and progress\n- Take initiative to drive productivity and keep the user informed',
    communicationStyle:
      "Friendly, proactive, and collaborative. Confidently suggest next steps and actively check in with the user. Use plain language, but don't hesitate to lead conversations or propose actions.",
  },
};

/**
 * Boot the runtime on an ephemeral port with real ambient services. Wraps
 * `createOracleApp` identically to production — Matrix init still runs in
 * the background, graceful shutdown still registers. The only test-time
 * concessions are the ephemeral `port: 0` default and the captured
 * lifecycle-event buffers exposed on `result.events`.
 */
export async function createIntegrationOracle(
  opts: CreateIntegrationOracleOptions = {},
): Promise<IntegrationOracle> {
  const events: IntegrationOracle['events'] = {
    statusChanges: [],
    errors: [],
  };

  const logger = opts.logger ?? {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };

  // Default `resolveModel` swaps the production main/subagent models for the
  // PR-tier test pair (spec §7). Caller-supplied hooks merge on top — any
  // key the caller sets wins. `resolveModel` itself is overridable for tests
  // that need a deterministic fake (e.g. trajectory recording).
  const mergedHooks: MainAgentHooks = {
    resolveModel: buildTestResolveModel(),
    ...opts.hooks,
  };

  const app = await createOracleApp({
    config: opts.config ?? IDENTITY_DEFAULTS,
    plugins: opts.plugins ?? [],
    bundledPlugins: opts.bundledPlugins,
    features: opts.features,
    nestModules: opts.nestModules,
    authExcludedRoutes: opts.authExcludedRoutes,
    env: opts.env,
    logger,
    hooks: mergedHooks,
  });

  app.onPluginStatusChange((event) => {
    events.statusChanges.push(event);
  });
  app.onError((err, source) => {
    events.errors.push({ err, source });
  });

  const portOpt = opts.port ?? 0;
  await app.listen(portOpt);

  // Resolve the actual bound port. NestJS wraps express; `getHttpServer()`
  // returns the underlying HTTP server, whose `address()` exposes the port
  // when bound. Falls back to `portOpt` for environments where the
  // introspection isn't available (lightweight test runtimes that stub
  // `NestFactory.create`).
  const baseUrl = resolveBaseUrl(app, portOpt);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const nestApp = app.getNestApp();
    if (typeof nestApp.close === 'function') {
      await nestApp.close();
    }
  };

  return {
    baseUrl,
    app,
    events,
    status: () => app.plugins.status(),
    close,
  };
}

/** Resolve the bound `http://host:port` for a started `OracleApp`. */
function resolveBaseUrl(app: OracleApp, fallbackPort: number): string {
  const nestApp = app.getNestApp();
  const getServer = (
    nestApp as unknown as { getHttpServer?: () => { address?: () => unknown } }
  ).getHttpServer;
  if (typeof getServer === 'function') {
    const server = getServer.call(nestApp);
    if (server && typeof server.address === 'function') {
      const addr = server.address() as AddressInfo | string | null;
      if (addr && typeof addr === 'object' && typeof addr.port === 'number') {
        return `http://127.0.0.1:${addr.port}`;
      }
    }
  }
  return `http://127.0.0.1:${fallbackPort}`;
}

// ─────────────────────────────────────────────────────────────────────────
// createIntegrationRuntime — Tier A entry point (no Nest, no HTTP)
// ─────────────────────────────────────────────────────────────────────────

/** Options for `createIntegrationRuntime`. */
export interface CreateIntegrationRuntimeOptions {
  /** Plugins under test. Resolved via the production loader. */
  plugins: OraclePlugin[];
  /** Feature toggles — same shape as `createOracleApp`. */
  features?: Partial<Record<string, FeatureToggle>>;
  /** Merged config the runtime exposes to plugins. Defaults to `process.env`. */
  config?: Record<string, unknown>;
  /**
   * Test user identity. `did` is required; `matrixUserId` defaults to a
   * synthesized `@did-...:test-host` value.
   */
  user: {
    did: string;
    matrixUserId?: string;
  };
  /** Base64 UCAN delegation string — sent as `userContext.ucanDelegation.raw`. */
  delegation?: string;
  /** Parsed delegation capabilities, when callers want strict UCAN checks. */
  capabilities?: IntegrationCapability[];
  /** Override the synthesized session. */
  session?: Partial<RuntimeContext['session']>;
  /** Override the read-only state used for tool invocations. */
  state?: Partial<ReadonlyState>;
  /** Override the oracle identity. */
  identity?: Partial<OracleIdentity>;
  /** Logger; defaults to a NestJS `Logger`. */
  logger?: PluginLogger;
  /**
   * Optional `fetch` override — when set, plugin handlers that call
   * `globalThis.fetch` route through this instead. Tests that need to
   * stub upstreams can pass `undici.MockAgent`-style implementations.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Optional real `UcanAdapter` override. The default stub throws on
   * `mintInvocation` because the Tier A entry point doesn't boot a
   * `UcanService`. Tests for plugins whose tools mint downstream UCAN
   * invocations (memory, sandbox, skills, composio, …) supply a real
   * adapter — typically `bootedOracle.app.ambient.ucan`, after seeding
   * the user's delegation into the booted oracle's `UcanService` cache.
   */
  ucan?: UcanAdapter;
}

/** Public surface of a Tier A integration runtime. */
export interface IntegrationRuntime {
  /** Invoke a tool by name against the real runtime context. */
  invokeTool: (name: string, args: unknown) => Promise<unknown>;
  /** Invoke a middleware's lifecycle hooks in isolation. */
  invokeMiddleware: (
    nameOrIndex: string | number,
    state: Record<string, unknown>,
    runtime?: { context?: Record<string, unknown> },
  ) => Promise<{ before?: unknown; after?: unknown }>;
  /** Invoke a sub-agent with a textual task — returns its first LLM reply. */
  invokeSubAgent: (name: string, task: string) => Promise<string>;
  /** The real `AmbientServices` bag exposed to plugin builders. */
  ambient: AmbientServices;
  /** No-op today; reserved for future resource holders. */
  close: () => Promise<void>;
}

/**
 * Build a Tier A runtime backed by real ambient services. The harness:
 *
 *  1. Resolves the plugin list via the production loader (same `autoDetect`
 *     gates a real boot would run).
 *  2. Populates the six registries.
 *  3. Wires real adapters for `llm`, `secrets`, `matrix`, `ucan`, `emit`
 *     (in-memory no-ops for Matrix and secrets — the harness doesn't need
 *     a live homeserver to call a plugin tool that doesn't depend on one).
 *  4. Builds a fresh `RuntimeContext` per invocation using the test
 *     user/session/delegation.
 *
 * Use this when you want to call a tool *directly* against the real upstream
 * (Memory Engine, Sandbox, Skills, Composio, Firecrawl, …) without a model.
 */
export async function createIntegrationRuntime(
  opts: CreateIntegrationRuntimeOptions,
): Promise<IntegrationRuntime> {
  const logger = opts.logger ?? {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  const config = opts.config ?? process.env;

  // Stringify the config for plugin-loader autoDetect probes — `process.env`
  // values are strings, so the test config must look the same to keep the
  // boot path consistent.
  const envForLoader: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined || v === null) continue;
    envForLoader[k] = typeof v === 'string' ? v : String(v);
  }

  const resolved = resolvePlugins({
    bundled: opts.plugins,
    features: opts.features,
    env: envForLoader,
    logger,
  });

  const loadedPluginNames = new Set(resolved.loaded.map((p) => p.name));

  const tools = new ToolRegistry();
  const subAgents = new SubAgentRegistry();
  const middlewares = new MiddlewareRegistry();
  const manifests = new ManifestRegistry();
  const configSchemas = new ConfigSchemaRegistry();
  const sharedState = new SharedStateRegistry();
  for (const plugin of resolved.loaded) {
    tools.register(plugin);
    subAgents.register(plugin);
    middlewares.register(plugin);
    manifests.register(plugin);
    configSchemas.register(plugin);
    sharedState.register(plugin);
  }

  const identity: OracleIdentity = {
    name: 'IntegrationTestOracle',
    org: 'IXO',
    description: 'createIntegrationRuntime',
    entityDid:
      typeof config.ORACLE_ENTITY_DID === 'string'
        ? config.ORACLE_ENTITY_DID
        : 'did:ixo:test',
    ...opts.identity,
  };

  // Real LLM adapter — production-grade provider.
  const llmAdapter: LlmAdapter = {
    get(role, params) {
      return getProviderChatModel(role, params);
    },
  };

  // Matrix / secrets stay in-memory by default. Tests that need a live
  // Matrix surface should boot via `createIntegrationOracle()` instead —
  // a Tier A test that depends on Matrix is mis-tiered.
  const matrixAdapter: MatrixAdapter = {
    async postToRoom() {
      return 'integration-noop-event-id';
    },
    async getRoomState(roomId) {
      return { roomId, state: [] };
    },
    async getEventById(_roomId, eventId) {
      return { eventId, type: 'm.room.message', content: {} };
    },
  };

  const secretsAdapter: SecretsAdapter = {
    async getIndex() {
      return {};
    },
    async getValues() {
      return {};
    },
  };

  // UCAN adapter — honors the parsed capability list, matching production.
  // Callers can swap in a real adapter via `opts.ucan` when the plugin under
  // test needs to mint downstream invocations (memory / sandbox / skills /
  // composio). Typical pattern: boot an oracle via `createIntegrationOracle`
  // and pass `bootedOracle.app.ambient.ucan` here.
  const ucanCapabilities = opts.capabilities ?? [];
  const ucanAdapter: UcanAdapter = opts.ucan ?? {
    hasCapability(delegation, resource, action) {
      const caps = delegation?.capabilities ?? ucanCapabilities;
      return Boolean(
        caps.some((cap) => cap.resource === resource && cap.action === action),
      );
    },
    requireCapability(delegation, resource, action) {
      const caps = delegation?.capabilities ?? ucanCapabilities;
      const ok = caps.some(
        (cap) => cap.resource === resource && cap.action === action,
      );
      if (!ok) {
        throw new Error(
          `UCAN capability missing: '${action}' on '${resource}'.`,
        );
      }
    },
    async mintInvocation() {
      throw new Error(
        'createIntegrationRuntime: mintInvocation is not wired. Pass ' +
          '`ucan: bootedOracle.app.ambient.ucan` from a `createIntegrationOracle()` ' +
          'boot if your test needs downstream service invocations.',
      );
    },
    async resolveServiceDid() {
      return null;
    },
    hasSigningKey() {
      return false;
    },
    async createInvocationFromDelegation() {
      throw new Error(
        'createIntegrationRuntime: createInvocationFromDelegation is not wired. Pass ' +
          '`ucan: bootedOracle.app.ambient.ucan` from a `createIntegrationOracle()` ' +
          'boot if your test needs CAR-driven invocation minting.',
      );
    },
    async mintSelfSignedInvocation() {
      throw new Error(
        'createIntegrationRuntime: mintSelfSignedInvocation is not wired. Pass ' +
          '`ucan: bootedOracle.app.ambient.ucan` from a `createIntegrationOracle()` ' +
          'boot if your test needs self-signed invocation minting.',
      );
    },
    async getServiceDelegation() {
      return { error: 'no-delegation' as const };
    },
  };

  const emitAdapter: EmitAdapter = {
    emit() {
      // Silent — tests that need to assert on events should use
      // createIntegrationOracle().events instead.
    },
  };

  const blobStoreAdapter: BlobStoreAdapter = mockBlobStore();

  const ambient: AmbientServices = {
    config,
    identity,
    availablePlugins: loadedPluginNames,
    secrets: secretsAdapter,
    blobStore: blobStoreAdapter,
    matrix: matrixAdapter,
    llm: llmAdapter,
    emit: emitAdapter,
    ucan: ucanAdapter,
    logger,
  };

  const buildCtxFor = (pluginName: string) =>
    buildPluginContext({
      config,
      identity,
      availablePlugins: loadedPluginNames,
      logger,
      pluginName,
    });

  const sharedBuildCtx = buildCtxFor('__integration__');
  const pluginCollectedTools = await tools.collect(sharedBuildCtx);
  const collectedSubAgents = await subAgents.collect(sharedBuildCtx);
  const collectedMiddlewares = middlewares.collect(sharedBuildCtx);

  // Meta-tools (`list_capabilities`, `load_capability`) are registered by
  // the runtime at agent-build time in production — not by plugins. The
  // Tier A harness wires them in here so direct `invokeTool` can reach
  // them; same instance the agent would see at runtime.
  const metaToolEntries = buildMetaTools({
    manifestRegistry: manifests,
    collectedTools: pluginCollectedTools,
  }).map((tool) => ({ pluginName: '__meta__', tool }));
  const collectedTools = [...pluginCollectedTools, ...metaToolEntries];

  const delegation: UcanDelegation = {
    raw: opts.delegation ?? '',
    issuer: opts.user.did,
    audience: identity.entityDid,
    capabilities: ucanCapabilities,
  };

  const buildRtCtx = (): RuntimeContext => {
    const runConfig: RunConfig = {
      context: {
        user: {
          did: opts.user.did,
          matrixUserId:
            opts.user.matrixUserId ??
            `@${opts.user.did.replaceAll(':', '-')}:test-host`,
          ucanDelegation: delegation,
        },
        session: {
          id: opts.session?.id ?? `integration-session-${Date.now()}`,
          client: opts.session?.client ?? 'portal',
          requestId: opts.session?.requestId ?? `integration-req-${Date.now()}`,
          ...(opts.session ?? {}),
        },
      },
    };
    const stateInput = {
      messages: [],
      // Default: pre-load every resolved plugin so Tier A direct-invoke
      // tests don't need to call `load_capability` before reaching the
      // plugin's tools. Tests that exercise the on-demand-load flow itself
      // (`list_capabilities`, `load_capability`) override this with
      // `state: { loadedPlugins: new Set() }` for an empty-start scenario.
      loadedPlugins: loadedPluginNames,
      ...(opts.state ?? {}),
    };
    return buildRuntimeContext(runConfig, ambient, stateInput);
  };

  // If the caller asked for a custom fetch, install it for the duration of
  // the runtime. We restore on close() so parallel tests don't poison each
  // other's globalThis.fetch.
  const originalFetch = globalThis.fetch;
  if (opts.fetch) {
    globalThis.fetch = opts.fetch;
  }

  return {
    async invokeTool(name, args) {
      const rtCtx = buildRtCtx();
      // First check boot tools (collected once at harness construction).
      let entry = collectedTools.find((t) => t.tool.name === name);
      if (!entry) {
        // Fall through to per-request tools — `getRequestTools(rtCtx)` reads
        // the live runtime context (timezone, ucan delegation, etc.) so it
        // must be collected per-invocation rather than at harness build time.
        const requestTools = await tools.collectRequest(rtCtx);
        entry = requestTools.find((t) => t.tool.name === name);
      }
      if (!entry) {
        const available = [
          ...collectedTools.map((t) => t.tool.name),
          ...(await tools.collectRequest(rtCtx)).map((t) => t.tool.name),
        ].join(', ');
        throw new Error(
          `Tool "${name}" not found. Registered tools: ${available || '(none)'}.`,
        );
      }
      return entry.tool.handler(args, rtCtx);
    },

    async invokeMiddleware(nameOrIndex, state, runtimeArg) {
      const middleware = findMiddleware(collectedMiddlewares, nameOrIndex);
      const runtimeCtx = runtimeArg ?? { context: {} };
      const out: { before?: unknown; after?: unknown } = {};
      // LangChain v1.x middleware hooks have rich generic types; at the
      // harness boundary they all collapse to `(state, runtime) => result`.
      // The same shape `create-test-runtime.ts` uses.
      const hookBag = middleware as unknown as Record<
        string,
        HookEntry<unknown, unknown> | undefined
      >;
      const before1 = await runHook(hookBag.beforeAgent, state, runtimeCtx);
      if (before1 !== undefined) out.before = before1;
      const before2 = await runHook(hookBag.beforeModel, state, runtimeCtx);
      if (before2 !== undefined) out.before = before2;
      const after1 = await runHook(hookBag.afterModel, state, runtimeCtx);
      if (after1 !== undefined) out.after = after1;
      const after2 = await runHook(hookBag.afterAgent, state, runtimeCtx);
      if (after2 !== undefined) out.after = after2;
      return out;
    },

    async invokeSubAgent(name, task) {
      const entry = collectedSubAgents.find((s) => s.subAgent.name === name);
      if (!entry) {
        throw new Error(
          `Sub-agent "${name}" not found. Registered: ${
            collectedSubAgents.map((s) => s.subAgent.name).join(', ') ||
            '(none)'
          }.`,
        );
      }
      const sub = entry.subAgent;
      const buildCtx = buildCtxFor(entry.pluginName);
      const subTools =
        typeof sub.tools === 'function' ? sub.tools(buildCtx) : sub.tools;
      const systemPrompt =
        typeof sub.systemPrompt === 'function'
          ? sub.systemPrompt(buildCtx)
          : sub.systemPrompt;
      const model = ambient.llm.get(sub.model ?? 'subagent');
      const reply = await model.invoke([new HumanMessage(task)]);
      const replyText =
        typeof reply.content === 'string'
          ? reply.content
          : JSON.stringify(reply.content);
      return JSON.stringify({
        subAgent: sub.name,
        plugin: entry.pluginName,
        task,
        systemPromptPreview: systemPrompt.slice(0, 80),
        toolNames: subTools.map((t) => t.name),
        reply: replyText,
      });
    },

    ambient,

    async close() {
      if (opts.fetch) {
        globalThis.fetch = originalFetch;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────

/** LangChain-style middleware hook entry: either a function or `{ hook, … }`. */
type HookCallable<S, R> = (state: S, runtime: R) => unknown;
type HookEntry<S, R> =
  | HookCallable<S, R>
  | { hook: HookCallable<S, R>; canJumpTo?: unknown };

async function runHook<S, R>(
  entry: HookEntry<S, R> | undefined,
  state: S,
  runtime: R,
): Promise<unknown> {
  if (!entry) return undefined;
  const fn = typeof entry === 'function' ? entry : entry.hook;
  return fn(state, runtime);
}

function findMiddleware(
  collected: ReadonlyArray<{
    pluginName: string;
    middleware: { name: string };
  }>,
  nameOrIndex: string | number,
): { name: string } {
  if (typeof nameOrIndex === 'number') {
    const found = collected[nameOrIndex];
    if (!found) {
      throw new Error(
        `Middleware index ${nameOrIndex} out of range (0..${collected.length - 1}).`,
      );
    }
    return found.middleware;
  }
  const direct = collected.find((m) => m.middleware.name === nameOrIndex);
  if (direct) return direct.middleware;
  const names = collected.map((m) => m.middleware.name).join(', ');
  throw new Error(
    `Middleware "${nameOrIndex}" not found. Registered: ${names || '(none)'}.`,
  );
}

// Silence "BaseMessage import is unused" — types are needed for downstream
// consumers that augment opts.state with arbitrary message arrays.
export type { BaseMessage };
