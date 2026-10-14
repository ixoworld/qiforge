import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DecisionBenchmarkProvenanceError,
  runDecisionProviderBakeoff,
  type DecisionBenchmarkCase,
} from './benchmark.js';
import type { DecisionAdapter, DecisionProviderResult } from './types.js';

function booleanCase(id: string, positive: boolean): DecisionBenchmarkCase {
  return {
    id,
    request: {
      state: { positive },
      questions: { yes: { kind: 'boolean', instructions: 'Positive?' } },
    },
    questionId: 'yes',
    gold: positive,
  };
}

/** An adapter that answers correctly and reports what `report` returns. */
function reportingAdapter(
  report: (call: number) => Omit<DecisionProviderResult, 'answers'>,
): DecisionAdapter {
  let call = 0;
  return {
    provider: 'databricks',
    model: 'ai_decide',
    capabilities: {
      apiDialect: 'databricks-ai-decide-v1',
      primitives: ['boolean'],
      answerSemantics: 'distribution',
      modelPinning: 'mutable',
    },
    async evaluate(request) {
      const positive =
        typeof request.state === 'object' &&
        request.state !== null &&
        'positive' in request.state &&
        request.state.positive === true;
      return {
        answers: {
          yes: { kind: 'boolean', probabilityTrue: positive ? 0.9 : 0.1 },
        },
        ...report(call++),
      };
    },
  };
}

