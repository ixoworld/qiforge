import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { MemorySaver } from '@langchain/langgraph';
import { FakeToolCallingModel } from 'langchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OraclePlugin } from '../plugin-api/oracle-plugin';
import type { ModelRole } from '../plugin-api/types';
import { createRuntimeCore, type RuntimeCore } from './index';
import { contextBudgetFor } from './context-budget';
import { createMainAgent } from './main-agent';
import type { ContextGuardEvent } from './middlewares/context-guard';
import { isSummarizationMessage } from './middlewares/summarization';
import { SkillsPlugin } from './plugins/skills';
import { PortalPlugin } from '../plugins/portal';
import { WeatherPlugin } from './plugins/weather';
import { createNoopAmbient, type AmbientServices } from './runtime-context';
import {
  makeClaimStore,
  makeEnv,
  makeManifest,
  makePlugin,
  makeTool,
} from './test-fixtures';
import { createToolExecutionMiddleware } from './middlewares/tool-execution';
import { ToolScheduler } from './tool-scheduler';
import { tool as pluginTool } from '../plugin-api/tool-helper';
import { resolveDeliveryProfile } from '../delivery/profile';
import { harnessLimitOf, TurnBudget } from './turn-budget';
import { z } from 'zod';

// ── Open-Meteo / skills-registry fetch stub ─────────────────────────────────

const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(): void {
  fetchCalls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      fetchCalls.push({ url, init });
      if (url.startsWith('https://geocoding-api.open-meteo.com/v1/search')) {
        return jsonResponse({
          results: [
            {
              latitude: 52.52,
              longitude: 13.41,
              name: 'Berlin',
              country: 'Germany',
            },
          ],
        });
      }
      if (url.startsWith('https://api.open-meteo.com/v1/forecast')) {
        if (url.includes('current_weather=true')) {
          return jsonResponse({
            current_weather: {
              temperature: 14,
              windspeed: 12,
              weathercode: 61,
            },
          });
        }
        return jsonResponse({
          daily: {
            time: ['2026-08-25', '2026-08-26'],
            temperature_2m_max: [18, 14],
            temperature_2m_min: [10, 8],
            weathercode: [1, 61],
          },
        });
      }
      if (url.startsWith('https://capsules.skills.ixo.earth/capsules')) {
        return jsonResponse({
          capsules: [
            { cid: 'bafy1', name: 'invoice', description: 'Make invoices' },
            {
              cid: 'bafy2',
              name: 'mine',
              description: 'My skill',
              visibility: 'private',
            },
          ],
          pagination: { total: 2, limit: 20, offset: 0, hasMore: false },
        });
      }
      return new Response('not stubbed', { status: 404 });
    }),
  );
}

// ── Scripted models per role ────────────────────────────────────────────────

type Script = Array<
  Array<{ name: string; args: Record<string, unknown>; id: string }>
>;

function scriptedLlm(
  scripts: Partial<Record<string, Script>>,
): AmbientServices['llm'] {
  return {
    get: (role: ModelRole) =>
      new FakeToolCallingModel({
        toolCalls: scripts[String(role)] ?? [],
      }) as unknown as BaseChatModel,
  };
}

function bootCore(
  plugins: OraclePlugin[] = [new WeatherPlugin(), new SkillsPlugin()],
): RuntimeCore {
  return createRuntimeCore({
    config: {
      name: 'TestOracle',
      org: 'Acme',
      description: 'a test oracle',
      prompt: { customInstructions: 'Always greet the user in French.' },
    },
    plugins,
    env: makeEnv(),
  });
}

function ambientFor(
  core: RuntimeCore,
  llm: AmbientServices['llm'],
): AmbientServices {
  return createNoopAmbient({
    config: core.validatedEnv,
    identity: core.identity,
    availablePlugins: core.availablePlugins,
    llm,
  });
}

const requestCtx = {
  user: {
    did: 'did:ixo:user1',
    matrixUserId: '@did-ixo-user1:ixo.world',
    ucanDelegation: { raw: 'ucan' },
    timezone: 'Europe/Berlin',
    currentTime: '2026-08-25T10:00:00Z',
  },
  session: { id: 'sess-1', client: 'portal' as const, requestId: 'req-1' },
};

