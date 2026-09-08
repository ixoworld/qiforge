/**
 * The runtime core — everything between "a list of plugins + the Worker env"
 * and "a compiled LangChain agent for one turn". Nothing in here touches
 * Durable Objects, Matrix, or Hono; the host (`src/do`, `src/shell`) supplies
 * those through the `AmbientServices` adapters and mounts `pluginRoutes`.
 */
import { z } from 'zod';
import type { OraclePlugin, PluginRoute } from '../plugin-api/oracle-plugin';
import type {
  AuthExcludedRoute,
  Logger,
  OracleConfig,
  OracleIdentity,
  PluginContext,
} from '../plugin-api/types';
import { baseEnvSchema, composeEnvSchema, validateEnv } from './env';
import { createLlmAdapter, type OpenRouterLlmAdapter } from './llm';
import { validateManifest, type PluginManifestOverride } from './manifest';
import {
  resolvePlugins,
  type ExcludedPlugin,
  type FeatureToggle,
  type SoftDepGap,
} from './plugin-loader';
import { createRegistries, type Registries } from './registries';
import { buildPluginContext } from './runtime-context';
import { NOOP_LOGGER } from './utils';

// ── Public surface ──────────────────────────────────────────────────────────

export { z };

export { baseEnvSchema, composeEnvSchema, validateEnv } from './env';
export type {
  BaseEnv,
  ComposeEnvSchemaResult,
  ValidateEnvError,
  ValidateEnvResult,
} from './env';

export { resolvePlugins, topoSort } from './plugin-loader';
export type {
  ExcludedPlugin,
  ExclusionCause,
  FeatureToggle,
  ResolvePluginsInput,
  ResolvePluginsResult,
  SoftDepGap,
} from './plugin-loader';

export {
  ConfigSchemaRegistry,
  ManifestRegistry,
  MiddlewareRegistry,
  SharedStateRegistry,
  SubAgentRegistry,
  ToolRegistry,
  createRegistries,
  formatByPlugin,
} from './registries';
export type {
  ManifestCrossCheckResult,
  RegisteredConfigSchema,
  RegisteredManifest,
  RegisteredMiddleware,
  RegisteredSharedAccessor,
  RegisteredSubAgent,
  RegisteredTool,
  Registries,
  ToolSummary,
} from './registries';

export {
  estimateTokensApprox,
  manifestCategorySchema,
  manifestExampleSchema,
  manifestStabilitySchema,
  manifestVisibilitySchema,
  mergeManifestOverride,
  pluginManifestSchema,
  renderTier1,
  validateExamplesAgainstTools,
  validateManifest,
} from './manifest';
export type {
  ManifestValidationResult,
  PluginManifestOverride,
  Tier1Entry,
  Tier1Input,
  Tier1Output,
} from './manifest';

export {
  buildListCapabilitiesTool,
  buildLoadCapabilityTool,
  buildMetaTools,
} from './meta-tools';
export type { BuildMetaToolsOptions } from './meta-tools';

export {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  OPENROUTER_BASE_URL,
  OPENROUTER_MAIN_FALLBACKS,
  OPENROUTER_MODEL_MAP,
  TIER_DISPLAY,
  DEFAULT_MODEL_PRICE_MARKUP,
  buildModelListing,
  createLlmAdapter,
  getCatalogEntry,
  getDefaultModelId,
  getModelCapabilities,
  getModelPriceMarkup,
  isAllowedModel,
  listModelCatalog,
  listModels,
} from './llm';
export {
  OPENROUTER_MODELS_URL,
  OPENROUTER_PRICE_CACHE_TTL_MS,
  fetchOpenRouterPrices,
  resetOpenRouterPriceCache,
  type FetchOpenRouterPricesOptions,
} from './openrouter-pricing';
export type {
  LlmEnv,
  ModelCatalogEntry,
  ModelFamily,
  ModelInputCapabilities,
  ModelListItem,
  ModelListing,
  ModelPrice,
  ModelTier,
  OpenRouterLlmAdapter,
  ProviderModelRole,
} from './llm';

export { MainAgentGraphState } from './state';
export type {
  AgAction,
  BrowserToolCall,
  TMainAgentGraphState,
  UserPreferences,
} from './state';

