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
 * when they are present in `process.env`. The runtime reads them in exactly
 * one place — the per-request selective-tracing decision in
 * `modules/messages/langsmith-tracing.ts`; everything else (client
 * construction, batching, upload) stays LangChain's own env-driven wiring.
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

  /**
   * Default model for new chats — an OpenRouter slug (e.g.
   * `openai/gpt-5.4-nano`), ideally one returned by `GET /models`. When unset
   * the runtime uses its built-in default (GPT-5.4 Nano). Lets an operator
   * change the default per deployment without a code change. Only applies to
   * the OpenRouter provider.
   */
  DEFAULT_MODEL: z.string().optional(),

  /**
   * Markup applied to raw OpenRouter list prices when the catalog is shown to
   * users, so the displayed number is what they actually pay. Mirrors the
   * credit-billing markup (1.6× on mainnet). Display-only — it does not change
   * how credits are deducted.
   */
  MODEL_PRICE_MARKUP: z.coerce.number().default(1.6),

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

  /**
   * Selective tracing: comma-separated allowlist of user DIDs whose chat
   * turns are traced to LangSmith without enabling the global
   * `LANGSMITH_TRACING` switch (e.g. `did:ixo:ixo1abc...,did:x:zQ3sh...`).
   * `*` traces every user. Requires `LANGSMITH_API_KEY`; mutually exclusive
   * with `LANGSMITH_TRACING=true` — both misconfigurations fail the boot via
   * `validateLangsmithTracing`. Unset = no selective tracing. Consumed
   * per-request by `modules/messages/langsmith-tracing.ts`.
   */
  LANGSMITH_TRACED_DIDS: z.string().optional(),

  /**
   * Extended-thinking effort for the main model. Lower = faster time-to-first
   * token, at some cost to hard multi-step reasoning. Default `medium`
   * preserves current behaviour; set `low` to trade reasoning depth for latency.
   */
  MAIN_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),

  /**
   * Bring-your-own-credential LLMs: users connect their own ChatGPT
   * subscription or provider API keys and their turns run (and are billed)
   * on their own account. Off by default — enabled only on the personal
   * companion deployment. Env vars are strings, so only the literal 'true'
   * enables it (`Boolean('false')` is true).
   */
  BYO_LLM_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  /**
   * OAuth client id used for the ChatGPT subscription connect flow. Defaults
   * to the Codex public client; override only for testing against a stub.
   */
  BYO_CHATGPT_CLIENT_ID: z.string().optional(),

  /**
   * Path to the entity's `domain.md` — its constitution. Required: the runtime
   * evaluates every tool call against it, and there is no default constitution
   * to fall back on. An entity without one has no basis for the authority it
   * would be exercising, whatever kind of entity it is.
   */
  DOMAIN_MD_PATH: z.string(),

  /**
   * How the runtime treats a constitution it cannot fully vouch for.
   *
   * `strict` (the default, and the only posture to deploy) requires the
   * document to be anchored to canonical state and refuses actions it cannot
   * classify. `permissive` tolerates an unanchored draft for development.
   *
   * Neither mode disables the gate — enforcement is not a feature flag, so
   * there is deliberately no `off`.
   */
  DOMAIN_ENFORCEMENT: z.enum(['strict', 'permissive']).default('strict'),

  /**
   * Which of the entity's declared agents this runtime is acting as — an id
   * from `agents.entries[].id` in the constitution.
   *
   * An entity and its agents are different things. An agentic organisation,
   * project, asset or deed typically declares several agents and is none of
   * them; only an agentic oracle collapses the two by being its own single
   * agent. Where the constitution declares more than one agent and none of
   * them is the entity itself, the runtime cannot tell which output bounds
   * and escalation route apply to it, and strict enforcement refuses to boot
   * until this says so.
   *
   * Optional, because a constitution declaring one agent (or none) is
   * unambiguous without it.
   */
  DOMAIN_AGENT_ID: z.string().optional(),

  /**
   * Matrix room the hash-chained authorization decision records are written
   * to. Kept separate from `MATRIX_ACCOUNT_ROOM_ID`, which custodies keys:
   * an audit ledger and a key store want different access, and conflating
   * them means widening one to widen the other.
   *
   * Required under strict enforcement — an unrecordable decision is an
   * unauditable one — and checked by `validateDomainEnforcement`.
   */
  MATRIX_DECISIONS_ROOM_ID: z.string().optional(),
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

