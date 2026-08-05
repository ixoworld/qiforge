/**
 * @fileoverview Runs the reference oracle's shipped constitution through the
 * real evaluator.
 *
 * This document is the one forks copy. Everything it permits, a fork inherits
 * on day one, and everything it silently stopped refusing would be inherited
 * just as quietly. Linting proves it parses; this proves what it *means*.
 *
 * The two newer example apps have had this from the start, and it is how three
 * bugs in their documents were caught — a grant killed by an override, a
 * ceiling shadowing a deny, and a payment that turned out to escalate rather
 * than permit. The reference oracle had only a lint, which is the weaker half.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// The `/constitution` entrypoint rather than the barrel: this is pure
// evaluation, and the barrel drags in Matrix and Nest — an environment a test
// about a document has no business needing.
import {
  authorize,
  fixedClock,
  hasBlockingFindings,
  lintDomainMdSubset,
  loadDomainMd,
  parseDomainMdSubset,
  REASON,
  type AuthorizationRequest,
  type AuthorizeDeps,
  type ConstitutionPolicy,
} from '@ixo/oracle-runtime/constitution';
import { beforeAll, describe, expect, it } from 'vitest';

const DOMAIN_MD = fileURLToPath(new URL('../domain.md', import.meta.url));

/** The oracle's own identifier. A draft `urn:uuid`, since nothing is anchored. */
const ORACLE = 'urn:uuid:6f1d0d5a-4a1e-4f2b-9c7a-2f9a5b3c1d40';

const deps: AuthorizeDeps = { time: fixedClock('2026-08-03T09:00:00.000Z') };

let policy: ConstitutionPolicy;

beforeAll(async () => {
  const result = await loadDomainMd({
    source: DOMAIN_MD,
    bytes: readFileSync(DOMAIN_MD, 'utf8'),
    // The document ships as an `authoring_draft` — it is a template, not a
    // deployment. Strict would refuse it, correctly, and that is asserted
    // below rather than worked around here.
    enforcement: 'permissive',
  });
  if (!result.context) {
    throw new Error(
      `The reference oracle's constitution does not load: ${result.errors
        .map((e) => e.message)
        .join('; ')}`,
    );
  }
  policy = result.context.policy;
});

function request(
  overrides: Partial<AuthorizationRequest>,
): AuthorizationRequest {
  return {
    principal: { did: ORACLE, sessionId: 'session-1' },
    action: 'read',
    operation: 'read_context',
    object: 'ixo:oracle',
    ...overrides,
  };
}

