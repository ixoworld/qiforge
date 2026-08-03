import { describe, expect, it, vi } from 'vitest';
import {
  authorize,
  REASON,
  toConstitutionPolicy,
  type AuthorizationRequest,
  type AuthorizeDeps,
  type ConstitutionPolicy,
} from './authorize.js';
import { parseDomainMdSubset } from './parse.js';
import { SUPPORTED_SCHEMA_URI, SUPPORTED_SPEC_VERSION } from './schema.js';
import { fixedClock } from './time.js';

const NOW = '2026-08-02T12:00:00.000Z';
const SUBJECT = 'did:ixo:entity:oracle';

function grant(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'right:test:grant',
    type: 'write',
    effect: 'allow',
    subject: SUBJECT,
    object: 'ixo:oracle/workspace/*',
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
    ...overrides,
  };
}

function policy(
  options: {
    mode?: string;
    overrides?: Record<string, boolean>;
    baseline?: string[];
    humanReview?: string[];
    grants?: Array<Record<string, unknown>>;
    status?: string;
    failurePolicy?: string;
  } = {},
): ConstitutionPolicy {
  const frontmatter = {
    version: SUPPORTED_SPEC_VERSION,
    kind: 'domain.md',
    conformance: {
      spec_version: SUPPORTED_SPEC_VERSION,
      schema: SUPPORTED_SCHEMA_URI,
      profile: 'authoring_draft',
    },
    document_revision: '0.1.0',
    domain: {
      id: SUBJECT,
      iid: null,
      type: 'oracle',
      status: 'active',
      purpose: 'Test subject.',
      operating_boundary: 'Testing.',
    },
    constitution: {
      status: options.status ?? 'in_force',
      reason: null,
      subject: SUBJECT,
      type: 'con:OracleConstitution',
      execution: { failure_policy: options.failurePolicy ?? 'deny' },
    },
    agent_default_mode: {
      mode: options.mode ?? 'bounded_execute',
      overrides: options.overrides ?? {},
      human_review_required_for: options.humanReview ?? [],
    },
    rights: {
      agent_baseline: {
        require_explicit_grant_for: options.baseline ?? [
          'write',
          'pay',
          'issue',
          'govern',
        ],
      },
      entries: options.grants ?? [grant()],
    },
  };
  return toConstitutionPolicy(
    parseDomainMdSubset(
      `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n# domain.md\n`,
    ),
  );
}

function request(
  overrides: Partial<AuthorizationRequest> = {},
): AuthorizationRequest {
  return {
    principal: { did: SUBJECT, sessionId: 'session-1' },
    action: 'write',
    operation: 'write_file',
    object: 'ixo:oracle/workspace/notes.md',
    ...overrides,
  };
}

const deps: AuthorizeDeps = { time: fixedClock(NOW) };

describe('authorize — recognition and ceiling', () => {
  it('permits a read below the ceiling with no grant needed', async () => {
    const decision = await authorize(
      request({ action: 'read', operation: 'read_file', object: 'ixo:oracle' }),
      policy({ mode: 'read_only' }),
      deps,
    );
    expect(decision.outcome).toBe('permit');
    expect(decision.reasonCodes).toEqual([]);
  });

  it('denies an action above the mode ceiling', async () => {
    const decision = await authorize(
      request({ action: 'evaluate', operation: 'create_evaluation_claim' }),
      policy({ mode: 'propose_only' }),
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.modeCeiling);
    expect(decision.ruleRefs).toContain('agent_default_mode.mode');
  });

  it('denies a value-moving action even at the top ceiling when the override disables it', async () => {
    const decision = await authorize(
      request({
        action: 'pay',
        operation: 'release_payment',
        object: 'ixo:oracle/treasury',
      }),
      policy({ overrides: { move_value: false } }),
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.overrideDisabled);
  });

  it('escalates instead of denying when the failure policy says so', async () => {
    const decision = await authorize(
      request({ action: 'evaluate', operation: 'create_evaluation_claim' }),
      policy({ mode: 'propose_only', failurePolicy: 'pause_and_escalate' }),
      deps,
    );
    expect(decision.outcome).toBe('manual_review_required');
  });

  it('refuses effectful work while the constitution is suspended', async () => {
    const decision = await authorize(
      request(),
      policy({ status: 'suspended' }),
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.constitutionNotInForce);
  });

  it('refuses effectful work when the clock cannot be trusted', async () => {
    const decision = await authorize(request(), policy(), {
      time: fixedClock(NOW, { trusted: false }),
    });
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.clockUntrusted);
  });
});

