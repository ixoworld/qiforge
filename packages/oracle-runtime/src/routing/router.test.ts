import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createCapabilityGateMiddleware } from '../graph/middlewares/capability-gate-middleware.js';
import type { AuditRecord } from '../kernel/audit.js';
import {
  createEmbeddingRouteClassifier,
  createLlmRouteClassifier,
} from './classifiers.js';
import {
  parseRouterConfigEnv,
  routerConfigSchema,
  validateRouterConfig,
  type RouteDecision,
  type RouterConfig,
} from './route-config.js';
import { createSemanticRouterMiddleware } from './semantic-router-middleware.js';

const weatherRoute = {
  name: 'weather',
  description: 'Questions about weather and forecasts',
  exemplars: ['weather in tokyo', 'is it raining in cape town'],
  target: {
    modelRole: 'fast',
    loadCapabilities: ['weather'],
    subAgentHint: 'the weather sub-agent',
  },
};

const travelRoute = {
  name: 'travel',
  description: 'Flight and hotel bookings',
  exemplars: ['book a flight to nairobi'],
  target: { loadCapabilities: ['travel'] },
};

function makeConfig(overrides?: Record<string, unknown>): RouterConfig {
  return routerConfigSchema.parse({
    strategy: 'llm',
    routes: [weatherRoute, travelRoute],
    ...overrides,
  });
}

/** Minimal chat model exposing only what the llm classifier touches. */
function structuredModel(result: {
  route: string;
  confidence: number;
}): BaseChatModel {
  return {
    withStructuredOutput: () => ({ invoke: async () => result }),
  } as never;
}

describe('createLlmRouteClassifier', () => {
  it('selects the named route when confidence clears the llm threshold', async () => {
    const classify = createLlmRouteClassifier({
      model: structuredModel({ route: 'weather', confidence: 0.9 }),
      config: makeConfig(),
    });
    const decision = await classify({ text: 'weather in tokyo?' });
    expect(decision?.route.name).toBe('weather');
    expect(decision?.strategy).toBe('llm');
    expect(decision?.confidence).toBe(0.9);
  });

  it('returns null when the model answers "none"', async () => {
    const classify = createLlmRouteClassifier({
      model: structuredModel({ route: 'none', confidence: 0.99 }),
      config: makeConfig(),
    });
    expect(await classify({ text: 'hello there' })).toBeNull();
  });

  it('rejects confident-sounding matches below the llm threshold', async () => {
    const classify = createLlmRouteClassifier({
      model: structuredModel({ route: 'weather', confidence: 0.5 }),
      config: makeConfig(), // default llm threshold 0.55
    });
    expect(await classify({ text: 'weather in tokyo?' })).toBeNull();
  });

  it('honours an operator-tuned llm threshold', async () => {
    const classify = createLlmRouteClassifier({
      model: structuredModel({ route: 'weather', confidence: 0.5 }),
      config: makeConfig({ minConfidence: { llm: 0.4, embedding: 0.75 } }),
    });
    expect((await classify({ text: 'weather?' }))?.route.name).toBe('weather');
  });
});