export {
  buildOracleSection,
  composePrompt,
  formatTimeContext,
  formatUserPreferences,
} from './prompt-composer';
export type {
  ComposePromptInput,
  MemoryCommunity,
  MemoryContextSection,
  MemoryEntity,
  MemoryEpisode,
  MemoryFact,
  TypedUserContext,
} from './prompt-composer';
export { compileTemplate, renderTemplate } from './template';
export type { CompiledTemplate, TemplateValues } from './template';

export * from './middlewares';

export {
  EMPTY_SHARED,
  EVENT_NAMES,
  buildPluginContext,
  buildRuntimeContext,
  createMemoryBlobStore,
  createNoopAmbient,
  createScopedEmitter,
  createUnavailableLlmAdapter,
  createUnavailableMatrixAdapter,
  createUnsignedUcanAdapter,
  delegationHasCapability,
} from './runtime-context';
export type {
  AmbientServices,
  BlobStoreAdapter,
  BuildPluginContextInput,
  DelegationLike,
  EmitAdapter,
  LlmAdapter,
  MatrixAdapter,
  NoopAmbientOverrides,
  RawEventPayload,
  RunConfig,
  RunConfigContext,
  RuntimeSessionContext,
  RuntimeStateInput,
  RuntimeUserContext,
  ScopeKeys,
  ScopedEmitter,
  SecretsAdapter,
  UcanAdapter,
} from './runtime-context';

export { wrapPluginTool } from './wrap-plugin-tool';
export type { WrapPluginToolOptions } from './wrap-plugin-tool';
export {
  computeSubAgentToolName,
  createSubagentAsTool,
  filterForwardedMessages,
} from './subagent-as-tool';
export type { AgentSpec, SubagentToolOptions } from './subagent-as-tool';
export { collectSubAgentsWithFallback } from './sub-agent-fallback';
export type { CollectSubAgentsInput } from './sub-agent-fallback';

export { createMainAgent } from './main-agent';
export { mainAgentRequestContextSchema } from './main-agent-types';
export type {
  CompiledMainAgent,
  MainAgentArgs,
  MainAgentBuildResult,
  MainAgentHooks,
  MainAgentRegistries,
  MainAgentRequestContext,
} from './main-agent-types';

export {
  NOOP_LOGGER,
  acquireToolLock,
  clientSchemaToZod,
  createConsoleLogger,
  inlineLocalJsonPointerRefs,
  lruInsert,
  sweepExpired,
} from './utils';

export * from './plugins';

// ── Boot ────────────────────────────────────────────────────────────────────

export interface RuntimeCoreOptions {
  /** Inline oracle config. `entityDid` comes from env — do not put it here. */
  config: OracleConfig;
  /**
   * Every plugin the oracle may load. Each goes through `features` and its
   * own `autoDetect`; plugins with neither load unconditionally.
   */
  plugins: OraclePlugin[];
  features?: Partial<Record<string, FeatureToggle>>;
  /**
   * Per-plugin manifest overrides, merged shallowly over each plugin's own
   * `manifest`. Keys that match no loaded plugin are logged and ignored.
   */
  manifestOverrides?: Partial<Record<string, PluginManifestOverride>>;
  /**
   * The Worker `env` bindings object. Validated against the base schema plus
   * every loaded plugin's `configSchema`; unknown keys (Durable Object
   * namespaces, …) are stripped from `validatedEnv`.
   */
  env: Record<string, unknown>;
  /** Boot + runtime logger. Defaults to a silent logger. */
  logger?: Logger;
}

/**
 * The boot-time snapshot the host builds once per isolate (memoised per
 * `env` object) and hands to every Durable Object turn.
 */
