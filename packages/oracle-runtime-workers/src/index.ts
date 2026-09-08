/* eslint-disable no-console -- console IS the logger on Workers (Logs/observability). */
/**
 * @ixo/oracle-runtime-workers — QiForge oracles on Cloudflare Workers.
 *
 * An oracle is a Worker whose entry does:
 *
 *   const oracle = createOracleWorker({ config, plugins: [new WeatherPlugin()] });
 *   export const { UserOracleDO, MatrixGatewayDO } = oracle;
 *   export default oracle;   // { fetch, scheduled }
 *
 * plus a `wrangler.jsonc` declaring the two Durable Object bindings
 * (`USER_ORACLE` → `UserOracleDO`, `MATRIX_GATEWAY` → `MatrixGatewayDO`,
 * both `new_sqlite_classes`) and the crypto-wasm alias. See
 * `apps/qiforge-workers-example`.
 */
import {
  createRuntimeCore,
  listModels,
  type RuntimeCoreOptions,
  type RuntimeCore,
} from './core';
import type { OraclePlugin } from './plugin-api';
import type { OracleConfig } from './plugin-api/types';
import type { OracleWorkerEnv } from './do/contracts';
import {
  createUserOracleDO,
  type OracleWorkerHooks,
} from './do/user-oracle-do';
import { MatrixGatewayDO } from './matrix/gateway-do';
import { createShell, gateway, type PluginRoute } from './shell/app';
import type { RouteExclusion } from './shell/auth';

export * from './plugin-api';
export * from './plugins';
export * from './do/contracts';
export type { OwnerStore } from './owner-store/types';
export { MigratingOwnerStore } from './owner-store/migrating-store';
export {
  IxoVfsOwnerStore,
  VFS_OWNER_COPY_RESOURCE,
  ownerCopyCapability,
} from './owner-store/ixo-vfs-store';
export { MatrixMediaOwnerStore } from './owner-store/matrix-media-store';
export { MatrixGatewayDO } from './matrix/gateway-do';
export {
  createUserOracleDO,
  type OracleWorkerHooks,
} from './do/user-oracle-do';
export { createShell } from './shell/app';
export { authenticate } from './shell/auth';
export {
  createRuntimeCore,
  createMainAgent,
  createLlmAdapter,
  buildModelListing,
  fetchOpenRouterPrices,
  listModelCatalog,
  listModels,
  MODEL_CATALOG,
  WeatherPlugin,
  SkillsPlugin,
  type RuntimeCore,
  type RuntimeCoreOptions,
} from './core';
export {
  NEBIUS_BASE_URL,
  NEBIUS_MODEL_MAP,
  langsmithEnvFromWorkerEnv,
  llmEnvFromWorkerEnv,
  resolveLangsmithTracing,
  type LangsmithTracingDecision,
  type LangsmithTracingEnv,
  type LlmProvider,
  type ResolveLangsmithTracingArgs,
} from './core/llm';

// --- per-room JWE secrets ---------------------------------------------------
export { decryptJwe, encryptJwe, parseJwk, type JWK } from './secrets/jwe';
export { decryptWithPin } from './secrets/pin-cipher';
export {
  RUNTIME_PUBLIC_KEY_ID,
  WorkersSecretsService,
  type SecretIndexEntry,
  type SecretsGateway,
  type WorkersSecretsServiceOptions,
} from './secrets/secrets-service';
export { createSecretsAdapter } from './do/secrets-adapter';

// --- bring-your-own-credential LLMs ----------------------------------------
export * from './llm/byo-catalog';
export { createByoLlmAdapter, type ByoTurnResolution } from './llm/byo-adapter';
export {
  ANTHROPIC_OPENAI_COMPAT_BASE_URL,
  CHATGPT_BACKEND_BASE_URL,
  DEEPSEEK_BASE_URL,
  GEMINI_OPENAI_COMPAT_BASE_URL,
  createByoChatModel,
  type CreateByoChatModelArgs,
} from './llm/byo-client';
export {
  WorkersByoService,
  type ByoCredentialMap,
  type ByoProviderStatus,
  type ByoSecretsBackend,
  type ByoStateStore,
  type ByoTurnState,
  type WorkersByoServiceOptions,
} from './llm/byo-service';
export { handleByoRequest } from './llm/byo-routes';
export {
  BYO_FALLBACK_KIND,
  buildByoFallbackNotice,
  type ByoFallbackNoticePayload,
  type ByoFallbackReason,
} from './llm/provider-error';
export {
  CHATGPT_REDIRECT_URI,
  ChatGptOAuthError,
  DEFAULT_CHATGPT_CLIENT_ID,
  DEVICE_VERIFICATION_URL,
  TOKEN_REFRESH_SKEW_MS,
  buildAuthorizeUrl,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  pollDeviceToken,
  refreshChatGptTokens,
  startDeviceAuthorization,
  type DeviceAuthorization,
  type DevicePollResult,
  type PkcePair,
} from './llm/chatgpt-oauth';

