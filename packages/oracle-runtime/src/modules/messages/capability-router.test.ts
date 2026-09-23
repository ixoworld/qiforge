import type { DecisionEvaluation } from '@ixo/common';
import {
  capabilityRouteDecision,
  noCapabilityOption,
} from '@ixo/common/ai/decisions';
import { describe, expect, it, vi } from 'vitest';
import {
  DecisionProviderUnavailableError,
  type DecisionEvaluator,
} from '../../decisions/decision-runtime.js';
import type { PluginManifest } from '../../plugin-api/types.js';
import type { RegisteredManifest } from '../../registries/manifest-registry.js';
import { makeManifest } from '../../registries/test-fixtures.js';
import { CapabilityRouter } from './capability-router.js';

const REQUEST_ID = 'req-1';
const MESSAGE = 'what will the weather be in Berlin tomorrow?';

function registered(
  pluginName: string,
  overrides: Partial<PluginManifest> = {},
): RegisteredManifest {
  return {
    pluginName,
    manifest: makeManifest({
      title: `${pluginName} title`,
      summary: `${pluginName} summary`,
      visibility: 'on-demand',
      ...overrides,
    }),
  };
}

/** Two routable plugins, one eager, one silent. */
const MANIFESTS: RegisteredManifest[] = [
  registered('weather'),
  registered('flows'),
  registered('memory', { visibility: 'always' }),
  registered('guard', { visibility: 'silent' }),
];
const NONE = noCapabilityOption(['weather', 'flows']);

function evaluation(answers: {
  needs: number;
  choice: string;
  confidence: number;
}): DecisionEvaluation {
  return {
    decision: { name: capabilityRouteDecision.name, version: '1.0.0' },
    provider: 'mock',
    model: 'mock-model',
    answers: {
      needsCapability: { kind: 'boolean', probabilityTrue: answers.needs },
      capability: {
        kind: 'choice',
        value: answers.choice,
        confidence: answers.confidence,
        probabilities: { [answers.choice]: answers.confidence },
      },
    },
    latencyMs: 12,
    evaluatedAt: '2026-09-22T00:00:00.000Z',
  };
}

const PRELOAD_WEATHER = evaluation({
  needs: 0.9,
  choice: 'weather',
  confidence: 0.8,
});

function harness(opts: {
  mode: unknown;
  evaluate?: DecisionEvaluator['evaluate'];
  noEvaluator?: boolean;
  now?: () => number;
}) {
  const evaluate = vi.fn<DecisionEvaluator['evaluate']>(
    opts.evaluate ?? (async () => PRELOAD_WEATHER),
  );
  const evaluator: DecisionEvaluator = {
    evaluate,
    evaluateByName: vi.fn<DecisionEvaluator['evaluateByName']>(),
  };
  const logger = { log: vi.fn(), warn: vi.fn() };
  const router = new CapabilityRouter({
    getDecisionEvaluator: () => (opts.noEvaluator ? undefined : evaluator),
    logger,
    ...(opts.now && { now: opts.now }),
  });
  const route = (
    overrides: Partial<Parameters<CapabilityRouter['route']>[0]> = {},
  ) =>
    router.route({
      requestId: REQUEST_ID,
      mode: opts.mode,
      text: MESSAGE,
      manifests: MANIFESTS,
      loadedPlugins: new Set<string>(),
      ...overrides,
    });
  return { router, route, evaluate, logger };
}