export interface RuntimeCore {
  identity: OracleIdentity;
  registries: Registries;
  /** Names of the plugins that loaded, in dependency order. */
  availablePlugins: ReadonlySet<string>;
  /** The loaded plugin instances, in dependency order. */
  plugins: OraclePlugin[];
  excluded: ExcludedPlugin[];
  softDepGaps: SoftDepGap[];
  /** Zod-validated env (base + plugin keys) — the `config` every context sees. */
  validatedEnv: Record<string, unknown>;
  /** Routes contributed by `getRoutes()`, for the shell to mount. */
  pluginRoutes: PluginRoute[];
  /** Auth exclusions contributed by `getAuthExcludedRoutes()`. */
  authExcludedRoutes: AuthExcludedRoute[];
  /** OpenRouter-backed LLM adapter (`get(role, params?)`). */
  llm: OpenRouterLlmAdapter;
  logger: Logger;
  /** A boot-time `PluginContext` scoped to `pluginName` (default `__runtime__`). */
  buildCtx(pluginName?: string): PluginContext;
  /**
   * Warm the registries' boot caches (`getTools` / `getSubAgents` /
   * `getMiddlewares`) and run the cross-plugin checks that need them: tool,
   * sub-agent and shared-state name collisions (fatal), and every manifest's
   * `examples[].tool` references (advisory — logged). Memoised — safe to
   * await on every turn; the first agent build would otherwise perform the
   * collection lazily without the checks. Rejects with the boot error.
   */
  warm(): Promise<void>;
}

function reportBootError(logger: Logger, message: string, hint?: string): void {
  const body = hint ? `${message}\n            ${hint}` : message;
  logger.error(`[boot-error] ${body}`);
}

function validateConfig(config: OracleConfig): void {
  if (!config || typeof config !== 'object') {
    throw new Error('createRuntimeCore: `config` is required.');
  }
  if (typeof config.name !== 'string' || config.name.trim().length === 0) {
    throw new Error(
      'createRuntimeCore: `config.name` is required and must be a non-empty string.',
    );
  }
}

/**
 * Resolve plugins, validate manifests and env, populate the registries and
 * collect routes — the Node runtime's `createOracleApp` boot minus NestJS
 * and Matrix (the Matrix gateway Durable Object owns its own init).
 * Synchronous so the host can memoise it per isolate without an await;
 * `warm()` does the async part.
 */