describe('authorize — grants', () => {
  it('denies a baseline action with no matching grant', async () => {
    const decision = await authorize(
      request({
        action: 'pay',
        operation: 'release_payment',
        object: 'ixo:oracle/treasury',
      }),
      policy(),
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.noMatchingGrant);
  });

  it('permits a baseline action covered by a wildcard object grant', async () => {
    const decision = await authorize(request(), policy(), deps);
    expect(decision.outcome).toBe('permit');
    expect(decision.matchedGrantId).toBe('right:test:grant');
  });

  it('does not match a grant belonging to another subject', async () => {
    const decision = await authorize(
      request(),
      policy({ grants: [grant({ subject: 'did:ixo:entity:someone-else' })] }),
      deps,
    );
    expect(decision.reasonCodes).toContain(REASON.noMatchingGrant);
  });

  it('does not match a grant for a different object', async () => {
    const decision = await authorize(
      request({ object: 'ixo:oracle/treasury/payout' }),
      policy(),
      deps,
    );
    expect(decision.reasonCodes).toContain(REASON.noMatchingGrant);
  });

  it('does not match a grant for a different operation', async () => {
    const decision = await authorize(
      request({ operation: 'delete_file' }),
      policy({ grants: [grant({ action: 'write_file' })] }),
      deps,
    );
    expect(decision.reasonCodes).toContain(REASON.noMatchingGrant);
  });

  it('lets a deny grant override an allow grant at the same scope', async () => {
    const decision = await authorize(
      request(),
      policy({
        grants: [grant(), grant({ id: 'right:test:deny', effect: 'deny' })],
      }),
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.denyGrant);
    expect(decision.ruleRefs).toContain('right:test:deny');
  });

  it('denies a deny-granted action even when it is below the baseline', async () => {
    const decision = await authorize(
      request({
        action: 'read',
        operation: 'read_file',
        object: 'ixo:oracle/secrets',
      }),
      policy({
        baseline: ['pay'],
        grants: [
          grant({
            id: 'right:test:no-secrets',
            type: 'read',
            effect: 'deny',
            object: 'ixo:oracle/secrets',
          }),
        ],
      }),
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.denyGrant);
  });
});

