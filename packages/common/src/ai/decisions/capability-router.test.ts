import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_ROUTE_DECISION_NAME,
  CAPABILITY_ROUTE_MIN_CONFIDENCE,
  capabilityRouteDecision,
  capabilityRouterEnvShape,
  decideCapabilityRoute,
  noCapabilityOption,
  toRoutableCapabilities,
  type RoutableCapability,
} from './capability-router.js';
import type { DecisionAnswer, DecisionEvaluation } from './types.js';

const capabilities: RoutableCapability[] = [
  { name: 'weather', title: 'Weather', summary: 'Forecasts and conditions.' },
  { name: 'payments', title: 'Payments', summary: 'Charge for services.' },
];

function evaluation(
  probabilityTrue: number,
  value: string,
  confidence: number,
): DecisionEvaluation {
  return evaluationWith({
    needsCapability: { kind: 'boolean', probabilityTrue },
    capability: {
      kind: 'choice',
      value,
      confidence,
      probabilities: { [value]: confidence },
    },
  });
}

function evaluationWith(
  answers: Record<string, DecisionAnswer>,
): DecisionEvaluation {
  return {
    decision: { name: CAPABILITY_ROUTE_DECISION_NAME, version: '1.0.0' },
    provider: 'test',
    model: 'test',
    answers,
    latencyMs: 1,
    evaluatedAt: new Date(0).toISOString(),
  };
}

describe('capabilityRouteDecision', () => {
  it('projects the message, recent turns and capabilities into bounded questions', () => {
    const request = capabilityRouteDecision.prepare({
      text: 'Will it rain in Cairo tomorrow?',
      recentTurns: ['Hi', 'Hello, how can I help?'],
      capabilities,
    });

    expect(request.state).toEqual({
      message: 'Will it rain in Cairo tomorrow?',
      recent: ['Hi', 'Hello, how can I help?'],
      capabilities,
    });
    expect(request.questions.needsCapability).toMatchObject({
      kind: 'boolean',
      criteria: { true: expect.any(String), false: expect.any(String) },
    });
    expect(request.questions.capability).toEqual({
      kind: 'choice',
      instructions: expect.any(String),
      options: {
        weather: 'Weather: Forecasts and conditions.',
        payments: 'Payments: Charge for services.',
        __no_capability__: expect.any(String),
      },
    });
  });

  it('defaults recentTurns to an empty list', () => {
    const request = capabilityRouteDecision.prepare({
      text: 'Hello',
      capabilities,
    });
    expect(request.state).toMatchObject({ recent: [] });
  });

  it('rejects empty text, too many turns and unroutable capability lists', () => {
    expect(() =>
      capabilityRouteDecision.prepare({ text: '', capabilities }),
    ).toThrow();
    expect(() =>
      capabilityRouteDecision.prepare({
        text: 'Hi',
        recentTurns: Array.from({ length: 7 }, () => 'turn'),
        capabilities,
      }),
    ).toThrow();
    expect(() =>
      capabilityRouteDecision.prepare({ text: 'Hi', capabilities: [] }),
    ).toThrow();
    expect(() =>
      capabilityRouteDecision.prepare({
        text: 'Hi',
        capabilities: [{ name: 'weather', title: '', summary: 'x' }],
      }),
    ).toThrow();
    expect(() =>
      capabilityRouteDecision.prepare({
        text: 'Hi',
        capabilities: Array.from({ length: 31 }, (_, index) => ({
          name: `cap-${index}`,
          title: 'Cap',
          summary: 'Summary',
        })),
      }),
    ).toThrow();
  });

  it('keeps the none option collision-free', () => {
    expect(noCapabilityOption(['weather'])).toBe('__no_capability__');
    expect(noCapabilityOption(['__no_capability__'])).toBe(
      '___no_capability__',
    );
    expect(
      noCapabilityOption(['__no_capability__', '___no_capability__']),
    ).toBe('____no_capability__');

    const request = capabilityRouteDecision.prepare({
      text: 'Do something',
      capabilities: [
        { name: '__no_capability__', title: 'Odd', summary: 'Odd name.' },
      ],
    });
    expect(request.questions.capability).toMatchObject({
      options: {
        __no_capability__: 'Odd: Odd name.',
        ___no_capability__: expect.any(String),
      },
    });
  });

  it('carries a tight timeout', () => {
    expect(capabilityRouteDecision.timeoutMs).toBe(2_000);
  });
});

