import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CAPABILITY_PRELOAD_BATCH_SIZE,
  CAPABILITY_PRELOAD_CALIBRATION_PROFILE,
  CAPABILITY_PRELOAD_WARM_THRESHOLD,
  CAPABILITY_ROUTE_CALIBRATION_PROFILE,
  CAPABILITY_ROUTE_DECISION_NAME,
  CAPABILITY_ROUTE_MIN_CONFIDENCE,
  capabilityPreloadDecision,
  capabilityRouteDecision,
  capabilityRouterEnvShape,
  decideCapabilityPreload,
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

describe('capability route calibration profile', () => {
  it('versions the default threshold without claiming held-out calibration', () => {
    expect(CAPABILITY_ROUTE_CALIBRATION_PROFILE).toMatchObject({
      decisionName: CAPABILITY_ROUTE_DECISION_NAME,
      decisionVersion: '1.0.0',
      primitive: 'boolean',
      questionId: 'needsCapability',
      threshold: CAPABILITY_ROUTE_MIN_CONFIDENCE,
      status: 'provisional',
    });
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
      calibrationProfileRef: CAPABILITY_ROUTE_CALIBRATION_PROFILE.id,
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

  it('stamps the calibration profile only when its threshold decided the verdict', () => {
    expect(
      decideCapabilityRoute(
        evaluation(0.9, 'weather', 0.9),
        capabilities,
        CAPABILITY_ROUTE_MIN_CONFIDENCE,
      ).calibrationProfileRef,
    ).toBe('ixo:calibration:runtime.route-capabilities:provisional-v1');
    expect(
      decideCapabilityRoute(evaluation(0.9, 'weather', 0.9), capabilities, 0.5),
    ).not.toHaveProperty('calibrationProfileRef');
  });

  it('preloads nothing when no capability is needed, even with a confident choice', () => {
    expect(
      decideCapabilityRoute(evaluation(0.2, 'weather', 0.99), capabilities),
    ).toEqual({
      preload: [],
      needsCapability: 0.2,
      capability: 'weather',
      capabilityConfidence: 0.99,
      calibrationProfileRef: CAPABILITY_ROUTE_CALIBRATION_PROFILE.id,
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
      calibrationProfileRef: CAPABILITY_ROUTE_CALIBRATION_PROFILE.id,
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

describe('capabilityPreloadDecision', () => {
  it('asks one boolean per candidate and sends only the message and recent turns as state', () => {
    const request = capabilityPreloadDecision.prepare({
      text: 'Will it rain in Cairo tomorrow?',
      recentTurns: ['user: hi', 'assistant: hello'],
      capabilities,
    });

    expect(request.state).toEqual({
      message: 'Will it rain in Cairo tomorrow?',
      recent: ['user: hi', 'assistant: hello'],
    });
    expect(Object.keys(request.questions)).toEqual(['weather', 'payments']);
    expect(request.questions.weather).toEqual({
      kind: 'boolean',
      instructions: expect.stringContaining(
        '"Weather" can do? Forecasts and conditions.',
      ),
    });
  });

  it('keeps the route name, so a provider route still applies, under a new version', () => {
    expect(capabilityPreloadDecision.name).toBe(CAPABILITY_ROUTE_DECISION_NAME);
    expect(capabilityPreloadDecision.version).not.toBe(
      capabilityRouteDecision.version,
    );
  });

  it('refuses more candidates than one request can ask about', () => {
    const many = Array.from(
      { length: CAPABILITY_PRELOAD_BATCH_SIZE + 1 },
      (_, index) => ({
        name: `plugin-${index}`,
        title: 'Plugin',
        summary: 'Does a thing.',
      }),
    );
    expect(() =>
      capabilityPreloadDecision.prepare({ text: 'Hi', capabilities: many }),
    ).toThrow();
    expect(
      Object.keys(
        capabilityPreloadDecision.prepare({
          text: 'Hi',
          capabilities: many.slice(0, CAPABILITY_PRELOAD_BATCH_SIZE),
        }).questions,
      ),
    ).toHaveLength(CAPABILITY_PRELOAD_BATCH_SIZE);
  });

  it('fails open quickly', () => {
    expect(capabilityPreloadDecision.timeoutMs).toBeLessThanOrEqual(1_000);
  });
});

describe('decideCapabilityPreload', () => {
  const threshold = CAPABILITY_PRELOAD_CALIBRATION_PROFILE.threshold;
  const booleans = (scores: Record<string, number>) =>
    evaluationWith(
      Object.fromEntries(
        Object.entries(scores).map(([name, probabilityTrue]) => [
          name,
          { kind: 'boolean', probabilityTrue },
        ]),
      ),
    );

  it('preloads every capability at or above the threshold, most likely first', () => {
    const verdict = decideCapabilityPreload(
      [booleans({ weather: threshold, payments: 0.9 })],
      capabilities,
    );
    expect(verdict.preload).toEqual(['payments', 'weather']);
    expect(verdict.calibrationProfileRef).toBe(
      CAPABILITY_PRELOAD_CALIBRATION_PROFILE.id,
    );
  });

  it('takes the bar a warm turn asks for, which no calibration profile backs', () => {
    const verdict = decideCapabilityPreload(
      [booleans({ weather: 0.79, payments: 0.8 })],
      capabilities,
      CAPABILITY_PRELOAD_WARM_THRESHOLD,
    );
    expect(verdict.preload).toEqual(['payments']);
    expect(verdict.calibrationProfileRef).toBeUndefined();
  });

  it('reads the warm threshold from the environment as a number, unset by default', () => {
    const schema = z.object(capabilityRouterEnvShape);
    expect(
      schema.parse({ CAPABILITY_ROUTER_WARM_THRESHOLD: '1.5' })
        .CAPABILITY_ROUTER_WARM_THRESHOLD,
    ).toBe(1.5);
    expect(schema.parse({}).CAPABILITY_ROUTER_WARM_THRESHOLD).toBeUndefined();
    // A blank value in a config file means unset, not "preload everything".
    for (const blank of ['', '  '])
      expect(
        schema.parse({ CAPABILITY_ROUTER_WARM_THRESHOLD: blank })
          .CAPABILITY_ROUTER_WARM_THRESHOLD,
      ).toBeUndefined();
    expect(
      schema.safeParse({ CAPABILITY_ROUTER_WARM_THRESHOLD: 'high' }).success,
    ).toBe(false);
  });

  it('preloads nothing just below the threshold but still reports the scores', () => {
    const verdict = decideCapabilityPreload(
      [booleans({ weather: threshold - 0.01, payments: 0.1 })],
      capabilities,
    );
    expect(verdict.preload).toEqual([]);
    expect(verdict.scores).toEqual([
      { name: 'weather', probability: threshold - 0.01 },
      { name: 'payments', probability: 0.1 },
    ]);
  });

  it('merges batches', () => {
    expect(
      decideCapabilityPreload(
        [booleans({ weather: 0.9 }), booleans({ payments: 0.8 })],
        capabilities,
      ).preload,
    ).toEqual(['weather', 'payments']);
  });

  it('throws when a candidate has no boolean answer', () => {
    expect(() =>
      decideCapabilityPreload([booleans({ weather: 0.9 })], capabilities),
    ).toThrow('"payments"');
    expect(() =>
      decideCapabilityPreload(
        [
          evaluationWith({
            weather: { kind: 'boolean', probabilityTrue: 0.9 },
            payments: {
              kind: 'choice',
              value: 'a',
              confidence: 1,
              probabilities: { a: 1 },
            },
          }),
        ],
        capabilities,
      ),
    ).toThrow('"payments"');
  });

  it('marks the threshold provisional and names what it was fitted against', () => {
    expect(CAPABILITY_PRELOAD_CALIBRATION_PROFILE).toMatchObject({
      status: 'provisional',
      decisionName: CAPABILITY_ROUTE_DECISION_NAME,
      decisionVersion: capabilityPreloadDecision.version,
      providerArtifactRef: 'typesafe/jev-1.13',
    });
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
