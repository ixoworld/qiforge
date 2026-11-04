import {
  AmbiguousDecisionProviderError,
  CAPABILITY_PRELOAD_BATCH_SIZE,
  CAPABILITY_PRELOAD_CALIBRATION_PROFILE,
  CAPABILITY_PRELOAD_WARM_THRESHOLD,
  CAPABILITY_ROUTE_DECISION_NAME,
  DecisionProviderUnavailableError,
  capabilityPreloadDecision,
  type DecisionAnswer,
  type DecisionEvaluation,
  type DecisionEvaluator,
} from '@ixo/common/ai/decisions';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../plugin-api/types';
import {
  capabilityRouterMode,
  createCapabilityRouter,
  preloadThreshold,
  routableCandidates,
  shadowAgreement,
  type CapabilityRouteTurn,
} from './capability-router';
import type { RegisteredManifest } from './registries';
import { makeManifest } from './test-fixtures';

const MESSAGE = 'Will it rain in Cairo tomorrow?';

/** What the build found left to load (`createMainAgent`). */
const manifests: RegisteredManifest[] = [
  {
    pluginName: 'weather',
    manifest: makeManifest({
      title: 'Weather',
      summary: 'Forecasts and conditions.',
      visibility: 'on-demand',
    }),
  },
  {
    pluginName: 'payments',
    manifest: makeManifest({
      title: 'Payments',
      summary: 'Charge for services.',
      // Default visibility: on-demand.
      visibility: undefined,
    }),
  },
];

function evaluation(
  capabilities: ReadonlyArray<{ name: string }>,
  scores: Record<string, number>,
): DecisionEvaluation {
  const answers: Record<string, DecisionAnswer> = Object.fromEntries(
    capabilities.map(({ name }) => [
      name,
      { kind: 'boolean', probabilityTrue: scores[name] ?? 0 },
    ]),
  );
  return {
    decision: {
      name: capabilityPreloadDecision.name,
      version: capabilityPreloadDecision.version,
    },
    provider: 'stub',
    model: 'stub-model',
    answers,
    latencyMs: 7,
    evaluatedAt: '2026-09-22T00:00:00.000Z',
  };
}

/** An evaluator body answering every offered candidate: `scores`, else 0. */
function scored(scores: Record<string, number>) {
  return async (...args: unknown[]): Promise<DecisionEvaluation> => {
    const { capabilities } = args[1] as {
      capabilities: Array<{ name: string }>;
    };
    return evaluation(capabilities, scores);
  };
}

function evaluatorOf(
  evaluate: (...args: unknown[]) => Promise<DecisionEvaluation>,
): DecisionEvaluator & { evaluate: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(evaluate);
  return {
    evaluate: fn,
    evaluateByName: vi.fn(async () => {
      throw new Error('not used');
    }),
  };
}

function loggerSpy() {
  return {
    log: vi.fn<Logger['log']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
  };
}

function turn(
  overrides: Partial<CapabilityRouteTurn> = {},
): CapabilityRouteTurn {
  return {
    mode: 'on',
    candidates: manifests,
    text: MESSAGE,
    requestId: 'req-1',
    ...overrides,
  };
}

describe('capabilityRouterMode', () => {
  it('accepts the three modes and treats anything else as off', () => {
    expect(capabilityRouterMode('on')).toBe('on');
    expect(capabilityRouterMode('shadow')).toBe('shadow');
    expect(capabilityRouterMode('off')).toBe('off');
    expect(capabilityRouterMode(undefined)).toBe('off');
    expect(capabilityRouterMode('yes')).toBe('off');
  });
});

describe('preloadThreshold', () => {
  it('asks a warm turn for more, and leaves a cold turn to the calibration profile', () => {
    expect(preloadThreshold(false, {})).toEqual({
      threshold: CAPABILITY_PRELOAD_WARM_THRESHOLD,
    });
    expect(preloadThreshold(true, {})).toEqual({});
  });

  it('takes the operator value for the kind of turn', () => {
    const env = {
      CAPABILITY_ROUTER_COLD_THRESHOLD: 0.5,
      CAPABILITY_ROUTER_WARM_THRESHOLD: 1.1,
    };
    expect(preloadThreshold(true, env)).toEqual({ threshold: 0.5 });
    expect(preloadThreshold(false, env)).toEqual({ threshold: 1.1 });
  });
});

