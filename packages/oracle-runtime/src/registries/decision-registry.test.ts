import { defineDecision } from '@ixo/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeBuildCtx, makePlugin } from './test-fixtures.js';
import { DecisionRegistry } from './decision-registry.js';

function decision(name: string) {
  return defineDecision({
    name,
    version: '1.0.0',
    description: `decision ${name}`,
    inputSchema: z.object({ value: z.string() }),
    project: ({ value }) => ({
      state: { value },
      questions: {
        match: {
          kind: 'boolean',
          instructions: 'Does it match?',
        },
      },
    }),
  });
}

describe('DecisionRegistry', () => {
  it('collects decisions with plugin attribution', () => {
    const registry = new DecisionRegistry();
    registry.register(
      makePlugin({
        name: 'commerce',
        getDecisions: () => [decision('commerce.route')],
      }),
    );

    const collected = registry.collect(makeBuildCtx());

    expect(collected).toHaveLength(1);
    expect(collected[0]?.pluginName).toBe('commerce');
    expect(registry.get('commerce.route')?.decision.name).toBe(
      'commerce.route',
    );
  });

  it('rejects decision name collisions across plugins', () => {
    const registry = new DecisionRegistry();
    registry.register(
      makePlugin({
        name: 'a',
        getDecisions: () => [decision('shared.route')],
      }),
    );
    registry.register(
      makePlugin({
        name: 'b',
        getDecisions: () => [decision('shared.route')],
      }),
    );
    registry.collect(makeBuildCtx());

    expect(() => registry.assertNoCollisions()).toThrow(
      /shared\.route.*a.*b/,
    );
  });
});
