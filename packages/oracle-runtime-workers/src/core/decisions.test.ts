import {
  DecisionProviderUnavailableError,
  defineDecision,
  type DecisionAdapter,
  type DecisionEvaluation,
  type DecisionEvaluator,
  type DecisionRequest,
} from '@ixo/common/ai/decisions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Logger } from '../plugin-api/types';
import { createRuntimeCore, type RuntimeCore } from './index';
import { DecisionRegistry } from './registries';
import { buildRuntimeContext, createNoopAmbient } from './runtime-context';
import {
  makeBuildCtx,
  makeEnv,
  makePlugin,
  makeRunConfig,
} from './test-fixtures';

function decision(name: string) {
  return defineDecision({
    name,
    version: '1.0.0',
    description: `decision ${name}`,
    inputSchema: z.object({ value: z.string() }),
    project: ({ value }) => ({
      state: { value },
      questions: {
        match: { kind: 'boolean', instructions: 'Does it match?' },
      },
    }),
  });
}

const ROUTE = decision('commerce.route');

/** The request `ROUTE.prepare({ value: 'x' })` produces. */
const ROUTE_REQUEST: DecisionRequest = {
  state: { value: 'x' },
  questions: { match: { kind: 'boolean', instructions: 'Does it match?' } },
};

/** The same request on Jev's wire (boolean → `noul`). */
const ROUTE_JEV_INPUT = {
  state: { value: 'x' },
  questions: { match: { type: 'noul', instructions: 'Does it match?' } },
};

function bootCore(
  env: Record<string, unknown>,
  extra: { decisionAdapter?: DecisionAdapter; logger?: Logger } = {},
): RuntimeCore {
  return createRuntimeCore({
    config: { name: 'TestOracle' },
    plugins: [makePlugin({ name: 'commerce', getDecisions: () => [ROUTE] })],
    env,
    ...extra,
  });
}

function stubAdapter() {
  const evaluate = vi.fn(async (_request: DecisionRequest) => ({
    answers: { match: { kind: 'boolean' as const, probabilityTrue: 0.75 } },
  }));
  const adapter: DecisionAdapter = {
    provider: 'stub',
    model: 'stub-model',
    evaluate,
  };
  return { adapter, evaluate };
}

const JEV_RESULT = {
  model: 'jev-1.13-2026-09',
  answers: { match: { type: 'noul', noul: 0.9 } },
};

describe('DecisionRegistry', () => {
  it('collects decisions with plugin attribution', () => {
    const registry = new DecisionRegistry();
    registry.register(
      makePlugin({ name: 'commerce', getDecisions: () => [ROUTE] }),
    );
    registry.register(makePlugin({ name: 'weather' }));

    expect(() => registry.get('commerce.route')).toThrow(/before collect/);

    const collected = registry.collect(makeBuildCtx());

    expect(collected).toHaveLength(1);
    expect(collected[0]?.pluginName).toBe('commerce');
    expect(registry.get('commerce.route')?.decision).toBe(ROUTE);
    expect(registry.get('unknown')).toBeUndefined();
    expect(registry.namesForPlugin('commerce')).toEqual(['commerce.route']);
    expect(registry.namesForPlugin('weather')).toEqual([]);
  });

  it('rejects decision name collisions across plugins', () => {
    const registry = new DecisionRegistry();
    registry.register(
      makePlugin({ name: 'a', getDecisions: () => [decision('shared.route')] }),
    );
    registry.register(
      makePlugin({ name: 'b', getDecisions: () => [decision('shared.route')] }),
    );
    registry.collect(makeBuildCtx());

    expect(() => registry.assertNoCollisions()).toThrow(/shared\.route.*a.*b/);
  });
});

