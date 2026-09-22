import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '../types.js';
import {
  JevDecisionError,
  normalizeJevResult,
  parseJevResult,
  jevResultSchema,
  toJevQuestions,
  unwrapCloudflareEnvelope,
} from './wire.js';

const request: DecisionRequest = {
  state: { message: 'Please file my taxes.' },
  questions: {
    work: {
      kind: 'boolean',
      instructions: 'Is paid work requested now?',
      criteria: {
        true: 'Explicit request to perform work',
        false: 'Question or support request',
      },
    },
    plain: {
      kind: 'boolean',
      instructions: 'Is this a greeting?',
    },
    service: {
      kind: 'choice',
      instructions: 'Which service matches?',
      options: { tax: 'Tax preparation', none: 'No matching service' },
    },
    urgency: {
      kind: 'ordinal',
      instructions: 'How urgent is the request?',
      levels: ['low', 'medium', 'high'],
    },
  },
};

describe('toJevQuestions', () => {
  it('folds boolean criteria into noul instructions without a criteria field', () => {
    const questions = toJevQuestions(request);

    expect(questions.work).toEqual({
      type: 'noul',
      instructions:
        'Is paid work requested now?\n' +
        'Answer true when: Explicit request to perform work\n' +
        'Answer false when: Question or support request',
    });
    expect(questions.work).not.toHaveProperty('criteria');
    expect(questions.plain).toEqual({
      type: 'noul',
      instructions: 'Is this a greeting?',
    });
  });

  it('maps choice options and ordinal levels to criteria', () => {
    const questions = toJevQuestions(request);

    expect(questions.service).toEqual({
      type: 'choice',
      instructions: 'Which service matches?',
      criteria: { tax: 'Tax preparation', none: 'No matching service' },
    });
    expect(questions.urgency).toEqual({
      type: 'score',
      instructions: 'How urgent is the request?',
      criteria: ['low', 'medium', 'high'],
    });
  });
});

describe('normalizeJevResult', () => {
  it('normalizes noul, choice and score answers', () => {
    const parsed = jevResultSchema.parse({
      model: 'jev-1.13.0',
      answers: {
        work: { type: 'noul', noul: 0.98 },
        service: {
          type: 'choice',
          choice: 'tax',
          confidence: 0.95,
          probabilities: { tax: 0.95, none: 0.05 },
        },
        urgency: {
          type: 'score',
          score: 1.4,
          confidence: 0.82,
          legend: { 0: 'low', 1: 'medium', 2: 'high' },
          probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 },
        },
        mood: { type: 'score', score: 0.2, confidence: 0.6 },
      },
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    expect(normalizeJevResult(parsed)).toEqual({
      modelVersion: 'jev-1.13.0',
      answers: {
        work: { kind: 'boolean', probabilityTrue: 0.98 },
        service: {
          kind: 'choice',
          value: 'tax',
          confidence: 0.95,
          probabilities: { tax: 0.95, none: 0.05 },
        },
        urgency: {
          kind: 'ordinal',
          score: 1.4,
          confidence: 0.82,
          probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 },
        },
        mood: { kind: 'ordinal', score: 0.2, confidence: 0.6 },
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  it('accepts OpenRouter usage aliases and ignores extra fields', () => {
    const result = parseJevResult(
      {
        model: 'typesafe/jev-1.13',
        provider: 'TypeSafe',
        answers: { work: { type: 'noul', noul: 0.5, extra: true } },
        usage: { prompt_tokens: 40, completion_tokens: 4, cost: 0.0001 },
      },
      'openrouter',
    );

    expect(result).toEqual({
      modelVersion: 'typesafe/jev-1.13',
      answers: { work: { kind: 'boolean', probabilityTrue: 0.5 } },
      usage: { inputTokens: 40, outputTokens: 4 },
    });
  });

  it('omits usage when the provider reports none', () => {
    const result = parseJevResult(
      { answers: { work: { type: 'noul', noul: 0.5 } } },
      'cloudflare',
    );

    expect(result).toEqual({
      answers: { work: { kind: 'boolean', probabilityTrue: 0.5 } },
    });
  });
});

describe('unwrapCloudflareEnvelope', () => {
  it('returns non-envelope payloads untouched and unwraps result', () => {
    const direct = { answers: {} };
    expect(unwrapCloudflareEnvelope(direct, 'cloudflare')).toBe(direct);
    expect(unwrapCloudflareEnvelope('text', 'cloudflare')).toBe('text');
    expect(
      unwrapCloudflareEnvelope(
        { success: true, errors: [], result: direct },
        'cloudflare',
      ),
    ).toBe(direct);
  });

  it('turns rejected envelopes into JevDecisionError with the first code', () => {
    let error: unknown;
    try {
      unwrapCloudflareEnvelope(
        { success: false, errors: [{ code: 1001, message: 'nope' }] },
        'cloudflare',
        401,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(JevDecisionError);
    expect(error).toMatchObject({
      name: 'JevDecisionError',
      provider: 'cloudflare',
      status: 401,
      code: 1001,
    });
  });

  it('rejects envelopes without a result', () => {
    expect(() =>
      unwrapCloudflareEnvelope({ success: true, errors: [] }, 'cloudflare'),
    ).toThrow(JevDecisionError);
  });
});

describe('parseJevResult', () => {
  it('rejects unknown answer types', () => {
    expect(() =>
      parseJevResult(
        { answers: { work: { type: 'freeform', text: 'yes' } } },
        'openrouter',
        200,
      ),
    ).toThrow(JevDecisionError);
  });

  it('never echoes provider payloads in error messages', () => {
    const sensitive = 'private-marker-that-must-not-leak';
    const attempts = [
      () =>
        parseJevResult(
          { success: false, errors: [{ code: 7, message: sensitive }] },
          'cloudflare',
        ),
      () => parseJevResult({ answers: { work: sensitive } }, 'openrouter'),
      () => parseJevResult(sensitive, 'cloudflare'),
    ];

    for (const attempt of attempts) {
      let error: unknown;
      try {
        attempt();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(JevDecisionError);
      expect(String(error)).not.toContain(sensitive);
    }
  });
});
