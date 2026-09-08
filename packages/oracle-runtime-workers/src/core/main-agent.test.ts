import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  type AIMessage,
  HumanMessage,
  type ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { FakeToolCallingModel } from 'langchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRole } from '../plugin-api/types';
import { createRuntimeCore, type RuntimeCore } from './index';
import { createMainAgent } from './main-agent';
import { SkillsPlugin } from './plugins/skills';
import { WeatherPlugin } from './plugins/weather';
import { createNoopAmbient, type AmbientServices } from './runtime-context';
import { makeEnv } from './test-fixtures';

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
  plugins = [new WeatherPlugin(), new SkillsPlugin()],
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
});