describe('authorize — grant conditions', () => {
  it('rejects a grant that has not started', async () => {
    const decision = await authorize(
      request(),
      policy({
        grants: [
          grant({
            conditions: {
              ...(grant().conditions as object),
              not_before: '2027-01-01T00:00:00Z',
            },
          }),
        ],
      }),
      deps,
    );
    expect(decision.reasonCodes).toContain(REASON.grantNotYetValid);
  });

  it('rejects an expired grant', async () => {
    const decision = await authorize(
      request(),
      policy({
        grants: [
          grant({
            conditions: {
              ...(grant().conditions as object),
              expiry: '2026-01-01T00:00:00Z',
            },
          }),
        ],
      }),
      deps,
    );
    expect(decision.reasonCodes).toContain(REASON.grantExpired);
  });

  // A request's amount is assembled at runtime by a plugin's `effect.value`
  // extractor, so unlike the constitution's own amounts it has never been
  // through a schema. These cases prove a bad one denies rather than throwing
  // — and that it denies wherever it appears, not only where a ceiling reads
  // it.
  it.each([
    ['not a number', 'abc'],
    ['a decimal', '1.5'],
    ['a negative', '-1'],
    ['leading zeros', '007'],
    ['an empty string', ''],
    ['whitespace', ' 10 '],
  ])('denies a value that is %s', async (_label, amount) => {
    const decision = await authorize(
      request({ value: { amount, denom: 'uixo' } }),
      policy({
        grants: [
          grant({
            conditions: {
              ...(grant().conditions as object),
              max_value: { amount: '1000', denom: 'uixo' },
            },
          }),
        ],
      }),
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.valueMalformed);
  });

  it('denies a malformed value on an action no ceiling would have checked', async () => {
    const decision = await authorize(
      request({
        action: 'read',
        operation: 'read_file',
        object: 'ixo:oracle',
        value: { amount: 'lots', denom: 'uixo' },
      }),
      policy({ mode: 'read_only' }),
      deps,
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.valueMalformed);
  });

  it('never hands a malformed value to the capability verifier', async () => {
    const verifyCapabilityProof = vi.fn();
    const decision = await authorize(
      request({
        value: { amount: '1e6', denom: 'uixo' },
        capabilityProof: 'proof',
      }),
      policy({
        grants: [grant({ capability: { format: 'ucan', reference: null } })],
      }),
      { ...deps, verifyCapabilityProof },
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.valueMalformed);
    expect(verifyCapabilityProof).not.toHaveBeenCalled();
  });

  it('rejects a value in a denomination the grant does not bound', async () => {
    const decision = await authorize(
      request({ value: { amount: '10', denom: 'uixo' } }),
      policy({
        grants: [
          grant({
            conditions: {
              ...(grant().conditions as object),
              max_value: { amount: '1000', denom: 'uusdc' },
            },
          }),
        ],
      }),
      deps,
    );
    expect(decision.reasonCodes).toContain(REASON.valueDenomMismatch);
  });

  it('rejects a value above the grant ceiling', async () => {
    const decision = await authorize(
      request({ value: { amount: '1001', denom: 'uixo' } }),
      policy({
        grants: [
          grant({
            conditions: {
              ...(grant().conditions as object),
              max_value: { amount: '1000', denom: 'uixo' },
            },
          }),
        ],
      }),
      deps,
    );
    expect(decision.reasonCodes).toContain(REASON.valueExceedsGrant);
  });

  it('permits a value at exactly the ceiling', async () => {
    const decision = await authorize(
      request({ value: { amount: '1000', denom: 'uixo' } }),
      policy({
        grants: [
          grant({
            conditions: {
              ...(grant().conditions as object),
              max_value: { amount: '1000', denom: 'uixo' },
            },
          }),
        ],
      }),
      deps,
    );
    expect(decision.outcome).toBe('permit');
  });

  it('compares value ceilings without floating-point loss', async () => {
    const huge = '9007199254740993'; // one above Number.MAX_SAFE_INTEGER
    const decision = await authorize(
      request({ value: { amount: huge, denom: 'uixo' } }),
      policy({
        grants: [
          grant({
            conditions: {
              ...(grant().conditions as object),
              max_value: { amount: '9007199254740992', denom: 'uixo' },
            },
          }),
        ],
      }),
      deps,
    );
    expect(decision.reasonCodes).toContain(REASON.valueExceedsGrant);
  });

  it('carries an unchecked ceiling forward as an obligation', async () => {
    const decision = await authorize(
      request(),
      policy({
        grants: [
          grant({
            conditions: {
              ...(grant().conditions as object),
              max_value: { amount: '500', denom: 'uixo' },
            },
          }),
        ],
      }),
      deps,
    );
    expect(decision.outcome).toBe('permit');
    expect(decision.obligations).toContainEqual({
      kind: 'value_ceiling',
      detail: 'At most 500 uixo.',
    });
  });

  it('rejects a missing role or credential', async () => {
    const roleDenied = await authorize(
      request(),
      policy({
        grants: [
          grant({
            conditions: {
              ...(grant().conditions as object),
              role_required: 'verifier',
            },
          }),
        ],
      }),
      deps,
    );
    expect(roleDenied.reasonCodes).toContain(REASON.roleMissing);

    const credentialDenied = await authorize(
      request(),
      policy({
        grants: [
          grant({
            conditions: {
              ...(grant().conditions as object),
              credential_required: 'vc:evidence-reviewer',
            },
          }),
        ],
      }),
      deps,
    );
    expect(credentialDenied.reasonCodes).toContain(REASON.credentialMissing);
  });

  it('accepts a satisfied role and flow state', async () => {
    const decision = await authorize(
      request({ roles: ['verifier'], flowState: 'evaluating' }),
      policy({
        grants: [
          grant({
            conditions: {
              ...(grant().conditions as object),
              role_required: 'verifier',
              flow_state: 'evaluating',
            },
          }),
        ],
      }),
      deps,
    );
    expect(decision.outcome).toBe('permit');
  });

  it('tries every candidate grant before refusing', async () => {
    const decision = await authorize(
      request(),
      policy({
        grants: [
          grant({
            id: 'right:expired',
            conditions: {
              ...(grant().conditions as object),
              expiry: '2026-01-01T00:00:00Z',
            },
          }),
          grant({ id: 'right:valid' }),
        ],
      }),
      deps,
    );
    expect(decision.outcome).toBe('permit');
    expect(decision.matchedGrantId).toBe('right:valid');
  });
});

