import { describe, expect, it } from 'vitest';
import { baseEnvSchema } from './base-env-schema.js';

describe('baseEnvSchema', () => {
  const requiredTier0Vars = {
    ORACLE_NAME: 'TestOracle',
    NETWORK: 'devnet',
    MATRIX_BASE_URL: 'https://mx.example',
    MATRIX_RECOVERY_PHRASE: 'word '.repeat(12).trim(),
    MATRIX_ORACLE_ADMIN_USER_ID: '@did-ixo-ixo1abc:mx.example',
    MATRIX_ORACLE_ADMIN_PASSWORD: 'pw',
    MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: 'tok',
    MATRIX_ACCOUNT_ROOM_ID: '!room:mx.example',
    MATRIX_VALUE_PIN: '1234',
    SQLITE_DATABASE_PATH: './data',
    BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.example/graphql',
    ORACLE_ENTITY_DID: 'did:ixo:entity',
    SECP_MNEMONIC: 'word '.repeat(12).trim(),
    RPC_URL: 'https://rpc.example',
  };

  it('parses a minimal valid Tier-0 env', () => {
    const parsed = baseEnvSchema.safeParse(requiredTier0Vars);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ORACLE_NAME).toBe('TestOracle');
    expect(parsed.data.NETWORK).toBe('devnet');
    // Defaults applied
    expect(parsed.data.NODE_ENV).toBe('development');
    expect(parsed.data.PORT).toBe(3000);
    expect(parsed.data.CORS_ORIGIN).toBe('*');
    expect(parsed.data.LLM_PROVIDER).toBe('openrouter');
    expect(parsed.data.MATRIX_STORE_PATH).toBe('./matrix-storage');
    expect(parsed.data.ORACLE_SECRETS).toBe('');
    expect(parsed.data.LIVE_AGENT_AUTH_API_KEY).toBe('');
  });

  it('rejects when a required Tier-0 var is missing', () => {
    const { ORACLE_NAME: _omit, ...withoutOracleName } = requiredTier0Vars;
    const parsed = baseEnvSchema.safeParse(withoutOracleName);
    expect(parsed.success).toBe(false);
  });

  it('coerces PORT from string', () => {
    const parsed = baseEnvSchema.safeParse({
      ...requiredTier0Vars,
      PORT: '4321',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.PORT).toBe(4321);
  });

  // Plugin-owned env vars must NOT be declared in the Tier-0 base schema —
  // each plugin contributes them via its own configSchema.
  const pluginOwnedKeys = [
    'COMPOSIO_API_KEY',
    'COMPOSIO_BASE_URL',
    'SLACK_BOT_OAUTH_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_USE_SOCKET_MODE',
    'SLACK_MAX_RECONNECT_ATTEMPTS',
    'SLACK_RECONNECT_DELAY_MS',
    'MEMORY_MCP_URL',
    'MEMORY_ENGINE_URL',
    'FIRECRAWL_MCP_URL',
    'DOMAIN_INDEXER_URL',
    'SANDBOX_MCP_URL',
    'SKIP_LOGGING_CHAT_HISTORY_TO_MATRIX',
    'SKILLS_CAPSULES_BASE_URL',
    'DISABLE_CREDITS',
    'SUBSCRIPTION_URL',
    'SUBSCRIPTION_ORACLE_MCP_URL',
    'REDIS_URL',
    'BLOCKSYNC_URI',
  ];

  it.each(pluginOwnedKeys)(
    'does not declare plugin-owned key %s in the base schema',
    (key) => {
      expect(Object.keys(baseEnvSchema.shape)).not.toContain(key);
    },
  );

  it('exposes exactly the Tier-0 keys', () => {
    const expected = new Set([
      'NODE_ENV',
      'PORT',
      'ORACLE_NAME',
      'CORS_ORIGIN',
      'NETWORK',
      'MATRIX_BASE_URL',
      'MATRIX_RECOVERY_PHRASE',
      'MATRIX_STORE_PATH',
      'MATRIX_ORACLE_ADMIN_USER_ID',
      'MATRIX_ORACLE_ADMIN_PASSWORD',
      'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
      'MATRIX_ACCOUNT_ROOM_ID',
      'MATRIX_VALUE_PIN',
      'SQLITE_DATABASE_PATH',
      'BLOCKSYNC_GRAPHQL_URL',
      'ORACLE_ENTITY_DID',
      'ORACLE_SECRETS',
      'SECP_MNEMONIC',
      'RPC_URL',
      'LLM_PROVIDER',
      'OPENAI_API_KEY',
      'OPEN_ROUTER_API_KEY',
      'NEBIUS_API_KEY',
      'LIVE_AGENT_AUTH_API_KEY',
      'LANGSMITH_TRACING',
      'LANGSMITH_API_KEY',
      'LANGSMITH_PROJECT',
      'LANGSMITH_ENDPOINT',
    ]);
    expect(new Set(Object.keys(baseEnvSchema.shape))).toEqual(expected);
  });
});
