import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '../types.js';
import { JevDecisionError } from './wire.js';
import {
  WorkersAiJevDecisionAdapter,
  type WorkersAiBinding,
} from './workers-ai.js';

const request: DecisionRequest = {
  state: { message: 'Please file my taxes.' },
  questions: {
    work: {
      kind: 'boolean',
      instructions: 'Is paid work requested now?',
      criteria: { true: 'Explicit request to perform work' },
    },
    urgency: {
      kind: 'ordinal',
      instructions: 'How urgent is the request?',
      levels: ['low', 'high'],
    },
  },
};

const jevResult = {
  model: 'jev-1.13.0',
  answers: {
    work: { type: 'noul', noul: 0.9 },
    urgency: {
      type: 'score',
      score: 0.7,
      confidence: 0.85,
      legend: { 0: 'low', 1: 'high' },
      probabilities: { 0: 0.3, 1: 0.7 },
    },
  },
};

function binding(run: WorkersAiBinding['run']): WorkersAiBinding {
  return { run };
}

describe('WorkersAiJevDecisionAdapter', () => {
  it('runs the Jev model through the binding and normalizes the result', async () => {
    const run = vi.fn<WorkersAiBinding['run']>(async () => jevResult);
    const adapter = new WorkersAiJevDecisionAdapter({ ai: binding(run) });
    expect(adapter.provider).toBe('cloudflare');
    expect(adapter.model).toBe('typesafe/jev');

    const result = await adapter.evaluate(request);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual([
      'typesafe/jev',
      {
        state: request.state,
        questions: {
          work: {
            type: 'noul',
            instructions:
              'Is paid work requested now?\n' +
              'Answer true when: Explicit request to perform work',
          },
          urgency: {
            type: 'score',
            instructions: 'How urgent is the request?',
            criteria: ['low', 'high'],
          },
        },
      },
    ]);
    expect(result).toEqual({
      modelVersion: 'jev-1.13.0',
      answers: {
        work: { kind: 'boolean', probabilityTrue: 0.9 },
        urgency: {
          kind: 'ordinal',
          score: 0.7,
          confidence: 0.85,
          probabilities: { 0: 0.3, 1: 0.7 },
        },
      },
    });
  });

  it('accepts an enveloped result and a model override', async () => {
    const run = vi.fn<WorkersAiBinding['run']>(async () => ({
      success: true,
      errors: [],
      result: jevResult,
    }));
    const adapter = new WorkersAiJevDecisionAdapter({
      ai: binding(run),
      model: 'typesafe/jev-next',
    });

    const result = await adapter.evaluate(request);

    expect(run.mock.calls[0]?.[0]).toBe('typesafe/jev-next');
    expect(result.answers.work).toEqual({
      kind: 'boolean',
      probabilityTrue: 0.9,
    });
  });

  it('wraps binding failures unless the caller aborted', async () => {
    const failure = new Error('AI binding unavailable');
    const failing = new WorkersAiJevDecisionAdapter({
      ai: binding(async () => {
        throw failure;
      }),
    });
    await expect(failing.evaluate(request)).rejects.toMatchObject({
      name: 'JevDecisionError',
      provider: 'cloudflare',
      cause: failure,
    });

    const controller = new AbortController();
    const aborted = new DOMException('Aborted', 'AbortError');
    const abortedAdapter = new WorkersAiJevDecisionAdapter({
      ai: binding(async () => {
        controller.abort();
        throw aborted;
      }),
    });
    await expect(
      abortedAdapter.evaluate(request, { signal: controller.signal }),
    ).rejects.toBe(aborted);
  });

  it('rejects results that do not match the Jev schema', async () => {
    const adapter = new WorkersAiJevDecisionAdapter({
      ai: binding(async () => ({ answers: { work: { type: 'freeform' } } })),
    });

    await expect(adapter.evaluate(request)).rejects.toBeInstanceOf(
      JevDecisionError,
    );
  });
});