describe('authorize — capability proofs', () => {
  const ucanGrant = grant({ capability: { format: 'ucan', reference: null } });

  it('denies when a proof is required but absent', async () => {
    const decision = await authorize(
      request(),
      policy({ grants: [ucanGrant] }),
      deps,
    );
    expect(decision.reasonCodes).toContain(REASON.proofMissing);
  });

  it('denies when no verifier is wired', async () => {
    const decision = await authorize(
      request({ capabilityProof: 'ucan-token' }),
      policy({ grants: [ucanGrant] }),
      deps,
    );
    expect(decision.reasonCodes).toContain(REASON.verifierUnavailable);
  });

  it('denies an invalid proof', async () => {
    const verifyCapabilityProof = vi.fn().mockResolvedValue({
      valid: false,
      proofDigest: 'sha256:bad',
      revoked: false,
    });
    const decision = await authorize(
      request({ capabilityProof: 'ucan-token' }),
      policy({ grants: [ucanGrant] }),
      { ...deps, verifyCapabilityProof },
    );
    expect(decision.reasonCodes).toContain(REASON.proofInvalid);
  });

  it('denies a revoked proof', async () => {
    const verifyCapabilityProof = vi.fn().mockResolvedValue({
      valid: true,
      proofDigest: 'sha256:revoked',
      revoked: true,
    });
    const decision = await authorize(
      request({ capabilityProof: 'ucan-token' }),
      policy({ grants: [ucanGrant] }),
      { ...deps, verifyCapabilityProof },
    );
    expect(decision.reasonCodes).toContain(REASON.proofRevoked);
  });

  it('denies when the verifier throws rather than trusting the proof', async () => {
    const verifyCapabilityProof = vi
      .fn()
      .mockRejectedValue(new Error('resolver offline'));
    const decision = await authorize(
      request({ capabilityProof: 'ucan-token' }),
      policy({ grants: [ucanGrant] }),
      { ...deps, verifyCapabilityProof },
    );
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain(REASON.proofInvalid);
  });

  it('permits a valid proof and records its digest', async () => {
    const verifyCapabilityProof = vi.fn().mockResolvedValue({
      valid: true,
      proofDigest: 'sha256:good',
      revoked: false,
    });
    const decision = await authorize(
      request({ capabilityProof: 'ucan-token' }),
      policy({ grants: [ucanGrant] }),
      { ...deps, verifyCapabilityProof },
    );
    expect(decision.outcome).toBe('permit');
    expect(decision.capability).toEqual({
      proofDigest: 'sha256:good',
      revoked: false,
    });
    expect(verifyCapabilityProof).toHaveBeenCalledWith('ucan-token', {
      subject: SUBJECT,
      object: 'ixo:oracle/workspace/notes.md',
      action: 'write_file',
      value: null,
    });
  });
});

