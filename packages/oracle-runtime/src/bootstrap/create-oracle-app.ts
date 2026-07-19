import { MatrixManager } from '@ixo/matrix';
import {
  loadEncryptionKey,
  setupClaimSigningMnemonics,
} from '@ixo/oracles-chain-client';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import {
  Logger,
  ValidationPipe,
  type DynamicModule,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import pkg from '../../package.json' with { type: 'json' };
import {
  baseEnvSchema,
  validateLlmProviderKey,
} from '../config/base-env-schema.js';
import type { MainAgentHooks } from '../graph/main-agent-types.js';
import {
  getModelForRole,
  getProviderConfig,
  setHostModelPolicy,
} from '../llm/llm-provider.js';
import type { ModelPolicyInput } from '../llm/model-policy.js';
import {
  mergeManifestOverride,
  type PluginManifestOverride,
} from '../manifest/merge-override.js';
import { validateManifest } from '../manifest/validator.js';
import { UserMatrixSqliteSyncService } from '../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { setFileProcessingProvider } from '../modules/messages/file-processing.service.js';
import { OracleRuntimeBundleHolder } from '../modules/messages/oracle-runtime-bundle.js';
import { SecretsService } from '../modules/secrets/secrets.service.js';
import { UcanService } from '../modules/ucan/ucan.service.js';
import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type {
  AuthExcludedRoute,
  OracleConfig,
  OracleIdentity,
  Logger as PluginLogger,
} from '../plugin-api/types.js';
import { BUNDLED_PLUGINS } from '../plugins/index.js';
import { buildPluginContext } from '../runtime-context/build-plugin.js';
import type { AmbientServices } from '../runtime-context/ambient.js';
import { buildAmbientServices } from './ambient-factory.js';
import {
  ConfigSchemaRegistry,
  ManifestRegistry,
  MiddlewareRegistry,
  PromptContributionRegistry,
  SharedStateRegistry,
  SubAgentRegistry,
  ToolRegistry,
} from '../registries/index.js';
import { registerGracefulShutdown } from './graceful-shutdown.js';
import {
  resolvePlugins,
  type FeatureToggle,
  type ResolvePluginsResult,
} from './plugin-loader.js';
import { RuntimeAppModule } from './runtime-app-module.js';
import { composeEnvSchema, validateEnv } from './schema-composer.js';

/**
 * Names of bundled plugins shipped by `@ixo/oracle-runtime`. Derived from
 * `BUNDLED_PLUGINS` so forks get suggestion-grade typing on `features`
 * without having to keep a parallel list in sync.
 */
export type BundledFeatureName = (typeof BUNDLED_PLUGINS)[number]['name'];

export interface CreateOracleAppOptions {
  /**
   * Inline oracle config. `entityDid` is sourced from `ORACLE_ENTITY_DID` env
   * — do not put it here. The runtime merges this with env-derived fields to
   * build the internal `OracleIdentity`.
   */
  config: OracleConfig;
  features?: Partial<Record<BundledFeatureName | (string & {}), FeatureToggle>>;
  /**
   * Per-plugin manifest overrides. Each entry is merged shallowly over the
   * plugin's own `manifest` at boot — keys you set win, keys you omit keep the
   * plugin's default. Use to retune a bundled plugin's discovery without
   * forking its source: flip a noisy `always` plugin to `on-demand`, hide one
   * behind `silent`, or relabel its `summary`/`tags`/`whenToUse`. The merged
   * manifest is validated exactly like an authored one, so an override that
   * (say) empties `whenToUse` on a non-silent plugin fails the boot with a
   * clear message. Keys that don't match a loaded plugin are logged and
   * ignored.
   */
  manifestOverrides?: Partial<
    Record<BundledFeatureName | (string & {}), PluginManifestOverride>
  >;
  plugins?: OraclePlugin[];
  /** Developer's own NestJS modules. Spread into `RuntimeAppModule.imports`. */
  nestModules?: Array<Type | DynamicModule>;
  /**
   * Host-declared routes that must NOT pass through `AuthHeaderMiddleware`.
   * Use for routes contributed by `nestModules` (e.g. webhooks, OAuth
   * callbacks, public probes). Symmetric with the plugin-side
   * `OraclePlugin.getAuthExcludedRoutes()` hook — both lists merge onto
   * the runtime's built-in exclusions (`/health`, `/docs`, etc.).
   */
  authExcludedRoutes?: AuthExcludedRoute[];
  /**
   * Optional override of the bundled plugin set. Provided primarily for tests
   * so the harness can spin up `createOracleApp` without dragging in the full
   * bundled catalog. Production callers should leave this unset.
   */
  bundledPlugins?: OraclePlugin[];
  /** Override `process.env`. Tests use this to inject a clean env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Skip starting the Matrix background init. Tests set this so the factory
   * resolves without touching real Matrix.
   */
  skipMatrixInit?: boolean;
  /**
   * Skip registering the SIGTERM/SIGINT shutdown handler. Tests set this
   * so the harness does not leak process-level listeners.
   */
  skipGracefulShutdown?: boolean;
  /** Override the bootstrap logger. Falls back to NestJS `Logger`. */
  logger?: PluginLogger;
  /**
   * Optional overrides for the agent-build hooks (checkpointer, model
   * resolver, prompt section snippets). Merged on top of the runtime's
   * defaults — host hooks WIN. The runtime supplies a per-user SQLite
   * checkpointer by default; pass `{ checkpointerForUser: ... }` here to
   * swap it for an alternate implementation.
   */
  hooks?: MainAgentHooks;
  /**
   * Host layer of the model policy — layered over the built-in table and
   * `MODEL_POLICY_JSON`. The signed oracle config document feeds this same
   * slot once the config loader lands, so forks adopting it now need no
   * further changes.
   */
  modelPolicy?: ModelPolicyInput;
}

export interface PluginStatusReport {
  loaded: string[];
  excluded: Array<{ plugin: string; reason: string }>;
  softDepGaps: Array<{ plugin: string; missing: string }>;
}

export interface PluginStatusChangeEvent {
  plugin: string;
  from: 'pending' | 'loaded' | 'failed';
  to: 'pending' | 'loaded' | 'failed';
  reason?: string;
}

export interface OracleApp {
  /** The underlying `INestApplication`. Use for direct customization. */
  getNestApp(): INestApplication;
  /**
   * The production `AmbientServices` bag — used by `MessagesController` to
   * build per-request `RuntimeContext`s before invoking `createMainAgent`.
   * Forks normally don't touch this directly.
   */
  ambient: AmbientServices;
  /** Snapshot of loader/exclusion/soft-dep state. */
  plugins: { status(): PluginStatusReport };
  /** Pre-listen hook (before HTTP starts accepting). */
  beforeListen(fn: (nestApp: INestApplication) => Promise<void> | void): void;
  /** Boot-time error subscriber (Matrix init + lifecycle errors). */
  onError(handler: (err: Error, source: string) => void): void;
  /** Subscribe to plugin lifecycle changes (e.g. Matrix coming online). */
  onPluginStatusChange(handler: (event: PluginStatusChangeEvent) => void): void;
  /** Start the HTTP server. Honours `beforeListen` callbacks first. */
  listen(port?: number): Promise<void>;
}

function reportBootError(
  logger: PluginLogger,
  message: string,
  hint?: string,
): void {
  const body = hint ? `${message}\n            ${hint}` : message;
  logger.error(`[boot-error] ${body}`);
}

/**
 * Resolve plugins, validate env, populate registries, build the dynamic
 * `RuntimeAppModule`, bootstrap NestJS (without listening) and return an
 * `OracleApp` whose `listen()` runs `beforeListen` callbacks then starts
 * the HTTP server.
 *
 * Matrix initialization runs in the background — the returned promise
 * resolves as soon as Nest is built. Status flips via
 * `onPluginStatusChange`.
 */
export async function createOracleApp(
  opts: CreateOracleAppOptions,
): Promise<OracleApp> {
  validateConfig(opts.config);

  // Install the host model-policy layer before anything resolves a model —
  // the policy is memoized on first use.
  setHostModelPolicy(opts.modelPolicy);

  const logger: PluginLogger = opts.logger ?? new Logger('createOracleApp');
  const env = opts.env ?? process.env;
  const userPlugins = opts.plugins ?? [];
  const bundled = opts.bundledPlugins ?? [...BUNDLED_PLUGINS];

  // 1-3. Plugin resolution + topo + soft-dep logging
  let resolved: ResolvePluginsResult;
  try {
    resolved = resolvePlugins({
      bundled,
      userPlugins,
      features: opts.features,
      env,
      logger,
    });
  } catch (err) {
    reportBootError(logger, err instanceof Error ? err.message : String(err));
    throw err;
  }

  // 4. Manifest validation — against the effective (override-merged) manifest
  // so a fork override is held to the same rules as an authored manifest.
  const manifestOverrides = opts.manifestOverrides ?? {};
  const loadedNames = new Set(resolved.loaded.map((p) => p.name));
  for (const key of Object.keys(manifestOverrides)) {
    if (!loadedNames.has(key)) {
      logger.warn?.(
        `[boot] manifestOverrides references '${key}', which is not a loaded plugin — ignored ` +
          `(event: boot.plugin.manifest_override_unknown)`,
      );
    }
  }

  const effectiveManifests = new Map(
    resolved.loaded.map((plugin) => [
      plugin.name,
      mergeManifestOverride(plugin.manifest, manifestOverrides[plugin.name]),
    ]),
  );

  const manifestErrors: string[] = [];
  for (const plugin of resolved.loaded) {
    const result = validateManifest(
      effectiveManifests.get(plugin.name),
      plugin.name,
    );
    if (!result.valid) manifestErrors.push(...result.errors);
  }
  if (manifestErrors.length > 0) {
    for (const err of manifestErrors) reportBootError(logger, err);
    throw new Error(
      `Plugin manifest validation failed (${manifestErrors.length} issues).`,
    );
  }

  // 5. Schema merge + env validation
  const composed = composeEnvSchema(resolved.loaded, baseEnvSchema, logger);
  const validated = validateEnv(composed.schema, env, composed.pluginOwnership);
  if (!validated.valid) {
    for (const issue of validated.errors) {
      reportBootError(
        logger,
        `Plugin '${issue.plugin}' env validation failed for '${issue.field}': ${issue.message}`,
        `Set '${issue.field}' or disable: features: { ${issue.plugin}: false }`,
      );
    }
    throw new Error(
      `Env validation failed (${validated.errors.length} issues).`,
    );
  }

  // Cross-field check the merged schema cannot express — the selected
  // LLM_PROVIDER must have its API key set. Surfaced here so the message
  // names the missing field exactly (`OPEN_ROUTER_API_KEY` / `NEBIUS_API_KEY`).
  const llmKeyErrors = validateLlmProviderKey(validated.config);
  if (llmKeyErrors.length > 0) {
    for (const issue of llmKeyErrors) {
      reportBootError(
        logger,
        `LLM provider env validation failed for '${issue.field}': ${issue.message}`,
      );
    }
    throw new Error(
      `Env validation failed (${llmKeyErrors.length} issue${llmKeyErrors.length === 1 ? '' : 's'}).`,
    );
  }

  // 5a. Build the internal identity from config + validated env. Defer until
  // here so `ORACLE_ENTITY_DID` has been parsed by the base env schema —
  // a missing/empty value fails validation above with a clear message.
  const entityDid = String(validated.config.ORACLE_ENTITY_DID ?? '');
  if (!entityDid) {
    throw new Error(
      'createOracleApp: ORACLE_ENTITY_DID env is required and was empty after validation.',
    );
  }
  const identity: OracleIdentity = {
    name: opts.config.name,
    org: opts.config.org ?? '',
    description: opts.config.description ?? '',
    entityDid,
    prompt: opts.config.prompt ?? {},
  };

  // 6. Registry population
  const registries = {
    tools: new ToolRegistry(),
    subAgents: new SubAgentRegistry(),
    middlewares: new MiddlewareRegistry(),
    manifests: new ManifestRegistry(),
    configSchema: new ConfigSchemaRegistry(),
    sharedState: new SharedStateRegistry(),
    promptContributions: new PromptContributionRegistry(),
  };
  for (const plugin of resolved.loaded) {
    registries.tools.register(plugin);
    registries.subAgents.register(plugin);
    registries.middlewares.register(plugin);
    registries.manifests.register(plugin, manifestOverrides[plugin.name]);
    registries.configSchema.register(plugin);
    registries.sharedState.register(plugin);
    registries.promptContributions.register(plugin);
  }

  // 7. NestJS bootstrap
  // The subscription/request-gate pipeline turns on when any loaded plugin
  // declares it provides one — a manifest capability, never a name match.
  const enableSubscription = resolved.loaded.some(
    (p) => p.manifest.providesRequestGate === true,
  );
  const loadedPluginNames = new Set(resolved.loaded.map((p) => p.name));
  const pluginNestModules = resolved.loaded.flatMap((p) => {
    const ctx = buildPluginContext({
      config: validated.config,
      identity,
      availablePlugins: loadedPluginNames,
      logger,
      pluginName: p.name,
    });
    return p.getNestModules?.(ctx) ?? [];
  });
  // Merge plugin-declared exclusions with host-declared ones (from opts).
  // Both flow into the same `RuntimeAppModule` configurer so the runtime
  // doesn't care whose route is opted out — only that it is.
  const pluginAuthExclusions = [
    ...resolved.loaded.flatMap((p) => p.getAuthExcludedRoutes?.() ?? []),
    ...(opts.authExcludedRoutes ?? []),
  ];
  const appModule = RuntimeAppModule.register({
    validatedEnv: validated.config,
    userNestModules: opts.nestModules,
    pluginNestModules,
    pluginAuthExclusions,
    enableSubscriptionMiddleware: enableSubscription,
  });

  // Wire the file-processing LLM provider getter BEFORE Nest constructs
  // `FileProcessingService`. The service's module-level getter throws on
  // first call until this runs — has to happen pre-bootstrap.
  // Uses the same OpenRouter / Nebius config + 'vision' role mapping the
  // legacy apps/app wired up.
  setFileProcessingProvider(() => {
    const cfg = getProviderConfig();
    return {
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      headers: cfg.headers,
      model: getModelForRole('vision'),
    };
  });

  const nestApp = await NestFactory.create(appModule, {
    bufferLogs: false,
  });

  // Global validation — enforce every controller's `class-validator` DTO
  // decorators. Without this, decorators like `@Matches`, `@ArrayMaxSize`,
  // and `@IsNotEmpty` are inert and arbitrary body fields flow straight into
  // graph state. `whitelist` strips unknown props, `forbidNonWhitelisted`
  // rejects them outright, `transform` instantiates nested `@Type` DTOs so
  // `@ValidateNested` actually runs. Guarded for the same reason as Swagger
  // (lightweight test runtimes stub `NestFactory.create`).
  if (typeof nestApp.useGlobalPipes === 'function') {
    nestApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
  }

  // CORS — auth flows from the browser need `x-ucan-delegation` allowed.
  // `credentials: true` requires a specific origin (not `*`); when the
  // host configures a wildcard we disable credentials so the browser
  // doesn't reject the preflight. Guarded for the same reason as Swagger
  // (test runtimes stub `NestFactory.create`).
  if (typeof nestApp.enableCors === 'function') {
    const corsOrigin =
      typeof validated.config.CORS_ORIGIN === 'string' &&
      validated.config.CORS_ORIGIN.length > 0
        ? validated.config.CORS_ORIGIN
        : '*';
    const useCredentials = corsOrigin !== '*';
    nestApp.enableCors({
      origin: corsOrigin,
      credentials: useCredentials,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-ucan-delegation',
        'x-matrix-access-token',
        'x-matrix-homeserver',
        'x-did',
        'x-request-id',
        'x-auth-type',
        'x-timezone',
      ],
      exposedHeaders: ['X-Request-Id'],
    });
  }

  // Swagger UI at `/docs`. Auth middleware already excludes `/docs` and
  // `/docs/(.*)`. Forks can replace by registering their own setup in a
  // `beforeListen` hook.
  //
  // Guarded because lightweight test runtimes stub `NestFactory.create`
  // with an object that lacks `getHttpAdapter` — Swagger introspects the
  // adapter to know whether it's express/fastify. In production both are
  // present.
  try {
    const swaggerDoc = SwaggerModule.createDocument(
      nestApp,
      new DocumentBuilder()
        .setTitle(identity.name)
        .setDescription(
          `${identity.description}\n\nQiForge runtime v${pkg.version}.`,
        )
        .setVersion(pkg.version)
        .addApiKey(
          { type: 'apiKey', name: 'x-ucan-delegation', in: 'header' },
          'ucan',
        )
        .build(),
    );
    SwaggerModule.setup('docs', nestApp, swaggerDoc);
  } catch (err) {
    logger.warn?.(
      `[createOracleApp] Swagger setup skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 8. AmbientServices — built once Nest's DI container exists. Plugins reach
  // this through `buildRuntimeContext(runConfig, ambient, state)`, wired by
  // the messages controller on a per-request basis.
  const ambient = buildAmbientServices({
    nestApp,
    config: validated.config,
    identity,
    availablePlugins: loadedPluginNames,
    logger,
    sharedStateRegistry: registries.sharedState,
  });

  // 9. Warm the boot caches inside each registry so the per-request agent
  // build only re-runs the request-time hooks (`getRequestTools`,
  // `getRequestSubAgents`). Boot-time outputs are identical for every
  // request and don't need to be recomputed.
  const warmBuildCtx = buildPluginContext({
    config: validated.config,
    identity,
    availablePlugins: loadedPluginNames,
    logger,
    pluginName: '__runtime__',
  });
  await registries.tools.collectBoot(warmBuildCtx);
  registries.subAgents.collectBoot(warmBuildCtx);
  registries.middlewares.collect(warmBuildCtx);

  // Fail the boot if two plugins contribute the same tool name, sub-agent
  // name, or shared-state key. Without this, a collision is silently
  // resolved last-write-wins: the agent binds duplicate tools and the
  // capability gate mis-attributes one of them, leaving it unreachable.
  // Only the boot-time contributions are checked here — request-time tools
  // (`getRequestTools`) are per-user and dynamic, so a static cross-plugin
  // assertion can't cover them.
  registries.tools.assertNoCollisions();
  registries.subAgents.assertNoCollisions();
  registries.sharedState.assertNoCollisions();

  // 10. Build the merged hooks the agent build will use:
  //   - default: per-user SQLite checkpointer backed by
  //     `UserMatrixSqliteSyncService` (already DI-managed)
  //   - override: anything the host passed in `opts.hooks` wins
  //
  // The merged hooks live inside the bundle so `agent-builder.ts` reads
  // them through `bundle.hooks` without ever rewriting the contract.
  const checkpointSync = nestApp.get(UserMatrixSqliteSyncService, {
    strict: false,
  });
  const defaultHooks: MainAgentHooks = checkpointSync
    ? {
        checkpointerForUser: async (userDid: string) => {
          // `getUserCheckpointer` reuses a per-connection saver when
          // `CACHE_CHECKPOINTER_SAVER` is on (the build calls this hook twice
          // per turn), otherwise builds a fresh one — same as before.
          const saver = await checkpointSync.getUserCheckpointer(userDid);
          return saver as unknown as BaseCheckpointSaver;
        },
      }
    : {};
  const mergedHooks: MainAgentHooks = { ...defaultHooks, ...opts.hooks };

  // 11. Populate the OracleRuntimeBundleHolder so MessagesService (and any
  // other Nest-managed consumer) can grab the boot-snapshot per request.
  // `strict: false` so we get `undefined` instead of throwing when the
  // holder isn't registered (lightweight test runtimes that skip
  // MessagesModule). In that case the bundle is just not available.
  const bundleHolder = nestApp.get(OracleRuntimeBundleHolder, {
    strict: false,
  });
  if (bundleHolder) {
    bundleHolder.populate({
      ambient,
      registries,
      identity,
      config: validated.config,
      availablePlugins: loadedPluginNames,
      hooks: mergedHooks,
    });
  }

  // 12. Background Matrix init — fire-and-forget.
  const beforeListenHooks: Array<
    (nestApp: INestApplication) => Promise<void> | void
  > = [];
  const errorHandlers: Array<(err: Error, source: string) => void> = [];
  const statusHandlers: Array<(e: PluginStatusChangeEvent) => void> = [];

  const dispatchError = (err: Error, source: string): void => {
    if (errorHandlers.length === 0) {
      logger.error(`[${source}] ${err.message}`);
      return;
    }
    for (const handler of errorHandlers) {
      try {
        handler(err, source);
      } catch (callbackErr) {
        logger.error(`onError handler threw: ${String(callbackErr)}`);
      }
    }
  };

  const dispatchStatus = (evt: PluginStatusChangeEvent): void => {
    for (const handler of statusHandlers) {
      try {
        handler(evt);
      } catch (callbackErr) {
        logger.error(
          `onPluginStatusChange handler threw: ${String(callbackErr)}`,
        );
      }
    }
  };

  if (!opts.skipMatrixInit) {
    const matrixManager = MatrixManager.getInstance();
    // Defer to the next macrotask so callers can attach
    // `onPluginStatusChange` / `onError` handlers before the first event
    // fires. The init itself is still asynchronous and does not block the
    // returned promise.
    setImmediate(() => {
      dispatchStatus({ plugin: 'matrix', from: 'pending', to: 'pending' });
      matrixManager
        .init()
        .then(async () => {
          // Matrix is up. Load the UCAN signing mnemonic + (optional)
          // user-secrets encryption key from the oracle's Matrix account
          // room. Both rely on Matrix state events as the source of truth,
          // so this MUST run after init.
          //
          // The signing mnemonic enables `UcanService.createServiceInvocation`
          // → which the credits/subscription middleware needs on the very
          // first authenticated request. Failing this step silently is the
          // origin of "UCAN signing key not configured" errors mid-flight.
          //
          // Wrapped in try/catch so a key-setup failure (e.g. test env
          // without real Matrix state events) doesn't block the
          // `matrix:loaded` status dispatch — auth-requiring routes will
          // 401 until the operator provisions the keys, but the rest of
          // the app stays usable (health, docs, ws).
          try {
            await wireSigningAndEncryptionKeys({
              nestApp,
              config: validated.config,
              logger,
            });
          } catch (err) {
            logger.error?.(
              `[boot] key setup failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          dispatchStatus({ plugin: 'matrix', from: 'pending', to: 'loaded' });
        })
        .catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          dispatchStatus({
            plugin: 'matrix',
            from: 'pending',
            to: 'failed',
            reason: error.message,
          });
          dispatchError(error, 'matrix-init');
        });
    });

    if (!opts.skipGracefulShutdown) {
      registerGracefulShutdown({ app: nestApp, matrixManager });
    }
  }

  // Public surface
  const statusReport = (): PluginStatusReport => ({
    loaded: resolved.loaded.map((p) => p.name),
    excluded: resolved.excluded.map((e) => ({
      plugin: e.plugin,
      reason: e.reason,
    })),
    softDepGaps: resolved.softDepGaps.map((s) => ({
      plugin: s.plugin,
      missing: s.missing,
    })),
  });

  let started = false;

  return {
    getNestApp(): INestApplication {
      return nestApp;
    },
    ambient,
    plugins: {
      status: statusReport,
    },
    beforeListen(fn): void {
      beforeListenHooks.push(fn);
    },
    onError(handler): void {
      errorHandlers.push(handler);
    },
    onPluginStatusChange(handler): void {
      statusHandlers.push(handler);
    },
    async listen(port?: number): Promise<void> {
      if (started) {
        throw new Error('OracleApp.listen called twice.');
      }
      started = true;
      for (const hook of beforeListenHooks) {
        await hook(nestApp);
      }
      const portValue =
        port ??
        coercePort(validated.config.PORT) ??
        coercePort(env.PORT) ??
        5678;
      await nestApp.listen(portValue, '0.0.0.0');
      logger.log(
        `Oracle '${identity.name}' (runtime v${pkg.version}) listening on :${portValue}`,
      );
    },
  };
}