describe('createRuntimeCore decisions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers plugin decisions; without a provider every evaluation is unavailable', async () => {
    const core = bootCore(makeEnv());
    await core.warm();

    expect(core.registries.decisions.namesForPlugin('commerce')).toEqual([
      'commerce.route',
    ]);
    await expect(
      core.decisions.evaluateByName('commerce.route', { value: 'x' }),
    ).rejects.toBeInstanceOf(DecisionProviderUnavailableError);
    await expect(
      core.decisions.evaluateByName('missing', { value: 'x' }),
    ).rejects.toThrow(/"missing" is not registered/);
  });

  it('fails warm() on a decision name collision across plugins', async () => {
    const core = createRuntimeCore({
      config: { name: 'TestOracle' },
      plugins: [
        makePlugin({
          name: 'a',
          getDecisions: () => [decision('shared.route')],
        }),
        makePlugin({
          name: 'b',
          getDecisions: () => [decision('shared.route')],
        }),
      ],
      env: makeEnv(),
    });

    await expect(core.warm()).rejects.toThrow(/shared\.route.*"a".*"b"/);
  });

  it('a host decisionAdapter wins over env and stamps its provenance on the evaluation', async () => {
    const { adapter, evaluate } = stubAdapter();
    // Without the host adapter this env would fail the boot (no credentials).
    const core = bootCore(makeEnv({ DECISION_PROVIDER: 'cloudflare-jev' }), {
      decisionAdapter: adapter,
    });
    await core.warm();

    const result = await core.decisions.evaluateByName('commerce.route', {
      value: 'x',
    });

    expect(result).toMatchObject({
      decision: { name: 'commerce.route', version: '1.0.0' },
      provider: 'stub',
      model: 'stub-model',
      answers: { match: { kind: 'boolean', probabilityTrue: 0.75 } },
    });
    expect(evaluate).toHaveBeenCalledWith(ROUTE_REQUEST, {
      signal: expect.any(AbortSignal),
    });
  });

  it('DECISION_PROVIDER=openrouter-jev reuses OPEN_ROUTER_API_KEY against the OpenRouter decisions endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(JEV_RESULT, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const core = bootCore(
      makeEnv({
        DECISION_PROVIDER: 'openrouter-jev',
        DECISION_MODEL: 'typesafe/jev-next',
      }),
    );
    await core.warm();

    const result = await core.decisions.evaluateByName('commerce.route', {
      value: 'x',
    });

    expect(result).toMatchObject({
      provider: 'openrouter',
      model: 'typesafe/jev-next',
      modelVersion: 'jev-1.13-2026-09',
      answers: { match: { kind: 'boolean', probabilityTrue: 0.9 } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const [url, init] = call;
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer sk-or-test',
      'HTTP-Referer': 'oracle-app.com',
      'X-Title': 'TestOracle',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'typesafe/jev-next',
      ...ROUTE_JEV_INPUT,
    });
  });

  it('DECISION_PROVIDER=cloudflare-jev runs through the AI binding without account credentials', async () => {
    const run = vi.fn(async () => JEV_RESULT);
    const core = bootCore(
      makeEnv({ DECISION_PROVIDER: 'cloudflare-jev', AI: { run } }),
    );
    // The binding is not a string binding, so it never reaches `ctx.config`.
    expect(core.validatedEnv).not.toHaveProperty('AI');
    await core.warm();

    const result = await core.decisions.evaluateByName('commerce.route', {
      value: 'x',
    });

    expect(result).toMatchObject({
      provider: 'cloudflare',
      model: 'typesafe/jev',
      answers: { match: { kind: 'boolean', probabilityTrue: 0.9 } },
    });
    expect(run).toHaveBeenCalledWith('typesafe/jev', ROUTE_JEV_INPUT);
  });

  it('DECISION_PROVIDER=cloudflare-jev without the AI binding or credentials fails the boot', () => {
    const logger: Logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    expect(() =>
      bootCore(makeEnv({ DECISION_PROVIDER: 'cloudflare-jev' }), { logger }),
    ).toThrow(
      /Env validation failed \(2 issues\)[\s\S]*'CLOUDFLARE_ACCOUNT_ID'[\s\S]*'CLOUDFLARE_API_TOKEN'/,
    );
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});

