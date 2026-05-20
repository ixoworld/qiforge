/**
 * Vitest setup — populates env vars consumed by `@ixo/matrix` and
 * `@ixo/oracles-chain-client`'s top-level `getInstance()` calls. The values
 * are placeholders; nothing in unit tests actually hits Matrix or the chain.
 *
 * `dotenv/config` loads `.env` if present (used locally), and the explicit
 * defaults below cover the case where no `.env` exists (CI, fresh clone) so
 * the module-load side effects in `@ixo/matrix` / `oracles-chain-client`
 * never throw inside unit tests.
 */
import 'reflect-metadata';
import 'dotenv/config';

process.env.MATRIX_BASE_URL ??= 'https://matrix.test';
process.env.MATRIX_ORACLE_ADMIN_USER_ID ??= '@oracle-test:matrix.test';
process.env.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN ??= 'test-access-token';
process.env.RPC_URL ??= 'https://rpc.test';
process.env.SECP_MNEMONIC ??=
  'test test test test test test test test test test test junk';
process.env.BLOCKSYNC_GRAPHQL_URL ??= 'https://blocksync.test/graphql';
process.env.NEXT_PUBLIC_GRAPHQL_URL ??= 'https://blocksync.test/graphql';
process.env.SQLITE_DATABASE_PATH ??= './tmp/test.sqlite';