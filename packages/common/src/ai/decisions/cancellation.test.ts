import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineDecision } from './define-decision.js';
import { DecisionRuntime } from './runtime.js';
import type { DecisionProviderResult } from './types.js';

const definition = defineDecision({
  name: 'test.cancel',
  version: '1',
  description: 'Cancellation',
  inputSchema: z.object({}),
  project: () => ({
    state: {},
    questions: { ok: { kind: 'boolean', instructions: 'Is it valid?' } },
  }),
});
const answer: DecisionProviderResult = {
  answers: { ok: { kind: 'boolean', probabilityTrue: 1 } },
};

describe('decision cancellation', () => {
  it('never invokes a provider for an already cancelled request', async () => {
    const evaluate = vi.fn(async () => answer);
    const runtime = new DecisionRuntime(undefined, {
      provider: 'test',
      model: 'test',
      evaluate,
    });
    const abort = new AbortController();
    abort.abort(new Error('cancelled'));
    await expect(
      runtime.evaluate(definition, {}, { signal: abort.signal }),
    ).rejects.toThrow('cancelled');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('rejects cancellation even when the adapter ignores its signal', async () => {
    const abort = new AbortController();
    const runtime = new DecisionRuntime(undefined, {
      provider: 'test',
      model: 'test',
      evaluate: async () => {
        abort.abort(new Error('cancelled'));
        return new Promise<DecisionProviderResult>(() => {});
      },
    });
    await expect(
      runtime.evaluate(
        definition,
        {},
        { signal: abort.signal, timeoutMs: 1000 },
      ),
    ).rejects.toThrow('cancelled');
  });

  it('does not accept a result returned after cancellation', async () => {
    const abort = new AbortController();
    const runtime = new DecisionRuntime(undefined, {
      provider: 'test',
      model: 'test',
      evaluate: async () => {
        abort.abort(new Error('cancelled'));
        return answer;
      },
    });
    await expect(
      runtime.evaluate(definition, {}, { signal: abort.signal }),
    ).rejects.toThrow('cancelled');
  });
});
