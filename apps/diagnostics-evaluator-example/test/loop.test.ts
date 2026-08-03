/**
 * @fileoverview The sovereign loop, end to end, across two constitutions.
 *
 * Every other test in this repo evaluates one document. This one runs the
 * vehicle's and the evaluator's together, because the property that matters is
 * not in either document alone: **no principal can both generate a claim and
 * determine it.** A single document can assert that about itself and be wrong
 * about the other side.
 *
 * Both documents are the ones the apps actually ship. If either drifts, this
 * fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  authorize,
  fixedClock,
  loadDomainMd,
  REASON,
  type AuthorizationRequest,
  type AuthorizeDeps,
  type ConstitutionPolicy,
} from '@ixo/oracle-runtime/constitution';
import { beforeAll, describe, expect, it } from 'vitest';

const VEHICLE_MD = fileURLToPath(
  new URL('../../agentic-asset-example/domain.md', import.meta.url),
);
const EVALUATOR_MD = fileURLToPath(new URL('../domain.md', import.meta.url));

const VEHICLE = 'did:ixo:entity:dv-114';
const EVALUATOR = 'did:ixo:entity:fleet-diagnostics-evaluator';
const CLAIMS = 'ixo:collection:dv-fleet-diagnostics/claims';
const VENDOR = 'ixo:vendor:approved/northgate-fleet-services';
const CREDENTIAL = 'vc:fleet-diagnostics-evaluator';

const deps: AuthorizeDeps = {
  time: fixedClock('2026-08-03T09:00:00.000Z'),
  // The reserve has moved nothing today. Without a source for this the
  // account's daily limit is unenforceable, and an unenforceable limit denies.
  spentInWindow: async (_account, _since, denom) => ({ amount: '0', denom }),
};

/** The claim the vehicle files in step 2, referenced again at settlement. */
const CLAIM_ID = 'claim:dv114:0001';

let vehicle: ConstitutionPolicy;
let evaluator: ConstitutionPolicy;

