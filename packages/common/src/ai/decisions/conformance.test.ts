import { describe, expect, it } from 'vitest';
import { measureDecisionQuestionIsolation } from './conformance.js';
import { DecisionNotApplicableError } from './runtime.js';
import type {
  DecisionAdapter,
  DecisionAnswer,
  DecisionProviderOptions,
  DecisionRequest,
} from './types.js';

const request: DecisionRequest = {
  state: { message: 'Please file my taxes now.' },
  questions: {
    work: { kind: 'boolean', instructions: 'Is work requested?' },
    service: {
      kind: 'choice',
      instructions: 'Which service?',
      options: { tax: 'Tax preparation', none: 'No match' },
    },
    urgency: {
      kind: 'ordinal',
      instructions: 'How urgent is it?',
      levels: ['low', 'medium', 'high'],
    },
  },
  applicability: { applicable: true, evidenceComplete: true },
};

/**
 * Fake multi-question provider: `answer` sees whether the question arrived
 * packed with others, which is exactly the interference the probe measures.
 */
function fakeAdapter(
  answer: (question: string, packed: boolean) => DecisionAnswer,
) {
  const calls: { request: DecisionRequest; signal?: AbortSignal }[] = [];
  const adapter: DecisionAdapter = {
    provider: 'fake',
    model: 'fake-model',
    async evaluate(input, options?: DecisionProviderOptions) {
      calls.push({ request: input, signal: options?.signal });
      const keys = Object.keys(input.questions);
      return {
        answers: Object.fromEntries(
          keys.map((key) => [key, answer(key, keys.length > 1)]),
        ),
      };
    },
  };
  return { adapter, calls };
}

const stableAnswer = (question: string): DecisionAnswer => {
  switch (question) {
    case 'work':
      return { kind: 'boolean', probabilityTrue: 0.8 };
    case 'service':
      return {
        kind: 'choice',
        value: 'tax',
        confidence: 0.9,
        probabilities: { tax: 0.9, none: 0.1 },
      };
    default:
      return {
        kind: 'ordinal',
        score: 2,
        confidence: 0.7,
        probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
      };
  }
};

describe('measureDecisionQuestionIsolation', () => {
  it('detects packed-question interference', async () => {
    const { adapter } = fakeAdapter((question, packed) => {
      if (question === 'work') {
        return { kind: 'boolean', probabilityTrue: packed ? 0.2 : 0.8 };
      }
      if (question === 'service' && packed) {
        return {
          kind: 'choice',
          value: 'none',
          confidence: 0.6,
          probabilities: { tax: 0.4, none: 0.6 },
        };
      }
      if (question === 'urgency' && packed) {
        return { kind: 'ordinal', score: 0.5, confidence: 0.5 };
      }
      return stableAnswer(question);
    });

    const report = await measureDecisionQuestionIsolation(adapter, request);

    expect(report.changedSelections).toEqual(['work', 'service']);
    expect(report.maxProbabilityDelta).toBeCloseTo(0.6);
    expect(report.observations).toHaveLength(3);
    const [work, service, urgency] = report.observations;
    expect(work).toMatchObject({
      question: 'work',
      kind: 'boolean',
      selectedChanged: true,
    });
    expect(work?.maxProbabilityDelta).toBeCloseTo(0.6);
    expect(service).toMatchObject({
      question: 'service',
      kind: 'choice',
      selectedChanged: true,
    });
    expect(service?.maxProbabilityDelta).toBeCloseTo(0.5);
    // Only one side carried an ordinal distribution, so no probability delta.
    expect(urgency).toEqual({
      question: 'urgency',
      kind: 'ordinal',
      scoreDelta: 1.5,
    });
  });

  it('reports stable questions when packed and isolated answers match', async () => {
    const { adapter, calls } = fakeAdapter(stableAnswer);

    const report = await measureDecisionQuestionIsolation(adapter, request);

    expect(report.changedSelections).toEqual([]);
    expect(report.maxProbabilityDelta).toBe(0);
    expect(report.observations.find((o) => o.kind === 'ordinal')).toEqual({
      question: 'urgency',
      kind: 'ordinal',
      scoreDelta: 0,
      maxProbabilityDelta: 0,
    });
    // One packed run plus one run per question, all over identical state.
    expect(calls).toHaveLength(4);
    expect(calls.map((call) => Object.keys(call.request.questions))).toEqual([
      ['work', 'service', 'urgency'],
      ['work'],
      ['service'],
      ['urgency'],
    ]);
    for (const call of calls) {
      expect(call.request.state).toBe(request.state);
    }
  });

  it('compares normalised distributions, so an omitted zero is no delta', async () => {
    const { adapter } = fakeAdapter((question, packed) =>
      question === 'service'
        ? {
            kind: 'choice',
            value: 'tax',
            confidence: 1,
            probabilities: packed ? { tax: 1 } : { tax: 1, none: 0 },
          }
        : stableAnswer(question),
    );

    const report = await measureDecisionQuestionIsolation(adapter, request);

    expect(report.maxProbabilityDelta).toBe(0);
  });

  it('forwards the caller signal to every provider run', async () => {
    const { adapter, calls } = fakeAdapter(stableAnswer);
    const controller = new AbortController();

    await measureDecisionQuestionIsolation(adapter, request, {
      signal: controller.signal,
    });

    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  it('refuses to probe a request whose evidence is incomplete without calling the provider', async () => {
    const { adapter, calls } = fakeAdapter(stableAnswer);

    await expect(
      measureDecisionQuestionIsolation(adapter, {
        ...request,
        applicability: {
          applicable: true,
          evidenceComplete: false,
          reason: 'Encrypted delegated task is unavailable.',
        },
      }),
    ).rejects.toBeInstanceOf(DecisionNotApplicableError);
    expect(calls).toHaveLength(0);
  });

  it('rejects malformed provider output instead of measuring it', async () => {
    const { adapter } = fakeAdapter((question, packed) =>
      question === 'work' && !packed
        ? { kind: 'boolean', probabilityTrue: 2 }
        : stableAnswer(question),
    );

    await expect(
      measureDecisionQuestionIsolation(adapter, request),
    ).rejects.toThrow(/0 to 1/);
  });
});