function toolMessages(messages: BaseMessage[]): ToolMessage[] {
  return messages.filter((m): m is ToolMessage => m.type === 'tool');
}

/** `loadedPlugins` as persisted in a `getState` snapshot; `[]` when unset. */
function checkpointedLoadedPlugins(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== 'object' || !('values' in snapshot))
    throw new Error('snapshot has no values');
  const values: unknown = snapshot.values;
  if (!values || typeof values !== 'object' || !('loadedPlugins' in values))
    return [];
  const loaded: unknown = values.loadedPlugins;
  return Array.isArray(loaded)
    ? loaded.filter((p): p is string => typeof p === 'string')
    : [];
}

beforeEach(stubFetch);
afterEach(() => vi.unstubAllGlobals());

// ── createRuntimeCore ───────────────────────────────────────────────────────

describe('createRuntimeCore', () => {
  it('boots synchronously: identity, plugins, validated env, routes, llm', async () => {
    const core = bootCore();
    expect(core.identity).toMatchObject({
      name: 'TestOracle',
      org: 'Acme',
      entityDid: 'did:ixo:entity:oracle1',
    });
    expect([...core.availablePlugins]).toEqual(['weather', 'skills']);
    // Plugin defaults land in the merged config; bindings do not.
    expect(core.validatedEnv.WEATHER_DEFAULT_UNITS).toBe('celsius');
    expect(core.validatedEnv.SKILLS_CAPSULES_BASE_URL).toBe(
      'https://capsules.skills.ixo.earth',
    );
    expect(core.validatedEnv).not.toHaveProperty('USER_ORACLE');
    expect(core.pluginRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /weather/now',
    ]);
    expect(core.authExcludedRoutes).toEqual([
      { path: 'weather/now', method: 'GET' },
    ]);
    expect(core.llm.modelForRole('main')).toBe(core.llm.defaultModelId);
    expect(core.llm.modelForRole('session-title')).toBe(
      'meta-llama/llama-3.1-8b-instruct',
    );

    await expect(core.warm()).resolves.toBeUndefined();
    expect(core.registries.tools.toolNames()).toEqual([
      'get_current_weather',
      'list_skills',
      'search_skills',
    ]);
  });

  it('honours DEFAULT_MODEL and falls entityDid back to ORACLE_DID', () => {
    const env = makeEnv({ DEFAULT_MODEL: 'anthropic/claude-sonnet-5' });
    delete env.ORACLE_ENTITY_DID;
    const core = createRuntimeCore({ config: { name: 'X' }, plugins: [], env });
    expect(core.identity.entityDid).toBe('did:ixo:oracle1');
    expect(core.llm.modelForRole('main')).toBe('anthropic/claude-sonnet-5');
  });

  it('fails the boot with attributed env errors', () => {
    const env = makeEnv({ WEATHER_DEFAULT_UNITS: 'kelvin' });
    delete env.OPEN_ROUTER_API_KEY;
    expect(() =>
      createRuntimeCore({
        config: { name: 'X' },
        plugins: [new WeatherPlugin()],
        env,
      }),
    ).toThrow(
      /Plugin 'core'.*'OPEN_ROUTER_API_KEY'[\s\S]*Plugin 'weather'.*'WEATHER_DEFAULT_UNITS'/,
    );
  });

  it('serves the weather route over fetch', async () => {
    const core = bootCore([new WeatherPlugin()]);
    const route = core.pluginRoutes[0]!;
    const res = await route.handler(
      new Request('https://oracle.example/weather/now?city=Berlin'),
      {} as never,
      { auth: null },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      city: 'Berlin',
      temp_c: 14,
      conditions: 'rain',
    });
    const missing = await route.handler(
      new Request('https://oracle.example/weather/now'),
      {} as never,
      { auth: null },
    );
    expect(missing.status).toBe(400);
  });
});

// ── createMainAgent end-to-end ──────────────────────────────────────────────

