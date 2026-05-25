import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  resolvePlugins,
  type FeatureToggle,
} from '../bootstrap/plugin-loader.js';
import { validateManifest } from '../manifest/validator.js';
import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type {
  AgentMiddleware,
  Logger,
  OracleIdentity,
  PluginManifest,
  PluginTool,
  ReadonlyState,
  RuntimeContext,
} from '../plugin-api/types.js';
import {
  ConfigSchemaRegistry,
  ManifestRegistry,
  MiddlewareRegistry,
  SharedStateRegistry,
  SubAgentRegistry,
  ToolRegistry,
} from '../registries/index.js';
import { buildPluginContext } from '../runtime-context/build-plugin.js';
import {
  buildRuntimeContext,
  type RunConfig,
} from '../runtime-context/build-runtime.js';
import type { AmbientServices } from '../runtime-context/ambient.js';
import {
  mockBlobStore,
  mockEmit,
  mockLlm,
  mockLogger,
  mockMatrix,
  mockSecrets,
  mockUcan,
  type FetchHandler,
  type MockMatrixOverrides,
} from './mocks.js';

/** Options accepted by `createTestRuntime`. */
export interface CreateTestRuntimeOptions {
  /** Plugins under test. Resolved via the production plugin loader. */
  plugins: OraclePlugin[];
  /**
   * Feature toggles, same shape as `createOracleApp`. Defaults to `'auto'`
   * for plugins that have an `autoDetect`, otherwise on.
   */
  features?: Partial<Record<string, FeatureToggle>>;
  /** Merged config (env vars). Plugins read this through `ctx.config`. */
  config?: Record<string, unknown>;
  /** Override fields on the synthesized RuntimeContext.user. */
  user?: Partial<RuntimeContext['user']>;
  /** Override fields on the synthesized RuntimeContext.session. */
  session?: Partial<RuntimeContext['session']>;
  /** Override fields on the read-only state passed to invoked handlers. */
  state?: Partial<ReadonlyState>;
  /** Override the identity exposed to plugin builders. */
  identity?: Partial<OracleIdentity>;
  /** Logger. Defaults to a `vi.fn()`-backed no-op. */
  logger?: Logger;
  /** Mock adapter overrides. */
  mocks?: {
    fetch?: FetchHandler;
    matrix?: MockMatrixOverrides;
    secrets?: Record<string, string>;
    llm?: { respondWith?: string | string[] };
  };
}

/** A `list_capabilities`-shaped row. */
export interface CapabilityListing {
  name: string;
  summary: string;
  visibility: NonNullable<PluginManifest['visibility']>;
  loaded: boolean;
  category?: PluginManifest['category'];
  tags: string[];
}

/** Public surface of the test runtime. */
export interface TestRuntime {
  /** Invoke a tool by its registered name. */
  invokeTool: (name: string, args: unknown) => Promise<unknown>;
  /** Invoke a middleware's hooks in isolation. */
  invokeMiddleware: (
    nameOrIndex: string | number,
    state: Record<string, unknown>,
    runtime?: { context?: Record<string, unknown> },
  ) => Promise<{ before?: unknown; after?: unknown }>;
  /** Invoke a sub-agent with a textual task; returns the LLM's first response. */
  invokeSubAgent: (name: string, task: string) => Promise<string>;
  /** List tools. Filter by plugin if supplied. */
  listTools: (plugin?: string) => PluginTool[];
  /** Read a plugin's manifest. Throws if unknown. */
  getManifest: (plugin: string) => PluginManifest;
  /** Same shape as the `list_capabilities` meta-tool. */
  listCapabilities: () => CapabilityListing[];
  /** Add a plugin to `loadedPlugins` for subsequent calls. */
  loadCapability: (name: string) => void;
  /** Throws on any registry collision. */
  assertNoCollisions: () => void;
  /** Throws on any invalid manifest. */
  assertManifestValid: () => void;
  /**
   * Stub for full agent invocation. Throws — full agent assembly lands once
   * `createMainAgent` is consumed by `createOracleApp`.
   */
  invokeAgent: (
    messages: BaseMessage[],
  ) => Promise<{ messages: BaseMessage[] }>;
  /** Mock-control surface; rebinds the underlying ambient services. */
  mocks: {
    matrix: (overrides: MockMatrixOverrides) => void;
    fetch: (handler: FetchHandler) => void;
  };
  /** Cleanup — releases anything the harness allocated. */
  close: () => Promise<void>;
}

/**
 * Build a `TestRuntime` for unit-testing one or more plugins in isolation.
 *
 * The harness wires the same registries the production runtime does, so
 * collisions, manifest validation, and meta-tool behavior all match what
 * an oracle would see at boot. It does NOT spin up Matrix, Redis, or a
 * real LLM — every ambient service is replaced with a mock by default.
 */