export function createRuntimeCore(opts: RuntimeCoreOptions): RuntimeCore {
  validateConfig(opts.config);
  const logger = opts.logger ?? NOOP_LOGGER;

  // 1. Plugin resolution — toggles, auto-detect, cascade, topo order.
  let resolved;
  try {
    resolved = resolvePlugins({
      bundled: opts.plugins,
      features: opts.features,
      env: opts.env,
      logger,
    });
  } catch (err) {
    reportBootError(logger, err instanceof Error ? err.message : String(err));
    throw err;
  }

  // 2. Manifest overrides + validation.
  const manifestOverrides = opts.manifestOverrides ?? {};
  const loadedNames = new Set(resolved.loaded.map((p) => p.name));
  for (const key of Object.keys(manifestOverrides)) {
    if (!loadedNames.has(key)) {
      logger.warn(
        `[boot] manifestOverrides references '${key}', which is not a loaded plugin — ignored (event: boot.plugin.manifest_override_unknown)`,
      );
    }
  }

  const registries = createRegistries();
  for (const plugin of resolved.loaded) {
    registries.manifests.register(plugin, manifestOverrides[plugin.name]);
  }
  const manifestErrors: string[] = [];
  for (const { pluginName, manifest } of registries.manifests.collect()) {
    const result = validateManifest(manifest, pluginName);
    for (const warning of result.warnings) logger.warn(`[boot] ${warning}`);
    if (!result.valid) manifestErrors.push(...result.errors);
  }
  if (manifestErrors.length > 0) {
    for (const err of manifestErrors) reportBootError(logger, err);
    throw new Error(
      `Plugin manifest validation failed (${manifestErrors.length} issues):\n  - ${manifestErrors.join('\n  - ')}`,
    );
  }

  // 3. Env — base schema + plugin schemas, attributed errors.
  const composed = composeEnvSchema(resolved.loaded, baseEnvSchema, logger);
  const validated = validateEnv(
    composed.schema,
    opts.env,
    composed.pluginOwnership,
  );
  if (!validated.valid) {
    const lines: string[] = [];
    for (const issue of validated.errors) {
      const message = `Plugin '${issue.plugin}' env validation failed for '${issue.field}': ${issue.message}`;
      reportBootError(
        logger,
        message,
        issue.plugin === 'core'
          ? `Set '${issue.field}' on the Worker (wrangler secret / vars).`
          : `Set '${issue.field}' or disable: features: { ${issue.plugin}: false }`,
      );
      lines.push(message);
    }
    throw new Error(
      `Env validation failed (${validated.errors.length} issues):\n  - ${lines.join('\n  - ')}`,
    );
  }

  // 4. Identity.
  const oracleDid = String(validated.config.ORACLE_DID);
  const entityDid =
    typeof validated.config.ORACLE_ENTITY_DID === 'string' &&
    validated.config.ORACLE_ENTITY_DID.length > 0
      ? validated.config.ORACLE_ENTITY_DID
      : oracleDid;
  const identity: OracleIdentity = {
    name: opts.config.name,
    org: opts.config.org ?? '',
    description: opts.config.description ?? '',
    entityDid,
    prompt: opts.config.prompt ?? {},
  };

  // 5. Registries.
  for (const plugin of resolved.loaded) {
    registries.tools.register(plugin);
    registries.subAgents.register(plugin);
    registries.middlewares.register(plugin);
    registries.configSchema.register(plugin);
    registries.sharedState.register(plugin);
  }

  const availablePlugins: ReadonlySet<string> = loadedNames;
  const buildCtx = (pluginName = '__runtime__'): PluginContext =>
    buildPluginContext({
      config: validated.config,
      identity,
      availablePlugins,
      logger,
      pluginName,
    });

  // 6. Routes + auth exclusions (sync — plugins close over config here).
  const pluginRoutes: PluginRoute[] = resolved.loaded.flatMap(
    (p) => p.getRoutes?.(buildCtx(p.name)) ?? [],
  );
  const authExcludedRoutes: AuthExcludedRoute[] = resolved.loaded.flatMap(
    (p) => p.getAuthExcludedRoutes?.() ?? [],
  );

  // 7. LLM.
  const llm = createLlmAdapter(
    {
      OPEN_ROUTER_API_KEY: String(validated.config.OPEN_ROUTER_API_KEY),
      DEFAULT_MODEL:
        typeof validated.config.DEFAULT_MODEL === 'string'
          ? validated.config.DEFAULT_MODEL
          : undefined,
      MAIN_REASONING_EFFORT: validated.config.MAIN_REASONING_EFFORT as
        | 'low'
        | 'medium'
        | 'high'
        | undefined,
      ORACLE_NAME: String(validated.config.ORACLE_NAME),
    },
    logger,
  );

  // 8. Warm-up (memoised). Collision + manifest cross-checks need the boot
  // caches, which may involve async `getTools`, so they cannot run here.
  let warmed: Promise<void> | null = null;
  const warm = (): Promise<void> => {
    warmed ??= (async () => {
      const ctx = buildCtx();
      await registries.tools.collectBoot(ctx);
      registries.subAgents.collectBoot(ctx);
      registries.middlewares.collect(ctx);
      try {
        registries.tools.assertNoCollisions();
        registries.subAgents.assertNoCollisions();
        registries.sharedState.assertNoCollisions();
        // Advisory only: request-time tools (`getRequestTools`) are invisible
        // at boot, so an example that names one reads as "unknown" here. The
        // Node runtime does not run this check at boot at all; surfacing it
        // as a warning keeps stale references visible without blocking.
        const cross = registries.manifests.validateAgainstTools(
          registries.tools,
          registries.subAgents,
        );
        for (const issue of cross.errors) {
          logger.warn(
            `[boot] ${issue} (boot-time tools only — ignore if the tool comes from getRequestTools)`,
          );
        }
      } catch (err) {
        reportBootError(
          logger,
          err instanceof Error ? err.message : String(err),
        );
        throw err;
      }
    })().catch((err: unknown) => {
      // Let the next caller retry rather than caching a rejection forever
      // (a transient `getTools` failure should not brick the isolate).
      warmed = null;
      throw err;
    });
    return warmed;
  };

  logger.log(
    `[boot] oracle '${identity.name}' loaded plugins: [${[...availablePlugins].join(', ')}]` +
      (resolved.excluded.length > 0
        ? ` excluded: [${resolved.excluded.map((e) => `${e.plugin} (${e.reason})`).join(', ')}]`
        : ''),
  );

  return {
    identity,
    registries,
    availablePlugins,
    plugins: resolved.loaded,
    excluded: resolved.excluded,
    softDepGaps: resolved.softDepGaps,
    validatedEnv: validated.config,
    pluginRoutes,
    authExcludedRoutes,
    llm,
    logger,
    buildCtx,
    warm,
  };
}
