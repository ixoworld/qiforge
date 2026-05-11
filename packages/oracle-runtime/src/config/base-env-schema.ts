import { z } from 'zod';

/**
 * Tier-0 (core) environment variables. Always required by the runtime
 * regardless of which plugins are installed.
 *
 * Plugin-owned env vars (Composio, Slack, Memory, Firecrawl, Domain Indexer,
 * Sandbox, Skills, Credits/Subscription, Tasks/Redis) are NOT declared here —
 * each plugin contributes its own `configSchema` which the boot composer
 * extends onto this base schema at runtime.
 *
 * `LANGSMITH_*` keys are declared here because LangChain auto-wires tracing
 * when they are present in `process.env`; the runtime never reads them
 * directly, but documenting them in the base schema makes them visible to
 * `qiforge env` / inspect tooling.
 *
 * Field names match today's `apps/app/src/config.ts` exactly so existing
 * `.env` files keep working without renames.
 */
export const baseEnvSchema = z.object({
  // Runtime
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().default(3000),
  ORACLE_NAME: z.string(),
  CORS_ORIGIN: z.string().default('*'),
  NETWORK: z.enum(['mainnet', 'testnet', 'devnet']),

  // Matrix
  MATRIX_BASE_URL: z.string(),
  MATRIX_RECOVERY_PHRASE: z.string(),
  MATRIX_STORE_PATH: z.string().default('./matrix-storage'),
  MATRIX_ORACLE_ADMIN_USER_ID: z.string(),
  MATRIX_ORACLE_ADMIN_PASSWORD: z.string(),
  MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: z.string(),
  MATRIX_ACCOUNT_ROOM_ID: z.string(),
  MATRIX_VALUE_PIN: z.string(),

  // Storage paths
  SQLITE_DATABASE_PATH: z.string(),

  // Blocksync / chain
  BLOCKSYNC_GRAPHQL_URL: z.string(),
  ORACLE_ENTITY_DID: z.string(),
  SECP_MNEMONIC: z.string(),
  RPC_URL: z.string(),

  // LLM provider selection (provider-specific keys are optional so a fork
  // can choose between OpenRouter and Nebius without setting both).
  LLM_PROVIDER: z.enum(['openrouter', 'nebius']).default('openrouter'),
  OPENAI_API_KEY: z.string().optional(),
  OPEN_ROUTER_API_KEY: z.string().optional(),
  NEBIUS_API_KEY: z.string().optional(),

  // Operator-defined secrets surfaced to capabilities as `x-os-*` headers.
  // Format: `KEY1=value1,KEY2=value2`. Defaults to empty.
  ORACLE_SECRETS: z.string().default(''),

  // Live agent auth
  LIVE_AGENT_AUTH_API_KEY: z.string().optional().default(''),

  // LangSmith tracing — auto-wired by LangChain when these are set. Optional.
  LANGSMITH_TRACING: z.string().optional(),
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().optional(),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