describe('createMainAgent', () => {
  it('runs a tool-calling turn: load_capability → on-demand weather tool → final answer', async () => {
    const core = bootCore();
    await core.warm();
    const llm = scriptedLlm({
      main: [
        [{ name: 'load_capability', args: { names: ['weather'] }, id: 'c1' }],
        [{ name: 'get_current_weather', args: { city: 'Berlin' }, id: 'c2' }],
        [],
      ],
    });
    const ambient = ambientFor(core, llm);
    const checkpointer = new MemorySaver();

    const { agent, systemPrompt, boundToolNames } = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient,
      requestCtx,
      state: {},
      checkpointer,
    });

    // Meta-tools first, then every plugin tool (on-demand ones included —
    // gating is the middleware's job), then sub-agents.
    expect(boundToolNames.slice(0, 2)).toEqual([
      'load_capability',
      'list_capabilities',
    ]);
    expect(boundToolNames).toEqual(
      expect.arrayContaining([
        'get_current_weather',
        'get_weather_forecast',
        'list_skills',
        'search_skills',
        'call_weather_planner_agent',
      ]),
    );
    expect(systemPrompt).toContain(
      'You are TestOracle, an AI agent operated by Acme. a test oracle.',
    );
    expect(systemPrompt).toContain('## Available Capabilities');
    expect(systemPrompt).toContain('- **skills** — ');
    expect(systemPrompt).not.toContain('- **weather** — ');
    expect(systemPrompt).toContain('Always greet the user in French.');
    expect(systemPrompt).toContain(
      '**Current time:** 2026-08-25T10:00:00Z (Europe/Berlin)',
    );

    const config = { configurable: { thread_id: 'sess-1' } };
    const result = (await agent.invoke(
      { messages: [new HumanMessage('Weather in Berlin?')] },
      config,
    )) as { messages: BaseMessage[]; loadedPlugins?: string[] };

    const tools = toolMessages(result.messages);
    expect(tools.map((t) => t.tool_call_id)).toEqual(['c1', 'c2']);
    // load_capability returned a Command: state updated AND a ToolMessage
    // with the manifest + tool list landed on the same turn.
    const loaded = JSON.parse(String(tools[0]?.content)) as Array<{
      title: string;
      alreadyAvailable: boolean;
      tools: Array<{ name: string }>;
    }>;
    expect(loaded[0]).toMatchObject({
      title: 'Weather',
      alreadyAvailable: false,
    });
    expect(loaded[0]?.tools.map((t) => t.name)).toEqual([
      'get_current_weather',
      'get_weather_forecast',
    ]);
    expect(result.loadedPlugins).toEqual(['weather']);
    // The weather tool ran against the (stubbed) Open-Meteo API.
    expect(JSON.parse(String(tools[1]?.content))).toMatchObject({
      city: 'Berlin',
      temp: 14,
      conditions: 'rain',
      units: 'celsius',
    });
    expect(fetchCalls.some((c) => c.url.includes('geocoding-api'))).toBe(true);

    // The checkpointer persisted the thread, including loadedPlugins.
    const snapshot = (await agent.getState(config)) as unknown as {
      values: { loadedPlugins: string[] };
    };
    expect(snapshot.values.loadedPlugins).toEqual(['weather']);
  });

  it('preloadedPlugins reach the gate and ctx.loadedPlugins but never the graph state', async () => {
    // An on-demand probe plugin whose tool reports what the RuntimeContext
    // considers loaded at call time.
    const probe = makePlugin({
      name: 'probe',
      manifest: makeManifest({
        title: 'Probe',
        summary: 'Reports the loaded plugins.',
        visibility: 'on-demand',
      }),
      getTools: () => [
        makeTool('probe_loaded', {
          handler: async (_args, ctx) => Array.from(ctx.loadedPlugins),
        }),
      ],
    });
    const core = bootCore([new WeatherPlugin(), probe]);
    await core.warm();
    const llm = scriptedLlm({
      main: [[{ name: 'probe_loaded', args: {}, id: 'c1' }], []],
    });
    const gateLines: string[] = [];
    const ambient = createNoopAmbient({
      config: core.validatedEnv,
      identity: core.identity,
      availablePlugins: core.availablePlugins,
      llm,
      logger: {
        log: (message: unknown) => {
          if (String(message).startsWith('[CapabilityGateMiddleware]'))
            gateLines.push(String(message));
        },
        warn: () => undefined,
        error: () => undefined,
      },
    });
    const checkpointer = new MemorySaver();

    const { agent } = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      preloadedPlugins: new Set(['probe']),
      ambient,
      requestCtx,
      state: {},
      checkpointer,
    });

    const config = { configurable: { thread_id: 'sess-preload' } };
    const result = (await agent.invoke(
      { messages: [new HumanMessage('What is loaded?')] },
      config,
    )) as { messages: BaseMessage[]; loadedPlugins?: string[] };

    // The gate admitted the probe tool (weather stayed hidden), so the
    // model's first call ran without a `load_capability` round trip …
    expect(gateLines).toHaveLength(2);
    expect(gateLines[0]).toContain('preloadedPlugins=probe');
    const tools = toolMessages(result.messages);
    expect(tools.map((t) => t.tool_call_id)).toEqual(['c1']);
    // … and the handler saw the preload as loaded …
    expect(JSON.parse(String(tools[0]?.content))).toEqual(['probe']);
    // … while the checkpointed channel never learned about it: the turn
    // output and the checkpoint carry no `loadedPlugins` beyond the default.
    expect(result.loadedPlugins ?? []).toEqual([]);
    expect(checkpointedLoadedPlugins(await agent.getState(config))).toEqual([]);
  });

  it('renders the "Browser tools this turn" block from state.browserTools, with the load line until portal is loaded', async () => {
    const core = bootCore([new PortalPlugin(), new SkillsPlugin()]);
    await core.warm();
    const ambient = ambientFor(core, scriptedLlm({}));
    const browserTools = [
      { name: 'open_url', description: 'Open a URL', schema: {} },
      { name: 'create_page_room', description: 'Create a page', schema: {} },
    ];
    const promptFor = async (state: {
      browserTools?: typeof browserTools;
      loadedPlugins?: string[];
    }) =>
      (
        await createMainAgent({
          registries: core.registries,
          identity: core.identity,
          config: core.validatedEnv,
          availablePlugins: core.availablePlugins,
          ambient,
          requestCtx,
          state,
        })
      ).systemPrompt;
    const LOAD_LINE =
      "They are bound behind the `portal` capability — call `load_capability({ names: ['portal'] })` once before using them.";

    // Portal is on-demand by default and not loaded yet: block + load line.
    const gated = await promptFor({ browserTools });
    expect(gated).toContain(
      "The Portal exposed these browser-side tools for this turn (they act on the user's screen): open_url, create_page_room",
    );
    expect(gated).toContain(LOAD_LINE);

    // Loaded this thread: the block stays, the load line goes.
    const loaded = await promptFor({ browserTools, loadedPlugins: ['portal'] });
    expect(loaded).toContain('## Browser tools this turn');
    expect(loaded).not.toContain(LOAD_LINE);

    // No browser tools on the request: the block costs nothing.
    expect(await promptFor({})).not.toContain('## Browser tools this turn');
  });

  it('runs a sub-agent as a tool and forwards its tool calls into the parent history', async () => {
    const core = bootCore([new WeatherPlugin()]);
    const llm = scriptedLlm({
      main: [
        [
          {
            name: 'call_weather_planner_agent',
            args: { task: 'Jacket in Berlin tomorrow?' },
            id: 'p1',
          },
        ],
        [],
      ],
      subagent: [
        [
          {
            name: 'get_weather_forecast',
            args: { city: 'Berlin', days: 2 },
            id: 's1',
          },
        ],
        [
          {
            name: 'recommend_outfit',
            args: { temp_c: 14, conditions: 'rain' },
            id: 's2',
          },
        ],
        [],
      ],
    });
    const ambient = ambientFor(core, llm);

    const { agent } = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient,
      requestCtx,
      state: { loadedPlugins: ['weather'] },
      checkpointer: new MemorySaver(),
    });

    const result = (await agent.invoke(
      {
        messages: [new HumanMessage('Do I need a jacket in Berlin tomorrow?')],
      },
      { configurable: { thread_id: 'sess-2' } },
    )) as { messages: BaseMessage[] };

    const tools = toolMessages(result.messages);
    // `forwardTools: true` → the sub-agent's own calls are replayed into the
    // parent transcript with ids prefixed by the parent tool-call id, then
    // the sub-agent's answer closes the parent call.
    expect(tools.map((t) => t.name)).toEqual([
      'get_weather_forecast',
      'recommend_outfit',
      undefined,
    ]);
    expect(tools.map((t) => t.tool_call_id)).toEqual(['p1_s1', 'p1_s2', 'p1']);
    expect(JSON.parse(String(tools[0]?.content))).toMatchObject({
      city: 'Berlin',
      timezone: 'Europe/Berlin',
      days: [
        { date: '2026-08-25', tempMax: 18, conditions: 'partly cloudy' },
        { date: '2026-08-26', tempMax: 14, conditions: 'rain' },
      ],
    });
    expect(String(tools[1]?.content)).toBe(
      'Wear a light jacket and bring an umbrella.',
    );
    // Forwarded AI messages carry the rewritten ids too.
    const forwardedAi = result.messages.filter(
      (m): m is AIMessage =>
        m.type === 'ai' && (m as AIMessage).tool_calls?.[0]?.id === 'p1_s1',
    );
    expect(forwardedAi).toHaveLength(1);

    // The shared-state accessor another plugin would read is populated from
    // the sub-agent's tool run. Inner tools see the request's session id
    // (`requestCtx.session.id`, via the build-time fallback context), not
    // the LangGraph thread id.
    const shared = core.registries.sharedState.build({}, {
      session: { id: requestCtx.session.id },
    } as never) as { lastWeatherQuery?: { city: string } };
    expect(shared.lastWeatherQuery?.city).toBe('Berlin');
  });

  it('runs the skills tools public-only without a signing key, and with a bearer when a builder mints one', async () => {
    const withStub = new SkillsPlugin({
      ucanBuilder: async () => 'minted-ucan',
    });
    for (const [plugin, expectAuth] of [
      [new SkillsPlugin(), false],
      [withStub, true],
    ] as const) {
      stubFetch();
      const core = bootCore([plugin]);
      const llm = scriptedLlm({
        main: [[{ name: 'list_skills', args: {}, id: 'l1' }], []],
      });
      const { agent } = await createMainAgent({
        registries: core.registries,
        identity: core.identity,
        config: core.validatedEnv,
        availablePlugins: core.availablePlugins,
        ambient: ambientFor(core, llm),
        requestCtx,
        state: {},
      });
      const result = (await agent.invoke({
        messages: [new HumanMessage('What skills do you have?')],
      })) as { messages: BaseMessage[] };
      const [listMsg] = toolMessages(result.messages);
      const payload = JSON.parse(String(listMsg?.content)) as {
        skills: Array<{ title: string; source: string }>;
        privateSkillCount: number;
      };
      // Private rows first, then public.
      expect(payload.skills.map((s) => `${s.title}:${s.source}`)).toEqual([
        'mine:private',
        'invoice:public',
      ]);
      const registryCall = fetchCalls.find((c) => c.url.includes('/capsules?'));
      const headers = (registryCall?.init?.headers ?? {}) as Record<
        string,
        string
      >;
      expect(headers['X-IXO-Network']).toBe('devnet');
      expect('Authorization' in headers).toBe(expectAuth);
      expect(headers.Authorization).toBe(
        expectAuth ? 'Bearer minted-ucan' : undefined,
      );
    }
  });

  it('keeps building when one sub-agent fails to initialise', async () => {
    const core = bootCore([new WeatherPlugin()]);
    const error = vi.fn();
    const ambient = createNoopAmbient({
      config: core.validatedEnv,
      identity: core.identity,
      availablePlugins: core.availablePlugins,
      llm: {
        get: (role) => {
          if (role === 'subagent') throw new Error('no subagent model');
          return new FakeToolCallingModel({
            toolCalls: [],
          }) as unknown as BaseChatModel;
        },
      },
      logger: { log: vi.fn(), warn: vi.fn(), error },
    });
    const { boundToolNames } = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient,
      requestCtx,
      state: {},
    });
    expect(boundToolNames).toContain('get_current_weather');
    expect(boundToolNames).not.toContain('call_weather_planner_agent');
    expect(String(error.mock.calls[0]?.[0])).toContain('sub-agent init failed');
  });

  // ── Context budget wiring ─────────────────────────────────────────────────

  /** A past turn: question, tool call, a `chars`-long result, answer. */
  const pastTurn = (i: number, chars: number): BaseMessage[] => [
    new HumanMessage({ id: `h${i}`, content: `question ${i}` }),
    new AIMessage({
      id: `a${i}`,
      content: '',
      tool_calls: [
        { id: `c${i}`, name: 'get_current_weather', args: { city: `c${i}` } },
      ],
    }),
    new ToolMessage({
      id: `t${i}`,
      tool_call_id: `c${i}`,
      name: 'get_current_weather',
      content: `${i}:${'w'.repeat(chars)}`,
    }),
    new AIMessage({ id: `r${i}`, content: `answer ${i}` }),
  ];
  // 32k window: summarizeAt 16,000 tokens, pruneAt 11,200, cap 15,360 chars.
  const budget = contextBudgetFor({
    model: 'm',
    tokens: 32_000,
    origin: 'override',
  });

  it('a context budget binds read_result, logs the budget, and has the guard prune old results under pressure', async () => {
    const core = bootCore([new WeatherPlugin()]);
    const log = vi.fn();
    const ambient = createNoopAmbient({
      config: core.validatedEnv,
      identity: core.identity,
      availablePlugins: core.availablePlugins,
      llm: scriptedLlm({}),
      logger: { log, warn: vi.fn(), error: vi.fn() },
    });
    const events: ContextGuardEvent[] = [];
    const readResult = vi.fn();
    const { agent, boundToolNames } = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient,
      requestCtx,
      state: {},
      contextBudget: budget,
      hooks: { readResult, onContextEvent: (e) => events.push(e) },
    });
    expect(boundToolNames).toContain('read_result');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        '[context] model=m window=32000 (override) summarizeAt=16000 pruneAt=11200 resultCap=15360c',
      ),
    );

    // 6 past turns × 8k-char results ≈ 12k tokens: over pruneAt, under
    // summarizeAt — the request is pruned, the history is not condensed.
    // The 10-message tail keeps the last two results and the new question;
    // the four older results are demoted.
    const history = Array.from({ length: 6 }, (_, i) =>
      pastTurn(i, 8_000),
    ).flat();
    const result = (await agent.invoke(
      { messages: [...history, new HumanMessage('and now?')] },
      { configurable: { thread_id: 'budget-1' } },
    )) as { messages: BaseMessage[] };
    expect(events).toEqual([
      expect.objectContaining({ kind: 'prune', stage: 'soft', pruned: 4 }),
    ]);
    const prune = events[0] as Extract<ContextGuardEvent, { kind: 'prune' }>;
    expect(prune.beforeTokens).toBeGreaterThan(budget.pruneAtTokens);
    expect(prune.afterTokens).toBeLessThan(budget.pruneAtTokens);
    // Pruning is request-only: the state still holds every result whole.
    const kept = toolMessages(result.messages);
    expect(kept).toHaveLength(6);
    expect(kept.every((m) => String(m.content).length > 8_000)).toBe(true);
    expect(result.messages.some(isSummarizationMessage)).toBe(false);
  });

  it('a context budget summarizes the history at the window fraction with no message-count trigger', async () => {
    const core = bootCore([new WeatherPlugin()]);
    const summarizer = new FakeListChatModel({ responses: ['the gist'] });
    const log = vi.fn();
    const ambient = createNoopAmbient({
      config: core.validatedEnv,
      identity: core.identity,
      availablePlugins: core.availablePlugins,
      llm: {
        get: (role) =>
          (role === 'routing'
            ? summarizer
            : new FakeToolCallingModel({
                toolCalls: [],
              })) as unknown as BaseChatModel,
      },
      logger: { log, warn: vi.fn(), error: vi.fn() },
    });
    const { agent } = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient,
      requestCtx,
      state: {},
      contextBudget: budget,
    });

    // 6 past turns × 12k-char results ≈ 18k tokens > summarizeAt (16k) with
    // only 25 messages — the legacy 20-message trigger would have fired at
    // 8k chars; here the token trigger is what fires.
    const history = Array.from({ length: 6 }, (_, i) =>
      pastTurn(i, 12_000),
    ).flat();
    const result = (await agent.invoke(
      { messages: [...history, new HumanMessage('and now?')] },
      { configurable: { thread_id: 'budget-2' } },
    )) as { messages: BaseMessage[] };
    const summaries = result.messages.filter(isSummarizationMessage);
    expect(summaries).toHaveLength(1);
    expect(String(summaries[0]!.content)).toContain('the gist');
    expect(result.messages.length).toBeLessThan(history.length);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[summarization\] condensed the history: 25 messages/,
      ),
    );

    // Under the threshold nothing is condensed, however many messages there are.
    const small = Array.from({ length: 12 }, (_, i) => pastTurn(i, 100)).flat();
    const untouched = (await agent.invoke(
      { messages: [...small, new HumanMessage('still here?')] },
      { configurable: { thread_id: 'budget-3' } },
    )) as { messages: BaseMessage[] };
    expect(untouched.messages.some(isSummarizationMessage)).toBe(false);
    expect(toolMessages(untouched.messages)).toHaveLength(12);
  });
});