describe('the document is well formed', () => {
  it('parses and lints without a blocking finding', () => {
    const findings = lintDomainMdSubset(
      parseDomainMdSubset(readFileSync(DOMAIN_MD, 'utf8')),
    );
    const blocking = findings.filter((f) => f.severity === 'error');
    expect(blocking).toEqual([]);
    expect(hasBlockingFindings(findings)).toBe(false);
  });

  // The bug that shipped here once: both grants named an invented DID the
  // constitution's own subject could never equal, so neither could match.
  it('names a subject its own grants can match', () => {
    expect(policy.subject).toBe(ORACLE);
    const selfGrants = policy.grants.filter(
      (g) => g.subject === policy.subject,
    );
    expect(selfGrants.length).toBe(policy.grants.length);
  });

  // A draft is not a deployment. Strict enforcement must say so rather than
  // let a template out of the door as if it were anchored.
  it('is refused by strict enforcement, because nothing anchors it', async () => {
    const result = await loadDomainMd({
      source: DOMAIN_MD,
      bytes: readFileSync(DOMAIN_MD, 'utf8'),
      enforcement: 'strict',
    });
    expect(result.context).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('what it permits', () => {
  it('reads its own domain context without needing a grant', async () => {
    const decision = await authorize(request({}), policy, deps);
    expect(decision.outcome).toBe('permit');
  });

  it('proposes, which is what a bounded_evaluate ceiling is for', async () => {
    const decision = await authorize(
      request({ action: 'propose', operation: 'propose_change' }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('permit');
  });
});

/**
 * The workspace grant ships **inert**, and that is worth a test of its own.
 *
 * `write` needs `bounded_execute`; the template's ceiling is
 * `bounded_evaluate`. So the grant authorizes nothing as shipped — it is the
 * grant a fork will want once it raises the ceiling, pre-scoped to the
 * workspace. A fork author reading the rights list would otherwise reasonably
 * conclude this oracle can write, which it cannot.
 *
 * Both halves are asserted: that it is shadowed today, and that it is correctly
 * scoped for the day it is not. Without the second, someone could raise the
 * ceiling and inherit a grant nobody had checked the bounds of.
 */
describe('the workspace grant, shipped inert', () => {
  /** The same constitution with the ceiling a fork would raise it to. */
  const raised = (): ConstitutionPolicy => ({
    ...policy,
    modeCeiling: 'bounded_execute',
  });

  it('is shadowed by the ceiling as shipped', async () => {
    const decision = await authorize(
      request({
        action: 'write',
        operation: 'draft_note',
        object: 'ixo:oracle/workspace/notes.md',
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.modeCeiling);
  });

  it('takes effect once a fork raises the ceiling', async () => {
    const decision = await authorize(
      request({
        action: 'write',
        operation: 'draft_note',
        object: 'ixo:oracle/workspace/notes.md',
      }),
      raised(),
      deps,
    );
    expect(decision.outcome).toBe('permit');
    expect(decision.matchedGrantId).toBe(
      'right:oracle:author-working-documents',
    );
  });

  // Scoped by object. A write outside the workspace is not a narrower version
  // of the same permission — it is a different action with no grant behind it.
  it('still does not reach outside the workspace at the raised ceiling', async () => {
    const decision = await authorize(
      request({
        action: 'write',
        operation: 'draft_note',
        object: 'ixo:oracle/treasury/ledger',
      }),
      raised(),
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.noMatchingGrant);
  });
});

/**
 * The document's central promise, in its own words: *"Do not move value, issue
 * credentials, or change rights — no grant in this document authorizes it."*
 *
 * Prose in a constitution is not enforcement. These assert the machine layer
 * agrees, and each of the three is stopped twice over — by a disabled override
 * and by the absence of a grant — so removing either leaves the other.
 */
describe('what it refuses, as its prose promises', () => {
  it.each([
    ['moving value', 'pay' as const, 'release_payment', 'ixo:oracle/treasury'],
    [
      'issuing a credential',
      'issue' as const,
      'issue_credential',
      'ixo:oracle/credentials',
    ],
    [
      'changing its own rights',
      'govern' as const,
      'amend_rights',
      'ixo:oracle',
    ],
    ['minting', 'mint' as const, 'mint_token', 'ixo:oracle/treasury'],
    ['transferring', 'transfer' as const, 'transfer', 'ixo:oracle/treasury'],
  ])('refuses %s', async (_label, action, operation, object) => {
    const decision = await authorize(
      request({ action, operation, object }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('deny');
  });

  /**
   * Value movement is stopped three times over, and the layers are peeled off
   * one at a time here.
   *
   * The order the evaluator applies them means only the outermost shows up in
   * a real refusal, which makes the inner two easy to remove by accident: a
   * fork raises the ceiling, the tests still pass on the override, someone
   * later flips the override, and nothing is left. Each layer is asserted
   * alone so removing any one fails here rather than in production.
   */
  describe('and refuses it at every layer independently', () => {
    const payment = () =>
      request({
        action: 'pay',
        operation: 'release_payment',
        object: 'ixo:oracle/treasury',
      });

    it('on the ceiling, which is what actually fires as shipped', async () => {
      const decision = await authorize(payment(), policy, deps);
      expect(decision.reasonCodes).toContain(REASON.modeCeiling);
    });

    it('on the override, with the ceiling raised out of the way', async () => {
      const decision = await authorize(
        payment(),
        { ...policy, modeCeiling: 'bounded_execute' },
        deps,
      );
      expect(decision.outcome).toBe('deny');
      expect(decision.reasonCodes).toContain(REASON.overrideDisabled);
    });

    it('on the absence of any grant, with both lifted', async () => {
      const decision = await authorize(
        payment(),
        { ...policy, modeCeiling: 'bounded_execute', disabledOverrides: [] },
        deps,
      );
      expect(decision.outcome).toBe('deny');
      expect(decision.reasonCodes).toContain(REASON.noMatchingGrant);
    });
  });
});

describe('the ceiling', () => {
  // `bounded_evaluate` is the ceiling a fork starts from. Executing is above
  // it, so a fork that wants to act has to raise the ceiling deliberately —
  // which is the point of shipping the template at this level.
  it('stops at evaluation, so execution needs a deliberate change', async () => {
    const decision = await authorize(
      request({
        action: 'execute',
        operation: 'run_action',
        object: 'ixo:oracle/actions/deploy',
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.modeCeiling);
  });

  it('permits evaluation itself only with a grant', async () => {
    const decision = await authorize(
      request({
        action: 'evaluate',
        operation: 'evaluate_claim',
        object: 'ixo:collection:anything/claims',
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.noMatchingGrant);
  });
});

describe('what the model is told', () => {
  it('surfaces the prohibitions verbatim, not paraphrased', () => {
    const body = readFileSync(DOMAIN_MD, 'utf8');
    for (const prohibition of [
      'Do not move value, issue credentials, or change rights',
      'Do not approve a high-value claim from a model response alone',
      'Do not treat chat history, a model response, or private reasoning as canonical domain state',
    ]) {
      expect(body).toContain(prohibition);
    }
  });

  it('declares the review triggers a fork is most likely to need', () => {
    for (const trigger of [
      'payment_release',
      'credential_issuance',
      'irreversible_state_change',
      'controller_change',
    ]) {
      expect(policy.humanReviewRequiredFor).toContain(trigger);
    }
  });
});
