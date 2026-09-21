import { defineDecision, type DecisionAdapter } from '@ixo/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DecisionRegistry } from '../registries/decision-registry.js';
import { makeBuildCtx, makePlugin } from '../registries/test-fixtures.js';
import {
  DecisionProviderUnavailableError,
  DecisionRuntime,
} from './decision-runtime.js';
import { DecisionProviderRegistry } from './provider-registry.js';
import { DecisionProviderRouter } from './provider-router.js';

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
        };
      },
    };
    const runtime = new DecisionRuntime(registry(), adapter);

    const result = await runtime.evaluateByName('test.boolean', {
      text: 'yes',
    });

    expect(result.providerId).toBe('legacy');
    expect(result.providerSelection).toBe('default');
    expect(result.provider).toBe('test-provider');
    expect(result.model).toBe('test-model');
    expect(result.modelVersion).toBe('v1');
    expect(result.answers.yes).toEqual({
      kind: 'boolean',
      probabilityTrue: 0.8,
    });
  });

  it('routes by Decision name and allows an explicit provider override', async () => {
    const makeAdapter = (
      provider: string,
      probabilityTrue: number,
    ): DecisionAdapter => ({
      provider,
      model: `${provider}-model`,
      async evaluate() {
        return {
          answers: {
            yes: { kind: 'boolean', probabilityTrue },
          },
        };
      },
    });
    const providers = new DecisionProviderRegistry([
      { id: 'default-provider', adapter: makeAdapter('default', 0.2) },
      { id: 'routed-provider', adapter: makeAdapter('routed', 0.8) },
      { id: 'override-provider', adapter: makeAdapter('override', 0.95) },
    ]);
    const runtime = new DecisionRuntime(
      registry(),
      new DecisionProviderRouter(providers, {
        defaultProviderId: 'default-provider',
        routes: { 'test.boolean': 'routed-provider' },
      }),
    );

    const routed = await runtime.evaluateByName('test.boolean', {
      text: 'yes',
    });
    expect(routed.providerId).toBe('routed-provider');
    expect(routed.providerSelection).toBe('decision-route');

    const overridden = await runtime.evaluateByName(
      'test.boolean',
      { text: 'yes' },
      { providerId: 'override-provider' },
    );
    expect(overridden.providerId).toBe('override-provider');
    expect(overridden.providerSelection).toBe('caller-override');
    expect(overridden.answers.yes).toEqual({
      kind: 'boolean',
      probabilityTrue: 0.95,
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
