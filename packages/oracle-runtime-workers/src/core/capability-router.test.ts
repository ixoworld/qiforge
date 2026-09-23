import {
  DecisionProviderUnavailableError,
  capabilityRouteDecision,
  noCapabilityOption,
  type DecisionAnswer,
  type DecisionEvaluation,
  type DecisionEvaluator,
} from '@ixo/common/ai/decisions';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../plugin-api/types';
import {
  capabilityRouterMode,
  createCapabilityRouter,
  routableCandidates,
  shadowAgreement,
  type CapabilityRouteTurn,
} from './capability-router';
import type { RegisteredManifest } from './registries';
import { makeManifest } from './test-fixtures';

const MESSAGE = 'Will it rain in Cairo tomorrow?';

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
  {
    pluginName: 'memory',
    manifest: makeManifest({
      title: 'Memory',
      summary: 'Recall.',
      visibility: 'on-demand',
    }),
  },
  {
    pluginName: 'skills',
    manifest: makeManifest({ title: 'Skills', summary: 'Skills registry.' }),
  },
  {
    pluginName: 'telemetry',
    manifest: makeManifest({
      title: 'Telemetry',
      summary: 'Silent bookkeeping.',
      visibility: 'silent',
    }),
  },
];

/** `weather` and `payments` remain: `memory` is loaded, `skills` is always, `telemetry` silent. */
const loaded: ReadonlySet<string> = new Set(['memory']);
const CANDIDATE_NAMES = ['weather', 'payments'];

function evaluation(
  probabilityTrue: number,
  value: string,
  confidence: number,
): DecisionEvaluation {
  const answers: Record<string, DecisionAnswer> = {
    needsCapability: { kind: 'boolean', probabilityTrue },
    capability: {
      kind: 'choice',
      value,
      confidence,
      probabilities: { [value]: confidence },
    },
  };
  return {
    decision: { name: capabilityRouteDecision.name, version: '1.0.0' },
    provider: 'stub',
    model: 'stub-model',
    answers,
    latencyMs: 7,
    evaluatedAt: '2026-09-22T00:00:00.000Z',
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
    manifests,
    loaded,
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

describe('routableCandidates', () => {
  it('keeps effectively on-demand plugins the thread has not loaded', () => {
    expect(routableCandidates(manifests, loaded)).toEqual([
      {
        name: 'weather',
        title: 'Weather',
        summary: 'Forecasts and conditions.',
      },
      { name: 'payments', title: 'Payments', summary: 'Charge for services.' },
    ]);
    expect(
      routableCandidates(
        manifests,
        new Set([...loaded, 'weather', 'payments']),
      ),
    ).toEqual([]);
  });
});

describe('createCapabilityRouter', () => {
  it('off: never evaluates', async () => {
    const evaluator = evaluatorOf(async () => evaluation(1, 'weather', 1));
    const route = createCapabilityRouter({ evaluator, logger: loggerSpy() });

    expect(await route(turn({ mode: 'off' }))).toEqual(new Set());
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it('skips when nothing is routable or the message is blank', async () => {
    const evaluator = evaluatorOf(async () => evaluation(1, 'weather', 1));
    const route = createCapabilityRouter({ evaluator, logger: loggerSpy() });

    expect(
      await route(turn({ loaded: new Set(['memory', 'weather', 'payments']) })),
    ).toEqual(new Set());
    expect(await route(turn({ text: '   ' }))).toEqual(new Set());
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it('on: a strong verdict preloads the routed plugin for the turn', async () => {
    const evaluator = evaluatorOf(async () =>
      evaluation(0.92, 'weather', 0.88),
    );
    const logger = loggerSpy();
    const signal = new AbortController().signal;
    const route = createCapabilityRouter({ evaluator, logger });

    expect(await route(turn({ signal }))).toEqual(new Set(['weather']));

    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    const [definition, input, options] = evaluator.evaluate.mock.calls[0] ?? [];
    expect(definition).toBe(capabilityRouteDecision);
    expect(input).toEqual({
      text: MESSAGE,
      recentTurns: [],
      capabilities: routableCandidates(manifests, loaded),
    });
    expect(options).toEqual({ signal });
    expect(logger.log).toHaveBeenCalledWith(
      '[capability-router] request=req-1 preloaded=[weather] candidates=2',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('on: preloads nothing on low confidence, the none option or an unknown capability', async () => {
    const none = noCapabilityOption(CANDIDATE_NAMES);
    const verdicts = [
      evaluation(0.4, 'weather', 0.95),
      evaluation(0.95, 'weather', 0.5),
      evaluation(0.95, none, 0.9),
      evaluation(0.95, 'memory', 0.9),
    ];
    const evaluator = evaluatorOf(async () => {
      const next = verdicts.shift();
      if (!next) throw new Error('script exhausted');
      return next;
    });
    const logger = loggerSpy();
    const route = createCapabilityRouter({ evaluator, logger });

    for (let i = 0; i < 4; i += 1) {
      expect(await route(turn())).toEqual(new Set());
    }
    expect(evaluator.evaluate).toHaveBeenCalledTimes(4);
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
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

  it('hands the turn trace to the evaluation, with the signal only when awaited', async () => {
    const trace = {
      callbacks: [{ handleChainStart: () => undefined }],
      metadata: { user_did: 'did:test:user', thread_id: 'session-1' },
    };
    const signal = new AbortController().signal;

    const live = evaluatorOf(async () => evaluation(0.92, 'weather', 0.88));
    await createCapabilityRouter({ evaluator: live, logger: loggerSpy() })(
      turn({ signal, trace }),
    );
    expect(live.evaluate.mock.calls[0]?.[2]).toEqual({ ...trace, signal });

    const shadow = evaluatorOf(async () => evaluation(0.92, 'weather', 0.88));
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

  it('shadow: logs the verdict when it lands and hands the prediction to the host', async () => {
    const evaluator = evaluatorOf(async () =>
      evaluation(0.92, 'weather', 0.88),
    );
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
      '[capability-router-shadow] request=req-1 status=ok needsCapability=0.92 ' +
        'capability=weather capabilityConfidence=0.88 wouldPreload=[weather] ' +
        'reason=preload latencyMs=40 provider=stub model=stub-model',
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