describe('buildRuntimeContext decisions', () => {
  const state = { messages: [], loadedPlugins: new Set<string>() };

  it('rejects as unavailable over the no-op ambient', async () => {
    const ctx = buildRuntimeContext(
      makeRunConfig(),
      createNoopAmbient(),
      state,
    );

    await expect(
      ctx.decisions.evaluate(ROUTE, { value: 'x' }),
    ).rejects.toBeInstanceOf(DecisionProviderUnavailableError);
    await expect(
      ctx.decisions.evaluateByName('commerce.route', { value: 'x' }),
    ).rejects.toBeInstanceOf(DecisionProviderUnavailableError);
  });

  it('combines caller cancellation with turn cancellation', async () => {
    const evaluation: DecisionEvaluation = {
      decision: { name: 'commerce.route', version: '1.0.0' },
      provider: 'stub',
      model: 'stub-model',
      answers: { match: { kind: 'boolean', probabilityTrue: 0.75 } },
      latencyMs: 1,
      evaluatedAt: '2026-09-22T00:00:00.000Z',
    };
    const decisions: DecisionEvaluator = {
      evaluate: vi.fn(async () => evaluation),
      evaluateByName: vi.fn(async () => evaluation),
    };
    const turn = new AbortController();
    const ctx = buildRuntimeContext(
      makeRunConfig({ signal: turn.signal }),
      createNoopAmbient({ decisions }),
      state,
    );

    await expect(ctx.decisions.evaluate(ROUTE, { value: 'x' })).resolves.toBe(
      evaluation,
    );
    expect(decisions.evaluate).toHaveBeenCalledWith(
      ROUTE,
      { value: 'x' },
      { signal: turn.signal },
    );

    const own = new AbortController();
    await ctx.decisions.evaluateByName(
      'commerce.route',
      { value: 'x' },
      { signal: own.signal, timeoutMs: 10 },
    );
    const call = vi.mocked(decisions.evaluateByName).mock.calls[0];
    const combined = call?.[2]?.signal;
    expect(combined?.aborted).toBe(false);
    turn.abort(new Error('turn cancelled'));
    expect(combined?.aborted).toBe(true);
    expect(combined?.reason.message).toBe('turn cancelled');
    expect(decisions.evaluateByName).toHaveBeenCalledWith(
      'commerce.route',
      { value: 'x' },
      { signal: expect.any(AbortSignal), timeoutMs: 10 },
    );
  });

  it("traces on the run's callbacks unless the caller passes its own", async () => {
    const evaluation: DecisionEvaluation = {
      decision: { name: 'commerce.route', version: '1.0.0' },
      provider: 'stub',
      model: 'stub-model',
      answers: { match: { kind: 'boolean', probabilityTrue: 0.75 } },
      latencyMs: 1,
      evaluatedAt: '2026-09-22T00:00:00.000Z',
    };
    const decisions: DecisionEvaluator = {
      evaluate: vi.fn(async () => evaluation),
      evaluateByName: vi.fn(async () => evaluation),
    };
    const turn = new AbortController();
    const toolRunCallbacks = [{ handleChainStart: () => undefined }];
    const ctx = buildRuntimeContext(
      makeRunConfig({ signal: turn.signal, callbacks: toolRunCallbacks }),
      createNoopAmbient({ decisions }),
      state,
    );

    await ctx.decisions.evaluate(ROUTE, { value: 'x' });
    expect(decisions.evaluate).toHaveBeenCalledWith(
      ROUTE,
      { value: 'x' },
      { signal: turn.signal, callbacks: toolRunCallbacks },
    );

    const own = [{ handleChainEnd: () => undefined }];
    await ctx.decisions.evaluateByName(
      'commerce.route',
      { value: 'x' },
      { callbacks: own },
    );
    expect(decisions.evaluateByName).toHaveBeenCalledWith(
      'commerce.route',
      { value: 'x' },
      { signal: turn.signal, callbacks: own },
    );
  });
});
