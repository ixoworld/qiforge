import 'dotenv/config';

import {
  CreditsPlugin,
  EditorPlugin,
  createOracleApp,
} from '@ixo/oracle-runtime';
import Redis from 'ioredis';
import * as sdk from 'matrix-js-sdk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

interface OracleIdentityConfig {
  name: string;
  org: string;
  description: string;
  entityDid: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const oracleConfig = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'oracle.config.json'), 'utf-8'),
) as OracleIdentityConfig;

/**
 * QiForge example oracle.
 *
 * Everything that needs no constructor args is picked up automatically from
 * `BUNDLED_PLUGINS` inside `createOracleApp` (each plugin's `autoDetect`
 * inspects `process.env` and opts in/out cleanly). We only instantiate the
 * two plugins that take live runtime objects (Redis + Matrix client) and
 * pass them explicitly — the plugin loader dedupes by name, so our explicit
 * instances override the bundled defaults.
 */
async function bootstrap(): Promise<void> {
  if (!oracleConfig.entityDid) {
    throw new Error(
      'oracle.config.json: `entityDid` is empty. Set the oracle entity DID before booting.',
    );
  }

  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl ? new Redis(redisUrl) : null;

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

  const app = await createOracleApp({
    identity: {
      name: oracleConfig.name,
      org: oracleConfig.org,
      description: oracleConfig.description,
      entityDid: oracleConfig.entityDid,
    },
    plugins: [
      // Plugins that need live runtime objects passed explicitly. Everything
      // else (memory, portal, agui, firecrawl, domain-indexer, composio,
      // sandbox, skills, slack, user-preferences) flows in via
      // BUNDLED_PLUGINS and auto-detects from env.
      ...(redis ? [new CreditsPlugin({ redis, network })] : []),
      new EditorPlugin({ matrixClient }),
    ],
  });

  app.onPluginStatusChange((event) => {
    console.log(
      `[plugin] ${event.plugin} ${event.from} → ${event.to}${event.reason ? ` (${event.reason})` : ''}`,
    );
  });
  app.onError((err, source) => {
    console.error(`[runtime] ${source}: ${err.message}`);
  });

  const status = app.plugins.status();
  console.log(
    `[boot] loaded plugins: ${status.loaded.join(', ') || '(none)'}`,
  );
  if (status.excluded.length > 0) {
    console.log(
      '[boot] excluded plugins:',
      status.excluded
        .map((e) => `${e.plugin} (${e.reason})`)
        .join(', '),
    );
  }

  await app.listen();
}

bootstrap().catch((err) => {
  console.error('Oracle failed to start:', err);
  process.exit(1);
});
