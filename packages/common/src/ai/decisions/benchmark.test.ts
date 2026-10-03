import { describe, expect, it } from 'vitest';
import { runDecisionProviderBakeoff } from './benchmark.js';
import type { DecisionAdapter } from './types.js';

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
        state: undefined,
        request: {
          state: { positive: true },
          questions: { yes: { kind: 'boolean', instructions: 'Positive?' } },
        },
        questionId: 'yes',
        gold: true,
      } as never,
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
});