/** Let every pending promise hop in the shadow chain settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function lines(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

describe('CapabilityRouter', () => {
  describe('off', () => {
    it('never consults the evaluator and logs nothing', async () => {
      const { route, evaluate, logger } = harness({ mode: 'off' });

      const outcome = await route();

      expect(outcome.preloadedPlugins.size).toBe(0);
      expect(outcome.shadow).toBeUndefined();
      expect(evaluate).not.toHaveBeenCalled();
      expect(logger.log).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('treats an unrecognised mode value as off', async () => {
      const { route, evaluate } = harness({ mode: 'yes please' });

      await route();

      expect(evaluate).not.toHaveBeenCalled();
    });
  });

  describe('candidates', () => {
    it('offers only unloaded on-demand plugins, with the message as the text', async () => {
      const { route, evaluate } = harness({ mode: 'on' });
      const signal = new AbortController().signal;

      await route({ loadedPlugins: new Set(['flows']), signal });

      expect(evaluate).toHaveBeenCalledTimes(1);
      const [definition, input, options] = evaluate.mock.calls[0] ?? [];
      expect(definition).toBe(capabilityRouteDecision);
      expect(input).toEqual({
        text: MESSAGE,
        recentTurns: [],
        capabilities: [
          {
            name: 'weather',
            title: 'weather title',
            summary: 'weather summary',
          },
        ],
      });
      expect(options).toEqual({ signal });
    });

    it('hands the turn trace to the evaluation in both modes', async () => {
      const callbacks = [{ handleChainStart: () => undefined }];
      const trace = {
        callbacks,
        metadata: { user_did: 'did:test:user', thread_id: 'thread-1' },
      };
      const signal = new AbortController().signal;

      for (const mode of ['on', 'shadow'] as const) {
        const { route, evaluate } = harness({ mode });
        await route({ trace, signal });
        await flush();
        expect(evaluate.mock.calls[0]?.[2]).toEqual({
          callbacks,
          metadata: trace.metadata,
          signal,
        });
      }
    });

    it('skips the router when every on-demand plugin is already loaded', async () => {
      const { route, evaluate } = harness({ mode: 'on' });

      const outcome = await route({
        loadedPlugins: new Set(['weather', 'flows']),
      });

      expect(outcome.preloadedPlugins.size).toBe(0);
      expect(evaluate).not.toHaveBeenCalled();
    });

    it('skips the router on a Matrix support turn', async () => {
      const { route, evaluate } = harness({ mode: 'on' });

      const outcome = await route({ commerceMode: 'support' });

      expect(outcome.preloadedPlugins.size).toBe(0);
      expect(evaluate).not.toHaveBeenCalled();
    });

    it('skips the router on a blank message', async () => {
      const { route, evaluate } = harness({ mode: 'on' });

      await route({ text: '   ' });

      expect(evaluate).not.toHaveBeenCalled();
    });
  });

  describe('on', () => {
    it('preloads the routed plugin and logs the preload line', async () => {
      const ticks = [1_000, 1_040];
      const { route, logger } = harness({
        mode: 'on',
        now: () => ticks.shift() ?? 1_040,
      });

      const outcome = await route();

      expect(outcome.preloadedPlugins).toEqual(new Set(['weather']));
      expect(outcome.shadow).toBeUndefined();
      expect(lines(logger.log)).toEqual([
        `[capability-router] request=${REQUEST_ID} mode=on status=ok preloaded=[weather] candidates=2 ` +
          'needsCapability=0.9 capability=weather capabilityConfidence=0.8 reason=preload latencyMs=40 provider=mock model=mock-model',
      ]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it.each([
      [
        'low choice confidence',
        { needs: 0.9, choice: 'weather', confidence: 0.5 },
        'low-confidence',
      ],
      [
        'the none option',
        { needs: 0.9, choice: NONE, confidence: 0.9 },
        'none-option',
      ],
      [
        'no capability needed',
        { needs: 0.2, choice: 'weather', confidence: 0.9 },
        'no-capability',
      ],
    ])('preloads nothing on %s', async (_label, answers, reason) => {
      const { route, logger } = harness({
        mode: 'on',
        evaluate: async () => evaluation(answers),
      });

      const outcome = await route();

      expect(outcome.preloadedPlugins.size).toBe(0);
      const [line] = lines(logger.log);
      expect(line).toContain('preloaded=[]');
      expect(line).toContain(`reason=${reason}`);
    });

    it('falls open with one safe warn when the evaluation throws', async () => {
      const { route, logger } = harness({
        mode: 'on',
        evaluate: async () => {
          const error = new Error(`provider echoed: ${MESSAGE}`);
          error.name = 'TimeoutError';
          throw error;
        },
      });

      const outcome = await route();

      expect(outcome.preloadedPlugins.size).toBe(0);
      expect(lines(logger.warn)).toEqual([
        `[capability-router] request=${REQUEST_ID} mode=on status=fallback reason=TimeoutError`,
      ]);
      expect(logger.log).not.toHaveBeenCalled();
    });

    it('never puts the message text into a log line', async () => {
      const { route, logger } = harness({
        mode: 'on',
        evaluate: async () => {
          throw new Error(MESSAGE);
        },
      });

      await route();

      for (const line of [...lines(logger.warn), ...lines(logger.log)]) {
        expect(line).not.toContain('Berlin');
      }
    });

    it('warns once per process when no Decision provider is configured', async () => {
      const { route, logger } = harness({
        mode: 'on',
        evaluate: async () => {
          throw new DecisionProviderUnavailableError();
        },
      });

      const first = await route();
      const second = await route();

      expect(first.preloadedPlugins.size).toBe(0);
      expect(second.preloadedPlugins.size).toBe(0);
      expect(lines(logger.warn)).toEqual([
        `[capability-router] request=${REQUEST_ID} mode=on status=fallback reason=DecisionProviderUnavailableError (logged once per process)`,
      ]);
    });

    it('warns once per process when the ambient runtime has no evaluator', async () => {
      const { route, logger } = harness({ mode: 'on', noEvaluator: true });

      await route();
      await route();

      expect(lines(logger.warn)).toEqual([
        `[capability-router] request=${REQUEST_ID} mode=on status=fallback reason=missing-evaluator (logged once per process)`,
      ]);
    });
  });

  describe('shadow', () => {
    it('returns immediately without preloading, even when the evaluation never settles', async () => {
      const { route, evaluate, logger } = harness({
        mode: 'shadow',
        evaluate: () => new Promise<DecisionEvaluation>(() => undefined),
      });

      const outcome = await route();

      expect(outcome.preloadedPlugins.size).toBe(0);
      expect(outcome.shadow).toBeDefined();
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(logger.log).not.toHaveBeenCalled();
    });

    it('logs the verdict when the evaluation completes', async () => {
      const ticks = [1_000, 1_025];
      const { route, logger } = harness({
        mode: 'shadow',
        now: () => ticks.shift() ?? 1_025,
      });

      await route();
      await flush();

      expect(lines(logger.log)).toEqual([
        `[capability-router-shadow] request=${REQUEST_ID} status=ok needsCapability=0.9 capability=weather ` +
          'capabilityConfidence=0.8 reason=preload wouldPreload=[weather] candidates=2 latencyMs=25 provider=mock model=mock-model',
      ]);
    });

    it('logs a safe failure line when the evaluation rejects', async () => {
      const { route, logger } = harness({
        mode: 'shadow',
        evaluate: async () => {
          throw new Error(MESSAGE);
        },
      });

      const outcome = await route();
      await flush();
      outcome.shadow?.compare(['weather']);
      await flush();

      expect(lines(logger.warn)).toEqual([
        `[capability-router-shadow] request=${REQUEST_ID} status=failed errorType=Error`,
      ]);
      // A failed prediction has nothing to agree with.
      expect(logger.log).not.toHaveBeenCalled();
    });

    it.each([
      ['a preload the model also made', ['weather'], true],
      ['a preload the model did not make', [], false],
      ['a preload of the wrong plugin', ['flows'], false],
    ])('compares the prediction with %s', async (_label, loaded, agree) => {
      const { route, logger } = harness({ mode: 'shadow' });

      const outcome = await route();
      outcome.shadow?.compare(loaded);
      await flush();

      const compareLine = lines(logger.log).at(-1);
      expect(compareLine).toBe(
        `[capability-router-shadow] request=${REQUEST_ID} wouldPreload=[weather] loadedDuringTurn=[${loaded.join(',')}] agree=${String(agree)}`,
      );
    });

    it('counts an empty prediction as agreeing only with a turn that loaded nothing', async () => {
      const { route, logger } = harness({
        mode: 'shadow',
        evaluate: async () =>
          evaluation({ needs: 0.1, choice: NONE, confidence: 0.9 }),
      });

      (await route()).shadow?.compare([]);
      (await route()).shadow?.compare(['weather']);
      await flush();

      const compareLines = lines(logger.log).filter((line) =>
        line.includes('loadedDuringTurn='),
      );
      expect(compareLines).toEqual([
        `[capability-router-shadow] request=${REQUEST_ID} wouldPreload=[] loadedDuringTurn=[] agree=true`,
        `[capability-router-shadow] request=${REQUEST_ID} wouldPreload=[] loadedDuringTurn=[weather] agree=false`,
      ]);
    });

    it('measures loadedDuringTurn against what was loaded before the turn', async () => {
      const { route, logger } = harness({ mode: 'shadow' });

      const outcome = await route({ loadedPlugins: new Set(['flows']) });
      outcome.shadow?.compare(['flows', 'weather']);
      await flush();

      expect(lines(logger.log).at(-1)).toContain(
        'loadedDuringTurn=[weather] agree=true',
      );
    });

    it('warns once per process when the ambient runtime has no evaluator', async () => {
      const { route, logger } = harness({ mode: 'shadow', noEvaluator: true });

      const outcome = await route();
      await route();

      expect(outcome.shadow).toBeUndefined();
      expect(lines(logger.warn)).toEqual([
        `[capability-router-shadow] request=${REQUEST_ID} mode=shadow status=fallback reason=missing-evaluator (logged once per process)`,
      ]);
    });
  });
});
