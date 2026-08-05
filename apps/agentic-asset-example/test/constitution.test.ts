/**
 * @fileoverview Runs the vehicle's real constitution through the real
 * evaluator.
 *
 * Not a unit test of the runtime — that lives in the runtime package. This
 * asserts that the document shipped in this app means what its prose says it
 * means, which is the thing a constitution can silently stop doing when it is
 * edited.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// The `/constitution` entrypoint rather than the barrel: this exercises pure
// evaluation, and the barrel drags in Matrix, which would make a test about a
// document depend on an environment it has nothing to do with.
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

const DOMAIN_MD = fileURLToPath(new URL('../domain.md', import.meta.url));
const VEHICLE = 'did:ixo:entity:dv-114';
const APPROVED = 'ixo:vendor:approved/northgate-fleet-services';
const NOW = '2026-08-03T09:00:00.000Z';

const deps: AuthorizeDeps = { time: fixedClock(NOW) };

let policy: ConstitutionPolicy;

beforeAll(async () => {
  const result = await loadDomainMd({
    source: DOMAIN_MD,
    bytes: readFileSync(DOMAIN_MD, 'utf8'),
    enforcement: 'permissive',
  });
  if (!result.context) {
    throw new Error(
      `The vehicle's constitution does not load: ${result.errors
        .map((e) => `${e.field}: ${e.message}`)
        .join('; ')}`,
    );
  }
  policy = result.context.policy;
});

function request(
  overrides: Partial<AuthorizationRequest>,
): AuthorizationRequest {
  return {
    principal: { did: VEHICLE, sessionId: 'session-1' },
    action: 'read',
    operation: 'read_telemetry',
    object: 'ixo:asset:dv-114/telemetry/current',
    ...overrides,
  };
}

describe('the document loads and describes an asset', () => {
  it('is an asset governed by a general agentic constitution', async () => {
    const result = await loadDomainMd({
      source: DOMAIN_MD,
      bytes: readFileSync(DOMAIN_MD, 'utf8'),
      enforcement: 'permissive',
    });
    expect(result.errors).toEqual([]);
    expect(result.context?.entityType).toBe('asset');
    expect(result.context?.advisory.constitutionType).toBe(
      'con:AgenticConstitution',
    );
  });

  // The entity is the agent for its own agentic functions: the twin does not
  // have an agent, it is one.
  it('resolves the vehicle itself as the agent', async () => {
    const result = await loadDomainMd({
      source: DOMAIN_MD,
      bytes: readFileSync(DOMAIN_MD, 'utf8'),
      enforcement: 'permissive',
    });
    expect(result.context?.agentId).toBe(VEHICLE);
    expect(result.context?.advisory.forbiddenOutputs).toContain(
      'self_determination',
    );
    expect(result.context?.advisory.escalationRoom).toBe(
      '!dv114-review:ixo.world',
    );
  });
});

describe('sense', () => {
  it('permits reading its own telemetry without a grant', async () => {
    const decision = await authorize(request({}), policy, deps);
    expect(decision.outcome).toBe('permit');
  });

  it('permits reading its own maintenance history', async () => {
    const decision = await authorize(
      request({
        operation: 'read_maintenance_history',
        object: 'ixo:asset:dv-114/maintenance/history',
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('permit');
  });
});

describe('claim', () => {
  it('permits submitting an observation to the diagnostics collection', async () => {
    const decision = await authorize(
      request({
        action: 'write',
        operation: 'submit_claim',
        object: 'ixo:collection:dv-fleet-diagnostics/claims',
        claimType: 'vehicle_fault_observation',
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('permit');
  });

  it('refuses a claim of a type the grant does not cover', async () => {
    const decision = await authorize(
      request({
        action: 'write',
        operation: 'submit_claim',
        object: 'ixo:collection:dv-fleet-diagnostics/claims',
        claimType: 'vehicle_roadworthiness_certification',
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('deny');
  });
});

describe('determine — the load-bearing rule', () => {
  // An asset that both reports a fault and rules on the report can authorise
  // its own spending by inventing a fault.
  it('denies the vehicle determining its own claim', async () => {
    const decision = await authorize(
      request({
        action: 'evaluate',
        operation: 'evaluate_claim',
        object: 'ixo:collection:dv-fleet-diagnostics/claims',
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.denyGrant);
    expect(decision.ruleRefs).toContain('right:dv114:no-self-determination');
  });

  // The deny grant exists rather than relying on default-deny precisely so a
  // future broad `evaluate` grant cannot quietly restore self-determination.
  it('keeps denying even against a permissive allow grant', async () => {
    const withBroadAllow: ConstitutionPolicy = {
      ...policy,
      grants: [
        ...policy.grants,
        {
          id: 'right:dv114:hypothetical-broad-evaluate',
          type: 'evaluate_claim',
          effect: 'allow',
          subject: VEHICLE,
          object: 'ixo:collection:dv-fleet-diagnostics/*',
          action: '*',
          capability: { format: 'policy', reference: 'domain_md' },
          conditions: {
            flow_state: null,
            claim_type: null,
            max_value: null,
            not_before: null,
            expiry: null,
            role_required: null,
            credential_required: null,
            human_review: false,
          },
          revocation: {},
          audit: {},
        },
      ],
    };
    const decision = await authorize(
      request({
        action: 'evaluate',
        operation: 'evaluate_claim',
        object: 'ixo:collection:dv-fleet-diagnostics/claims',
      }),
      withBroadAllow,
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.denyGrant);
  });
});

describe('act', () => {
  const upheld = { flowState: 'determination_upheld' };

  /**
   * What a settlement has to bring with it.
   *
   * The maintenance reserve's spending policy demands a claim, an independent
   * determination, and a human release. So a payment names the account it
   * draws on and points at the evidence — it does not assert that evidence
   * exists. Without this the request is refused before review is even reached,
   * which is the sequence the document describes in prose.
   */
  const settlement = {
    ...upheld,
    account: 'Maintenance reserve',
    claimRef: 'claim:dv114:0001',
    udidRef: 'did:ixo:entity:fleet-diagnostics-evaluator#claim:dv114:0001',
  };

  /** The reserve has moved nothing today. */
  const spendDeps: AuthorizeDeps = {
    ...deps,
    spentInWindow: async (_account, _since, denom) => ({
      amount: '0',
      denom,
    }),
  };

  it('permits booking an approved vendor against an upheld determination', async () => {
    const decision = await authorize(
      request({
        action: 'write',
        operation: 'book_service_appointment',
        object: APPROVED,
        ...upheld,
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('permit');
  });

  it('refuses booking before a determination is upheld', async () => {
    const decision = await authorize(
      request({
        action: 'write',
        operation: 'book_service_appointment',
        object: APPROVED,
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('deny');
  });

  // A well-formed payment does not simply execute. `payment_release` is a
  // declared review trigger, so a valid invoice to an approved vendor inside
  // the ceiling still stops for a human. Autonomy here means the vehicle
  // assembles the whole case by itself, not that it releases the money by
  // itself.
  it('escalates a valid payment rather than executing it', async () => {
    const decision = await authorize(
      request({
        action: 'pay',
        operation: 'settle_service_invoice',
        object: APPROVED,
        value: { amount: '148500000', denom: 'uusdc' },
        ...settlement,
      }),
      policy,
      spendDeps,
    );
    expect(decision.outcome).toBe('manual_review_required');
  });

  it('permits the same payment once a human approval is proven', async () => {
    const decision = await authorize(
      request({
        action: 'pay',
        operation: 'settle_service_invoice',
        object: APPROVED,
        value: { amount: '148500000', denom: 'uusdc' },
        reviewProofRef: '$matrix:approval-event-id',
        requestDigest: 'sha256:invoice-digest',
        ...settlement,
      }),
      policy,
      {
        ...spendDeps,
        verifyReviewProof: async (ref, digest) =>
          ref === '$matrix:approval-event-id' &&
          digest === 'sha256:invoice-digest',
      },
    );
    expect(decision.outcome).toBe('permit');
  });

  // The approval is bound to one request. An approval for a different invoice
  // is not a general licence to pay.
  it('refuses an approval that does not match this request', async () => {
    const decision = await authorize(
      request({
        action: 'pay',
        operation: 'settle_service_invoice',
        object: APPROVED,
        value: { amount: '148500000', denom: 'uusdc' },
        reviewProofRef: '$matrix:approval-for-another-invoice',
        requestDigest: 'sha256:invoice-digest',
        ...upheld,
      }),
      policy,
      { ...deps, verifyReviewProof: async () => false },
    );
    expect(decision.outcome).not.toBe('permit');
  });

  it('refuses a payment over the per-transaction ceiling', async () => {
    const decision = await authorize(
      request({
        action: 'pay',
        operation: 'settle_service_invoice',
        object: APPROVED,
        value: { amount: '250000001', denom: 'uusdc' },
        ...upheld,
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.valueExceedsGrant);
  });

  it('refuses a payment to a vendor that is not approved', async () => {
    const decision = await authorize(
      request({
        action: 'pay',
        operation: 'settle_service_invoice',
        object: 'ixo:vendor:unlisted/roadside-quickfix',
        value: { amount: '100000', denom: 'uusdc' },
        ...upheld,
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.noMatchingGrant);
  });

  // A conversion rate is a price policy, and this document does not contain
  // one. Refusing beats converting at a rate nobody governs.
  it('refuses an invoice denominated in something the ceiling does not bound', async () => {
    const decision = await authorize(
      request({
        action: 'pay',
        operation: 'settle_service_invoice',
        object: APPROVED,
        value: { amount: '1000', denom: 'uixo' },
        ...upheld,
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.valueDenomMismatch);
  });
});

// The scenario the whole document is shaped against: the reasoning model is
// compromised and proposes the worst thing it can. Every clause fails
// independently, so no single one is load-bearing on its own.
describe('a fully compromised model', () => {
  it('cannot pay an unlisted vendor a large sum on an undetermined fault', async () => {
    const decision = await authorize(
      request({
        action: 'pay',
        operation: 'settle_service_invoice',
        object: 'ixo:vendor:unlisted/roadside-quickfix',
        value: { amount: '5000000000', denom: 'uusdc' },
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('deny');
  });

  it('cannot raise its own ceiling, because changing rights is disabled', async () => {
    const decision = await authorize(
      request({
        action: 'govern',
        operation: 'update_rights',
        object: VEHICLE,
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.overrideDisabled);
  });

  // `pay` is granted, narrowly. `transfer` is not granted at all — the
  // vehicle settles invoices, it does not move money around. The capability
  // it needs does not carry the capability next to it.
  it('cannot transfer value, only settle an invoice', async () => {
    const decision = await authorize(
      request({
        action: 'transfer',
        operation: 'transfer_funds',
        object: APPROVED,
        value: { amount: '1', denom: 'uusdc' },
        flowState: 'determination_upheld',
      }),
      policy,
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.noMatchingGrant);
  });
});

// The maintenance reserve's spending policy was parsed, documented, and — until
// now — never consulted. These lock in that it bites, because the document's
// central promise is that money moves only at the end of the
// claim → determination → settlement sequence, never on the vehicle's say-so.
describe('the maintenance reserve enforces its own policy', () => {
  const APPROVED_VENDOR = 'ixo:vendor:approved/northgate-fleet-services';
  const upheld = { flowState: 'determination_upheld' };

  const spendDeps = (spent = '0'): AuthorizeDeps => ({
    time: fixedClock(NOW),
    spentInWindow: async (_account, _since, denom) => ({
      amount: spent,
      denom,
    }),
    verifyReviewProof: async () => true,
  });

  function settlement(overrides: Partial<AuthorizationRequest> = {}) {
    return request({
      action: 'pay',
      operation: 'settle_service_invoice',
      object: APPROVED_VENDOR,
      value: { amount: '148500000', denom: 'uusdc' },
      account: 'Maintenance reserve',
      claimRef: 'claim:dv114:0001',
      udidRef: 'did:ixo:entity:fleet-diagnostics-evaluator#claim:dv114:0001',
      reviewProofRef: '$matrix:approval',
      requestDigest: 'sha256:invoice',
      ...upheld,
      ...overrides,
    });
  }

  it('permits a settlement that brings everything the reserve asks for', async () => {
    const decision = await authorize(settlement(), policy, spendDeps());
    expect(decision.outcome).toBe('permit');
  });

  // The vehicle claiming its own fault is not evidence that the fault is real.
  it('refuses a settlement with no claim behind it', async () => {
    const decision = await authorize(
      settlement({ claimRef: undefined }),
      policy,
      spendDeps(),
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.claimRequired);
  });

  // The one that matters most: a claim the vehicle made about itself, with no
  // independent determination, cannot release money however well-formed it is.
  it('refuses a settlement with no independent determination behind it', async () => {
    const decision = await authorize(
      settlement({ udidRef: undefined }),
      policy,
      spendDeps(),
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.udidRequired);
  });

  it('refuses a settlement that names no account to draw on', async () => {
    const decision = await authorize(
      settlement({ account: undefined }),
      policy,
      spendDeps(),
    );
    expect(decision.reasonCodes).toContain(REASON.accountUnnamed);
  });

  it('refuses a settlement drawn on an account the constitution never declared', async () => {
    const decision = await authorize(
      settlement({ account: 'Petty cash' }),
      policy,
      spendDeps(),
    );
    expect(decision.reasonCodes).toContain(REASON.accountUnknown);
  });

  // The allowlist is now enforced twice over — by the grant's object scope and
  // by the account. Either alone would do; both is the fail-closed reading.
  it('refuses a settlement to a vendor outside the reserve’s allowlist', async () => {
    const decision = await authorize(
      settlement({ object: 'ixo:vendor:unvetted/cheap-garage' }),
      policy,
      spendDeps(),
    );
    expect(decision.outcome).toBe('deny');
  });

  // The grant's `max_value` and the account's `max_single_transaction` are
  // the same 250000000 uusdc — the document's "three different mechanisms
  // pointed at one property". The grant is evaluated first, so it is the one
  // cited; the account would refuse the same payment on its own.
  it('refuses a settlement above the per-transaction maximum', async () => {
    const decision = await authorize(
      settlement({ value: { amount: '999000000', denom: 'uusdc' } }),
      policy,
      spendDeps(),
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.valueExceedsGrant);
  });

  // The account's ceiling standing alone, with the grant's out of the way.
  it('refuses on the account’s ceiling when the grant’s does not apply', async () => {
    const withoutGrantCeiling: ConstitutionPolicy = {
      ...policy,
      grants: policy.grants.map((entry) =>
        entry.type === 'pay'
          ? {
              ...entry,
              conditions: { ...entry.conditions, max_value: null },
            }
          : entry,
      ),
    };
    const decision = await authorize(
      settlement({ value: { amount: '999000000', denom: 'uusdc' } }),
      withoutGrantCeiling,
      spendDeps(),
    );
    expect(decision.reasonCodes).toContain(REASON.exceedsSingleTransaction);
  });

  // The limit is on the day's total, not on this invoice alone. Two invoices
  // each inside the per-transaction ceiling can still breach it together.
  it('refuses a settlement that would push the day over its limit', async () => {
    const decision = await authorize(
      settlement(),
      policy,
      spendDeps('400000000'),
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.exceedsDailyLimit);
  });

  // A limit is a claim about history. Nothing able to answer it means the
  // limit is unenforced, and an unenforced limit is not a limit.
  it('refuses a settlement when nothing can say what the day has spent', async () => {
    const decision = await authorize(settlement(), policy, {
      time: fixedClock(NOW),
      verifyReviewProof: async () => true,
    });
    expect(decision.reasonCodes).toContain(REASON.dailyLimitUncheckable);
  });
});
