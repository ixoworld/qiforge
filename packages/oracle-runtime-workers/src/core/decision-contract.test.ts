import type { DecisionRequest } from '@ixo/common/ai/decisions';
import { describe, expect, it } from 'vitest';
import {
  StaleDecisionSubjectError,
  canonicalizeFinalDecisionSubject,
  createDecisionAuthorityReceipt,
  createDecisionExecutionReceipt,
  measureDecisionQuestionIsolation,
  type DecisionAdapter,
  type FinalDecisionSubject,
} from './index';

/**
 * The Decision contract primitives the runtime re-exports, run where the
 * runtime runs: this file is in both the plain-Node core suite and the
 * workerd pool, so the digest is pinned to the same bytes on both.
 */

const approved = (): FinalDecisionSubject => ({
  kind: 'payment',
  policyRef: 'rubric:pay-v3',
  evidenceRefs: ['claim:123'],
  action: { payee: 'did:ixo:recipient', currency: 'USD', amount: '125.00' },
});

describe('Final Decision Subject binding on the runtime', () => {
  it('produces the ixo-json-v1 canonical form and its SHA-256 digest', async () => {
    expect(canonicalizeFinalDecisionSubject(approved())).toBe(
      '{"action":{"amount":"125.00","currency":"USD","payee":"did:ixo:recipient"},"evidenceRefs":["claim:123"],"kind":"payment","policyRef":"rubric:pay-v3"}',
    );

    const authority = await createDecisionAuthorityReceipt({
      subject: approved(),
      mechanism: 'ucan',
    });

    expect(authority.subject).toEqual({
      algorithm: 'sha256',
      canonicalization: 'ixo-json-v1',
      subjectDigest:
        'c7a9974f315947c1f9e1403a24ddea7822c1fcf329af36db049d4cd3c657d7db',
    });
  });

  it('executes the approved subject and refuses a subject mutated after approval', async () => {
    const authority = await createDecisionAuthorityReceipt({
      subject: approved(),
      mechanism: 'contract-gate',
    });

    const execution = await createDecisionExecutionReceipt({
      authority,
      currentSubject: approved(),
    });
    expect(execution.receipt.actionDigest).toBe(
      authority.subject.subjectDigest,
    );
    // The effect runs from the frozen subject that was hashed.
    expect(execution.subject).toEqual(approved());
    expect(Object.isFrozen(execution.subject.action)).toBe(true);

    const mutated: FinalDecisionSubject = {
      ...approved(),
      action: {
        payee: 'did:ixo:someone-else',
        currency: 'USD',
        amount: '125.00',
      },
    };
    await expect(
      createDecisionExecutionReceipt({ authority, currentSubject: mutated }),
    ).rejects.toBeInstanceOf(StaleDecisionSubjectError);
  });
});

describe('packed-question isolation probe on the runtime', () => {
  it('reports a selection flip from a fake adapter that answers differently when packed', async () => {
    const request: DecisionRequest = {
      state: { message: 'Book me a flight and file my taxes.' },
      questions: {
        travel: { kind: 'boolean', instructions: 'Is travel requested?' },
        tax: { kind: 'boolean', instructions: 'Is tax work requested?' },
      },
    };
    const adapter: DecisionAdapter = {
      provider: 'fake',
      model: 'fake-model',
      async evaluate(input) {
        const keys = Object.keys(input.questions);
        const packed = keys.length > 1;
        return {
          answers: Object.fromEntries(
            keys.map((key) => [
              key,
              {
                kind: 'boolean' as const,
                // The packed run lets "travel" crowd out "tax".
                probabilityTrue: key === 'tax' && packed ? 0.3 : 0.9,
              },
            ]),
          ),
        };
      },
    };

    const report = await measureDecisionQuestionIsolation(adapter, request);

    expect(report.changedSelections).toEqual(['tax']);
    expect(report.maxProbabilityDelta).toBeCloseTo(0.6);
    expect(report.observations).toEqual([
      {
        question: 'travel',
        kind: 'boolean',
        selectedChanged: false,
        maxProbabilityDelta: 0,
      },
      {
        question: 'tax',
        kind: 'boolean',
        selectedChanged: true,
        maxProbabilityDelta: expect.closeTo(0.6),
      },
    ]);
  });
});
