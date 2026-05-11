/**
 * Eval test setup — runs inside each worker process before test files are
 * loaded.  Sets the minimum env vars required to satisfy module-level
 * getOrThrow() calls in main-agent.ts and user-matrix-sqlite-sync-service.ts
 * without triggering real network connections.
 *
 * Real-infrastructure values (LLM keys, real Matrix URLs) are read from the
 * actual process.env so developers can override with a .env.eval file.
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EVAL_SQLITE_DIR = path.join(tmpdir(), 'qiforge-eval-tests');

// Create the SQLite temp directory so the service doesn't throw on mkdir checks
mkdirSync(path.join(EVAL_SQLITE_DIR, 'user_dbs'), { recursive: true });

const stubs: Record<string, string> = {
  MATRIX_BASE_URL: 'https://stub.matrix.eval',
  MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: 'stub_eval_access_token',
  MATRIX_ORACLE_ADMIN_USER_ID: '@oracle-stub:stub.matrix.eval',
  MATRIX_ORACLE_ADMIN_PASSWORD: 'stub_eval_password',
  MATRIX_RECOVERY_PHRASE:
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  MATRIX_VALUE_PIN: 'stub-eval-pin',
  MATRIX_ACCOUNT_ROOM_ID: '!stubroom:stub.matrix.eval',
  ORACLE_NAME: 'Eval Oracle',
  ORACLE_ENTITY_DID: 'did:ixo:evaloracle123',
  NETWORK: 'devnet',
  BLOCKSYNC_GRAPHQL_URL: 'https://stub.blocksync.eval/graphql',
  SQLITE_DATABASE_PATH: EVAL_SQLITE_DIR,
  MEMORY_MCP_URL: 'https://stub.memory.eval/mcp',
  MEMORY_ENGINE_URL: 'https://stub.memory.eval',
  FIRECRAWL_MCP_URL: 'https://stub.firecrawl.eval/mcp',
  DOMAIN_INDEXER_URL: 'https://stub.domain.eval',
  SANDBOX_MCP_URL: 'https://stub.sandbox.eval/mcp',
  SECP_MNEMONIC:
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  RPC_URL: 'https://stub.rpc.eval',
  LLM_PROVIDER: 'openrouter',
};

for (const [key, value] of Object.entries(stubs)) {
  // Don't overwrite real values — lets developers use their own .env.eval
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
