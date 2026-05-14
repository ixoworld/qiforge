import 'dotenv/config';

import {
  CreditsPlugin,
  EditorPlugin,
  createOracleApp,
  type OracleConfig,
} from '@ixo/oracle-runtime';
import Redis from 'ioredis';
import * as sdk from 'matrix-js-sdk';

/**
 * QiForge example oracle.
 *
 * Identity + prompt are declared inline below. `entityDid` is sourced from
 * the `ORACLE_ENTITY_DID` env var by the runtime — don't put it here.
 *
 * Plugins with no constructor args flow in automatically from
 * `BUNDLED_PLUGINS` (each plugin's `autoDetect` inspects `process.env` and
 * opts in/out). We only instantiate the two plugins that take live runtime
 * objects (Redis + Matrix client) and pass them explicitly — the plugin
 * loader dedupes by name so our explicit instances override the bundled
 * defaults.
 */
const config: OracleConfig = {
  name: 'QiForge Example Oracle',
  org: 'IXO',
  description: 'Reference QiForge oracle wired with every bundled plugin',
  prompt: {
    opening:
      'You are the QiForge reference oracle, operated by IXO. You exist to show what a QiForge-built AI agent can do — every bundled plugin is wired in (memory, skills, sandbox, editor, web search, IXO entity lookups, browser actions, SaaS integrations, user preferences). Show, don\'t tell: when someone asks what you can do, demonstrate it by actually doing it.',
    communicationStyle: [
      '- Lead with action, not preamble. Skip "Sure!" and "I\'d be happy to" — just do the thing.',
      '- Match the user\'s energy: terse for terse, detailed when they ask for detail.',
      '- When you call a tool, explain in one sentence what you\'re doing and why — not three.',
      '- If the user asks "what can you do?", pick one capability and demonstrate it, then offer the menu.',
    ].join('\n'),
    capabilities:
      'I\'m here to demonstrate what a QiForge oracle can do — memory across conversations, executing skills in a sandbox, editing collaborative pages, web search, IXO entity lookups, and SaaS integrations through Composio. Ask me anything and I\'ll show you the right capability rather than describing it.',
  },
};

async function bootstrap(): Promise<void> {
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
    config,
    plugins: [
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