describe('decideCapabilityRoute', () => {
  it('preloads a confidently routed known capability', () => {
    expect(
      decideCapabilityRoute(evaluation(0.9, 'weather', 0.85), capabilities),
    ).toEqual({
      preload: ['weather'],
      needsCapability: 0.9,
      capability: 'weather',
      capabilityConfidence: 0.85,
      reason: 'preload',
    });
  });

  it('preloads exactly at the threshold and not just below it', () => {
    const threshold = CAPABILITY_ROUTE_MIN_CONFIDENCE;
    expect(
      decideCapabilityRoute(
        evaluation(threshold, 'weather', threshold),
        capabilities,
      ).reason,
    ).toBe('preload');
    expect(
      decideCapabilityRoute(
        evaluation(threshold - 0.01, 'weather', threshold),
        capabilities,
      ).reason,
    ).toBe('no-capability');
    expect(
      decideCapabilityRoute(
        evaluation(threshold, 'weather', threshold - 0.01),
        capabilities,
      ).reason,
    ).toBe('low-confidence');
  });

  it('honours a caller-supplied threshold', () => {
    expect(
      decideCapabilityRoute(evaluation(0.6, 'weather', 0.6), capabilities, 0.5)
        .reason,
    ).toBe('preload');
    expect(
      decideCapabilityRoute(evaluation(0.9, 'weather', 0.9), capabilities, 0.95)
        .reason,
    ).toBe('no-capability');
  });

  it('preloads nothing when no capability is needed, even with a confident choice', () => {
    expect(
      decideCapabilityRoute(evaluation(0.2, 'weather', 0.99), capabilities),
    ).toEqual({
      preload: [],
      needsCapability: 0.2,
      capability: 'weather',
      capabilityConfidence: 0.99,
      reason: 'no-capability',
    });
  });

  it('preloads nothing when the choice is not confident enough', () => {
    expect(
      decideCapabilityRoute(evaluation(0.9, 'payments', 0.4), capabilities),
    ).toMatchObject({
      preload: [],
      capability: 'payments',
      reason: 'low-confidence',
    });
  });

  it('preloads nothing for the none option and omits the capability field', () => {
    expect(
      decideCapabilityRoute(
        evaluation(0.9, '__no_capability__', 0.9),
        capabilities,
      ),
    ).toEqual({
      preload: [],
      needsCapability: 0.9,
      capabilityConfidence: 0.9,
      reason: 'none-option',
    });
  });

  it('recognises the shifted none option when a plugin uses the default key', () => {
    const odd: RoutableCapability[] = [
      { name: '__no_capability__', title: 'Odd', summary: 'Odd name.' },
    ];
    expect(
      decideCapabilityRoute(evaluation(0.9, '___no_capability__', 0.9), odd)
        .reason,
    ).toBe('none-option');
    expect(
      decideCapabilityRoute(evaluation(0.9, '__no_capability__', 0.9), odd),
    ).toMatchObject({ preload: ['__no_capability__'], reason: 'preload' });
  });

  it('preloads nothing for a value that is not a listed capability', () => {
    expect(
      decideCapabilityRoute(evaluation(0.95, 'toString', 0.95), capabilities),
    ).toMatchObject({
      preload: [],
      capability: 'toString',
      reason: 'unknown-capability',
    });
    expect(
      decideCapabilityRoute(evaluation(0.95, 'weather', 0.95), []),
    ).toMatchObject({ preload: [], reason: 'unknown-capability' });
  });

  it('throws when the answers are not the expected kinds', () => {
    expect(() =>
      decideCapabilityRoute(
        evaluationWith({
          needsCapability: {
            kind: 'choice',
            value: 'yes',
            confidence: 1,
            probabilities: { yes: 1 },
          },
          capability: {
            kind: 'choice',
            value: 'weather',
            confidence: 1,
            probabilities: { weather: 1 },
          },
        }),
        capabilities,
      ),
    ).toThrow(/needsCapability/);
    expect(() =>
      decideCapabilityRoute(
        evaluationWith({
          needsCapability: { kind: 'boolean', probabilityTrue: 1 },
        }),
        capabilities,
      ),
    ).toThrow(/capability/);
  });
});

describe('toRoutableCapabilities', () => {
  it('drops entries missing a title or summary and trims the rest', () => {
    expect(
      toRoutableCapabilities([
        { name: ' weather ', title: ' Weather ', summary: ' Forecasts. ' },
        { name: 'no-title', summary: 'Has a summary only.' },
        { name: 'no-summary', title: 'Has a title only' },
        { name: 'blank', title: '   ', summary: 'Whitespace title.' },
        { name: '  ', title: 'Blank name', summary: 'Cannot be an option.' },
      ]),
    ).toEqual([{ name: 'weather', title: 'Weather', summary: 'Forecasts.' }]);
  });

  it('caps at 30 entries preserving order', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      name: `cap-${index}`,
      title: `Cap ${index}`,
      summary: 'Summary',
    }));
    const routable = toRoutableCapabilities(many);
    expect(routable).toHaveLength(30);
    expect(routable[0]!.name).toBe('cap-0');
    expect(routable[29]!.name).toBe('cap-29');
    expect(() =>
      capabilityRouteDecision.prepare({ text: 'Hi', capabilities: routable }),
    ).not.toThrow();
  });
});

describe('capabilityRouterEnvShape', () => {
  it('defaults CAPABILITY_ROUTER to off and rejects unknown modes', () => {
    expect(capabilityRouterEnvShape.CAPABILITY_ROUTER.parse(undefined)).toBe(
      'off',
    );
    expect(capabilityRouterEnvShape.CAPABILITY_ROUTER.parse('shadow')).toBe(
      'shadow',
    );
    expect(capabilityRouterEnvShape.CAPABILITY_ROUTER.parse('on')).toBe('on');
    expect(() =>
      capabilityRouterEnvShape.CAPABILITY_ROUTER.parse('always'),
    ).toThrow();
  });
});