export async function createTestRuntime(
  opts: CreateTestRuntimeOptions,
): Promise<TestRuntime> {
  const logger = opts.logger ?? mockLogger();

  // 1. Resolve the plugin list through the production loader. `autoDetect`
  // probes are typed against `NodeJS.ProcessEnv` (string-or-undefined values),
  // so we stringify the test config — plugin authors can drop in numbers or
  // bools and still see consistent string-shaped probe input.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(opts.config ?? {})) {
    if (v === undefined || v === null) continue;
    env[k] = typeof v === 'string' ? v : String(v);
  }
  const resolved = resolvePlugins({
    bundled: opts.plugins,
    features: opts.features,
    env,
    logger,
  });

  const loadedPluginNames = new Set(resolved.loaded.map((p) => p.name));

  // 2. Populate the six registries.
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

  // 3. Mock ambient services. `let`-bindings so `rt.mocks.*` can swap them.
  let matrixAdapter = mockMatrix(opts.mocks?.matrix);
  const llmAdapter = mockLlm(opts.mocks?.llm);
  const secretsAdapter = mockSecrets(opts.mocks?.secrets);
  const blobStoreAdapter = mockBlobStore();
  const ucanAdapter = mockUcan();
  const emitAdapter = mockEmit();
  let fetchHandler: FetchHandler | undefined = opts.mocks?.fetch;

  const identity: OracleIdentity = {
    name: 'TestOracle',
    org: 'Test',
    description: 'createTestRuntime',
    entityDid: 'did:ixo:test',
    ...opts.identity,
  };

  // Build the ambient services with `matrix` as a getter so subsequent
  // `rt.mocks.matrix(...)` swaps are picked up by every fresh
  // `buildRuntimeContext` call without relying on a re-bind.
  const ambient: AmbientServices = {
    config: opts.config ?? {},
    identity,
    availablePlugins: loadedPluginNames,
    secrets: secretsAdapter,
    blobStore: blobStoreAdapter,
    get matrix() {
      return matrixAdapter;
    },
    llm: llmAdapter,
    emit: emitAdapter,
    ucan: ucanAdapter,
    logger,
  };

  // 4. Build the per-plugin PluginContexts (used to collect tools/subagents/etc).
  const buildCtxFor = (pluginName: string) =>
    buildPluginContext({
      config: opts.config ?? {},
      identity,
      availablePlugins: loadedPluginNames,
      logger,
      pluginName,
    });

  // Pre-collect tools/subagents/middlewares so the registries' query helpers
  // (`toolsForPlugin`, `assertNoCollisions`) work synchronously thereafter.
  // Registries pass a single PluginContext to every plugin; we use the
  // generic `__test__`-scoped one — attribution is by `plugin.name`, not by
  // anything inside the ctx, so a shared ctx is correct.
  const sharedBuildCtx = buildCtxFor('__test__');
  const collectedTools = await tools.collect(sharedBuildCtx);
  const collectedSubAgents = await subAgents.collect(sharedBuildCtx);
  const collectedMiddlewares = middlewares.collect(sharedBuildCtx);

  const loadedSet = new Set<string>();

  // 5. Helper to construct a fresh RuntimeContext per invocation.
  const buildRtCtx = (): RuntimeContext => {
    const runConfig: RunConfig = {
      context: {
        user: {
          did: 'did:ixo:test-user',
          matrixUserId: '@did-ixo-test-user:ixo.world',
          ucanDelegation: { raw: 'test-ucan' },
          ...opts.user,
        },
        session: {
          id: 'test-session',
          client: 'portal',
          requestId: 'test-req',
          ...opts.session,
        },
      },
    };
    const stateInput = {
      messages: [],
      ...(opts.state ?? {}),
      loadedPlugins: loadedSet,
    };
    return buildRuntimeContext(runConfig, ambient, stateInput);
  };

  // 6. Public surface.
  const runtime: TestRuntime = {
    async invokeTool(name, args) {
      const entry = collectedTools.find((t) => t.tool.name === name);
      if (!entry) {
        const available = collectedTools.map((t) => t.tool.name).join(', ');
        throw new Error(
          `Tool "${name}" not found. Registered tools: ${available || '(none)'}.`,
        );
      }
      return entry.tool.handler(args, buildRtCtx());
    },

    async invokeMiddleware(nameOrIndex, state, runtimeArg) {
      const middleware = findMiddleware(collectedMiddlewares, nameOrIndex);
      const runtimeCtx = runtimeArg ?? { context: {} };
      const out: { before?: unknown; after?: unknown } = {};

      // Run hooks in agent order. LangChain hooks have rich generic types
      // (BeforeAgentHook<TSchema, TFullContext> and friends), but at the
      // unit-test boundary they all collapse to `(state, runtime) => result`.
      // Each call goes through `runHook` so the harness invokes whichever
      // hooks the middleware actually defined.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = middleware as any;
      const before1 = await runHook(m.beforeAgent, state, runtimeCtx);
      if (before1 !== undefined) out.before = before1;
      const before2 = await runHook(m.beforeModel, state, runtimeCtx);
      if (before2 !== undefined) out.before = before2;
      const after1 = await runHook(m.afterModel, state, runtimeCtx);
      if (after1 !== undefined) out.after = after1;
      const after2 = await runHook(m.afterAgent, state, runtimeCtx);
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
      // Layer-1: deterministic envelope. Reuses the configured llm mock so
      // authors can opt into a recorded response via `mocks.llm.respondWith`.
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

    listTools(plugin) {
      const filtered = plugin
        ? collectedTools.filter((t) => t.pluginName === plugin)
        : collectedTools;
      return filtered.map((t) => t.tool);
    },

    getManifest(plugin) {
      const entry = manifests.collect().find((m) => m.pluginName === plugin);
      if (!entry) throw new Error(`Plugin "${plugin}" is not registered.`);
      return entry.manifest;
    },

    listCapabilities() {
      const out: CapabilityListing[] = [];
      for (const { pluginName, manifest } of manifests.collect()) {
        const visibility: NonNullable<PluginManifest['visibility']> =
          manifest.visibility ?? 'on-demand';
        if (visibility === 'silent') continue;
        out.push({
          name: pluginName,
          summary: manifest.summary,
          visibility,
          loaded: visibility === 'always' || loadedSet.has(pluginName),
          category: manifest.category,
          tags: manifest.tags ?? [],
        });
      }
      return out;
    },

    loadCapability(name) {
      const entry = manifests.collect().find((m) => m.pluginName === name);
      if (!entry) {
        throw new Error(
          `Cannot load capability "${name}" — not registered. Call rt.listCapabilities() to see what's available.`,
        );
      }
      if (entry.manifest.visibility === 'silent') {
        throw new Error(
          `Capability "${name}" is silent and cannot be loaded by the agent.`,
        );
      }
      loadedSet.add(name);
    },

    assertNoCollisions() {
      tools.assertNoCollisions();
      subAgents.assertNoCollisions();
      middlewares.assertNoCollisions();
      manifests.assertNoCollisions();
      configSchemas.assertNoCollisions();
      sharedState.assertNoCollisions();
      // Cross-check examples against tools too — surfaces stale `examples[].tool`.
      const cross = manifests.validateAgainstTools(tools, subAgents);
      if (cross.errors.length > 0) {
        throw new Error(
          `Manifest cross-check failed:\n  - ${cross.errors.join('\n  - ')}`,
        );
      }
    },

    assertManifestValid() {
      const errors: string[] = [];
      for (const { pluginName, manifest } of manifests.collect()) {
        const result = validateManifest(manifest, pluginName);
        if (!result.valid) errors.push(...result.errors);
      }
      if (errors.length > 0) {
        throw new Error(
          `Manifest validation failed:\n  - ${errors.join('\n  - ')}`,
        );
      }
    },

    async invokeAgent(_messages) {
      throw new Error(
        'invokeAgent is not implemented yet. Full agent assembly lights up once ' +
          'createMainAgent is consumed by createOracleApp. For unit tests, use ' +
          'invokeTool / invokeMiddleware / invokeSubAgent.',
      );
    },

    mocks: {
      matrix(overrides) {
        matrixAdapter = mockMatrix(overrides);
      },
      fetch(handler) {
        fetchHandler = handler;
      },
    },

    async close() {
      // Nothing allocated outside JS heap; placeholder for symmetry with
      // future resource-holding test runtimes (e.g. recorded LLM cassettes).
    },
  };

  // Expose the fetch handler under a leading-underscore hidden field so
  // tests can read whatever was bound via `rt.mocks.fetch(...)` without
  // widening the public `TestRuntime` interface.
  Object.defineProperty(runtime, '_fetchHandler', {
    enumerable: false,
    get: () => fetchHandler,
  });

  return runtime;
}

/**
 * Locate a middleware in the collected list by name, falling back to a
 * positional `mw{n}` form so the `makeMiddleware('mw0')`-style fixtures
 * still resolve. Throws with a useful list when the middleware is missing.
 */
function findMiddleware(
  collected: ReadonlyArray<{
    pluginName: string;
    middleware: AgentMiddleware;
  }>,
  nameOrIndex: string | number,
): AgentMiddleware {
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

/**
 * Invoke an optional middleware lifecycle hook. LangChain v1.x wraps each
 * hook as `{ hook, canJumpTo? }`; older / hand-rolled middlewares may pass a
 * plain function. We accept either at the harness boundary.
 */
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
