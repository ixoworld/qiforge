import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineDecision } from './define-decision.js';
import {
  validateDecisionProviderResult,
  validateDecisionRequest,
} from './validation.js';

const routeDecision = defineDecision({
  name: 'test.route',
  version: '1.0.0',
  description: 'Choose whether a request is work.',
  inputSchema: z.object({ text: z.string() }),
  project(input) {
    return {
      state: { text: input.text },
      questions: {
        work: {
          kind: 'boolean',
          instructions: 'Is this an explicit work request?',
        },
        service: {
          kind: 'choice',
          instructions: 'Which service matches?',
          options: {
            tax: 'Tax preparation',
            none: 'No matching service',
          },
        },
      },
    };
  },
});

describe('bounded decisions', () => {
  it('validates input before projecting a request', () => {
    expect(() => routeDecision.prepare({ text: 123 })).toThrow();
    expect(routeDecision.prepare({ text: 'file my taxes' }).state).toEqual({
      text: 'file my taxes',
    });
  });

  it('rejects unbounded or malformed requests', () => {
    expect(() =>
      validateDecisionRequest({
        state: {},
        questions: {},
      }),
    ).toThrow(/at least one question/);

    expect(() =>
      validateDecisionRequest({
        state: {},
        questions: {
          route: {
            kind: 'choice',
            instructions: 'Choose',
            options: { only: 'Only option' },
          },
        },
      }),
    ).toThrow(/at least two options/);
  });

  it('validates provider answers against the declared question space', () => {
    const request = routeDecision.prepare({ text: 'file my taxes' });

    expect(() =>
      validateDecisionProviderResult(request, {
        answers: {
          work: { kind: 'boolean', probabilityTrue: 0.95 },
          service: {
            kind: 'choice',
            value: 'tax',
            confidence: 0.9,
            probabilities: { tax: 0.9, none: 0.1 },
          },
        },
      }),
    ).not.toThrow();

    expect(() =>
      validateDecisionProviderResult(request, {
        answers: {
          work: { kind: 'boolean', probabilityTrue: 1.2 },
          service: {
            kind: 'choice',
            value: 'tax',
            confidence: 0.9,
            probabilities: { tax: 0.9, none: 0.1 },
          },
        },
      }),
    ).toThrow(/0 to 1/);
  });
});