// ── Tool execution inside the real middleware stack ─────────────────────────

describe('createMainAgent tool execution', () => {
  /** A read that fails once like a dropped connection, and a write that always does. */
  function flakyPlugin() {
    const calls = { read: 0, write: 0 };
    const plugin = makePlugin({
      name: 'flaky',
      getTools: () => [
        makeTool('get_flaky', {
          effect: 'read',
          handler: async () => {
            calls.read += 1;
            if (calls.read === 1) throw new TypeError('fetch failed');
            return 'read ok';
          },
        }),
        makeTool('send_flaky', {
          effect: 'write',
          schema: z.object({ to: z.string() }),
          handler: async () => {
            calls.write += 1;
            throw new TypeError('fetch failed');
          },
        }),
      ],
    });
    return { plugin, calls };
  }

  async function build(
    plugin: OraclePlugin,
    script: Script,
    limits = { tokens: 1_000_000, tools: 20, durationMs: 60_000 },
  ) {
    const core = bootCore([plugin]);
    await core.warm();
    const claims = makeClaimStore();
    const budget = new TurnBudget(limits);
    const built = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient: ambientFor(core, scriptedLlm({ main: script })),
      requestCtx,
      state: {},
      checkpointer: new MemorySaver(),
      hooks: {
        toolExecution: createToolExecutionMiddleware({
          budget,
          scheduler: new ToolScheduler(),
          laneOf: (name) =>
            built.subAgentToolNames.has(name)
              ? 'subagent'
              : (built.toolEffects.get(name) ?? 'write'),
          runId: 'run-1',
          sessionId: 'sess-1',
          claims: claims.store,
        }),
      },
    });
    return { agent: built.agent, claims, budget };
  }

  it('retries a transient read once, never a write, and keeps the write’s claim', async () => {
    const { plugin, calls } = flakyPlugin();
    const { agent, claims, budget } = await build(plugin, [
      [
        { name: 'get_flaky', args: {}, id: 'r1' },
        { name: 'send_flaky', args: { to: 'bob' }, id: 'w1' },
      ],
      [],
    ]);
    const result = (await agent.invoke(
      { messages: [new HumanMessage('go')] },
      { configurable: { thread_id: 'sess-1' } },
    )) as { messages: BaseMessage[] };
    const byId = new Map(
      toolMessages(result.messages).map((m) => [m.tool_call_id, m]),
    );
    expect(calls).toEqual({ read: 2, write: 1 });
    expect(byId.get('r1')?.content).toBe('read ok');
    expect(byId.get('w1')?.status).toBe('error');
    // The write failed on the wire: its outcome is unknown, the claim stays.
    expect([...claims.rows.values()]).toEqual([
      { toolName: 'send_flaky', runId: 'run-1', state: 'pending' },
    ]);
    // Both read attempts and the write were charged.
    expect(budget.snapshot().toolAttempts).toBe(3);
  }, 15_000);

  it('ends the turn when a retry runs out of budget, instead of reporting a tool error', async () => {
    const { plugin, calls } = flakyPlugin();
    const { agent } = await build(
      plugin,
      [[{ name: 'get_flaky', args: {}, id: 'r1' }], []],
      { tokens: 1_000_000, tools: 1, durationMs: 60_000 },
    );
    await expect(
      agent.invoke(
        { messages: [new HumanMessage('go')] },
        { configurable: { thread_id: 'sess-2' } },
      ),
    ).rejects.toSatisfy(
      // LangChain wraps it once per middleware layer; the stream recovers
      // the original the same way.
      (error: unknown) => harnessLimitOf(error)?.limit === 'tools',
    );
    expect(calls.read).toBe(1);
  }, 15_000);
});

