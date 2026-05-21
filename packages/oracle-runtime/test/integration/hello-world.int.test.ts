/**
 * Phase 0 hello-world for the integration harness.
 *
 * Proves the four foundation pieces:
 *   1. The vitest `--mode int` config picks up `*.int.test.ts` files.
 *   2. `setup.ts` loads `.env` + `.env.integration` from `apps/qiforge-example/`.
 *   3. `mintUserDelegation()` produces a parseable UCAN token.
 *   4. `createIntegrationOracle()` boots the real Nest stack on an ephemeral
 *      port, serves `/health`, and tears down cleanly. Matrix init runs in
 *      the background — we DO NOT wait for `matrix:loaded` here; later
 *      phases will gate on that event. We just verify the HTTP layer comes
 *      up and shutdown is clean.
 *
 * No skip flags, no mocks. Missing env fails the file at load time, loud and
 * obvious — never silently passed.
 */
import { test, expect } from 'vitest';
import { parseDelegation } from '@ixo/ucan';
import {
  mintUserDelegation,
  allCaps,
  createIntegrationOracle,
} from '@ixo/oracle-runtime/testing/integration';

const REQUIRED_ENV = [
  'TEST_USER_MNEMONIC',
  'ORACLE_DID',
  'ORACLE_ENTITY_DID',
  'MATRIX_BASE_URL',
] as const;
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `hello-world.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missing.join(', ')}`,
  );
}

test('mintUserDelegation produces a parseable token', async () => {
  const token = await mintUserDelegation({
    userMnemonic: process.env.TEST_USER_MNEMONIC!,
    oracleDid: process.env.ORACLE_DID!,
    capabilities: allCaps,
  });
  expect(token).toBeTypeOf('string');
  expect(token.length).toBeGreaterThan(20);

  const parsed = await parseDelegation(token);
  expect(parsed).toBeDefined();
});

test('createIntegrationOracle boots real oracle, serves /health, closes', async () => {
  const oracle = await createIntegrationOracle({
    plugins: [],
    bundledPlugins: [],
  });
  try {
    const res = await fetch(`${oracle.baseUrl}/health`);
    expect(res.status).toBe(200);
  } finally {
    await oracle.close();
  }
});
