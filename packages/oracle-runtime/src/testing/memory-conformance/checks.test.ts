/**
 * Verifies the conformance suite itself.
 *
 * Two properties matter, and neither is implied by the other:
 *
 *   1. **Sound** — a conformant engine passes every check. Otherwise the suite
 *      rejects good implementations and nobody will adopt it.
 *   2. **Discriminating** — for each rule, an engine that breaks *only* that
 *      rule fails *that* check. Otherwise the suite is decorative: it would
 *      report "conformant" for an engine that leaks memory across users.
 *
 * Property 2 is the one that matters for the sovereignty guarantee, and it is
 * why `ReferenceMemoryEngine` takes a `defects` bag.
 */
import { describe, expect, it } from 'vitest';
import { runConformance } from './checks.js';
import {
  ReferenceMemoryEngine,
  expiredReferenceInvocation,
  referenceInvocation,
  type ReferenceEngineDefects,
} from './reference-engine.js';
import type { ConformanceContext, ConformanceReport } from './types.js';

const USER_A = 'did:ixo:userA';
const USER_B = 'did:ixo:userB';

function makeContext(runToken = 'test-run'): ConformanceContext {
  return {
    userA: {
      invocation: referenceInvocation(USER_A),
      roomId: '!roomA:ixo.earth',
    },
    userB: {
      invocation: referenceInvocation(USER_B),
      roomId: '!roomB:ixo.earth',
    },
    expiredInvocation: expiredReferenceInvocation(USER_A),
    oracleDids: ['did:ixo:entity:oracle'],
    runToken,
  };
}

async function run(
  defects: ReferenceEngineDefects = {},
): Promise<ConformanceReport> {
  return runConformance(new ReferenceMemoryEngine(defects), makeContext());
}

/** Ids of every check that did not pass. */
function failedIds(report: ConformanceReport): string[] {
  return report.results.filter((r) => r.status === 'fail').map((r) => r.id);
}

describe('memory-engine conformance suite', () => {
  describe('soundness — a conformant engine passes', () => {
    it('reports full conformance for the reference engine', async () => {
      const report = await run();

      expect(failedIds(report)).toEqual([]);
      expect(report.coreConformant).toBe(true);
      expect(report.fullConformant).toBe(true);
      expect(report.skipped).toBe(0);
    });

    it('runs every check exactly once', async () => {
      const report = await run();
      const ids = report.results.map((r) => r.id);

      expect(ids).toHaveLength(17);
      expect(new Set(ids).size).toBe(17);
    });
  });

  describe('discrimination — one broken rule fails its own check', () => {
    // Each case breaks exactly one contract rule and names the check that must
    // catch it. `expected` is asserted as the ONLY Core failure, so a check
    // that fails for an unrelated reason does not count as catching it.
    const cases: Array<{
      rule: string;
      defects: ReferenceEngineDefects;
      expected: string;
    }> = [
      {
        rule: '§3.1 rejects unauthenticated requests',
        defects: { allowUnauthenticated: true },
        expected: 'MEC-04',
      },
      {
        rule: '§3.1 rejects expired invocations',
        defects: { ignoreExpiry: true },
        expected: 'MEC-05',
      },
      {
        rule: '§3.3 requires x-room-id',
        defects: { ignoreRoomId: true },
        expected: 'MEC-07',
      },
      {
        rule: '§5.6 confirmation interlock',
        defects: { ignoreConfirmation: true },
        expected: 'MEC-11',
      },
      {
        rule: '§4 user space is not visible at oracle scope',
        defects: { leakUserSpaceToOracleScope: true },
        expected: 'MEC-12',
      },
      {
        rule: '§4 cross-user isolation',
        defects: { partitionByRoomOnly: true },
        expected: 'MEC-13',
      },
      {
        rule: '§5 all six tools present',
        defects: { omitTool: 'delete_edge' },
        expected: 'MEC-02',
      },
      {
        rule: '§6.1 batch arity',
        defects: { truncateBatch: true },
        expected: 'MEC-15',
      },
      {
        rule: '§6.1 partial batch failure',
        defects: { failWholeBatch: true },
        expected: 'MEC-16',
      },
    ];

    it.each(cases)(
      'catches a violation of $rule',
      async ({ defects, expected }) => {
        const report = await run(defects);
        const failed = failedIds(report);

        expect(failed).toContain(expected);
        expect(report.fullConformant).toBe(false);
      },
    );

    it('flags cross-user leakage as a Core failure, not a warning', async () => {
      const report = await run({ partitionByRoomOnly: true });
      const isolation = report.results.find((r) => r.id === 'MEC-13');

      expect(isolation?.status).toBe('fail');
      expect(isolation?.level).toBe('core');
      expect(isolation?.detail).toMatch(/leakage|partition/i);
      expect(report.coreConformant).toBe(false);
    });
  });

  describe('unverified isolation is never silently a pass', () => {
    it('skips MEC-13 without a second identity and blocks full conformance', async () => {
      const ctx = makeContext();
      delete ctx.userB;

      const report = await runConformance(new ReferenceMemoryEngine(), ctx);
      const isolation = report.results.find((r) => r.id === 'MEC-13');

      expect(isolation?.status).toBe('skip');
      expect(isolation?.detail).toMatch(/UNVERIFIED/);
      // A skip must not read as conformance for the level that requires it.
      expect(report.fullConformant).toBe(false);
    });
  });

  describe('report rendering', () => {
    it('marks Core conformance independently of Full', async () => {
      // Truncated batch is a Full-level violation only — Core must survive it.
      const report = await run({ truncateBatch: true });

      expect(report.coreConformant).toBe(true);
      expect(report.fullConformant).toBe(false);
    });

    it('records a spec section for every check', async () => {
      const report = await run();

      for (const result of report.results) {
        expect(result.section).toMatch(/^§/);
        expect(result.detail.length).toBeGreaterThan(0);
      }
    });
  });
});