export interface CreateOracleWorkerOptions {
  config: OracleConfig;
  plugins?: OraclePlugin[];
  features?: RuntimeCoreOptions['features'];
  /**
   * Per-plugin manifest overrides, shallow-merged over each loaded plugin's
   * own `manifest` at boot (the Node runtime's `createOracleApp` option of
   * the same name): retune a bundled plugin's summary, hints or
   * `visibility` — e.g. `{ portal: { visibility: 'always' } }` binds the
   * Portal's browser tools on every turn instead of behind
   * `load_capability`. Keys naming no loaded plugin are logged and ignored;
   * the merged manifest is validated like an authored one.
   */
  manifestOverrides?: RuntimeCoreOptions['manifestOverrides'];
  /** Extra host routes mounted on the shell. */
  routes?: PluginRoute[];
  /** Host routes exempt from UCAN auth. */
  authExcludedRoutes?: RouteExclusion[];
  /**
   * Overrides for the model catalog exposed on `GET /models`. Default: the
   * curated catalog with live OpenRouter prices (`listModels`).
   */
  listModels?: (env: OracleWorkerEnv) => unknown | Promise<unknown>;
  /**
   * Host hooks for the per-turn agent build — the Node runtime's
   * `opts.hooks.getRoomTitle` / `safetyModel`, resolved per turn against the
   * user object's ambient services.
   */
  hooks?: OracleWorkerHooks;
}

export interface OracleWorker {
  fetch: (
    request: Request,
    env: OracleWorkerEnv,
    ctx: ExecutionContext,
  ) => Promise<Response>;
  scheduled: (
    event: ScheduledController,
    env: OracleWorkerEnv,
    ctx: ExecutionContext,
  ) => Promise<void>;
  UserOracleDO: ReturnType<typeof createUserOracleDO>;
  MatrixGatewayDO: typeof MatrixGatewayDO;
  /** Resolve (and memoize per isolate) the runtime core for an env. */
  core: (env: OracleWorkerEnv) => RuntimeCore;
}

export function createOracleWorker(
  opts: CreateOracleWorkerOptions,
): OracleWorker {
  // One core per isolate per env object. Isolates are reused across requests
  // (cheap), evicted under pressure (rebuilt on demand) — same lifetime the
  // Node runtime's boot caches had, minus the process.
  const cores = new WeakMap<object, RuntimeCore>();
  const coreFor = (env: OracleWorkerEnv): RuntimeCore => {
    let core = cores.get(env);
    if (!core) {
      core = createRuntimeCore({
        config: opts.config,
        plugins: opts.plugins ?? [],
        features: opts.features,
        manifestOverrides: opts.manifestOverrides,
        env,
        logger: console,
      });
      cores.set(env, core);
    }
    return core;
  };

  const apps = new WeakMap<object, ReturnType<typeof createShell>>();
  const appFor = (env: OracleWorkerEnv) => {
    let app = apps.get(env);
    if (!app) {
      const core = coreFor(env);
      app = createShell({
        routes: [...core.pluginRoutes, ...(opts.routes ?? [])],
        authExcludedRoutes: [
          ...core.authExcludedRoutes,
          ...(opts.authExcludedRoutes ?? []),
        ],
        listModels: opts.listModels ?? ((e) => listModels(e)),
        banner: {
          name: opts.config.name,
          description: opts.config.description,
        },
      });
      apps.set(env, app);
    }
    return app;
  };

  const UserOracleDO = createUserOracleDO({
    core: coreFor,
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
  });

  return {
    UserOracleDO,
    MatrixGatewayDO,
    core: coreFor,
    fetch: async (request, env, ctx) => {
      // Make sure the Matrix bot is running; the call is idempotent and cheap
      // once started. Done in the background so it never delays a request.
      ctx.waitUntil(
        gateway(env)
          .ensureStarted()
          .catch((err) => console.error('[matrix] ensureStarted failed', err)),
      );
      return appFor(env).fetch(request, env, ctx);
    },
    scheduled: async (_event, env) => {
      // Cron safety net: if the gateway's keep-alive loop ever died, this
      // restarts it. Declare a `triggers.crons` entry (e.g. every 5 minutes).
      await gateway(env).ensureStarted();
    },
  };
}