/**
 * Cross-field check binding the enforcement posture to the audit ledger.
 *
 * Same contract as `validateLlmProviderKey`: structured errors for the boot
 * reporter, empty array when the configuration is coherent.
 *
 * Strict enforcement promises that no tool executes without a recorded
 * decision. Without a room to record into, the runtime would keep refusing
 * and permitting while the record of why went nowhere — the enforcement would
 * be real and the accountability would not. Failing the boot is the honest
 * outcome; the alternative is a deployment that believes it is audited.
 *
 * Permissive deployments may omit the room: they are development runs, and
 * the decision path buffers rather than blocks.
 */
export function validateDomainEnforcement(
  env: Record<string, unknown>,
): Array<{ field: string; message: string }> {
  const enforcement = env.DOMAIN_ENFORCEMENT ?? 'strict';
  if (enforcement !== 'strict') return [];

  const room = env.MATRIX_DECISIONS_ROOM_ID;
  if (typeof room === 'string' && room.trim().length > 0) return [];

  return [
    {
      field: 'MATRIX_DECISIONS_ROOM_ID',
      message:
        'DOMAIN_ENFORCEMENT is strict but MATRIX_DECISIONS_ROOM_ID is not set. Strict ' +
        'enforcement records every authorization decision, including refusals, to a ' +
        'dedicated Matrix room; without one the runtime would enforce without leaving an ' +
        'audit trail. Set MATRIX_DECISIONS_ROOM_ID, or set DOMAIN_ENFORCEMENT=permissive ' +
        'for development.',
    },
  ];
}

/**
 * Cross-field check for the selective-tracing allowlist
 * (`LANGSMITH_TRACED_DIDS`). Same contract as `validateLlmProviderKey`:
 * returns structured errors for the boot-error reporter; empty array when
 * the allowlist is unset.
 *
 * Rules (each would otherwise fail silently at request time):
 *  - The allowlist requires `LANGSMITH_API_KEY` — without it the runtime
 *    refuses to attach a tracer and the operator would believe tracing is
 *    on while nothing uploads.
 *  - The allowlist is mutually exclusive with `LANGSMITH_TRACING=true` —
 *    the global switch already traces every user, which would make the
 *    allowlist meaningless without any signal that it is being ignored.
 *  - Every entry must be `*` or a `did:`-prefixed identifier — catches
 *    delimiter typos (spaces, semicolons) that would otherwise trace nobody.
 *
 * Deliberately does NOT validate the global-mode combination
 * (`LANGSMITH_TRACING=true` without `LANGSMITH_API_KEY`): LangChain also
 * honours legacy `LANGCHAIN_*` aliases outside this schema, so rejecting
 * that pair could break deployments that are actually working.
 */
export function validateLangsmithTracing(
  env: Record<string, unknown>,
): Array<{ field: string; message: string }> {
  const raw = env.LANGSMITH_TRACED_DIDS;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [];
  }

  const errors: Array<{ field: string; message: string }> = [];

  const apiKey = env.LANGSMITH_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    errors.push({
      field: 'LANGSMITH_API_KEY',
      message:
        'LANGSMITH_TRACED_DIDS is set but LANGSMITH_API_KEY is not — selective tracing ' +
        'would silently upload nothing. Set LANGSMITH_API_KEY or unset LANGSMITH_TRACED_DIDS.',
    });
  }

  const globalTracing = env.LANGSMITH_TRACING;
  if (typeof globalTracing === 'string' && globalTracing.trim() === 'true') {
    errors.push({
      field: 'LANGSMITH_TRACED_DIDS',
      message:
        'LANGSMITH_TRACED_DIDS and LANGSMITH_TRACING=true are both set. Global tracing ' +
        'already traces every user, which would silently ignore the allowlist. Unset one: ' +
        'keep LANGSMITH_TRACING=true to trace everyone, or keep LANGSMITH_TRACED_DIDS to ' +
        'trace only the listed DIDs.',
    });
  }

  const invalidEntries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => entry !== '*' && !entry.startsWith('did:'));
  if (invalidEntries.length > 0) {
    errors.push({
      field: 'LANGSMITH_TRACED_DIDS',
      message:
        `LANGSMITH_TRACED_DIDS contains entries that are neither '*' nor DIDs: ` +
        `${invalidEntries.join(', ')}. Use a comma-separated list of did:-prefixed ` +
        `identifiers, or '*' to trace every user.`,
    });
  }

  return errors;
}
