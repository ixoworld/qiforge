import 'dotenv/config';

import {
  EditorPlugin,
  FlowsPlugin,
  createOracleApp,
  type AuthExcludedRoute,
} from '@ixo/oracle-runtime';
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

// ─────────────────────────────────────────────────────────────────────────
// QiForge Flow Builder — a dedicated flow-builder oracle.
//
// The only capability wired in is the Flows plugin: the agent designs runnable
// flow *templates* by conversation, inspects live flow runs, and fixes the
// template when a run reveals a build mistake. It never executes, signs, or
// runs a step — the user does that in the portal. The agent persona lives in
// `./config.ts`.
// ─────────────────────────────────────────────────────────────────────────
@Controller('version')
class VersionController {
  @Get()
  get(): { name: string; description: string } {
    return {
      name: 'QiForge Flow Builder',
      description: 'A QiForge oracle that designs runnable automation flows',
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
 * Oracle identity + prompt live in `./config.ts` so integration tests can
 * import them without triggering this file's top-level `bootstrap()` call.
 *
 * The Flows plugin takes a live Matrix client so it can connect to flow rooms;
 * we instantiate it explicitly and pass the client in.
 */
async function bootstrap(): Promise<void> {
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

  const nestModules: Array<Type | DynamicModule> = [VersionModule];
  const authExcludedRoutes: AuthExcludedRoute[] = [
    ...HOST_AUTH_EXCLUDED_ROUTES,
  ];

  const app = await createOracleApp({
    config,
    logger: Logger,
    features: {
      'domain-indexer': false,
      tasks: false,
    },
    // The Flows plugin is the oracle's only capability. It shares the Matrix
    // client so it can connect to flow rooms and author templates.
    plugins: [
      new FlowsPlugin({ matrixClient }),
      new EditorPlugin({ matrixClient }),
    ],
    nestModules,
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
