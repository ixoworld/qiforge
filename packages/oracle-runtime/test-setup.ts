/**
 * Vitest setup — populates env vars consumed by `@ixo/matrix` and
 * `@ixo/oracles-chain-client`'s top-level `getInstance()` calls. The values
 * are placeholders; nothing in unit tests actually hits Matrix or the chain.
 */
import 'reflect-metadata';

const envFallbacks: Record<string, string> = {
  MATRIX_BASE_URL: 'https://matrix.test.local',
  MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: 'test-admin-token',
  MATRIX_ORACLE_ADMIN_USER_ID: '@oracle:matrix.test.local',
  MATRIX_ORACLE_ADMIN_PASSWORD: 'test-admin-password',
  MATRIX_RECOVERY_PHRASE: 'test test test test',
  MATRIX_STORE_PATH: '/tmp/test-matrix-storage',
  MATRIX_SECRET_STORAGE_KEYS_PATH: '/tmp/test-matrix-secret-keys',
  MATRIX_VALUE_PIN: '0000',
  MATRIX_ACCOUNT_ROOM_ID: '!test:matrix.test.local',
  RPC_URL: 'https://rpc.test.local',
  SECP_MNEMONIC:
    'test test test test test test test test test test test junk',
  NETWORK: 'testnet',
  BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.test.local/graphql',
  ORACLE_NAME: 'TestOracle',
  ORACLE_DID: 'did:ixo:test',
  ORACLE_ENTITY_DID: 'did:ixo:entity:test',
  SQLITE_DATABASE_PATH: '/tmp/test-sqlite.db',
  MEMORY_ENGINE_URL: 'https://memory.test.local',
  MEMORY_MCP_URL: 'https://memory-mcp.test.local',
  FIRECRAWL_MCP_URL: 'https://firecrawl-mcp.test.local',
  DOMAIN_INDEXER_URL: 'https://domain-indexer.test.local',
  SANDBOX_MCP_URL: 'https://sandbox.test.local/mcp',
};

for (const [key, value] of Object.entries(envFallbacks)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
