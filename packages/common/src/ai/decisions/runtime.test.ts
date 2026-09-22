import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineDecision } from './define-decision.js';
import {
  DecisionProviderUnavailableError,
  DecisionRuntime,
  UNAVAILABLE_DECISION_EVALUATOR,
  type DecisionLookup,
} from './runtime.js';
import type { DecisionAdapter } from './types.js';

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

const routeDecision = defineDecision({
  name: 'test.route',
  version: '1.0.0',
  description: 'A test bounded choice decision.',
  inputSchema: z.object({ text: z.string() }),
  project: ({ text }) => ({
    state: { text },
    questions: {
      service: {
        kind: 'choice',
        instructions: 'Which service?',
        options: { tax: 'Tax preparation', none: 'No matching service' },
      },
    },
  }),
});

const lookup: DecisionLookup = {
  get: (name) => (name === decision.name ? { decision } : undefined),
};

function stubAdapter(evaluate: DecisionAdapter['evaluate']): DecisionAdapter {
  return { provider: 'test-provider', model: 'test-model', evaluate };
}

describe('DecisionRuntime', () => {
  it('evaluates a registered decision and preserves provenance', async () => {
    const adapter = stubAdapter(async () => ({
      answers: { yes: { kind: 'boolean', probabilityTrue: 0.8 } },
      modelVersion: 'v1',
      usage: { inputTokens: 12 },
    }));
    const runtime = new DecisionRuntime(lookup, adapter);

    const result = await runtime.evaluateByName('test.boolean', {
      text: 'yes',
    });

    expect(result.decision).toEqual({ name: 'test.boolean', version: '1.0.0' });
    expect(result.provider).toBe('test-provider');
    expect(result.model).toBe('test-model');
    expect(result.modelVersion).toBe('v1');
    expect(result.usage).toEqual({ inputTokens: 12 });
    expect(result.answers.yes).toEqual({
      kind: 'boolean',
      probabilityTrue: 0.8,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(result.evaluatedAt))).toBe(false);
  });

  it('returns input preparation failures as promise rejections', async () => {
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(async () => ({
        answers: { yes: { kind: 'boolean', probabilityTrue: 0.8 } },
      })),
    );

    const rejection = runtime.evaluateByName('test.boolean', { text: 123 });

    expect(rejection).toBeInstanceOf(Promise);
    await expect(rejection).rejects.toThrow();
  });

  it('rejects unknown decision names and a missing lookup', async () => {
    const adapter = stubAdapter(async () => ({ answers: {} }));

    await expect(
      new DecisionRuntime(lookup, adapter).evaluateByName('missing', {}),
    ).rejects.toThrow(/"missing" is not registered/);
    await expect(
      new DecisionRuntime(undefined, adapter).evaluateByName('test.boolean', {
        text: 'yes',
      }),
    ).rejects.toThrow(/No DecisionRegistry/);
  });

  it('fails when no decision adapter is configured', async () => {
    const runtime = new DecisionRuntime(lookup);

    await expect(
      runtime.evaluate(decision, { text: 'yes' }),
    ).rejects.toBeInstanceOf(DecisionProviderUnavailableError);
  });

  it('rejects provider output outside the declared answer contract', async () => {
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(async () => ({
        answers: { yes: { kind: 'boolean', probabilityTrue: 1.5 } },
      })),
    );

    await expect(runtime.evaluate(decision, { text: 'yes' })).rejects.toThrow(
      /0 to 1/,
    );
  });

  it('returns the normalized provider result', async () => {
    const runtime = new DecisionRuntime(
      undefined,
      stubAdapter(async () => ({
        answers: {
          service: {
            kind: 'choice',
            value: 'tax',
            confidence: 0.9,
            probabilities: { tax: 1 },
          },
        },
      })),
    );

    const result = await runtime.evaluate(routeDecision, { text: 'taxes' });

    expect(result.answers.service).toEqual({
      kind: 'choice',
      value: 'tax',
      confidence: 0.9,
      probabilities: { tax: 1, none: 0 },
    });
  });

  it('aborts the adapter and rejects when the timeout elapses', async () => {
    let adapterSignal: AbortSignal | undefined;
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(
        (_request, options) =>
          new Promise(() => {
            adapterSignal = options?.signal;
          }),
      ),
    );

    await expect(
      runtime.evaluate(decision, { text: 'yes' }, { timeoutMs: 10 }),
    ).rejects.toThrow(/timed out after 10ms/);
    expect(adapterSignal?.aborted).toBe(true);
  });

  it('forwards caller aborts to the adapter signal', async () => {
    const controller = new AbortController();
    const runtime = new DecisionRuntime(
      lookup,
      stubAdapter(async (_request, options) => {
        controller.abort(new Error('caller cancelled'));
        if (options?.signal?.aborted) throw options.signal.reason;
        return {
          answers: { yes: { kind: 'boolean', probabilityTrue: 0.8 } },
        };
      }),
    );

    await expect(
      runtime.evaluate(
        decision,
        { text: 'yes' },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/caller cancelled/);
  });
});

describe('UNAVAILABLE_DECISION_EVALUATOR', () => {
  it('rejects every call with DecisionProviderUnavailableError', async () => {
    await expect(
      UNAVAILABLE_DECISION_EVALUATOR.evaluate(decision, { text: 'yes' }),
    ).rejects.toBeInstanceOf(DecisionProviderUnavailableError);
    await expect(
      UNAVAILABLE_DECISION_EVALUATOR.evaluateByName('test.boolean', {}),
    ).rejects.toBeInstanceOf(DecisionProviderUnavailableError);
  });
});
