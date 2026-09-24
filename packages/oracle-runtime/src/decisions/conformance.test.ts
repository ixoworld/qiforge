import type {
  DecisionAdapter,
  DecisionProviderResult,
  DecisionRequest,
} from '@ixo/common';
import { describe, expect, it } from 'vitest';
import { measureDecisionQuestionIsolation } from './conformance.js';

const request: DecisionRequest = {
  state: { message: 'Please file my taxes now.' },
  questions: {
    work: {
      kind: 'boolean',
      instructions: 'Is work requested?',
    },
    service: {
      kind: 'choice',
      instructions: 'Which service?',
      options: {
        tax: 'Tax preparation',
        none: 'No match',
      },
    },
  },
  applicability: {
    applicable: true,
    evidenceComplete: true,
  },
};

function adapter(
  evaluate: (request: DecisionRequest) => DecisionProviderResult,
): DecisionAdapter {
  return {
    provider: 'test',
    model: 'test',
    async evaluate(input) {
      return evaluate(input);
    },
  };
}

describe('measureDecisionQuestionIsolation', () => {
  it('detects packed-question interference', async () => {
    const report = await measureDecisionQuestionIsolation(
      adapter((input) => {
        const packed = Object.keys(input.questions).length > 1;
        return {
          answers: Object.fromEntries(
            Object.keys(input.questions).map((key) =>
              key === 'work'
                ? [
                    key,
                    {
                      kind: 'boolean',
                      probabilityTrue: packed ? 0.2 : 0.8,
                    },
                  ]
                : [
                    key,
                    {
                      kind: 'choice',
                      value: 'tax',
                      confidence: 0.9,
                      probabilities: { tax: 0.9, none: 0.1 },
                    },
                  ],
            ),
          ),
        };
      }),
      request,
    );

    expect(report.changedSelections).toEqual(['work']);
    expect(report.maxProbabilityDelta).toBeCloseTo(0.6);
    const work = report.observations.find(
      (observation) => observation.question === 'work',
    );
    expect(work).toMatchObject({
      kind: 'boolean',
      comparable: true,
      selectedChanged: true,
    });
    expect(work?.maxProbabilityDelta).toBeCloseTo(0.6);
  });

  it('reports isolated questions as stable when packed and single results match', async () => {
    const report = await measureDecisionQuestionIsolation(
      adapter((input) => ({
        answers: Object.fromEntries(
          Object.keys(input.questions).map((key) =>
            key === 'work'
              ? [key, { kind: 'boolean', probabilityTrue: 0.8 }]
              : [
                  key,
                  {
                    kind: 'choice',
                    value: 'tax',
                    confidence: 0.9,
                    probabilities: { tax: 0.9, none: 0.1 },
                  },
                ],
          ),
        ),
      })),
      request,
    );

    expect(report.changedSelections).toEqual([]);
    expect(report.maxProbabilityDelta).toBe(0);
  });

  it('refuses to probe a request whose evidence is declared incomplete', async () => {
    await expect(
      measureDecisionQuestionIsolation(
        adapter(() => ({ answers: {} })),
        {
          ...request,
          applicability: {
            applicable: true,
            evidenceComplete: false,
            reason: 'Encrypted delegated task is unavailable.',
          },
        },
      ),
    ).rejects.toThrow(/evidence-incomplete/);
  });
});
