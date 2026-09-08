import { z } from 'zod';
import type { OraclePlugin } from '../plugin-api/oracle-plugin';
import type { Logger } from '../plugin-api/types';
import { NOOP_LOGGER } from './utils';

/**
 * Tier-0 (core) environment for the Workers runtime. Mirrors
 * `OracleWorkerEnv` in `src/do/contracts.ts`: every key here is a Worker
 * secret or var. Plugin-owned keys are NOT declared here — each plugin's
 * `configSchema` is folded onto this base by {@link composeEnvSchema}.
 *
 * Deliberately absent versus the Node runtime's base schema: `NODE_ENV`,
 * `PORT`, `SQLITE_DATABASE_PATH`, `MATRIX_STORE_PATH`, `SECP_MNEMONIC`,
 * `RPC_URL`, `OPENAI_API_KEY`, `SESSION_TITLE_MODEL`, `ORACLE_SECRETS`,
 * `LIVE_AGENT_AUTH_API_KEY` — filesystem/process concerns that do not exist
 * on Workers or features this runtime does not carry. Optional features
 * (Nebius, LangSmith, BYO credentials, the account-room secrets key) are
 * read straight from `OracleWorkerEnv` by the code that owns them.
 *
 * Unknown keys are stripped by Zod, so the Durable Object namespaces and any
 * other non-string bindings on the Worker `env` object never reach plugins
 * through `ctx.config`.
 */
