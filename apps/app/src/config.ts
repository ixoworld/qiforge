import { ConfigService } from '@nestjs/config';
import z from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().default(3000),
  ORACLE_NAME: z.string(),

  // CORS
  CORS_ORIGIN: z.string().default('*'),
  COMPOSIO_BASE_URL: z.url().default('https://composio.ixo.earth'),
  COMPOSIO_API_KEY: z.string().optional(),

  // Slack
  SLACK_BOT_OAUTH_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_USE_SOCKET_MODE: z.string().default('true'),
  SLACK_MAX_RECONNECT_ATTEMPTS: z.coerce.number().default(10),
  SLACK_RECONNECT_DELAY_MS: z.coerce.number().default(1000),

  // Matrix
  MATRIX_BASE_URL: z.string(),
  MATRIX_RECOVERY_PHRASE: z.string(),
  MATRIX_STORE_PATH: z.string().default('./matrix-storage'),
  MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: z.string(),
  MATRIX_ORACLE_ADMIN_USER_ID: z.string(),
  MATRIX_ORACLE_ADMIN_PASSWORD: z.string(),
  MATRIX_SECRET_STORAGE_KEYS_PATH: z
    .string()
    .default('./matrix-secret-storage-keys-new2'),
  SKIP_LOGGING_CHAT_HISTORY_TO_MATRIX: z.string().optional(),

  // LLM Provider selection: 'openrouter' (default) or 'nebius'
  LLM_PROVIDER: z.enum(['openrouter', 'nebius']).default('openrouter'),

  // OpenAI - used by @ixo/common package
  OPENAI_API_KEY: z.string().optional(),

  // OpenRouter
  OPEN_ROUTER_API_KEY: z.string().optional(),

  // Nebius Token Factory
  NEBIUS_API_KEY: z.string().optional(),

  SUBSCRIPTION_ORACLE_MCP_URL: z.url().optional(),
  NETWORK: z.enum(['mainnet', 'testnet', 'devnet']),
  BLOCKSYNC_URI: z.string().optional(),
  BLOCKSYNC_GRAPHQL_URL: z.string(),
  SQLITE_DATABASE_PATH: z.string(),
  LIVE_AGENT_AUTH_API_KEY: z.string().optional().default(''),
  MEMORY_MCP_URL: z.url(),
  MEMORY_ENGINE_URL: z.url(),
  ORACLE_ENTITY_DID: z.string(),
  SUBSCRIPTION_URL: z.string().optional(),
  FIRECRAWL_MCP_URL: z.url(),
  DOMAIN_INDEXER_URL: z.url(),
  REDIS_URL: z.string().optional(),
  SECP_MNEMONIC: z.string(),
  RPC_URL: z.string(),
  MATRIX_VALUE_PIN: z.string(),
  // convert string to boolean
  DISABLE_CREDITS: z
    .string()
    .transform((val) => val === 'true')
    .default(false),

  MATRIX_ACCOUNT_ROOM_ID: z.string(),
  SANDBOX_MCP_URL: z.url(),
  SKILLS_CAPSULES_BASE_URL: z
    .url()
    .default('https://capsules.skills.ixo.earth'),

  // Oracle operator secrets exposed to sandbox as x-os-* headers
  // Format: "KEY1=value1,KEY2=value2"
  ORACLE_SECRETS: z.string().default(''),
});

export const matrixAccountRoomId = {
  mainnet: '!ekfOXRmXCdBkDaRDDr:mx.ixo.earth',
  testnet: '!HLRUpfYhwoLYDSEVcX:testmx.ixo.earth',
  devnet: '!RHtTYnmThqJKAPqYXR:devmx.ixo.earth',
}[(process.env.NETWORK as keyof typeof matrixAccountRoomId) ?? 'devnet'];

export type ENV = z.infer<typeof EnvSchema> & {
  ORACLE_DID: string;
};

/**
 * Centralized config accessor. Works with both NestJS-injected ConfigService
 * and standalone (module-level) usage via the singleton fallback.
 *
 * Usage:
 *   const config = getConfig();          // standalone (reads from process.env)
 *   const config = getConfig(injected);  // NestJS DI context
 *
 *   config.get('PORT')                   // returns value or undefined
 *   config.getOrThrow('ORACLE_DID')      // throws if missing
 */
export function getConfig(configService?: ConfigService<ENV>) {
  const svc = configService ?? singletonConfigService();
  return {
    get<K extends keyof ENV>(
      key: K,
      defaultValue?: ENV[K],
    ): ENV[K] | undefined {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return svc.get(key as any, defaultValue);
    },
    getOrThrow<K extends keyof ENV>(key: K): ENV[K] {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return svc.getOrThrow(key as any);
    },
  };
}

/**
 * Returns true when a REDIS_URL is configured.
 * Used to conditionally enable Redis-dependent features
 * (BullMQ task queues, token/credit limiting, etc.).
 */
export function isRedisEnabled(): boolean {
  return !!process.env.REDIS_URL;
}

let _singleton: ConfigService<ENV> | undefined;
function singletonConfigService(): ConfigService<ENV> {
  if (!_singleton) {
    const parsed = EnvSchema.safeParse(process.env);
    const envVars = parsed.success ? parsed.data : process.env;
    _singleton = new ConfigService<ENV>(envVars as Record<string, unknown>);
  }
  return _singleton;
}
