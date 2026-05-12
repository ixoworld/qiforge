import { MatrixManager } from '@ixo/matrix';
import {
  Logger,
  type DynamicModule,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pkg from '../../package.json' with { type: 'json' };
import { baseEnvSchema } from '../config/base-env-schema.js';
import { validateManifest } from '../manifest/validator.js';
import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type {
  OracleIdentity,
  Logger as PluginLogger,
} from '../plugin-api/types.js';
import { BUNDLED_PLUGINS } from '../plugins/index.js';
import {
  ConfigSchemaRegistry,
  ManifestRegistry,
  MiddlewareRegistry,
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
  identity: OracleIdentity;
  features?: Partial<Record<BundledFeatureName | (string & {}), FeatureToggle>>;
  plugins?: OraclePlugin[];
  /** Developer's own NestJS modules. Spread into `RuntimeAppModule.imports`. */
  nestModules?: Array<Type | DynamicModule>;
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
  validateIdentity(opts.identity);

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

  // 4. Manifest validation
  const manifestErrors: string[] = [];
  for (const plugin of resolved.loaded) {
    const result = validateManifest(plugin.manifest, plugin.name);
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

  // 6. Registry population
  const registries = {
    tools: new ToolRegistry(),
    subAgents: new SubAgentRegistry(),
    middlewares: new MiddlewareRegistry(),
    manifests: new ManifestRegistry(),
    configSchema: new ConfigSchemaRegistry(),
    sharedState: new SharedStateRegistry(),
  };
  for (const plugin of resolved.loaded) {
    registries.tools.register(plugin);
    registries.subAgents.register(plugin);
    registries.middlewares.register(plugin);
    registries.manifests.register(plugin);
    registries.configSchema.register(plugin);
    registries.sharedState.register(plugin);
  }

  // 7. NestJS bootstrap
  const enableSubscription = resolved.loaded.some((p) => p.name === 'credits');
  const pluginNestModules = resolved.loaded.flatMap(
    (p) => p.getNestModules?.() ?? [],
  );
  const appModule = RuntimeAppModule.register({
    validatedEnv: validated.config,
    userNestModules: opts.nestModules,
    pluginNestModules,
    enableSubscriptionMiddleware: enableSubscription,
  });

  const nestApp = await NestFactory.create(appModule, {
    bufferLogs: false,
  });

  // 8. Background Matrix init — fire-and-forget.
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
        .then(() => {
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
        `Oracle '${opts.identity.name}' (runtime v${pkg.version}) listening on :${portValue}`,
      );
    },
  };
}

function validateIdentity(identity: OracleIdentity | undefined): void {
  if (!identity) {
    throw new Error("createOracleApp: 'identity' is required.");
  }
  const missing: string[] = [];
  if (!identity.name) missing.push('name');
  if (!identity.org) missing.push('org');
  if (!identity.description) missing.push('description');
  if (!identity.entityDid) missing.push('entityDid');
  if (missing.length > 0) {
    throw new Error(
      `createOracleApp: identity is missing required fields: ${missing.join(', ')}.`,
    );
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