describe('routableCandidates', () => {
  it('describes a plugin by its summary and whenToUse lines', () => {
    const [candidate] = routableCandidates([
      {
        pluginName: 'tokens',
        manifest: makeManifest({
          title: 'Tokens',
          summary: 'Moves tokens.',
          whenToUse: ['The user asks to send.', 'The user asks to retire.'],
          visibility: 'on-demand',
        }),
      },
    ]);
    expect(candidate?.summary).toBe(
      'Moves tokens. Use when: The user asks to send. The user asks to retire.',
    );
  });

  it('keeps the summary alone when a manifest has no whenToUse lines', () => {
    const [candidate] = routableCandidates([
      {
        pluginName: 'tokens',
        manifest: makeManifest({
          summary: 'Moves tokens.',
          whenToUse: [],
          visibility: 'on-demand',
        }),
      },
    ]);
    expect(candidate?.summary).toBe('Moves tokens.');
  });
});

describe('createCapabilityRouter', () => {
  it('off: never evaluates', async () => {
    const evaluator = evaluatorOf(scored({ weather: 1 }));
    const route = createCapabilityRouter({ evaluator, logger: loggerSpy() });

    expect(await route(turn({ mode: 'off' }))).toEqual(new Set());
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it('skips when nothing is routable or the message is blank', async () => {
    const evaluator = evaluatorOf(scored({ weather: 1 }));
    const route = createCapabilityRouter({ evaluator, logger: loggerSpy() });

    expect(await route(turn({ candidates: [] }))).toEqual(new Set());
    expect(await route(turn({ text: '   ' }))).toEqual(new Set());
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it('on: preloads every plugin at or above the threshold, likeliest first in the log', async () => {
    const threshold = CAPABILITY_PRELOAD_CALIBRATION_PROFILE.threshold;
    const evaluator = evaluatorOf(
      scored({ payments: threshold, weather: 0.92 }),
    );
    const logger = loggerSpy();
    const signal = new AbortController().signal;
    let clock = 1_000;
    const route = createCapabilityRouter({
      evaluator,
      logger,
      now: () => {
        clock += 40;
        return clock;
      },
    });

    expect(await route(turn({ signal }))).toEqual(
      new Set(['weather', 'payments']),
    );

    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    const [definition, input, options] = evaluator.evaluate.mock.calls[0] ?? [];
    expect(definition).toBe(capabilityPreloadDecision);
    expect(input).toEqual({
      text: MESSAGE,
      recentTurns: [],
      capabilities: routableCandidates(manifests),
    });
    expect(options).toEqual({ signal });
    expect(logger.log).toHaveBeenCalledWith(
      `[capability-router] request=req-1 mode=on status=ok preloaded=[weather, payments] top=weather:0.92,payments:${threshold.toFixed(2)} threshold=profile candidates=2 recentTurns=0 latencyMs=40`,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('on: preloads nothing just below the threshold, and logs the scores for refitting', async () => {
    const below = CAPABILITY_PRELOAD_CALIBRATION_PROFILE.threshold - 0.01;
    const evaluator = evaluatorOf(scored({ weather: below }));
    const logger = loggerSpy();
    const route = createCapabilityRouter({
      evaluator,
      logger,
      now: () => 1_000,
    });

    expect(await route(turn())).toEqual(new Set());

    expect(logger.log).toHaveBeenCalledWith(
      `[capability-router] request=req-1 mode=on status=none preloaded=[] top=weather:${below.toFixed(2)},payments:0.00 threshold=profile candidates=2 recentTurns=0 latencyMs=0`,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('on: a warm turn asks for the threshold it is given', async () => {
    const evaluator = evaluatorOf(scored({ payments: 0.79, weather: 0.8 }));
    const logger = loggerSpy();
    const route = createCapabilityRouter({
      evaluator,
      logger,
      now: () => 1_000,
    });

    expect(await route(turn({ threshold: 0.8 }))).toEqual(new Set(['weather']));
    expect(logger.log).toHaveBeenCalledWith(
      '[capability-router] request=req-1 mode=on status=ok preloaded=[weather] top=weather:0.80,payments:0.79 threshold=0.8 candidates=2 recentTurns=0 latencyMs=0',
    );
  });

  it('does not evaluate at a threshold no score can reach', async () => {
    const evaluator = evaluatorOf(scored({ weather: 1 }));
    const route = createCapabilityRouter({ evaluator, logger: loggerSpy() });

    expect(await route(turn({ threshold: 1.1 }))).toEqual(new Set());
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it('on: a verdict missing a candidate preloads nothing, with a warning', async () => {
    const evaluator = evaluatorOf(async () =>
      evaluation([{ name: 'weather' }], { weather: 1 }),
    );
    const logger = loggerSpy();
    const route = createCapabilityRouter({ evaluator, logger });

    expect(await route(turn())).toEqual(new Set());

    expect(logger.warn).toHaveBeenCalledWith(
      '[capability-router] request=req-1 mode=on status=fallback reason=Error',
    );
  });

  it('on: evaluates candidates past the question limit in batches and merges them', async () => {
    const count = CAPABILITY_PRELOAD_BATCH_SIZE + 2;
    const many: RegisteredManifest[] = Array.from(
      { length: count },
      (_, index) => ({
        pluginName: `plugin-${index}`,
        manifest: makeManifest({
          title: `Plugin ${index}`,
          summary: `Does thing ${index}.`,
          visibility: 'on-demand',
        }),
      }),
    );
    const last = `plugin-${count - 1}`;
    const evaluator = evaluatorOf(scored({ 'plugin-0': 0.9, [last]: 0.8 }));
    const route = createCapabilityRouter({ evaluator, logger: loggerSpy() });

    expect(await route(turn({ candidates: many }))).toEqual(
      new Set(['plugin-0', last]),
    );

    const sizes = evaluator.evaluate.mock.calls.map(
      (call) => (call[1] as { capabilities: unknown[] }).capabilities.length,
    );
    expect(sizes).toEqual([CAPABILITY_PRELOAD_BATCH_SIZE, 2]);
  });

  it('on: one failed batch preloads nothing', async () => {
    const many: RegisteredManifest[] = Array.from(
      { length: CAPABILITY_PRELOAD_BATCH_SIZE + 1 },
      (_, index) => ({
        pluginName: `plugin-${index}`,
        manifest: makeManifest({ visibility: 'on-demand' }),
      }),
    );
    const answer = scored({ 'plugin-0': 0.9 });
    let calls = 0;
    const evaluator = evaluatorOf(async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('second batch failed');
      return answer(...args);
    });
    const logger = loggerSpy();
    const route = createCapabilityRouter({ evaluator, logger });

    expect(await route(turn({ candidates: many }))).toEqual(new Set());
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('on: routes on the recent turns it is given, read only when it evaluates', async () => {
    const evaluator = evaluatorOf(scored({ weather: 0.9 }));
    const logger = loggerSpy();
    const route = createCapabilityRouter({
      evaluator,
      logger,
      now: () => 1_000,
    });
    const recentTurns = vi.fn(async () => [
      'user: rain in Cairo?',
      'assistant: Light rain.',
    ]);

    await route(turn({ mode: 'off', recentTurns }));
    await route(turn({ text: '   ', recentTurns }));
    await route(turn({ candidates: [], recentTurns }));
    expect(recentTurns).not.toHaveBeenCalled();

    await route(turn({ text: 'and tomorrow?', recentTurns }));

    expect(recentTurns).toHaveBeenCalledTimes(1);
    expect(evaluator.evaluate.mock.lastCall?.[1]).toMatchObject({
      text: 'and tomorrow?',
      recentTurns: ['user: rain in Cairo?', 'assistant: Light rain.'],
    });
    expect(logger.log.mock.lastCall?.[0]).toContain('recentTurns=2');
  });

  it('on: recent turns that cannot be read leave the message to route alone', async () => {
    const failure = new Error(`disk error near "${MESSAGE}"`);
    const evaluator = evaluatorOf(scored({ weather: 0.9 }));
    const logger = loggerSpy();
    const route = createCapabilityRouter({ evaluator, logger });

    expect(
      await route(
        turn({
          recentTurns: async () => {
            throw failure;
          },
        }),
      ),
    ).toEqual(new Set(['weather']));

    expect(evaluator.evaluate.mock.calls[0]?.[1]).toMatchObject({
      recentTurns: [],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[capability-router] request=req-1 mode=on status=degraded reason=Error (recent turns unavailable)',
    );
    expect(String(logger.warn.mock.calls[0]?.[0])).not.toContain('Cairo');
  });

  it('on: any evaluation failure falls back to no preload with one warning that never carries the message', async () => {
    const timeout = new Error(`timed out evaluating "${MESSAGE}"`);
    timeout.name = 'TimeoutError';
    const evaluator = evaluatorOf(async () => {
      throw timeout;
    });
    const logger = loggerSpy();
    const route = createCapabilityRouter({ evaluator, logger });

    expect(await route(turn())).toEqual(new Set());
    expect(await route(turn({ requestId: 'req-2' }))).toEqual(new Set());

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      '[capability-router] request=req-1 mode=on status=fallback reason=TimeoutError',
    );
    for (const [line] of logger.warn.mock.calls) {
      expect(String(line)).not.toContain('Cairo');
    }
  });

  it('on: a missing Decision provider is reported once per router', async () => {
    const evaluator = evaluatorOf(async () => {
      throw new DecisionProviderUnavailableError();
    });
    const logger = loggerSpy();
    const route = createCapabilityRouter({ evaluator, logger });

    expect(await route(turn())).toEqual(new Set());
    expect(await route(turn({ requestId: 'req-2' }))).toEqual(new Set());

    expect(evaluator.evaluate).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain(
      'request=req-1 mode=on status=fallback reason=DecisionProviderUnavailableError',
    );
  });

  it('on: an ambiguous provider configuration fails open like a missing provider', async () => {
    const evaluator = evaluatorOf(async () => {
      throw new AmbiguousDecisionProviderError(CAPABILITY_ROUTE_DECISION_NAME, [
        'a',
        'b',
      ]);
    });
    const logger = loggerSpy();
    const route = createCapabilityRouter({ evaluator, logger });

    expect(await route(turn())).toEqual(new Set());
    expect(await route(turn({ requestId: 'req-2' }))).toEqual(new Set());

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain(
      'request=req-1 mode=on status=fallback reason=AmbiguousDecisionProviderError (route runtime.route-capabilities or set decisionProviderPolicy.defaultProviderId)',
    );
  });

  it('hands the turn trace to the evaluation, with the signal only when awaited', async () => {
    const trace = {
      callbacks: [{ handleChainStart: () => undefined }],
      metadata: { user_did: 'did:test:user', thread_id: 'session-1' },
    };
    const signal = new AbortController().signal;

    const live = evaluatorOf(scored({ weather: 0.92 }));
    await createCapabilityRouter({ evaluator: live, logger: loggerSpy() })(
      turn({ signal, trace }),
    );
    expect(live.evaluate.mock.calls[0]?.[2]).toEqual({ ...trace, signal });

    const shadow = evaluatorOf(scored({ weather: 0.92 }));
    await createCapabilityRouter({
      evaluator: shadow,
      logger: loggerSpy(),
      background: vi.fn(),
    })(turn({ mode: 'shadow', signal, trace }));
    expect(shadow.evaluate.mock.calls[0]?.[2]).toEqual(trace);
  });

  it('shadow: returns at once, never awaits the evaluation, and is not bound to the turn signal', async () => {
    const evaluator = evaluatorOf(
      () => new Promise<DecisionEvaluation>(() => {}),
    );
    const logger = loggerSpy();
    const background = vi.fn();
    const route = createCapabilityRouter({ evaluator, logger, background });

    expect(
      await route(
        turn({ mode: 'shadow', signal: new AbortController().signal }),
      ),
    ).toEqual(new Set());

    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    expect(evaluator.evaluate.mock.calls[0]?.[2]).toBeUndefined();
    expect(background).toHaveBeenCalledTimes(1);
    expect(background.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('shadow: a slow recent-turns read does not hold the turn', async () => {
    const evaluator = evaluatorOf(scored({ weather: 0.9 }));
    const background = vi.fn();
    const route = createCapabilityRouter({
      evaluator,
      logger: loggerSpy(),
      background,
    });

    expect(
      await route(
        turn({
          mode: 'shadow',
          recentTurns: () => new Promise<string[]>(() => {}),
        }),
      ),
    ).toEqual(new Set());

    expect(background).toHaveBeenCalledTimes(1);
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it('shadow: logs the verdict when it lands and hands the prediction to the host', async () => {
    const evaluator = evaluatorOf(scored({ weather: 0.92 }));
    const logger = loggerSpy();
    let pending: Promise<unknown> | undefined;
    let clock = 1_000;
    const route = createCapabilityRouter({
      evaluator,
      logger,
      background: (work) => {
        pending = work;
      },
      now: () => {
        clock += 40;
        return clock;
      },
    });
    const onShadowVerdict = vi.fn();

    expect(await route(turn({ mode: 'shadow', onShadowVerdict }))).toEqual(
      new Set(),
    );
    await pending;

    expect(logger.log).toHaveBeenCalledWith(
      '[capability-router-shadow] request=req-1 status=ok ' +
        'top=weather:0.92,payments:0.00 wouldPreload=[weather] threshold=profile ' +
        `calibrationProfile=${CAPABILITY_PRELOAD_CALIBRATION_PROFILE.id} ` +
        'latencyMs=40 provider=stub model=stub-model',
    );
    expect(onShadowVerdict).toHaveBeenCalledWith(['weather']);
  });

  it('shadow: a failed evaluation logs its error type only', async () => {
    const failure = new Error(`upstream 500 for "${MESSAGE}"`);
    failure.name = 'DecisionProviderError';
    const evaluator = evaluatorOf(async () => {
      throw failure;
    });
    const logger = loggerSpy();
    let pending: Promise<unknown> | undefined;
    const route = createCapabilityRouter({
      evaluator,
      logger,
      background: (work) => {
        pending = work;
      },
    });
    const onShadowVerdict = vi.fn();

    await route(turn({ mode: 'shadow', onShadowVerdict }));
    await pending;

    expect(logger.log).toHaveBeenCalledTimes(1);
    const line = String(logger.log.mock.calls[0]?.[0]);
    expect(line).toContain(
      '[capability-router-shadow] request=req-1 status=failed errorType=DecisionProviderError',
    );
    expect(line).not.toContain('Cairo');
    expect(onShadowVerdict).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('shadowAgreement', () => {
  it('compares what the turn loaded on its own with the prediction', () => {
    const priorLoaded = new Set(['memory']);
    expect(
      shadowAgreement({
        priorLoaded,
        loadedAfter: new Set(['memory', 'weather']),
        wouldPreload: ['weather'],
      }),
    ).toEqual({ loadedDuringTurn: ['weather'], agree: true });
    expect(
      shadowAgreement({
        priorLoaded,
        loadedAfter: new Set(['memory']),
        wouldPreload: ['weather'],
      }),
    ).toEqual({ loadedDuringTurn: [], agree: false });
    expect(
      shadowAgreement({
        priorLoaded,
        loadedAfter: new Set(['memory', 'payments']),
        wouldPreload: [],
      }),
    ).toEqual({ loadedDuringTurn: ['payments'], agree: false });
    expect(
      shadowAgreement({
        priorLoaded,
        loadedAfter: new Set(['memory']),
        wouldPreload: [],
      }),
    ).toEqual({ loadedDuringTurn: [], agree: true });
  });
});
