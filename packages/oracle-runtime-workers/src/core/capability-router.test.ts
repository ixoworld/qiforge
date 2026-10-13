import {
  AmbiguousDecisionProviderError,
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
import { createRegistries, type RegisteredManifest } from './registries';
import { delegationHasCapability } from './runtime-context';
import {
  makeBuildCtx,
  makeManifest,
  makePlugin,
  makeTool,
} from './test-fixtures';
import { bootHiddenPlugins } from './tool-access';

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

  it('never names a plugin whose tools are all admin tools the delegation does not grant', async () => {
    const registries = createRegistries();
    const payments = makePlugin({
      name: 'payments',
      manifest: makeManifest({ title: 'Payments', visibility: 'on-demand' }),
      getTools: () => [makeTool('refund', { plane: 'admin' })],
    });
    registries.tools.register(payments);
    registries.subAgents.register(payments);
    const hidden = (
      capabilities: Array<{ resource: string; action: string }>,
    ) =>
      bootHiddenPlugins({
        registries,
        buildCtx: makeBuildCtx(),
        has: (resource, action) =>
          delegationHasCapability({ capabilities }, resource, action),
      });

    const denied = await hidden([]);
    expect(denied).toEqual(new Set(['payments']));
    expect(
      routableCandidates(manifests, loaded, denied).map((c) => c.name),
    ).toEqual(['weather']);

    const granted = await hidden([
      {
        resource: 'ixo:qiforge:admin-tool/payments/refund',
        action: 'admin-tool/invoke',
      },
    ]);
    expect(
      routableCandidates(manifests, loaded, granted).map((c) => c.name),
    ).toEqual(CANDIDATE_NAMES);
  });
});

describe('routableCandidates — manifest requirements', () => {
  const REQUIRES = [{ resource: 'ixo:filesystem', action: 'fs/read' }];
  const withFiles: RegisteredManifest[] = [
    ...manifests,
    {
      pluginName: 'files',
      manifest: makeManifest({
        title: 'Files',
        summary: 'Personal files.',
        visibility: 'on-demand',
        requires: REQUIRES,
      }),
    },
  ];
  const has =
    (capabilities: Array<{ resource: string; action: string }>) =>
    (resource: string, action: string) =>
      delegationHasCapability({ capabilities }, resource, action);

  it('never names a plugin whose requires the delegation does not grant', () => {
    expect(
      routableCandidates(withFiles, loaded, undefined, has([])).map(
        (c) => c.name,
      ),
    ).toEqual(CANDIDATE_NAMES);
    expect(
      routableCandidates(
        withFiles,
        loaded,
        undefined,
        has([{ resource: 'ixo:filesystem', action: '*' }]),
      ).map((c) => c.name),
    ).toEqual([...CANDIDATE_NAMES, 'files']);
    // Without a delegation check the requirements are not looked at.
    expect(routableCandidates(withFiles, loaded).map((c) => c.name)).toEqual([
      ...CANDIDATE_NAMES,
      'files',
    ]);
  });

  it('does not spend the evaluation on a plugin the delegation cannot use', async () => {
    const evaluator = evaluatorOf(async () => evaluation(1, 'files', 1));
    const route = createCapabilityRouter({ evaluator, logger: loggerSpy() });
    const preloaded = await route(
      turn({ manifests: withFiles, hasCapability: has([]) }),
    );
    const offered = (
      evaluator.evaluate.mock.calls[0]?.[1] as {
        capabilities: Array<{ name: string }>;
      }
    ).capabilities.map((c) => c.name);
    expect(offered).not.toContain('files');
    // The model named a plugin that was not offered: nothing is preloaded.
    expect(preloaded.size).toBe(0);
  });
});

describe('createCapabilityRouter — hidden plugins', () => {
  it('computes a lazy hidden set only when it evaluates', async () => {
    const evaluator = evaluatorOf(async () => evaluation(1, 'weather', 1));
    const route = createCapabilityRouter({ evaluator, logger: loggerSpy() });
    const hidden = vi.fn(async () => new Set(['payments']));

    await route(turn({ mode: 'off', hidden }));
    await route(turn({ text: '   ', hidden }));
    expect(hidden).not.toHaveBeenCalled();

    await route(turn({ hidden }));
    expect(hidden).toHaveBeenCalledTimes(1);
    const offered = (
      evaluator.evaluate.mock.calls[0]?.[1] as {
        capabilities: Array<{ name: string }>;
      }
    ).capabilities.map((c) => c.name);
    expect(offered).toEqual(['weather']);
  });

  it('runs no boot sub-agent factory when the router is off', async () => {
    const registries = createRegistries();
    const factory = vi.fn(() => [makeTool('plan_trip')]);
    const planner = makePlugin({
      name: 'planner',
      manifest: makeManifest({ title: 'Planner', visibility: 'on-demand' }),
      getSubAgents: () => [
        {
          name: 'Trip Planner',
          description: 'plans',
          systemPrompt: 'plan',
          tools: factory,
        },
      ],
    });
    registries.tools.register(planner);
    registries.subAgents.register(planner);
    const route = createCapabilityRouter({
      evaluator: evaluatorOf(async () => evaluation(1, 'weather', 1)),
      logger: loggerSpy(),
    });
    const hidden = () =>
      bootHiddenPlugins({
        registries,
        buildCtx: makeBuildCtx(),
        has: () => true,
      });
    await route(turn({ mode: 'off', hidden }));
    expect(factory).not.toHaveBeenCalled();
    await route(turn({ hidden }));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('a hidden set that cannot be computed preloads nothing, with a warning', async () => {
    const evaluator = evaluatorOf(async () => evaluation(1, 'weather', 1));
    const logger = loggerSpy();
    const route = createCapabilityRouter({ evaluator, logger });
    const preloaded = await route(
      turn({
        hidden: async () => {
          throw new Error('getTools exploded');
        },
      }),
    );
    expect(preloaded.size).toBe(0);
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain(
      'status=fallback reason=Error',
    );
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

  it('on: an ambiguous provider configuration fails open like a missing provider', async () => {
    const evaluator = evaluatorOf(async () => {
      throw new AmbiguousDecisionProviderError(capabilityRouteDecision.name, [
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