describe('createEmbeddingRouteClassifier', () => {
  const VECTORS: Record<string, number[]> = {
    'weather in tokyo': [1, 0],
    'is it raining in cape town': [0.95, 0.05],
    'book a flight to nairobi': [0, 1],
  };

  function makeEmbed(queryVector: number[]) {
    return vi.fn(async (texts: string[]) =>
      texts.map((t) => VECTORS[t] ?? queryVector),
    );
  }

  it('picks the cosine top-1 exemplar route above the embedding threshold', async () => {
    const embed = makeEmbed([0.98, 0.02]);
    const classify = createEmbeddingRouteClassifier({
      embed,
      embedderId: 'test-embedder@2d',
      config: makeConfig({ strategy: 'embedding' }),
    });
    const decision = await classify({ text: 'how hot is it today' });
    expect(decision?.route.name).toBe('weather');
    expect(decision?.strategy).toBe('embedding');
    expect(decision?.confidence).toBeGreaterThan(0.9);
  });

  it('returns null below the embedding threshold', async () => {
    // Equidistant from both clusters: cosine ≈ 0.707 < default 0.75.
    const embed = makeEmbed([0.5, 0.5]);
    const classify = createEmbeddingRouteClassifier({
      embed,
      embedderId: 'test-embedder@2d',
      config: makeConfig({ strategy: 'embedding' }),
    });
    expect(await classify({ text: 'something ambiguous' })).toBeNull();
  });

  it('returns null when no route declares exemplars', async () => {
    const embed = makeEmbed([1, 0]);
    const bare = makeConfig({
      strategy: 'embedding',
      routes: [
        { ...weatherRoute, exemplars: undefined },
        { ...travelRoute, exemplars: undefined },
      ],
    });
    const classify = createEmbeddingRouteClassifier({
      embed,
      embedderId: 'test-embedder@2d',
      config: bare,
    });
    expect(await classify({ text: 'weather in tokyo' })).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it('memoizes the exemplar index across classifications', async () => {
    const embed = makeEmbed([0.98, 0.02]);
    const classify = createEmbeddingRouteClassifier({
      embed,
      embedderId: 'test-embedder@2d',
      config: makeConfig({ strategy: 'embedding' }),
    });
    await classify({ text: 'first query' });
    await classify({ text: 'second query' });
    // One exemplar-batch call + one call per query — the index is reused.
    expect(embed).toHaveBeenCalledTimes(3);
    expect(embed.mock.calls[0]?.[0]).toEqual([
      'weather in tokyo',
      'is it raining in cape town',
      'book a flight to nairobi',
    ]);
  });
});

describe('validateRouterConfig', () => {
  it('rejects routes that name unknown capabilities or model roles', () => {
    const errors = validateRouterConfig(makeConfig(), {
      availablePlugins: new Set(['travel']),
      policyRoles: new Set(['main']),
    });
    expect(errors.join('\n')).toMatch(/capability 'weather'/);
    expect(errors.join('\n')).toMatch(/model role 'fast'/);
  });

  it('passes when every target is a loaded plugin and a declared role', () => {
    const errors = validateRouterConfig(makeConfig(), {
      availablePlugins: new Set(['weather', 'travel']),
      policyRoles: new Set(['fast', 'main']),
    });
    expect(errors).toEqual([]);
  });

  it('requires at least two routes for an active strategy', () => {
    const single = makeConfig({ routes: [weatherRoute] });
    const errors = validateRouterConfig(single, {
      availablePlugins: new Set(['weather']),
      policyRoles: new Set(['fast']),
    });
    expect(errors.join('\n')).toMatch(/at least two routes/);
  });

  it('parses ROUTER_CONFIG_JSON and ignores empty values', () => {
    expect(parseRouterConfigEnv(undefined)).toBeUndefined();
    expect(parseRouterConfigEnv('')).toBeUndefined();
    const parsed = parseRouterConfigEnv(
      JSON.stringify({ strategy: 'llm', routes: [weatherRoute, travelRoute] }),
    );
    expect(parsed?.routes?.length).toBe(2);
    expect(() => parseRouterConfigEnv('{"strategy":"bogus"}')).toThrow();
  });
});

describe('createSemanticRouterMiddleware', () => {
  const weatherDecision: RouteDecision = {
    route: makeConfig().routes[0]!,
    strategy: 'llm',
    confidence: 0.9,
  };

  function setup(opts?: {
    config?: RouterConfig;
    classify?: ReturnType<typeof vi.fn>;
    resolveModel?: (role: string) => BaseChatModel;
    emitRouter?: ReturnType<typeof vi.fn>;
  }) {
    const records: AuditRecord[] = [];
    const routedCapabilities = new Set<string>();
    const classify =
      opts?.classify ?? vi.fn().mockResolvedValue(weatherDecision);
    const overrideModel = { tag: 'override-model' } as never;
    const mw = createSemanticRouterMiddleware({
      config: opts?.config ?? makeConfig(),
      classify,
      routedCapabilities,
      resolveModel: opts?.resolveModel ?? (() => overrideModel),
      emitRouter: opts?.emitRouter,
      audit: {
        append: (record) => {
          records.push(record);
        },
      },
      sessionId: 'sess-1',
      requestId: 'req-1',
    });
    const before = mw.beforeAgent;
    const wrap = mw.wrapModelCall;
    if (typeof before !== 'function' || typeof wrap !== 'function') {
      throw new Error('router middleware hooks missing');
    }
    return {
      mw,
      before,
      wrap,
      classify,
      records,
      routedCapabilities,
      overrideModel,
    };
  }

  const humanTurnState = () => ({
    messages: [new HumanMessage('weather in tokyo?'), new AIMessage('…')],
    loadedPlugins: ['memory'],
  });

  it('grants routed capabilities for the turn WITHOUT touching graph state', async () => {
    const { before, routedCapabilities } = setup();
    const state = humanTurnState();
    const keysBefore = Object.keys(state);

    const result = await before(state as never, {} as never);

    // The grant lives in the request-scoped set…
    expect(routedCapabilities.has('weather')).toBe(true);
    // …and NOTHING is returned or mutated that a checkpointer could persist:
    // no state-update command, no new keys, the monotonic loadedPlugins
    // channel untouched.
    expect(result).toBeUndefined();
    expect(Object.keys(state)).toEqual(keysBefore);
    expect(state.loadedPlugins).toEqual(['memory']);
  });

  it('exposes gated tools through the CapabilityGate for this turn only', async () => {
    const { before, routedCapabilities } = setup();
    await before(humanTurnState() as never, {} as never);

    const pluginByToolName = new Map([['get_forecast', 'weather']]);
    const visibilityByToolName = new Map<string, 'on-demand'>([
      ['get_forecast', 'on-demand'],
    ]);
    const request = {
      state: { loadedPlugins: [] },
      tools: [{ name: 'get_forecast' }],
    };

    // This turn: the gate consults the routed set → tool visible.
    const gate = createCapabilityGateMiddleware({
      pluginByToolName,
      visibilityByToolName,
      routedCapabilities,
    });
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const gateWrap = gate.wrapModelCall;
    if (!gateWrap) throw new Error('wrapModelCall missing');
    await gateWrap(request as never, handler as never);
    expect(
      (handler.mock.calls[0]?.[0] as { tools: { name: string }[] }).tools,
    ).toEqual([{ name: 'get_forecast' }]);

    // Next turn: a fresh request builds a fresh (empty) set — the grant is
    // gone because it was never persisted anywhere.
    const nextTurnGate = createCapabilityGateMiddleware({
      pluginByToolName,
      visibilityByToolName,
      routedCapabilities: new Set(),
    });
    const nextHandler = vi.fn().mockResolvedValue({ ok: true });
    const nextWrap = nextTurnGate.wrapModelCall;
    if (!nextWrap) throw new Error('wrapModelCall missing');
    await nextWrap(request as never, nextHandler as never);
    expect(
      (nextHandler.mock.calls[0]?.[0] as { tools: { name: string }[] }).tools,
    ).toEqual([]);
  });

  it('fails open to the default: classifier error grants nothing and keeps the request untouched', async () => {
    const classify = vi.fn().mockRejectedValue(new Error('classifier down'));
    const { before, wrap, routedCapabilities, records } = setup({ classify });
    await before(humanTurnState() as never, {} as never);

    expect(routedCapabilities.size).toBe(0);
    const failure = records.find(
      (r) => (r.detail as { step?: string }).step === 'route.none',
    );
    expect(failure?.detail).toMatchObject({ reason: 'classifier-error' });

    // wrapModelCall passes the request through byte-identical (same object).
    const request = { systemMessage: new SystemMessage('base') };
    const handler = vi.fn().mockResolvedValue({ ok: true });
    await wrap(request as never, handler as never);
    expect(handler.mock.calls[0]?.[0]).toBe(request);
  });

  it('audits a digest of the routed text, never the text itself', async () => {
    const { before, records } = setup();
    await before(humanTurnState() as never, {} as never);

    const selected = records.find(
      (r) => (r.detail as { step?: string }).step === 'route.selected',
    );
    expect(selected?.kind).toBe('route.decision');
    expect((selected?.detail as { textDigest?: string }).textDigest).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(JSON.stringify(records)).not.toContain('weather in tokyo?');
  });

  it('applies the model-role override and delegation hint on the model call', async () => {
    const { before, wrap, overrideModel } = setup();
    await before(humanTurnState() as never, {} as never);

    const handler = vi.fn().mockResolvedValue({ ok: true });
    await wrap(
      {
        systemMessage: new SystemMessage('base'),
        model: { tag: 'default-model' },
      } as never,
      handler as never,
    );
    const passed = handler.mock.calls[0]?.[0] as {
      systemMessage: SystemMessage;
      model: unknown;
    };
    expect(passed.model).toBe(overrideModel);
    expect(String(passed.systemMessage.content)).toContain(
      'the weather sub-agent',
    );
  });

  it('keeps the default model when the role override fails to resolve', async () => {
    const { before, wrap } = setup({
      resolveModel: () => {
        throw new Error('role not in policy');
      },
    });
    await before(humanTurnState() as never, {} as never);

    const defaultModel = { tag: 'default-model' };
    const handler = vi.fn().mockResolvedValue({ ok: true });
    await wrap(
      {
        systemMessage: new SystemMessage('base'),
        model: defaultModel,
      } as never,
      handler as never,
    );
    const passed = handler.mock.calls[0]?.[0] as { model: unknown };
    expect(passed.model).toBe(defaultModel);
  });

  it('does not classify when the strategy is off or fewer than two routes exist', async () => {
    const offSetup = setup({
      config: makeConfig({ strategy: 'off' }),
    });
    await offSetup.before(humanTurnState() as never, {} as never);
    expect(offSetup.classify).not.toHaveBeenCalled();

    const singleRoute = routerConfigSchema.parse({
      strategy: 'llm',
      routes: [weatherRoute],
    });
    const singleSetup = setup({ config: singleRoute });
    await singleSetup.before(humanTurnState() as never, {} as never);
    expect(singleSetup.classify).not.toHaveBeenCalled();
  });

  it('skips turns with no human text and audits no-match verdicts', async () => {
    const noMatch = setup({ classify: vi.fn().mockResolvedValue(null) });
    await noMatch.before(
      { messages: [new HumanMessage('meh')] } as never,
      {} as never,
    );
    expect(noMatch.routedCapabilities.size).toBe(0);
    const record = noMatch.records.find(
      (r) => (r.detail as { step?: string }).step === 'route.none',
    );
    expect(record?.detail).toMatchObject({
      reason: 'below-threshold-or-no-match',
    });

    const aiOnly = setup();
    await aiOnly.before(
      { messages: [new AIMessage('assistant only')] } as never,
      {} as never,
    );
    expect(aiOnly.classify).not.toHaveBeenCalled();
  });

  it('emits the decision on the router UI channel when enabled', async () => {
    const emitRouter = vi.fn();
    const { before } = setup({ emitRouter });
    await before(humanTurnState() as never, {} as never);
    expect(emitRouter).toHaveBeenCalledTimes(1);
    expect(emitRouter.mock.calls[0]?.[0]).toMatchObject({
      route: 'weather',
      strategy: 'llm',
    });
  });
});
