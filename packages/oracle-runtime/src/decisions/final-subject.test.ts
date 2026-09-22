import { describe, expect, it } from 'vitest';
import {
  assertFinalDecisionSubjectUnchanged,
  canonicalizeFinalDecisionSubject,
  createDecisionAuthorityReceipt,
  createDecisionExecutionReceipt,
  digestFinalDecisionSubject,
  StaleDecisionSubjectError,
  type FinalDecisionSubject,
} from './final-subject.js';

const subject = (): FinalDecisionSubject => ({
  kind: 'payment',
  action: {
    amount: '125.00',
    currency: 'USD',
    payee: 'did:ixo:recipient',
  },
  evidenceRefs: ['claim:123', 'evidence:abc'],
  policyRef: 'rubric:pay-v3',
  context: {
    network: 'impact-hub',
  },
});

describe('Final Decision Subject binding', () => {
  it('canonicalizes object key order deterministically', () => {
    const a: FinalDecisionSubject = {
      kind: 'payment',
      action: { z: 1, a: 2 },
    };
    const b: FinalDecisionSubject = {
      action: { a: 2, z: 1 },
      kind: 'payment',
    };

    expect(canonicalizeFinalDecisionSubject(a)).toBe(
      canonicalizeFinalDecisionSubject(b),
    );
    expect(digestFinalDecisionSubject(a)).toEqual(
      digestFinalDecisionSubject(b),
    );
  });

  it('preserves array order as material', () => {
    const a = {
      kind: 'allocation',
      action: { priority: ['alpha', 'beta'] },
    } satisfies FinalDecisionSubject;
    const b = {
      kind: 'allocation',
      action: { priority: ['beta', 'alpha'] },
    } satisfies FinalDecisionSubject;

    expect(digestFinalDecisionSubject(a).subjectDigest).not.toBe(
      digestFinalDecisionSubject(b).subjectDigest,
    );
  });

  it('rejects non-JSON-safe subject values', () => {
    expect(() =>
      canonicalizeFinalDecisionSubject({
        kind: 'tool-call',
        action: { amount: Number.NaN },
      }),
    ).toThrow(/finite JSON numbers/);
  });

  it('allows execution when the authorized subject is unchanged', () => {
    const authority = createDecisionAuthorityReceipt({
      subject: subject(),
      mechanism: 'ucan',
      reference: 'ucan:abc',
      authorizedAt: '2026-09-22T05:00:00.000Z',
    });

    expect(() =>
      assertFinalDecisionSubjectUnchanged(authority.subject, subject()),
    ).not.toThrow();

    const execution = createDecisionExecutionReceipt({
      authority,
      currentSubject: subject(),
      executedAt: '2026-09-22T05:00:01.000Z',
      reference: 'tx:123',
    });

    expect(execution.actionDigest).toBe(authority.subject.subjectDigest);
    expect(execution.reference).toBe('tx:123');
  });

  it('blocks approve(A) → mutate(A→B) → execute(B)', () => {
    const approved = subject();
    const authority = createDecisionAuthorityReceipt({
      subject: approved,
      mechanism: 'contract-gate',
    });

    const mutated: FinalDecisionSubject = {
      ...approved,
      action: {
        amount: '1250.00',
        currency: 'USD',
        payee: 'did:ixo:recipient',
      },
    };

    expect(() =>
      createDecisionExecutionReceipt({
        authority,
        currentSubject: mutated,
      }),
    ).toThrow(StaleDecisionSubjectError);
  });

  it('treats evidence or policy changes as stale too', () => {
    const approved = subject();
    const authority = createDecisionAuthorityReceipt({
      subject: approved,
      mechanism: 'human-approval',
    });

    expect(() =>
      assertFinalDecisionSubjectUnchanged(authority.subject, {
        ...approved,
        policyRef: 'rubric:pay-v4',
      }),
    ).toThrow(StaleDecisionSubjectError);

    expect(() =>
      assertFinalDecisionSubjectUnchanged(authority.subject, {
        ...approved,
        evidenceRefs: [...(approved.evidenceRefs ?? []), 'evidence:new'],
      }),
    ).toThrow(StaleDecisionSubjectError);
  });
});
