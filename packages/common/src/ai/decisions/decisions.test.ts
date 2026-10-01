import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineDecision } from './define-decision.js';
import {
  DEFAULT_DECISION_LIMITS,
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

  it('accepts scalar state as well as structured state', () => {
    expect(() =>
      validateDecisionRequest({
        state: 'A short support message',
        questions: {
          urgent: {
            kind: 'boolean',
            instructions: 'Is the message urgent?',
          },
        },
      }),
    ).not.toThrow();
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

  it('caps ordinal levels at the Jev Score limit of 10', () => {
    const levels = (count: number) =>
      Array.from({ length: count }, (_, index) => `level ${index}`);
    const withLevels = (count: number) => ({
      state: {},
      questions: {
        severity: {
          kind: 'ordinal' as const,
          instructions: 'How severe?',
          levels: levels(count),
        },
      },
    });

    expect(DEFAULT_DECISION_LIMITS.maxOrdinalLevels).toBe(10);
    expect(() => validateDecisionRequest(withLevels(10))).not.toThrow();
    expect(() => validateDecisionRequest(withLevels(11))).toThrow(
      /has 11 levels; maximum is 10/,
    );
  });

  it('accepts continuous ordinal scores inside the declared scale', () => {
    const request = {
      state: { text: 'moderately risky' },
      questions: {
        risk: {
          kind: 'ordinal' as const,
          instructions: 'How risky is this?',
          levels: ['low', 'moderate', 'high'],
        },
      },
    };

    expect(() =>
      validateDecisionProviderResult(request, {
        answers: {
          risk: {
            kind: 'ordinal',
            score: 1.4,
            confidence: 0.8,
            probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 },
          },
        },
      }),
    ).not.toThrow();

    expect(() =>
      validateDecisionProviderResult(request, {
        answers: {
          risk: {
            kind: 'ordinal',
            score: 3,
            confidence: 0.8,
            probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 },
          },
        },
      }),
    ).toThrow(/outside 0\.\.2/);
  });

  it('rejects inherited object-property names as undeclared choices', () => {
    const request = routeDecision.prepare({ text: 'file my taxes' });

    expect(() =>
      validateDecisionProviderResult(request, {
        answers: {
          work: { kind: 'boolean', probabilityTrue: 0.95 },
          service: {
            kind: 'choice',
            value: 'constructor',
            confidence: 0.9,
            probabilities: { tax: 0.9, none: 0.1 },
          },
        },
      }),
    ).toThrow(/unknown option/);
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

  it('fills omitted probabilities with zero and returns a copy', () => {
    const request = routeDecision.prepare({ text: 'file my taxes' });
    const providerResult = {
      answers: {
        work: { kind: 'boolean' as const, probabilityTrue: 0.95 },
        service: {
          kind: 'choice' as const,
          value: 'tax',
          confidence: 0.9,
          probabilities: { tax: 1 },
        },
      },
    };

    const normalized = validateDecisionProviderResult(request, providerResult);

    expect(normalized.answers.service).toEqual({
      kind: 'choice',
      value: 'tax',
      confidence: 0.9,
      probabilities: { tax: 1, none: 0 },
    });
    expect(normalized).not.toBe(providerResult);
    expect(providerResult.answers.service.probabilities).toEqual({ tax: 1 });
  });

  it('fills omitted ordinal level probabilities with zero', () => {
    const request = {
      state: 'text',
      questions: {
        risk: {
          kind: 'ordinal' as const,
          instructions: 'How risky is this?',
          levels: ['low', 'moderate', 'high'],
        },
      },
    };

    const normalized = validateDecisionProviderResult(request, {
      answers: {
        risk: {
          kind: 'ordinal',
          score: 1,
          confidence: 0.8,
          probabilities: { '1': 1 },
        },
      },
    });

    expect(normalized.answers.risk).toEqual({
      kind: 'ordinal',
      score: 1,
      confidence: 0.8,
      probabilities: { '0': 0, '1': 1, '2': 0 },
    });
  });

  it('still rejects undeclared probability keys and bad sums', () => {
    const request = routeDecision.prepare({ text: 'file my taxes' });
    const withProbabilities = (probabilities: Record<string, number>) => ({
      answers: {
        work: { kind: 'boolean' as const, probabilityTrue: 0.95 },
        service: {
          kind: 'choice' as const,
          value: 'tax',
          confidence: 0.9,
          probabilities,
        },
      },
    });

    expect(() =>
      validateDecisionProviderResult(
        request,
        withProbabilities({ tax: 0.9, none: 0.1, other: 0 }),
      ),
    ).toThrow(/do not match options/);
    expect(() =>
      validateDecisionProviderResult(request, withProbabilities({ tax: 0.5 })),
    ).toThrow(/sums to 0.5/);

    expect(() =>
      validateDecisionProviderResult(
        {
          state: 'text',
          questions: {
            risk: {
              kind: 'ordinal',
              instructions: 'How risky is this?',
              levels: ['low', 'high'],
            },
          },
        },
        {
          answers: {
            risk: {
              kind: 'ordinal',
              score: 1,
              confidence: 0.8,
              probabilities: { '0': 0, '1': 1, '2': 0 },
            },
          },
        },
      ),
    ).toThrow(/do not match levels/);
  });
});