export const baseEnvSchema = z.object({
  // --- identity -----------------------------------------------------------
  ORACLE_NAME: z.string().min(1),
  /** UCAN audience — the DID users address invocations/delegations to. */
  ORACLE_DID: z.string().min(1),
  /**
   * On-chain entity DID surfaced to the agent as `identity.entityDid`. Falls
   * back to `ORACLE_DID` when unset (see `createRuntimeCore`).
   */
  ORACLE_ENTITY_DID: z.string().min(1).optional(),
  NETWORK: z.enum(['mainnet', 'testnet', 'devnet']).default('mainnet'),

  // --- auth ---------------------------------------------------------------
  /** Blocksync GraphQL endpoint used to resolve `did:ixo` verification keys. */
  BLOCKSYNC_GRAPHQL_URL: z.string().min(1),
  /**
   * Max lifetime (seconds) the oracle accepts for a user *auth* invocation.
   * Bounds the replay window server-side regardless of the TTL the client
   * declares. Default 15 minutes.
   */
  UCAN_AUTH_MAX_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  // --- matrix -------------------------------------------------------------
  MATRIX_BASE_URL: z.string().min(1),
  MATRIX_ORACLE_ADMIN_USER_ID: z.string().min(1),
  /**
   * The bot account's password. The gateway logs its own device in with it,
   * keeps that device's token in its storage and re-logs in if the token is
   * ever rejected; plugins that need their own client (editor, flows) get a
   * second dedicated device from the gateway. No access token is ever
   * configured: a token is a device, and a device shared with any other
   * client splits its encryption state.
   */
  MATRIX_ORACLE_ADMIN_PASSWORD: z.string().min(1),
  /** SSSS recovery passphrase — lets a fresh device restore room keys. */
  MATRIX_RECOVERY_PHRASE: z.string().min(1).optional(),
  /** Matrix server name used when composing per-user room aliases. */
  MATRIX_HOMESERVER_NAME: z.string().min(1).optional(),

  // --- storage ------------------------------------------------------------
  /** Where the user-owned SQLite file lives; unset = the IXO VFS, `matrix` = legacy room media (local harness). */
  OWNER_STORE: z.enum(['matrix', 'vfs']).optional(),
  /** IXO VFS worker base URL when `OWNER_STORE=vfs` (defaults per NETWORK). */
  VFS_BASE_URL: z.string().url().optional(),
  /** UCAN store worker base URL (defaults per NETWORK). */
  UCAN_STORE_URL: z.string().url().optional(),

  // --- llm ----------------------------------------------------------------
  OPEN_ROUTER_API_KEY: z.string().min(1),
  /**
   * Default model for new chats — an OpenRouter slug. When unset the runtime
   * uses the catalog default. Lets an operator change the default per
   * deployment without a code change.
   */
  DEFAULT_MODEL: z.string().min(1).optional(),
  /**
   * Multiplier applied to raw provider prices in `GET /models` (the price the
   * user sees). Same default as the Node runtime.
   */
  MODEL_PRICE_MARKUP: z.coerce.number().positive().optional(),
  /**
   * Extended-thinking effort for the main model. Lower = faster time-to-first
   * token, at some cost to hard multi-step reasoning.
   */
  MAIN_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),

  // --- misc ---------------------------------------------------------------
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGIN: z.string().default('*'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export interface ComposeEnvSchemaResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodObject<any>;
  /**
   * Map of env field name -> the plugin that owns it. Used by
   * {@link validateEnv} to attribute Zod issues to a plugin.
   */
  pluginOwnership: Map<string, string>;
}

export interface ValidateEnvError {
  /** Plugin owning the failing field, or `'core'` if from a base schema. */
  plugin: string;
  /** Dotted field path from Zod's issue (e.g. `MEMORY_MCP_URL`). */
  field: string;
  /** Human-readable message from Zod. */
  message: string;
}

export interface ValidateEnvResult {
  valid: boolean;
  /** Parsed config object — empty when `valid` is false. */
  config: Record<string, unknown>;
  errors: ValidateEnvError[];
}

/**
 * Fold every plugin's `configSchema` into a single Zod object via
 * `.extend()`. The returned `pluginOwnership` map records which plugin
 * contributed each top-level field so {@link validateEnv} can attribute
 * Zod issues by plugin.
 *
 * Conflict policy: later wins. When two plugins declare the same field,
 * the later definition replaces the earlier one and a warning is emitted
 * via the supplied logger naming both plugins.
 */
export function composeEnvSchema(
  plugins: OraclePlugin[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  baseSchema?: z.ZodObject<any>,
  logger: Logger = NOOP_LOGGER,
): ComposeEnvSchemaResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let merged: z.ZodObject<any> = baseSchema ?? z.object({});
  const pluginOwnership = new Map<string, string>();

  if (baseSchema) {
    for (const key of Object.keys(baseSchema.shape)) {
      pluginOwnership.set(key, 'core');
    }
  }

  for (const plugin of plugins) {
    if (!plugin.configSchema) continue;
    const shape = plugin.configSchema.shape as Record<string, unknown>;
    for (const key of Object.keys(shape)) {
      const previous = pluginOwnership.get(key);
      if (previous !== undefined && previous !== plugin.name) {
        logger.warn(
          `[boot] env key '${key}' is defined by both '${previous}' and '${plugin.name}'; '${plugin.name}' wins.`,
        );
      }
      pluginOwnership.set(key, plugin.name);
    }
    merged = merged.extend(shape);
  }

  return { schema: merged, pluginOwnership };
}

/**
 * Validate `env` against the merged schema and produce structured errors
 * naming the owning plugin per failing field.
 *
 * `env` is the Worker's `env` bindings object (or any plain record) — this
 * module never reads `process.env`. On success, `config` holds the parsed
 * object (with any Zod coercions/defaults applied). On failure, `config` is
 * empty and every Zod issue is mapped through `pluginOwnership` to find the
 * owner.
 */
export function validateEnv(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodObject<any>,
  env: Record<string, unknown>,
  pluginOwnership: Map<string, string>,
): ValidateEnvResult {
  const result = schema.safeParse(env);
  if (result.success) {
    return {
      valid: true,
      config: result.data,
      errors: [],
    };
  }

  const errors: ValidateEnvError[] = result.error.issues.map((issue) => {
    const topField = issue.path.length > 0 ? String(issue.path[0]) : '<root>';
    const fullField = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    const plugin = pluginOwnership.get(topField) ?? 'unknown';
    return { plugin, field: fullField, message: issue.message };
  });

  return { valid: false, config: {}, errors };
}
