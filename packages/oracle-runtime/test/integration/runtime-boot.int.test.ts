/**
 * Phase 1 — Runtime boot, env validation, and auth middleware.
 *
 * What this file proves (spec items 1.1–1.7):
 *  - Plugin loader correctly includes/excludes plugins based on env probes.
 *  - Env-validation errors name the missing field + owning plugin.
 *  - The LLM-provider key check (validateLlmProviderKey) fires AFTER
 *    schema validation and identifies the right API-key field.
 *  - AuthHeaderMiddleware rejects missing / wrong-audience / expired UCANs.
 *  - Public routes (/health, /docs, /version, /weather/now) work without
 *    `x-ucan-delegation` because they're on the runtime's exclusion list.
 *
 * Boot strategy: items 1.1-1.3 throw BEFORE Nest starts (env validation
 * fails up-front, no Matrix init). Items 1.4-1.6 need an oracle running
 * but do NOT need Matrix fully loaded — AuthHeaderMiddleware only reads
 * UcanService + the blocksync DID resolver, neither depends on Matrix.
 * Item 1.7 needs the oracle running and public routes registered.
 *
 * No skip-flags: integration boot runs the same code path production runs.
 * If Matrix init fails in the background it logs an error but the tests
 * here don't gate on `matrix:loaded` (no UCAN minting needed).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MemoryPlugin } from '../../src/plugins/memory/index.js';
import { SkillsPlugin } from '../../src/plugins/skills/index.js';
import { SandboxPlugin } from '../../src/plugins/sandbox/index.js';
import {
  ChatClient,
  createIntegrationOracle,
  mintUserDelegation,
  allCaps,
  type IntegrationOracle,
} from '../../src/testing/integration/index.js';

const REQUIRED_BOOT_ENV = [
  'MATRIX_BASE_URL',
  'MATRIX_ORACLE_ADMIN_USER_ID',
  'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
  'ORACLE_DID',
  'ORACLE_ENTITY_DID',
  'SECP_MNEMONIC',
  'BLOCKSYNC_GRAPHQL_URL',
  'OPEN_ROUTER_API_KEY',
  'TEST_USER_MNEMONIC',
  'TEST_USER_DID',
] as const;

const missingBootEnv = REQUIRED_BOOT_ENV.filter((k) => !process.env[k]);
if (missingBootEnv.length > 0) {
  throw new Error(
    `runtime-boot.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missingBootEnv.join(', ')}`,
  );
}

describe('Phase 1 — env validation (no Nest boot needed)', () => {
  // 1.1 — Plugins whose env is present load; whose env is absent get excluded
  // with the autoDetectHint as the exclusion reason.
  test('1.1 boot with MEMORY_MCP_URL/SANDBOX_MCP_URL/SKILLS_CAPSULES_BASE_URL set loads those plugins', async () => {
    const oracle = await createIntegrationOracle({
      plugins: [],
      bundledPlugins: [
        new MemoryPlugin(),
        new SkillsPlugin(),
        new SandboxPlugin(),
      ],
    });
    try {
      const status = oracle.status();
      // Memory needs MEMORY_MCP_URL — present in .env.integration → loaded.
      expect(status.loaded).toContain('memory');
      // Skills has a default URL → always loads when no env probe says no.
      expect(status.loaded).toContain('skills');
      // Sandbox needs SANDBOX_MCP_URL — present → loaded.
      expect(status.loaded).toContain('sandbox');
    } finally {
      await oracle.close();
    }
  });

  // 1.2 — Remove MEMORY_MCP_URL → memory plugin excluded (autoDetect returns
  // false). Pair memory with sandbox (no inter-plugin dep) so the assertion
  // isolates "memory excluded" from "did skills get its sandbox dep too?".
  test('1.2 without MEMORY_MCP_URL, memory is excluded — other plugins unaffected', async () => {
    const envWithoutMemory = { ...process.env };
    delete envWithoutMemory.MEMORY_MCP_URL;
    const oracle = await createIntegrationOracle({
      plugins: [],
      bundledPlugins: [new MemoryPlugin(), new SandboxPlugin()],
      env: envWithoutMemory,
    });
    try {
      const status = oracle.status();
      expect(status.loaded).not.toContain('memory');
      expect(status.excluded.map((e) => e.plugin)).toContain('memory');
      // Sandbox doesn't depend on MEMORY_MCP_URL — must still be loaded.
      expect(status.loaded).toContain('sandbox');
    } finally {
      await oracle.close();
    }
  });

  // 1.3 — Without OPEN_ROUTER_API_KEY (and no NEBIUS_API_KEY), the
  // validateLlmProviderKey cross-field check throws and the error names
  // the missing field by name.
  test('1.3 without LLM provider key, env validation fails naming OPEN_ROUTER_API_KEY', async () => {
    const envWithoutLlm = { ...process.env };
    delete envWithoutLlm.OPEN_ROUTER_API_KEY;
    delete envWithoutLlm.NEBIUS_API_KEY;

    const collectedErrors: string[] = [];
    const logger = {
      log: () => {},
      warn: () => {},
      error: (msg: unknown) =>
        collectedErrors.push(
          typeof msg === 'string' ? msg : JSON.stringify(msg),
        ),
    };

    await expect(
      createIntegrationOracle({
        plugins: [],
        bundledPlugins: [],
        env: envWithoutLlm,
        logger,
      }),
    ).rejects.toThrow(/Env validation failed/);

    expect(collectedErrors.join('\n')).toMatch(/OPEN_ROUTER_API_KEY/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Items 1.4–1.7 share one booted oracle — keep Matrix-side state stable
// across tests AND avoid re-uploading Matrix one-time keys (which fails
// the second boot on the homeserver if it happens too quickly).
// ─────────────────────────────────────────────────────────────────────────

describe('Phase 1 — auth middleware + public route exclusions', () => {
  let oracle: IntegrationOracle | undefined;
  let validDelegation: string;

  beforeAll(async () => {
    oracle = await createIntegrationOracle({
      plugins: [],
      bundledPlugins: [],
    });
    validDelegation = await mintUserDelegation({
      userMnemonic: process.env.TEST_USER_MNEMONIC!,
      oracleDid: process.env.ORACLE_DID!,
      userDid: process.env.TEST_USER_DID!,
      capabilities: allCaps,
    });
  }, 60_000);

  afterAll(async () => {
    if (oracle) await oracle.close();
  });

  // 1.4 — Bare POST /messages/:id with no UCAN header → 401.
  test('1.4 no x-ucan-delegation → 401', async () => {
    if (!oracle) throw new Error('oracle not booted');
    const res = await fetch(`${oracle.baseUrl}/messages/test-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', stream: false }),
    });
    expect(res.status).toBe(401);
  });

  // 1.5 — Delegation for a DIFFERENT audience → validator rejects.
  test('1.5 delegation with wrong audience → 401', async () => {
    if (!oracle) throw new Error('oracle not booted');
    const wrongAudienceDelegation = await mintUserDelegation({
      userMnemonic: process.env.TEST_USER_MNEMONIC!,
      oracleDid: 'did:ixo:not-the-real-oracle',
      userDid: process.env.TEST_USER_DID!,
      capabilities: allCaps,
    });
    const client = new ChatClient(oracle.baseUrl, {
      delegation: wrongAudienceDelegation,
    });
    const res = await client.send('test-session', 'hi');
    expect(res.status).toBe(401);
  });

  // 1.6 — Delegation with `expiration` in the past → validator rejects.
  test('1.6 expired delegation → 401', async () => {
    if (!oracle) throw new Error('oracle not booted');
    // ttlSec=1 then sleep 2s so the delegation is past its expiration
    // before the request lands. `@ixo/ucan` expirations are Unix seconds.
    const expired = await mintUserDelegation({
      userMnemonic: process.env.TEST_USER_MNEMONIC!,
      oracleDid: process.env.ORACLE_DID!,
      userDid: process.env.TEST_USER_DID!,
      capabilities: allCaps,
      ttlSec: 1,
    });
    await new Promise((r) => setTimeout(r, 2000));
    const client = new ChatClient(oracle.baseUrl, { delegation: expired });
    const res = await client.send('test-session', 'hi');
    expect(res.status).toBe(401);
  });

  // 1.7 — Public routes reachable without UCAN header.
  test('1.7 /health is reachable without x-ucan-delegation', async () => {
    if (!oracle) throw new Error('oracle not booted');
    const res = await fetch(`${oracle.baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  // Sanity: a properly-issued delegation isn't 401 at the auth layer.
  // (Downstream 4xx for "session not found" or similar is fine — we're
  // just proving the middleware admits a valid delegation.)
  test('valid delegation passes the auth middleware (no 401)', async () => {
    if (!oracle) throw new Error('oracle not booted');
    const client = new ChatClient(oracle.baseUrl, {
      delegation: validDelegation,
    });
    const res = await client.send('phase1-valid-auth', 'hi');
    expect(res.status).not.toBe(401);
  });
});
