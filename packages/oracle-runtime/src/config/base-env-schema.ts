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
  /**
   * The oracle's own DID (`did:ixo:ixo1...`). Distinct from the
   * `ORACLE_ENTITY_DID` (entity record on chain). Used by UcanService as
   * the signer identity when minting downstream-service invocations.
   */
  ORACLE_DID: z.string(),
  ORACLE_ENTITY_DID: z.string(),
  SECP_MNEMONIC: z.string(),
  RPC_URL: z.string(),

  /**
   * Max lifetime (seconds) the oracle will accept for a user *auth* invocation
   * (the short-lived, JWT-style bearer token the client signs to authenticate).
   * Bounds the replay window server-side regardless of the TTL the client
   * declares — a tampered client can't mint a long-lived auth token. Default
   * 15 minutes.
   */
  UCAN_AUTH_MAX_TTL_SECONDS: z.coerce.number().default(900),

  /**
   * Throttle window (seconds) between "please re-authorize" prompts posted into
   * a user's Matrix room when their stored delegation is missing/expired, so a
   * de-authorized user isn't nagged on every message. Default 6 hours.
   */
  UCAN_REAUTH_PROMPT_THROTTLE_SECONDS: z.coerce.number().default(21600),

  // LLM provider selection (provider-specific keys are optional so a fork
  // can choose between OpenRouter and Nebius without setting both).
  LLM_PROVIDER: z.enum(['openrouter', 'nebius']).default('openrouter'),
  OPENAI_API_KEY: z.string().optional(),
  OPEN_ROUTER_API_KEY: z.string().optional(),
  NEBIUS_API_KEY: z.string().optional(),

  // Operator model policy overlay (JSON, layered over the built-in table):
  // role→model targets with opaque credentialRefs, constraint sets,
  // disclosed fallbacks, optional AI Gateway transport.
  MODEL_POLICY_JSON: z.string().optional(),

  // Semantic router configuration (JSON): strategy, routes with exemplars,
  // per-strategy confidence thresholds.
  ROUTER_CONFIG_JSON: z.string().optional(),

  // Cloudflare AI Gateway auth token (`cf-aig-authorization`), referenced
  // from model policy via the broker ref 'cf-aig-token'.
  CF_AIG_TOKEN: z.string().optional(),

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

  // Append-only JSONL audit trail (authority decisions, refusal retries,
  // model receipts). The audit stream always flows through the logger;
  // setting a path additionally persists it to disk.
  AUDIT_LOG_PATH: z.string().optional(),

  // Manifest-permission enforcement. 'enforce' (default) replaces
  // undeclared RuntimeContext surfaces with throwing guards; 'warn' logs
  // the first undeclared access per surface and allows it — a loudly-
  // logged migration escape for forks whose plugins predate declarations.
  PERMISSIONS_ENFORCEMENT: z.enum(['enforce', 'warn']).default('enforce'),

  // Per-turn resource ceilings as JSON (partial TurnBudget: wallMs,
  // maxModelCalls, maxToolCalls, maxOutputBytes, perToolTimeoutMs,
  // maxConcurrency). Missing fields use the runtime defaults.
  TURN_BUDGET_JSON: z.string().optional(),

  /**
   * Extended-thinking effort for the main model. Lower = faster time-to-first
   * token, at some cost to hard multi-step reasoning. Default `medium`
   * preserves current behaviour; set `low` to trade reasoning depth for latency.
   */
  MAIN_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/**
 * Cross-field check the merged schema cannot express on its own (we keep the
 * base schema as a `ZodObject` so plugins can still `.extend()` on top of it
 * via the schema composer).
 *
 * Enforces that the API key for the selected `LLM_PROVIDER` is set —
 * otherwise the runtime would boot fine and every model call would fail at
 * request time with a generic upstream 401. Returns a list of structured
 * errors in the same shape as the schema composer's so they slot into the
 * existing boot-error reporter without special-casing.
 */
export function validateLlmProviderKey(
  env: Record<string, unknown>,
): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = [];
  const provider = env.LLM_PROVIDER;
  if (provider === 'nebius') {
    const key = env.NEBIUS_API_KEY;
    if (typeof key !== 'string' || key.length === 0) {
      errors.push({
        field: 'NEBIUS_API_KEY',
        message:
          "LLM provider 'nebius' selected via LLM_PROVIDER but NEBIUS_API_KEY is not set. " +
          'Set NEBIUS_API_KEY, or switch LLM_PROVIDER to openrouter and set OPEN_ROUTER_API_KEY.',
      });
    }
    return errors;
  }
  // Default (openrouter) — selected when LLM_PROVIDER is unset or 'openrouter'.
  const key = env.OPEN_ROUTER_API_KEY;
  if (typeof key !== 'string' || key.length === 0) {
    errors.push({
      field: 'OPEN_ROUTER_API_KEY',
      message:
        "LLM provider 'openrouter' selected via LLM_PROVIDER but OPEN_ROUTER_API_KEY is not set. " +
        'Set OPEN_ROUTER_API_KEY, or switch LLM_PROVIDER to nebius and set NEBIUS_API_KEY.',
    });
  }
  return errors;
}