function validateConfig(config: OracleConfig | undefined): void {
  if (!config) {
    throw new Error("createOracleApp: 'config' is required.");
  }
  if (!config.name) {
    throw new Error("createOracleApp: 'config.name' is required.");
  }
}

function coercePort(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * After Matrix init succeeds, load the oracle's UCAN signing mnemonic and
 * (optional) P-256 secrets encryption key from the oracle's Matrix account
 * room, and seat them on the corresponding services.
 *
 * Without the signing mnemonic the credits/subscription middleware can't
 * mint downstream invocations — every authenticated request would fail at
 * the gate. Without the encryption key, the user-secrets read path skips
 * silently and returns nothing (acceptable degraded mode).
 */
async function wireSigningAndEncryptionKeys(args: {
  nestApp: INestApplication;
  config: Record<string, unknown>;
  logger: PluginLogger;
}): Promise<void> {
  const { nestApp, config, logger } = args;
  const need = (key: string): string => {
    const value = config[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`[boot] missing required env '${key}' for key setup`);
    }
    return value;
  };

  const matrixRoomId =
    typeof config.MATRIX_ACCOUNT_ROOM_ID === 'string'
      ? config.MATRIX_ACCOUNT_ROOM_ID
      : '';
  const matrixAccessToken = need('MATRIX_ORACLE_ADMIN_ACCESS_TOKEN');
  const walletMnemonic = need('SECP_MNEMONIC');
  const pin = need('MATRIX_VALUE_PIN');
  const signerDid = need('ORACLE_DID');
  const network = need('NETWORK');

  try {
    logger.log?.('[boot] Loading UCAN signing mnemonic from Matrix...');
    const signingMnemonic = await setupClaimSigningMnemonics({
      matrixRoomId,
      matrixAccessToken,
      walletMnemonic,
      pin,
      signerDid,
      network: network as 'mainnet' | 'testnet' | 'devnet',
    });
    if (signingMnemonic) {
      const ucan = nestApp.get(UcanService, { strict: false });
      if (ucan) {
        ucan.setSigningMnemonic(signingMnemonic, signerDid);
        logger.log?.('[boot] UCAN signing mnemonic loaded.');
      } else {
        logger.warn?.(
          '[boot] UcanService not available — signing mnemonic dropped.',
        );
      }
    } else {
      logger.warn?.(
        '[boot] setupClaimSigningMnemonics returned null. ' +
          'UCAN minting will be unavailable until the mnemonic is provisioned ' +
          '(run `oracles-cli setup-claim-signing-mnemonics`).',
      );
    }
  } catch (error) {
    logger.error?.(
      `[boot] Failed to set up claim signing mnemonics: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!matrixRoomId) {
    logger.warn?.(
      '[boot] No MATRIX_ACCOUNT_ROOM_ID; skipping encryption-key load. ' +
        'User secrets will be unavailable.',
    );
    return;
  }

  try {
    logger.log?.('[boot] Loading P-256 user-secrets encryption key...');
    const result = await loadEncryptionKey({
      matrixRoomId,
      matrixAccessToken,
      pin,
      signerDid,
    });
    if (result) {
      SecretsService.getInstance().setEncryptionKey(result.privateJwk);
      logger.log?.('[boot] P-256 encryption key loaded.');
    } else {
      logger.warn?.(
        '[boot] No P-256 encryption key found. User secrets will be ' +
          'unavailable. Provision one via `oracles-cli setup-encryption-key`.',
      );
    }
  } catch (error) {
    logger.error?.(
      `[boot] Failed to load P-256 encryption key: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
