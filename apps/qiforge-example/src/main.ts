import 'dotenv/config';

import { createOracleApp, type AuthExcludedRoute } from '@ixo/oracle-runtime';
// import Redis from 'ioredis';
import {
  Controller,
  Get,
  Logger,
  Module,
  RequestMethod,
  type DynamicModule,
  type Type,
} from '@nestjs/common';
import * as sdk from 'matrix-js-sdk';
import { config } from './config.js';
import { LinearPlugin } from './plugins/linear/index.js';

// ─────────────────────────────────────────────────────────────────────────
// Host-supplied Nest module — proves the `nestModules` slot works AND
// demos the new `authExcludedRoutes` option (TASK-35).
//
// Without `authExcludedRoutes: [{ path: 'version', method: GET }]` below,
// every call to GET /version would 401 with "Missing x-ucan-delegation
// header". Listing it here merges onto the runtime's exclusion list so
// the route is reachable without auth.
// ─────────────────────────────────────────────────────────────────────────
@Controller('version')
class VersionController {
  @Get()
  get(): { name: string; description: string } {
    return {
      name: 'QiForge Example Oracle',
      description: 'Reference QiForge oracle wired with every bundled plugin',
    };
  }
}

@Module({ controllers: [VersionController] })
class VersionModule {}

const HOST_AUTH_EXCLUDED_ROUTES: AuthExcludedRoute[] = [
  // VersionController's GET /version — no UCAN needed.
  { path: 'version', method: RequestMethod.GET },
];

/**
 * Plugins with no constructor args flow in automatically from
 * `BUNDLED_PLUGINS` (each plugin's `autoDetect` inspects `process.env` and
 * opts in/out). We only instantiate the two plugins that take live runtime
 * objects (Matrix client) and pass them explicitly — the plugin loader
 * dedupes by name so our explicit instances override the bundled defaults.
 *
 * Oracle identity + prompt live in `./config.ts` so integration tests can
 * import them without triggering this file's top-level `bootstrap()` call.
 */