async function policyOf(path: string): Promise<ConstitutionPolicy> {
  const result = await loadDomainMd({
    source: path,
    bytes: readFileSync(path, 'utf8'),
    enforcement: 'permissive',
  });
  if (!result.context) {
    throw new Error(
      `${path} does not load: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return result.context.policy;
}

beforeAll(async () => {
  vehicle = await policyOf(VEHICLE_MD);
  evaluator = await policyOf(EVALUATOR_MD);
});

function req(
  principal: string,
  overrides: Partial<AuthorizationRequest>,
): AuthorizationRequest {
  return {
    principal: { did: principal, sessionId: 'loop' },
    action: 'read',
    operation: 'read_claim',
    object: CLAIMS,
    ...overrides,
  };
}

const submitClaim = (principal: string) =>
  req(principal, {
    action: 'write',
    operation: 'submit_claim',
    object: CLAIMS,
    claimType: 'vehicle_fault_observation',
  });

const determineClaim = (principal: string) =>
  req(principal, {
    action: 'evaluate',
    operation: 'evaluate_claim',
    object: CLAIMS,
    claimType: 'vehicle_fault_observation',
    credentials: [CREDENTIAL],
  });

// The property neither document can establish alone.
describe('generation and evaluation never share a principal', () => {
  it('the vehicle may claim but not determine', async () => {
    const claiming = await authorize(submitClaim(VEHICLE), vehicle, deps);
    const determining = await authorize(determineClaim(VEHICLE), vehicle, deps);

    expect(claiming.outcome).toBe('permit');
    expect(determining.outcome).toBe('deny');
    expect(determining.ruleRefs).toContain('right:dv114:no-self-determination');
  });

  it('the evaluator may determine but not claim', async () => {
    const determining = await authorize(
      determineClaim(EVALUATOR),
      evaluator,
      deps,
    );
    const claiming = await authorize(submitClaim(EVALUATOR), evaluator, deps);

    expect(determining.outcome).toBe('permit');
    // Denied by the `bounded_evaluate` ceiling, which refuses every `write`
    // before any grant is consulted. The deny grant beneath it never gets a
    // turn today — see the next test for why it is there anyway.
    expect(claiming.outcome).toBe('deny');
    expect(claiming.reasonCodes).toContain(REASON.modeCeiling);
  });

  // The deny grant is a backstop, not the active rule. The ceiling shadows it
  // now; raise the ceiling — which a later revision might do so the oracle can
  // write reports elsewhere — and the deny grant is what still stops the
  // evaluator generating the evidence it judges.
  it('keeps the evaluator out of the claims collection even at a raised ceiling', async () => {
    const raised: ConstitutionPolicy = {
      ...evaluator,
      modeCeiling: 'bounded_execute',
    };
    const decision = await authorize(submitClaim(EVALUATOR), raised, deps);
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.denyGrant);
    expect(decision.ruleRefs).toContain('right:fde:no-self-generated-evidence');
  });

  // Stated as the invariant rather than as four separate assertions, because
  // this is the thing that must remain true however either document is edited.
  it('no principal holds both halves', async () => {
    const held = async (
      principal: string,
      policy: ConstitutionPolicy,
    ): Promise<{ claim: boolean; determine: boolean }> => ({
      claim:
        (await authorize(submitClaim(principal), policy, deps)).outcome ===
        'permit',
      determine:
        (await authorize(determineClaim(principal), policy, deps)).outcome ===
        'permit',
    });

    for (const [principal, policy] of [
      [VEHICLE, vehicle],
      [EVALUATOR, evaluator],
    ] as const) {
      const { claim, determine } = await held(principal, policy);
      expect(claim && determine).toBe(false);
    }
  });
});

describe('the evaluator cannot act on its own verdict', () => {
  // Upholding a claim releases someone else to spend. An evaluator that could
  // also act could pay itself by finding in its own favour — so acting is kept
  // above its ceiling entirely rather than granted narrowly.
  it.each([
    ['pay', 'settle_service_invoice'],
    ['transfer', 'transfer_funds'],
    ['execute', 'book_service_appointment'],
  ])('refuses to %s, above its ceiling', async (action, operation) => {
    const decision = await authorize(
      req(EVALUATOR, {
        action: action as AuthorizationRequest['action'],
        operation,
        object: VENDOR,
        value: { amount: '1000', denom: 'uusdc' },
        flowState: 'determination_upheld',
      }),
      evaluator,
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.modeCeiling);
  });
});

describe('evaluation authority is granted, not assumed', () => {
  // The credential is issued by the collection and revocable by it. Revoke it
  // and the oracle keeps its identity, memory and constitution — and stops
  // being able to determine anything.
  it('refuses determination without the collection’s credential', async () => {
    const decision = await authorize(
      req(EVALUATOR, {
        action: 'evaluate',
        operation: 'evaluate_claim',
        object: CLAIMS,
        claimType: 'vehicle_fault_observation',
        credentials: [],
      }),
      evaluator,
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.credentialMissing);
  });

  it('refuses determination of a claim type the grant does not cover', async () => {
    const decision = await authorize(
      req(EVALUATOR, {
        action: 'evaluate',
        operation: 'evaluate_claim',
        object: CLAIMS,
        claimType: 'roadworthiness_certification',
        credentials: [CREDENTIAL],
      }),
      evaluator,
      deps,
    );
    expect(decision.outcome).toBe('deny');
  });
});

// The whole loop, in the order it runs, each step gated by the constitution of
// whoever is taking it.
describe('the loop, end to end', () => {
  it('runs sense → claim → determine → book → pay, and refuses every shortcut', async () => {
    // 1. The vehicle senses. Baseline read, no grant needed.
    expect(
      (
        await authorize(
          req(VEHICLE, {
            operation: 'read_telemetry',
            object: 'ixo:asset:dv-114/telemetry/current',
          }),
          vehicle,
          deps,
        )
      ).outcome,
    ).toBe('permit');

    // 2. The vehicle claims. It is making a case, not reaching a verdict.
    expect((await authorize(submitClaim(VEHICLE), vehicle, deps)).outcome).toBe(
      'permit',
    );

    // 3. The shortcut: acting on the observation alone. Refused — no
    //    determination exists, so `determination_upheld` does not hold.
    expect(
      (
        await authorize(
          req(VEHICLE, {
            action: 'write',
            operation: 'book_service_appointment',
            object: VENDOR,
          }),
          vehicle,
          deps,
        )
      ).outcome,
    ).toBe('deny');

    // 4. The other shortcut: determining its own claim. Refused by deny grant.
    expect(
      (await authorize(determineClaim(VEHICLE), vehicle, deps)).outcome,
    ).toBe('deny');

    // 5. The evaluator determines. Different principal, different document,
    //    credentialed grant.
    expect(
      (await authorize(determineClaim(EVALUATOR), evaluator, deps)).outcome,
    ).toBe('permit');

    // 6. With the determination upheld, the vehicle may book.
    expect(
      (
        await authorize(
          req(VEHICLE, {
            action: 'write',
            operation: 'book_service_appointment',
            object: VENDOR,
            flowState: 'determination_upheld',
          }),
          vehicle,
          deps,
        )
      ).outcome,
    ).toBe('permit');

    // 7. Payment is assembled and correct — and still stops for a human,
    //    because `payment_release` is a declared review trigger.
    //
    //    "Correct" now means more than a valid grant. The maintenance
    //    reserve's spending policy demands the payment name the account it
    //    draws on and point at both the claim and the independent
    //    determination behind it. That is the sequence made mechanical: the
    //    evidence assembled in steps 1–6 is what the account asks to see.
    const payment = req(VEHICLE, {
      action: 'pay',
      operation: 'settle_service_invoice',
      object: VENDOR,
      value: { amount: '148500000', denom: 'uusdc' },
      flowState: 'determination_upheld',
      account: 'Maintenance reserve',
      claimRef: CLAIM_ID,
      udidRef: `${EVALUATOR}#${CLAIM_ID}`,
    });
    expect((await authorize(payment, vehicle, deps)).outcome).toBe(
      'manual_review_required',
    );

    // 8. With the steward's approval bound to this exact request, it releases.
    const approved = await authorize(
      { ...payment, reviewProofRef: '$approval', requestDigest: 'sha256:inv' },
      vehicle,
      {
        ...deps,
        verifyReviewProof: async (ref, digest) =>
          ref === '$approval' && digest === 'sha256:inv',
      },
    );
    expect(approved.outcome).toBe('permit');
  });
});