// ── Chat delivery ─────────────────────────────────────────────────────────────

describe('createMainAgent — chat delivery', () => {
  const whatsapp = resolveDeliveryProfile({
    client: 'channel',
    channel: {
      provider: 'whatsapp',
      bindingId: 'chb_x',
      remoteMessageRef: 'hmac:x',
    },
  });

  it('binds the turn tool, tells the model it is in a chat and ends the run on a return-direct call', async () => {
    const core = bootCore();
    const surfaces: unknown[] = [];
    const sendDocument = pluginTool(
      async (_args, ctx) => {
        surfaces.push(ctx.session.surface);
        return { ok: true };
      },
      {
        name: 'create_artifact',
        description: 'Send a document.',
        schema: z.object({}),
        effect: 'read',
      },
    );
    const { agent, systemPrompt, boundToolNames, toolEffects, context } =
      await createMainAgent({
        registries: core.registries,
        identity: core.identity,
        config: core.validatedEnv,
        availablePlugins: core.availablePlugins,
        ambient: ambientFor(
          core,
          scriptedLlm({
            main: [[{ name: 'create_artifact', args: {}, id: 'c1' }], []],
          }),
        ),
        requestCtx: {
          ...requestCtx,
          session: { ...requestCtx.session, client: 'channel' },
        },
        state: {},
        delivery: whatsapp,
        hooks: { turnTools: [{ tool: sendDocument, returnDirect: true }] },
      });
    expect(boundToolNames).toContain('create_artifact');
    expect(toolEffects.get('create_artifact')).toBe('read');
    expect(systemPrompt).toContain('You are replying in WhatsApp.');
    expect(systemPrompt).toContain('`create_artifact`');
    expect(context.session.surface).toEqual({
      kind: 'chat',
      surface: 'whatsapp',
      label: 'WhatsApp',
    });

    const result = (await agent.invoke(
      { messages: [new HumanMessage('Plan my week')] },
      { configurable: { thread_id: 'sess-chat' }, context },
    )) as { messages: BaseMessage[] };
    expect(result.messages.at(-1)?.type).toBe('tool');
    expect(surfaces).toEqual([
      { kind: 'chat', surface: 'whatsapp', label: 'WhatsApp' },
    ]);
  });

  it('adds nothing to a Portal turn', async () => {
    const core = bootCore();
    const { systemPrompt, context } = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient: ambientFor(core, scriptedLlm({})),
      requestCtx,
      state: {},
      delivery: { kind: 'stream' },
    });
    expect(systemPrompt).not.toContain(
      '## Where this conversation is happening',
    );
    expect(context.session.surface).toEqual({ kind: 'stream' });
  });
});
