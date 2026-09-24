import { defineDecision, type DecisionAdapter } from '@ixo/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DecisionRegistry } from '../registries/decision-registry.js';
import { makeBuildCtx, makePlugin } from '../registries/test-fixtures.js';
import {
  DecisionNotApplicableError,
  DecisionProviderUnavailableError,
  DecisionRuntime,
} from './decision-runtime.js';

const decision = defineDecision({
  name: 'test.boolean',
  version: '1.0.0',
  description: 'A test bounded boolean decision.',
  inputSchema: z.object({ text: z.string() }),
  project: ({ text }) => ({
    state: { text },
    questions: {
      yes: {
        kind: 'boolean',
        instructions: 'Is this a yes?',
      },
    },
  }),
});

function registry(): DecisionRegistry {
  const registry = new DecisionRegistry();
  registry.register(
    makePlugin({
      name: 'test',
      getDecisions: () => [decision],
    }),
  );
  registry.collect(makeBuildCtx());
  return registry;
}

describe('DecisionRuntime', () => {
  it('evaluates a registered decision and preserves provenance', async () => {
    const adapter: DecisionAdapter = {
      provider: 'test-provider',
      model: 'test-model',
      async evaluate() {
        return {
          answers: {
            yes: { kind: 'boolean', probabilityTrue: 0.8 },
          },
          modelVersion: 'v1',
          provenance: {
            method: {
              kind: 'specialized',
              name: 'test-head',
              artifactRef: 'artifact:head-v1',
            },
            calibration: {
              method: 'temperature-scaling',
              artifactRef: 'artifact:cal-v1',
              workload: 'test.boolean',
              version: '1',
              evaluatedAt: '2026-09-24T00:00:00.000Z',
              ece: 0.03,
              brier: 0.11,
            },
          },
        };
      },
    };
    const runtime = new DecisionRuntime(registry(), adapter);

    const result = await runtime.evaluateByName('test.boolean', {
      text: 'yes',
    });

    expect(result.provider).toBe('test-provider');
    expect(result.model).toBe('test-model');
    expect(result.modelVersion).toBe('v1');
    expect(result.applicability).toEqual({
      applicable: true,
      evidenceComplete: true,
    });
    expect(result.judgment).toEqual({
      method: {
        kind: 'specialized',
        name: 'test-head',
        artifactRef: 'artifact:head-v1',
      },
      calibration: {
        method: 'temperature-scaling',
        artifactRef: 'artifact:cal-v1',
        workload: 'test.boolean',
        version: '1',
        evaluatedAt: '2026-09-24T00:00:00.000Z',
        ece: 0.03,
        brier: 0.11,
      },
      questionSetVersion: '1.0.0',
    });
    expect(result.answers.yes).toEqual({
      kind: 'boolean',
      probabilityTrue: 0.8,
    });
  });

  it('returns input preparation failures as promise rejections', async () => {
    const runtime = new DecisionRuntime(registry(), {
      provider: 'test-provider',
      model: 'test-model',
      async evaluate() {
        return {
          answers: {
            yes: { kind: 'boolean', probabilityTrue: 0.8 },
          },
        };
      },
    });

    const rejection = runtime.evaluateByName('test.boolean', { text: 123 });

    expect(rejection).toBeInstanceOf(Promise);
    await expect(rejection).rejects.toThrow();
  });

  it('abstains before provider invocation when decision-relevant evidence is incomplete', async () => {
    let calls = 0;
    const incompleteDecision = defineDecision({
      name: 'test.incomplete',
      version: '1.0.0',
      description: 'A decision with unavailable delegated evidence.',
      inputSchema: z.object({ text: z.string() }),
      project: ({ text }) => ({
        state: { text },
        applicability: {
          applicable: true,
          evidenceComplete: false,
          reason: 'Encrypted delegated task is unavailable.',
        },
        questions: {
          yes: {
            kind: 'boolean',
            instructions: 'Is this a yes?',
          },
        },
      }),
    });
    const runtime = new DecisionRuntime(undefined, {
      provider: 'test-provider',
      model: 'test-model',
      async evaluate() {
        calls += 1;
        return {
          answers: {
            yes: { kind: 'boolean', probabilityTrue: 0.8 },
          },
        };
      },
    });

    await expect(
      runtime.evaluate(incompleteDecision, { text: 'yes' }),
    ).rejects.toBeInstanceOf(DecisionNotApplicableError);
    expect(calls).toBe(0);
  });

  it('fails when no decision adapter is configured', async () => {
    const runtime = new DecisionRuntime(registry());

    await expect(
      runtime.evaluate(decision, { text: 'yes' }),
    ).rejects.toBeInstanceOf(DecisionProviderUnavailableError);
  });

  it('rejects provider output outside the declared answer contract', async () => {
    const adapter: DecisionAdapter = {
      provider: 'test-provider',
      model: 'test-model',
      async evaluate() {
        return {
          answers: {
            yes: { kind: 'boolean', probabilityTrue: 1.5 },
          },
        };
      },
    };
    const runtime = new DecisionRuntime(registry(), adapter);

    await expect(runtime.evaluate(decision, { text: 'yes' })).rejects.toThrow(
      /0 to 1/,
    );
  });
});