async function bootstrap(): Promise<void> {
  // const redisUrl = process.env.REDIS_URL;
  // const redis = redisUrl ? new Redis(redisUrl) : null;

  const matrixBaseUrl = process.env.MATRIX_BASE_URL;
  const matrixUserId = process.env.MATRIX_ORACLE_ADMIN_USER_ID;
  const matrixAccessToken = process.env.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN;
  if (!matrixBaseUrl || !matrixUserId || !matrixAccessToken) {
    throw new Error(
      'Matrix env vars missing — MATRIX_BASE_URL / MATRIX_ORACLE_ADMIN_USER_ID / MATRIX_ORACLE_ADMIN_ACCESS_TOKEN are required.',
    );
  }

  const matrixClient = sdk.createClient({
    baseUrl: matrixBaseUrl,
    userId: matrixUserId,
    accessToken: matrixAccessToken,
  });

  const network = (process.env.NETWORK ?? 'devnet') as
    | 'mainnet'
    | 'testnet'
    | 'devnet';

  const nestModules: Array<Type | DynamicModule> = [VersionModule];
  const authExcludedRoutes: AuthExcludedRoute[] = [
    ...HOST_AUTH_EXCLUDED_ROUTES,
  ];

  // Dev-only BullMQ dashboard (bull-board) for the tasks plugin's queues.
  // The dynamic import means dist builds still compile the module (devDeps
  // are present at build time in CI), but production never loads it: the
  // NODE_ENV guard skips the import, and production installs (`pnpm install
  // --prod`) don't even ship the @bull-board/* packages.
  const dashboardRedisUrl = process.env.REDIS_URL;
  if (process.env.NODE_ENV !== 'production' && dashboardRedisUrl) {
    const { TasksDashboardModule, TASKS_DASHBOARD_ROUTE } =
      await import('./dev/tasks-dashboard.module.js');
    nestModules.push(TasksDashboardModule.register(dashboardRedisUrl));
    // Without these exclusions `AuthHeaderMiddleware` would 401 the dashboard
    // (no UCAN header on browser requests). The bare entry covers the route
    // itself; `{*path}` is the path-to-regexp v8 wildcard — the same form
    // Nest 11 converts the runtime's legacy `/docs/(.*)` exclusion into — and
    // covers the UI's API + static-asset sub-paths.
    authExcludedRoutes.push(
      { path: TASKS_DASHBOARD_ROUTE, method: RequestMethod.ALL },
      { path: `${TASKS_DASHBOARD_ROUTE}/{*path}`, method: RequestMethod.ALL },
    );
    Logger.log(
      `[dev] BullMQ dashboard mounted at http://localhost:${process.env.PORT ?? '3000'}${TASKS_DASHBOARD_ROUTE}`,
    );
  }

  const app = await createOracleApp({
    config,
    logger: Logger,
    plugins: [
      // Unblock 11 — customer support oracle. Auto-detects on LINEAR_API_KEY,
      // so the reference oracle still boots without Linear creds set.
      new LinearPlugin(),
    ],
    // Support oracle doesn't need these bundled capabilities — turn them off so
    // they never enter the prompt or the tool surface. Each key maps to a
    // bundled plugin; `false` excludes it regardless of env.
    features: {
      firecrawl: false, // web search/scraping — not a support concern
      composio: false, // generic SaaS gateway — Linear handled by our plugin
      'domain-indexer': false, // IXO entity lookups — irrelevant here
      tasks: false, // background-job placeholder — unused
      credits: false,
    },
    // Host-supplied Nest modules — see VersionController above (plus the
    // dev-only tasks dashboard when mounted).
    nestModules,
    // Opt host routes out of `AuthHeaderMiddleware`. Symmetric with the
    // plugin-side `getAuthExcludedRoutes()` hook used by the Weather plugin
    // for `/weather/now`. Both merge onto the runtime's built-in exclusions.
    authExcludedRoutes,
  });

  app.onPluginStatusChange((event) => {
    Logger.log(
      `[plugin] ${event.plugin} ${event.from} → ${event.to}${event.reason ? ` (${event.reason})` : ''}`,
    );
  });
  app.onError((err, source) => {
    Logger.error(`[runtime] ${source}: ${err.message}`);
  });

  const status = app.plugins.status();
  Logger.log(`[boot] loaded plugins: ${status.loaded.join(', ') || '(none)'}`);
  if (status.excluded.length > 0) {
    Logger.log(
      '[boot] excluded plugins:',
      status.excluded.map((e) => `${e.plugin} (${e.reason})`).join(', '),
    );
  }

  await app.listen();
}

bootstrap().catch((err) => {
  Logger.error('Oracle failed to start:', err);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────────────────
// Verify the new framework features (TASK-35 + TASK-36)
//
// Boot: `pnpm dev` (default port 5678; respects PORT env).
//
// TASK-35 — auth-excluded routes:
//   Plugin-declared:
//     curl 'http://localhost:5678/weather/now?city=Berlin'
//     → 200 with {ok:true, city, temp_c, ...}   (no UCAN header sent)
//
//   Host-declared (via authExcludedRoutes above):
//     curl 'http://localhost:5678/version'
//     → 200 with {name, description}            (no UCAN header sent)
//
//   Any other plugin/host route returns 401 without a UCAN header — proves
//   the exclusion list only opts these two paths out, not the whole app.
//
// TASK-36 — getNestModules(ctx):
//   The Weather plugin's `getNestModules(ctx)` reads
//   `ctx.config.WEATHER_DEFAULT_UNITS`. To see it in action, set:
//     WEATHER_DEFAULT_UNITS=fahrenheit pnpm dev
//   then curl `/weather/now?city=Berlin` — response should report
//   `"units":"fahrenheit"` and a Fahrenheit-scale value.
// ─────────────────────────────────────────────────────────────────────────
