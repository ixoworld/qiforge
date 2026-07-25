/**
 * Memory Engine Contract v1 — conformance run against a LIVE engine.
 *
 * This is the test that answers "is the deployed engine actually conformant?".
 * It hits real MCP + REST endpoints with real UCAN invocations.
 *
 *   cd packages/oracle-runtime
 *   pnpm test:integration -- memory-conformance
 *
 * Required in `.env.integration`:
 *   MEMORY_MCP_URL          MCP endpoint
 *   MEMORY_SERVICE_DID      the engine's own DID (invocation audience)
 *   TEST_USER_MNEMONIC      identity A
 *   TEST_ROOM_ID            identity A's room
 *
 * Optional but strongly recommended:
 *   MEMORY_ENGINE_URL       REST base — without it, Full-level checks skip
 *   TEST_USER_B_MNEMONIC    identity B — without it MEC-13 (isolation) SKIPS,
 *   TEST_USER_B_ROOM_ID     and unverified isolation is a red flag, not a pass
 *   TEST_USER_DID / TEST_USER_B_DID   explicit DIDs for on-chain identities
 *   ORACLE_ENTITY_DID       oracle DID for REST batch queries
 *
 * Missing required env THROWS rather than skipping — a skipped conformance run
 * is indistinguishable from a passing one in CI, which defeats the point.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { formatReport, runConformance } from './checks.js';
import { HttpMemoryEngineProbe } from './http-probe.js';
import { mintMemoryInvocation } from './mint-invocation.js';
import type { ConformanceContext, ConformanceReport } from './types.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[memory-conformance] ${name} is required. Set it in ` +
        `packages/oracle-runtime/.env.integration. This suite throws rather ` +
        `than skipping: an unrun conformance check must never look like a pass.`,
    );
  }
  return value;
}

describe('Memory Engine Contract v1 — live conformance', () => {
  let report: ConformanceReport;

  beforeAll(async () => {
    const mcpUrl = required('MEMORY_MCP_URL');
    const memoryServiceDid = required('MEMORY_SERVICE_DID');
    const userMnemonic = required('TEST_USER_MNEMONIC');
    const roomId = required('TEST_ROOM_ID');

    const probe = new HttpMemoryEngineProbe({
      mcpUrl,
      restUrl: process.env.MEMORY_ENGINE_URL,
    });

    const invocationA = await mintMemoryInvocation({
      userMnemonic,
      memoryServiceDid,
      userDid: process.env.TEST_USER_DID,
    });

    // Negative TTL ⇒ already expired. Exercises MEC-05 without waiting.
    const expiredInvocation = await mintMemoryInvocation({
      userMnemonic,
      memoryServiceDid,
      userDid: process.env.TEST_USER_DID,
      ttlSec: -600,
    });

    const mnemonicB = process.env.TEST_USER_B_MNEMONIC;
    const roomB = process.env.TEST_USER_B_ROOM_ID;
    const userB =
      mnemonicB && roomB
        ? {
            invocation: await mintMemoryInvocation({
              userMnemonic: mnemonicB,
              memoryServiceDid,
              userDid: process.env.TEST_USER_B_DID,
            }),
            roomId: roomB,
          }
        : undefined;

    const ctx: ConformanceContext = {
      userA: { invocation: invocationA, roomId },
      userB,
      expiredInvocation,
      oracleDids: [process.env.ORACLE_ENTITY_DID ?? 'did:ixo:entity:unknown'],
      // Unique per run so a retrieval check can never pass on a record left
      // behind by an earlier run.
      runToken: `conf-${Date.now().toString(36)}`,
    };

    report = await runConformance(probe, ctx);

    // Always print: a conformance run's value is the per-check evidence, not
    // the boolean. Reviewers need to see which rule failed and why.
    console.log(`\n${formatReport(report)}\n`);
  });

  it('passes every Core check', () => {
    const coreFailures = report.results.filter(
      (r) => r.level === 'core' && r.status === 'fail',
    );
    expect(
      coreFailures.map((r) => `${r.id} ${r.title}: ${r.detail}`),
      'Core conformance failures',
    ).toEqual([]);
    expect(report.coreConformant).toBe(true);
  });

  it('enforces cross-user isolation', () => {
    const isolation = report.results.find((r) => r.id === 'MEC-13');
    expect(isolation).toBeDefined();

    // A skip here means the run had no second identity — the sovereignty
    // guarantee is then simply unverified, and this test says so out loud
    // rather than letting a green run imply isolation was checked.
    expect(
      isolation?.status,
      'MEC-13 was not verified — set TEST_USER_B_MNEMONIC and TEST_USER_B_ROOM_ID. ' +
        'Cross-user isolation is the one check whose absence invalidates the run.',
    ).not.toBe('skip');
    expect(isolation?.status).toBe('pass');
  });

  it('passes every Full check when a REST URL is configured', () => {
    if (!process.env.MEMORY_ENGINE_URL) {
      // Core-only engines are legitimate (§1.1). Nothing to assert.
      expect(
        report.results
          .filter((r) => r.level === 'full')
          .every((r) => r.status === 'skip'),
      ).toBe(true);
      return;
    }
    const fullFailures = report.results.filter(
      (r) => r.level === 'full' && r.status === 'fail',
    );
    expect(
      fullFailures.map((r) => `${r.id} ${r.title}: ${r.detail}`),
      'Full conformance failures',
    ).toEqual([]);
  });
});