describe('runDecisionProviderBakeoff', () => {
  it('reports accuracy, calibration and latency for bounded cases', async () => {
    const adapter: DecisionAdapter = {
      provider: 'test',
      model: 'test',
      async evaluate(request) {
        const positive =
          typeof request.state === 'object' &&
          request.state !== null &&
          'positive' in request.state &&
          request.state.positive === true;
        return {
          answers: {
            yes: {
              kind: 'boolean',
              probabilityTrue: positive ? 0.9 : 0.1,
            },
          },
        };
      },
    };

    const result = await runDecisionProviderBakeoff(adapter, [
      {
        id: 'yes',
        request: {
          state: { positive: true },
          questions: { yes: { kind: 'boolean', instructions: 'Positive?' } },
        },
        questionId: 'yes',
        gold: true,
      },
      {
        id: 'no',
        request: {
          state: { positive: false },
          questions: { yes: { kind: 'boolean', instructions: 'Positive?' } },
        },
        questionId: 'yes',
        gold: false,
      },
    ]);

    expect(result.metrics.accuracy).toBe(1);
    expect(result.metrics.brier).toBeCloseTo(0.01);
    expect(result.metrics.ece).toBeCloseTo(0.1);
    expect(result.metrics.selectiveRiskAt80).toBe(0);
  });

  it('keeps each run with its response provenance and labels the aggregate with it', async () => {
    const report = () => ({
      provenance: {
        method: { kind: 'provider-native' },
        functionVersion: '1.0',
        providerArtifactRef: 'databricks:ai_decide:1.0',
      },
    });

    const result = await runDecisionProviderBakeoff(reportingAdapter(report), [
      booleanCase('a', true),
      booleanCase('b', false),
    ]);

    const provenance = {
      method: { kind: 'provider-native' },
      apiDialect: 'databricks-ai-decide-v1',
      requestedModel: 'ai_decide',
      functionVersion: '1.0',
      modelPinning: 'mutable',
      providerArtifactRef: 'databricks:ai_decide:1.0',
    };
    expect(result.provenance).toEqual(provenance);
    expect(result.runs).toEqual([
      {
        caseId: 'a',
        correct: true,
        confidence: 0.9,
        brier: expect.closeTo(0.01),
        latencyMs: expect.any(Number),
        provenance,
      },
      {
        caseId: 'b',
        correct: true,
        confidence: 0.9,
        brier: expect.closeTo(0.01),
        latencyMs: expect.any(Number),
        provenance,
      },
    ]);
  });

  it.each([
    [
      'the returned model',
      (call: number) => ({ modelVersion: `backend-build-${call}` }),
    ],
    [
      'the function version',
      (call: number) => ({
        provenance: {
          method: { kind: 'provider-native' },
          functionVersion: call === 0 ? '1.0' : '1.1',
        },
      }),
    ],
    [
      'the provider artifact',
      (call: number) => ({
        provenance: {
          method: { kind: 'provider-native' },
          providerArtifactRef: `artifact:${call}`,
        },
      }),
    ],
  ])(
    'refuses to aggregate runs whose provenance changes (%s)',
    async (_label, report) => {
      const run = runDecisionProviderBakeoff(reportingAdapter(report), [
        booleanCase('a', true),
        booleanCase('b', false),
      ]);

      await expect(run).rejects.toBeInstanceOf(
        DecisionBenchmarkProvenanceError,
      );
      await expect(run).rejects.toMatchObject({
        cohorts: [{ caseIds: ['a'] }, { caseIds: ['b'] }],
        runs: [{ caseId: 'a' }, { caseId: 'b' }],
      });
    },
  );

  it('refuses an empty case list instead of reporting zero metrics', async () => {
    await expect(
      runDecisionProviderBakeoff(
        reportingAdapter(() => ({})),
        [],
      ),
    ).rejects.toThrow(/at least one case/);
  });

  describe('case checks and scoring', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const routeQuestion = {
      kind: 'choice' as const,
      instructions: 'Which route?',
      options: { billing: 'Billing', support: 'Support' },
    };
    function choiceCase(id: string, gold: string): DecisionBenchmarkCase {
      return {
        id,
        request: { state: { id }, questions: { route: routeQuestion } },
        questionId: 'route',
        gold,
      };
    }
    function choiceAdapter(answer: {
      value: string;
      probabilities: Record<string, number>;
    }): DecisionAdapter {
      return {
        provider: 'test',
        model: 'test',
        async evaluate() {
          return {
            answers: {
              route: { kind: 'choice', confidence: 0.5, ...answer },
            },
          };
        },
      };
    }

    it('scores choice confidence as the probability of the answer given, not the largest one', async () => {
      const result = await runDecisionProviderBakeoff(
        choiceAdapter({
          value: 'billing',
          probabilities: { billing: 0.4, support: 0.6 },
        }),
        [choiceCase('a', 'billing')],
      );

      expect(result.primitive).toBe('choice');
      expect(result.runs[0]).toMatchObject({ correct: true, confidence: 0.4 });
    });

    it('refuses a case list that mixes boolean and choice questions', async () => {
      await expect(
        runDecisionProviderBakeoff(
          choiceAdapter({
            value: 'billing',
            probabilities: { billing: 1, support: 0 },
          }),
          [choiceCase('a', 'billing'), booleanCase('b', true)],
        ),
      ).rejects.toThrow(/mix choice and boolean questions \(case "b"\)/);
    });

    it('refuses a gold label that is not one of the options', async () => {
      const evaluate = vi.fn();
      await expect(
        runDecisionProviderBakeoff(
          { provider: 'test', model: 'test', evaluate },
          [choiceCase('a', 'sales')],
        ),
      ).rejects.toThrow(/case "a" has a gold label that is not one of/);
      expect(evaluate).not.toHaveBeenCalled();
    });

    it('names the case whose evaluation failed and keeps the cause', async () => {
      const cause = new Error('provider down');
      const run = runDecisionProviderBakeoff(
        {
          provider: 'test',
          model: 'test',
          evaluate: vi.fn(async () => {
            throw cause;
          }),
        },
        [choiceCase('first', 'billing')],
      );

      await expect(run).rejects.toThrow(
        'Decision bakeoff case "first" failed.',
      );
      await expect(run).rejects.toMatchObject({ cause });
    });

    it('reports nearest-rank latency percentiles', async () => {
      // started/finished pairs: 10 ms, then 30 ms.
      const now = vi.spyOn(Date, 'now');
      for (const value of [0, 10, 100, 130]) now.mockReturnValueOnce(value);

      const result = await runDecisionProviderBakeoff(
        choiceAdapter({
          value: 'billing',
          probabilities: { billing: 0.9, support: 0.1 },
        }),
        [choiceCase('a', 'billing'), choiceCase('b', 'billing')],
      );

      expect(result.latencyMs).toEqual({ mean: 20, p50: 10, p95: 30 });
    });
  });
});