describe('authorize — human review', () => {
  const payGrant = grant({
    id: 'right:test:pay',
    type: 'pay',
    object: 'ixo:oracle/treasury',
    action: 'release_payment',
  });
  const payRequest = request({
    action: 'pay',
    operation: 'release_payment',
    object: 'ixo:oracle/treasury',
  });

  it('escalates an action whose trigger the constitution declares', async () => {
    const decision = await authorize(
      payRequest,
      policy({ humanReview: ['payment_release'], grants: [payGrant] }),
      deps,
    );
    expect(decision.outcome).toBe('manual_review_required');
    expect(decision.reasonCodes).toContain(REASON.humanReviewRequired);
    expect(decision.obligations[0].kind).toBe('human_review');
  });

  it('does not invent a trigger the constitution never declared', async () => {
    const decision = await authorize(
      payRequest,
      policy({ grants: [payGrant] }),
      deps,
    );
    expect(decision.outcome).toBe('permit');
  });

  it('escalates when the grant itself demands review', async () => {
    const decision = await authorize(
      request(),
      policy({
        grants: [
          grant({
            conditions: {
              ...(grant().conditions as object),
              human_review: true,
            },
          }),
        ],
      }),
      deps,
    );
    expect(decision.outcome).toBe('manual_review_required');
  });

  it('permits once a review proof verifies against the request digest', async () => {
    const verifyReviewProof = vi.fn().mockResolvedValue(true);
    const decision = await authorize(
      {
        ...payRequest,
        reviewProofRef: 'approval-1',
        requestDigest: 'sha256:req',
      },
      policy({ humanReview: ['payment_release'], grants: [payGrant] }),
      { ...deps, verifyReviewProof },
    );
    expect(decision.outcome).toBe('permit');
    expect(verifyReviewProof).toHaveBeenCalledWith('approval-1', 'sha256:req');
  });

  it('refuses a review proof that does not verify', async () => {
    const verifyReviewProof = vi.fn().mockResolvedValue(false);
    const decision = await authorize(
      { ...payRequest, reviewProofRef: 'forged' },
      policy({ humanReview: ['payment_release'], grants: [payGrant] }),
      { ...deps, verifyReviewProof },
    );
    expect(decision.outcome).toBe('manual_review_required');
    expect(decision.reasonCodes).toContain(REASON.reviewProofInvalid);
  });
});

describe('toConstitutionPolicy', () => {
  it('carries document identity onto every policy', () => {
    const result = policy();
    expect(result.domainMdCid).toMatch(/^b/);
    expect(result.documentRevision).toBe('0.1.0');
    expect(result.subject).toBe(SUBJECT);
  });

  it('collects only the overrides that are switched off', () => {
    const result = policy({
      overrides: { move_value: false, some_future_flag: true },
    });
    expect(result.disabledOverrides).toEqual(['move_value']);
  });

  it('merges review triggers declared in both places', () => {
    const parsed = parseDomainMdSubset(
      `---\n${JSON.stringify(
        {
          version: SUPPORTED_SPEC_VERSION,
          kind: 'domain.md',
          conformance: {
            spec_version: SUPPORTED_SPEC_VERSION,
            schema: SUPPORTED_SCHEMA_URI,
            profile: 'authoring_draft',
          },
          document_revision: '1.0.0',
          domain: {
            id: SUBJECT,
            iid: null,
            type: 'oracle',
            status: 'active',
            purpose: 'p',
            operating_boundary: 'b',
          },
          constitution: {
            status: 'in_force',
            reason: null,
            subject: SUBJECT,
            type: 'con:OracleConstitution',
            execution: {
              failure_policy: 'deny',
              human_review_required_for: ['rights_change'],
            },
          },
          agent_default_mode: {
            mode: 'bounded_execute',
            overrides: {},
            human_review_required_for: ['payment_release'],
          },
          rights: {
            agent_baseline: { require_explicit_grant_for: ['pay'] },
            entries: [],
          },
        },
        null,
        2,
      )}\n---\n# domain.md\n`,
    );
    expect(toConstitutionPolicy(parsed).humanReviewRequiredFor).toEqual([
      'payment_release',
      'rights_change',
    ]);
  });
});
