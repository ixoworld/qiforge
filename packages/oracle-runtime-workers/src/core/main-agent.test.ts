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
import { contextBudgetFor, DEFAULT_CONTEXT_KNOBS } from './context-budget';
import { budgetedLlm } from './budgeted-llm';
import type { ToolMark } from '../do/run-store';
import {
  createToolMarksMiddleware,
  toolEffectOf,
  type ToolMarkStore,
} from './middlewares/tool-marks';
import { createMainAgent } from './main-agent';
import type { ContextGuardEvent } from './middlewares/context-guard';
import { isSummarizationMessage } from './middlewares/summarization';
import { SkillsPlugin } from './plugins/skills';
import { PortalPlugin } from '../plugins/portal';
import { WeatherPlugin } from './plugins/weather';
import { FlowsPlugin } from '../plugins/flows/flows.plugin';
import { FLOWS_OPERATING_GUIDE } from '../plugins/flows/prompts';
import { createNoopAmbient, type AmbientServices } from './runtime-context';
import {
  makeClaimStore,
  makeEnv,
  makeManifest,
  makePlugin,
  makeSubAgent,
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
    // The day and the zone only: the exact time would change the prompt
    // on every turn.
    expect(systemPrompt).toContain(
      '**Current date:** Tuesday, 2026-08-25 (Europe/Berlin)',
    );
    expect(systemPrompt).not.toContain('10:00');

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

  it('runs an identical write once per turn, whether repeated in a later step or in the same response', async () => {
    let writes = 0;
    let scrolls = 0;
    const notes = makePlugin({
      name: 'notes',
      manifest: makeManifest({
        title: 'Notes',
        summary: 'Records notes.',
        visibility: 'always',
      }),
      getTools: () => [
        makeTool('record_note', {
          handler: async () => {
            writes += 1;
            return `recorded #${writes}`;
          },
        }),
        // A UI step: the same arguments again is a new action.
        makeTool('scroll_page', {
          repeatable: true,
          handler: async () => {
            scrolls += 1;
            return `scrolled ${scrolls}`;
          },
        }),
      ],
    });
    const core = bootCore([new WeatherPlugin(), notes]);
    await core.warm();
    const note = (id: string) => ({
      name: 'record_note',
      args: { text: 'buy milk' },
      id,
    });

    const run = async (
      script: Script,
      threadId: string,
      env: Record<string, unknown> = {},
    ) => {
      const { agent } = await createMainAgent({
        registries: core.registries,
        identity: core.identity,
        config: { ...core.validatedEnv, ...env },
        availablePlugins: core.availablePlugins,
        ambient: ambientFor(core, scriptedLlm({ main: script })),
        requestCtx,
        state: {},
        checkpointer: new MemorySaver(),
      });
      const result = (await agent.invoke(
        { messages: [new HumanMessage('Note: buy milk.')] },
        { configurable: { thread_id: threadId } },
      )) as { messages: BaseMessage[] };
      return new Map(
        toolMessages(result.messages).map((m) => [m.tool_call_id, m]),
      );
    };

    const later = await run([[note('c1')], [note('c2')], []], 'cap-later');
    expect(String(later.get('c1')?.content)).toBe('recorded #1');
    expect(later.get('c2')?.status).toBe('error');
    expect(String(later.get('c2')?.content)).toContain(
      'would repeat its effect',
    );
    expect(writes).toBe(1);

    const sameStep = await run([[note('d1'), note('d2')], []], 'cap-same');
    expect(String(sameStep.get('d1')?.content)).toBe('recorded #2');
    expect(sameStep.get('d2')?.status).toBe('error');
    expect(writes).toBe(2);

    // A repeatable tool (a write by name) runs again with the same arguments.
    const scroll = (id: string) => ({
      name: 'scroll_page',
      args: { direction: 'down' },
      id,
    });
    const scrolled = await run(
      [[scroll('e1')], [scroll('e2')], []],
      'cap-repeatable',
    );
    expect(String(scrolled.get('e2')?.content)).toBe('scrolled 2');
    expect(scrolls).toBe(2);

    // TURN_MAX_IDENTICAL_WRITES raises the write cap.
    const raised = await run([[note('f1')], [note('f2')], []], 'cap-env', {
      TURN_MAX_IDENTICAL_WRITES: 2,
    });
    expect(String(raised.get('f2')?.content)).toBe('recorded #4');
    expect(writes).toBe(4);
  });

  it('refuses to run an on-demand tool the model calls before its capability is loaded', async () => {
    let probeRuns = 0;
    const probe = makePlugin({
      name: 'probe',
      manifest: makeManifest({
        title: 'Probe',
        summary: 'Counts its runs.',
        visibility: 'on-demand',
      }),
      getTools: () => [
        makeTool('probe_run', {
          handler: async () => {
            probeRuns += 1;
            return 'probe ran';
          },
        }),
      ],
    });
    const core = bootCore([new WeatherPlugin(), probe]);
    await core.warm();

    const run = async (script: Script, threadId: string) => {
      const { agent } = await createMainAgent({
        registries: core.registries,
        identity: core.identity,
        config: core.validatedEnv,
        availablePlugins: core.availablePlugins,
        ambient: ambientFor(core, scriptedLlm({ main: script })),
        requestCtx,
        state: {},
        checkpointer: new MemorySaver(),
      });
      const result = (await agent.invoke(
        { messages: [new HumanMessage('Run the probe.')] },
        { configurable: { thread_id: threadId } },
      )) as { messages: BaseMessage[] };
      return new Map(
        toolMessages(result.messages).map((m) => [m.tool_call_id, m]),
      );
    };
    const loadProbe = (id: string) => ({
      name: 'load_capability',
      args: { names: ['probe'] },
      id,
    });

    // Called by name while hidden: refused and never run; after the load
    // step the same tool runs.
    const direct = await run(
      [
        [{ name: 'probe_run', args: {}, id: 'c1' }],
        [loadProbe('c2')],
        [{ name: 'probe_run', args: {}, id: 'c3' }],
        [],
      ],
      'gate-direct',
    );
    expect(direct.get('c1')?.status).toBe('error');
    expect(String(direct.get('c1')?.content)).toContain(
      'belongs to the "probe" capability, which is not loaded',
    );
    expect(String(direct.get('c3')?.content)).toBe('probe ran');
    expect(probeRuns).toBe(1);

    // A load in the same model response does not unlock the call beside
    // it: both run on the state from before either.
    const sameStep = await run(
      [
        [loadProbe('c1'), { name: 'probe_run', args: {}, id: 'c2' }],
        [{ name: 'probe_run', args: {}, id: 'c3' }],
        [],
      ],
      'gate-same-step',
    );
    expect(sameStep.get('c2')?.status).toBe('error');
    expect(String(sameStep.get('c3')?.content)).toBe('probe ran');
    expect(probeRuns).toBe(2);
  });

  it("keeps a plugin the user's delegation does not grant out of reach: load refused, tools never run", async () => {
    const VAULT = { resource: 'ixo:vault', action: 'vault/read' };
    const runs = { files: 0, vault: 0 };
    const files = makePlugin({
      name: 'files',
      manifest: makeManifest({
        title: 'Files',
        summary: 'Personal files.',
        visibility: 'on-demand',
        requires: [VAULT],
      }),
      getTools: () => [
        makeTool('files_read', {
          handler: async () => {
            runs.files += 1;
            return 'files read';
          },
        }),
      ],
    });
    const vault = makePlugin({
      name: 'vault',
      manifest: makeManifest({
        title: 'Vault',
        summary: 'Always-on vault.',
        visibility: 'always',
        requires: [VAULT],
      }),
      getTools: () => [
        makeTool('vault_read', {
          handler: async () => {
            runs.vault += 1;
            return 'vault read';
          },
        }),
      ],
    });
    const core = bootCore([new WeatherPlugin(), files, vault]);
    await core.warm();

    const script: Script = [
      [{ name: 'load_capability', args: { names: ['files'] }, id: 'c1' }],
      [
        { name: 'files_read', args: {}, id: 'c2' },
        { name: 'vault_read', args: {}, id: 'c3' },
      ],
      [],
    ];
    const run = async (
      capabilities: Array<{ resource: string; action: string }>,
      threadId: string,
    ) => {
      const { agent } = await createMainAgent({
        registries: core.registries,
        identity: core.identity,
        config: core.validatedEnv,
        availablePlugins: core.availablePlugins,
        ambient: ambientFor(core, scriptedLlm({ main: script })),
        requestCtx: {
          ...requestCtx,
          user: {
            ...requestCtx.user,
            ucanDelegation: { raw: 'ucan', capabilities },
          },
        },
        state: {},
        checkpointer: new MemorySaver(),
      });
      const result = (await agent.invoke(
        { messages: [new HumanMessage('Read my files.')] },
        { configurable: { thread_id: threadId } },
      )) as { messages: BaseMessage[] };
      return new Map(
        toolMessages(result.messages).map((m) => [m.tool_call_id, m]),
      );
    };

    const refused = await run(
      [{ resource: 'ixo:oracle', action: '*' }],
      'requires-refused',
    );
    const [load] = JSON.parse(String(refused.get('c1')?.content)) as Array<{
      refused?: { reason: string };
    }>;
    expect(load?.refused?.reason).toContain('`vault/read` on `ixo:vault`');
    for (const id of ['c2', 'c3']) {
      expect(refused.get(id)?.status).toBe('error');
      expect(String(refused.get(id)?.content)).toContain(
        "the user's authorization for this oracle does not grant it",
      );
    }
    expect(runs).toEqual({ files: 0, vault: 0 });

    const granted = await run(
      [{ resource: 'ixo:vault', action: 'vault/*' }],
      'requires-granted',
    );
    expect(String(granted.get('c2')?.content)).toBe('files read');
    expect(String(granted.get('c3')?.content)).toBe('vault read');
    expect(runs).toEqual({ files: 1, vault: 1 });
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

  it('never lets a browser-declared name stand in for a server tool or a meta-tool', async () => {
    let writes = 0;
    const notes = makePlugin({
      name: 'notes',
      manifest: makeManifest({
        title: 'Notes',
        summary: 'Records notes.',
        visibility: 'always',
      }),
      getTools: () => [
        makeTool('record_note', {
          handler: async () => {
            writes += 1;
            return `recorded #${writes}`;
          },
        }),
        // Declared a write although its name reads like a read.
        makeTool('get_note_count', { effect: 'write' }),
      ],
    });
    const core = bootCore([notes, new PortalPlugin()]);
    await core.warm();
    const browserTools = [
      { name: 'record_note', description: 'Shadow', schema: {} },
      { name: 'get_note_count', description: 'Shadow', schema: {} },
      { name: 'load_capability', description: 'Shadow', schema: {} },
      { name: 'open_url', description: 'Open a URL', schema: {} },
    ];
    const note = (id: string) => ({
      name: 'record_note',
      args: { text: 'buy milk' },
      id,
    });
    const warn = vi.fn();
    const ambient = createNoopAmbient({
      config: core.validatedEnv,
      identity: core.identity,
      availablePlugins: core.availablePlugins,
      llm: scriptedLlm({ main: [[note('c1')], [note('c2')], []] }),
      logger: {
        log: () => undefined,
        warn,
        error: () => undefined,
        debug: () => undefined,
        verbose: () => undefined,
      },
    });
    const { agent, boundToolNames, toolEffects, systemPrompt } =
      await createMainAgent({
        registries: core.registries,
        identity: core.identity,
        config: core.validatedEnv,
        availablePlugins: core.availablePlugins,
        ambient,
        requestCtx,
        state: { browserTools, loadedPlugins: ['portal'] },
        checkpointer: new MemorySaver(),
      });

    const count = (name: string) =>
      boundToolNames.filter((bound) => bound === name).length;
    expect(count('record_note')).toBe(1);
    expect(count('get_note_count')).toBe(1);
    expect(count('load_capability')).toBe(1);
    expect(count('open_url')).toBe(1);
    expect(toolEffects.get('get_note_count')).toBe('write');
    expect(toolEffects.get('load_capability')).toBe('read');
    expect(systemPrompt).toContain(
      "The Portal exposed these browser-side tools for this turn (they act on the user's screen): open_url",
    );
    // A clash with a server tool is dropped by the registry as the tools are
    // collected; one with a meta-tool by the agent build. Each names the
    // plugin and the tool.
    for (const name of ['record_note', 'get_note_count', 'load_capability'])
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`"portal".*"${name}"|"${name}".*"portal"`),
        ),
      );

    // The server's handler runs, and its identical write stays capped: the
    // browser tool's `repeatable` flag did not reach the server tool's name.
    const result = (await agent.invoke(
      { messages: [new HumanMessage('Note: buy milk.')] },
      { configurable: { thread_id: 'shadow' } },
    )) as { messages: BaseMessage[] };
    const byId = new Map(
      toolMessages(result.messages).map((m) => [m.tool_call_id, m]),
    );
    expect(String(byId.get('c1')?.content)).toBe('recorded #1');
    expect(byId.get('c2')?.status).toBe('error');
    expect(String(byId.get('c2')?.content)).toContain(
      'would repeat its effect',
    );
    expect(writes).toBe(1);
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
        // The thread has weather loaded: the graph state says so as well as
        // the build-time state (the gate checks the graph's at tool-call time).
        loadedPlugins: ['weather'],
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

describe('createMainAgent admin-plane tools', () => {
  const ADMIN_ROOT = {
    resource: 'ixo:qiforge:admin-tool',
    action: 'admin-tool/invoke',
  };

  /** `requestCtx` whose delegation (as `withCapabilities` parses it) grants `capabilities`. */
  const granting = (
    capabilities: Array<{ resource: string; action: string }>,
  ) => ({
    ...requestCtx,
    user: {
      ...requestCtx.user,
      ucanDelegation: { raw: 'ucan', capabilities },
    },
  });

  it('binds only the admin tools the delegation grants, and the prompt never shows the rest', async () => {
    const runs = { grant: 0, rotate: 0 };
    const authority = makePlugin({
      name: 'authority',
      manifest: makeManifest({
        title: 'Authority',
        summary: 'Grants delegated authority.',
        visibility: 'always',
        examples: [{ user: 'Let Bob sign for me', tool: 'grant_authority' }],
      }),
      getTools: () => [
        makeTool('grant_authority', {
          plane: 'admin',
          handler: async () => {
            runs.grant += 1;
            return 'granted';
          },
        }),
      ],
    });
    const keys = makePlugin({
      name: 'keys',
      manifest: makeManifest({
        title: 'Keys',
        summary: 'Signing keys.',
        visibility: 'always',
        examples: [
          { user: 'Rotate my key', tool: 'rotate_key' },
          { user: 'Which keys do I have?', tool: 'list_keys' },
        ],
      }),
      getTools: () => [
        makeTool('list_keys'),
        makeTool('rotate_key', {
          plane: 'admin',
          handler: async () => {
            runs.rotate += 1;
            return 'rotated';
          },
        }),
      ],
    });
    const core = bootCore([new WeatherPlugin(), authority, keys]);
    await core.warm();
    const build = (
      capabilities: Array<{ resource: string; action: string }>,
      script: Script = [],
    ) =>
      createMainAgent({
        registries: core.registries,
        identity: core.identity,
        config: core.validatedEnv,
        availablePlugins: core.availablePlugins,
        ambient: ambientFor(core, scriptedLlm({ main: script })),
        requestCtx: granting(capabilities),
        state: {},
        checkpointer: new MemorySaver(),
      });

    const denied = await build(
      [
        {
          resource: 'ixo:qiforge:admin-tool/keys/rotate_key_all',
          action: 'admin-tool/invoke',
        },
      ],
      [
        [
          { name: 'rotate_key', args: {}, id: 'c1' },
          { name: 'grant_authority', args: {}, id: 'c2' },
        ],
        [],
      ],
    );
    expect(denied.boundToolNames).toContain('list_keys');
    expect(denied.boundToolNames).not.toContain('rotate_key');
    expect(denied.boundToolNames).not.toContain('grant_authority');
    // A plugin left with nothing is out of the prompt; a mixed one stays,
    // and neither teaches the withheld tool by example.
    expect(denied.systemPrompt).not.toContain('**authority**');
    expect(denied.systemPrompt).toContain('- **keys** — Signing keys.');
    expect(denied.systemPrompt).toContain('list_keys()');
    expect(denied.systemPrompt).not.toContain('rotate_key');
    expect(denied.systemPrompt).not.toContain('grant_authority');

    // Named anyway (a stale thread, injected text): refused by the gate,
    // without saying what the tool is, and never run.
    const result = (await denied.agent.invoke(
      { messages: [new HumanMessage('Rotate my key.')] },
      { configurable: { thread_id: 'admin-denied' } },
    )) as { messages: BaseMessage[] };
    expect(toolMessages(result.messages)).toHaveLength(2);
    for (const message of toolMessages(result.messages)) {
      expect(message.status).toBe('error');
      expect(String(message.content)).toContain(
        'is not available in this conversation',
      );
    }
    expect(runs).toEqual({ grant: 0, rotate: 0 });

    const granted = await build(
      [ADMIN_ROOT],
      [
        [
          { name: 'rotate_key', args: {}, id: 'c1' },
          { name: 'grant_authority', args: {}, id: 'c2' },
        ],
        [],
      ],
    );
    expect(granted.boundToolNames).toEqual(
      expect.arrayContaining(['list_keys', 'rotate_key', 'grant_authority']),
    );
    expect(granted.systemPrompt).toContain('- **authority** — ');
    await granted.agent.invoke(
      { messages: [new HumanMessage('Rotate my key.')] },
      { configurable: { thread_id: 'admin-granted' } },
    );
    expect(runs).toEqual({ grant: 1, rotate: 1 });
  });

  it("cuts a sub-agent's admin tools, and hides a sub-agent (and plugin) left with none", async () => {
    const runs = { status: 0, reset: 0, purge: 0 };
    const counted = (key: keyof typeof runs, plane?: 'admin') =>
      makeTool(key === 'status' ? 'ops_status' : `ops_${key}`, {
        ...(plane ? { plane } : {}),
        handler: async () => {
          runs[key] += 1;
          return `${key} done`;
        },
      });
    const ops = makePlugin({
      name: 'ops',
      manifest: makeManifest({ title: 'Ops', visibility: 'on-demand' }),
      getSubAgents: () => [
        makeSubAgent('Ops Agent', {
          tools: [counted('status'), counted('reset', 'admin')],
          forwardTools: ['ops_status', 'ops_reset'],
        }),
      ],
    });
    const purger = makePlugin({
      name: 'purger',
      manifest: makeManifest({ title: 'Purger', visibility: 'on-demand' }),
      getSubAgents: () => [
        makeSubAgent('Purge Agent', { tools: [counted('purge', 'admin')] }),
      ],
    });
    const core = bootCore([new WeatherPlugin(), ops, purger]);
    await core.warm();

    const { agent, boundToolNames } = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient: ambientFor(
        core,
        scriptedLlm({
          main: [
            [{ name: 'list_capabilities', args: {}, id: 'm1' }],
            [
              {
                name: 'call_ops_agent',
                args: { task: 'Reset ops.' },
                id: 'm2',
              },
            ],
            [],
          ],
          subagent: [
            [
              { name: 'ops_reset', args: {}, id: 's1' },
              { name: 'ops_status', args: {}, id: 's2' },
            ],
            [],
          ],
        }),
      ),
      requestCtx: granting([]),
      state: { loadedPlugins: ['ops'] },
      checkpointer: new MemorySaver(),
    });
    expect(boundToolNames).toContain('call_ops_agent');
    expect(boundToolNames).not.toContain('call_purge_agent');

    const result = (await agent.invoke(
      { messages: [new HumanMessage('Reset ops.')], loadedPlugins: ['ops'] },
      { configurable: { thread_id: 'admin-subagent' } },
    )) as { messages: BaseMessage[] };
    const messages = toolMessages(result.messages);
    const listed = JSON.parse(
      String(messages.find((m) => m.tool_call_id === 'm1')?.content),
    ) as Array<{ name: string }>;
    expect(listed.map((e) => e.name)).not.toContain('purger');
    expect(listed.map((e) => e.name)).toContain('ops');
    // The inner admin tool was never bound (and is not forwarded); the
    // orchestration one ran and was.
    expect(runs).toEqual({ status: 1, reset: 0, purge: 0 });
    expect(messages.map((m) => m.name)).not.toContain('ops_reset');
    expect(messages.map((m) => m.name)).toContain('ops_status');
  });
});

describe('supplied-context Markdown execution', () => {
  function closedArgs(model: BaseChatModel, checkpointer = new MemorySaver()) {
    const core = bootCore();
    return {
      executionProfile: 'supplied-context-markdown' as const,
      registries: new Proxy(core.registries, {
        get() {
          throw new Error('Restricted execution accessed a plugin registry');
        },
      }),
      identity: core.identity,
      config: core.validatedEnv,
      requestCtx,
      ambient: ambientFor(core, { get: () => model }),
      availablePlugins: core.availablePlugins,
      state: {
        userContext: { secret: 'PRIVATE_CONTEXT' },
        loadedPlugins: ['portal'],
      },
      checkpointer,
      hooks: {
        getRoomTitle: async () => {
          throw new Error('Read room context');
        },
        middlewares: [
          {
            name: 'ForbiddenHostHook',
            beforeModel: () => {
              throw new Error('Ran host hook');
            },
          },
        ],
      },
    };
  }

  it('runs the real graph without collecting plugins or exposing personal context', async () => {
    const built = await createMainAgent(
      closedArgs(
        new FakeListChatModel({
          responses: ['# Brief\nSupplied evidence only.'],
        }),
      ),
    );
    expect(built.boundToolNames).toEqual([]);
    expect(built.systemPrompt).not.toContain('PRIVATE_CONTEXT');
    expect(built.systemPrompt).not.toContain('French');
    const result = await built.agent.invoke(
      { messages: [new HumanMessage('Write a brief from this source.')] },
      {
        configurable: { thread_id: 'task:closed' },
        context: built.context,
      },
    );
    expect(result.messages.at(-1)?.content).toBe(
      '# Brief\nSupplied evidence only.',
    );
  });

  it('rejects model-emitted tools before handlers and retains the restriction on recovery', async () => {
    const saver = new MemorySaver();
    const model = new FakeToolCallingModel({
      toolCalls: [[{ name: 'send_payment', args: {}, id: 'call-1' }]],
    });
    const built = await createMainAgent(closedArgs(model, saver));
    const config = {
      configurable: { thread_id: 'task:tool-denied' },
      context: built.context,
    };
    await expect(
      built.agent.invoke({ messages: [new HumanMessage('Do work')] }, config),
    ).rejects.toThrow('Tools are forbidden');
    const recovered = await createMainAgent(closedArgs(model, saver));
    await expect(recovered.agent.invoke(null, config)).rejects.toThrow(
      'Tools are forbidden',
    );
  });
});

describe('bounded Topic research model loop', () => {
  it('binds only the host research tool without collecting registry or private context', async () => {
    const core = bootCore();
    let calls = 0;
    const research = makeTool('run_topic_research', {
      effect: 'write',
      schema: z.object({}).strict(),
      handler: async (_args, ctx) => {
        calls += 1;
        return {
          evidence: 'Committed evidence',
          privateContext: ctx.history.userContext,
        };
      },
    });
    const built = await createMainAgent({
      executionProfile: 'topic-research-v1',
      registries: new Proxy(core.registries, {
        get() {
          throw new Error('Read ordinary registry');
        },
      }),
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient: ambientFor(
        core,
        scriptedLlm({
          main: [
            [{ name: 'run_topic_research', args: {}, id: 'research1' }],
            [],
          ],
        }),
      ),
      requestCtx,
      state: {
        userContext: { secret: 'PRIVATE_CONTEXT' },
        loadedPlugins: ['memory'],
      },
      hooks: {
        researchTool: research,
        getRoomTitle: async () => {
          throw new Error('Read room title');
        },
      },
    });
    expect(built.boundToolNames).toEqual(['run_topic_research']);
    expect(built.systemPrompt).not.toContain('PRIVATE_CONTEXT');
    expect(built.systemPrompt).not.toContain('French');
    const result = await built.agent.invoke(
      { messages: [new HumanMessage('Research frozen evidence')] },
      { context: built.context },
    );
    expect(calls).toBe(1);
    expect(JSON.stringify(result.messages)).toContain('Committed evidence');
    expect(JSON.stringify(result.messages)).not.toContain('PRIVATE_CONTEXT');
  });
  it('requires the bounded host tool and refuses a read-effect substitute', async () => {
    const core = bootCore();
    const args = {
      executionProfile: 'topic-research-v1',
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient: ambientFor(core, scriptedLlm({})),
      requestCtx,
      state: {},
    } satisfies Parameters<typeof createMainAgent>[0];
    await expect(createMainAgent(args)).rejects.toThrow(/bounded host/);
    await expect(
      createMainAgent({
        ...args,
        hooks: {
          researchTool: makeTool('run_topic_research', { effect: 'read' }),
        },
      }),
    ).rejects.toThrow(/bounded host/);
  });
});

// ── Turn-building hardening ─────────────────────────────────────────────────

/** A summarizer model that records what it was handed, and can fail. */
class RecordingSummarizer extends FakeListChatModel {
  readonly inputs: string[] = [];

  constructor(private readonly failure?: Error) {
    super({ responses: ['the gist'] });
  }

  override async _generate(
    ...args: Parameters<FakeListChatModel['_generate']>
  ): ReturnType<FakeListChatModel['_generate']> {
    const [messages] = args;
    this.inputs.push(messages.map((m) => String(m.content)).join('\n'));
    if (this.failure) throw this.failure;
    return super._generate(...args);
  }
}

/** The scripted models, with `routing` (the summarizer) replaced. */
function llmWith(
  summarizer: BaseChatModel,
  scripts: Partial<Record<string, Script>>,
): AmbientServices['llm'] {
  const scripted = scriptedLlm(scripts);
  return {
    get: (role, params) =>
      role === 'routing' ? summarizer : scripted.get(role, params),
  };
}

describe('createMainAgent — summaries', () => {
  /** A past turn whose tool result is `chars` long. */
  const pastTurn = (i: number, chars: number): BaseMessage[] => [
    new HumanMessage({ id: `h${i}`, content: `question ${i}` }),
    new AIMessage({
      id: `a${i}`,
      content: '',
      tool_calls: [{ id: `c${i}`, name: 'get_probe', args: { i } }],
    }),
    new ToolMessage({
      id: `t${i}`,
      tool_call_id: `c${i}`,
      name: 'get_probe',
      content: `${i}:${'w'.repeat(chars)}`,
    }),
    new AIMessage({ id: `r${i}`, content: `answer ${i}` }),
  ];
  const probe = () =>
    makePlugin({
      name: 'probe',
      manifest: makeManifest({ title: 'Probe', visibility: 'always' }),
      getTools: () => [makeTool('get_probe', { handler: async () => 'ok' })],
    });
  // A 64k main window summarizes at 32k tokens; the summarizer has 16k.
  const budget = contextBudgetFor(
    { model: 'main', tokens: 64_000, origin: 'override' },
    DEFAULT_CONTEXT_KNOBS,
    { model: 'routing', tokens: 16_000, origin: 'override' },
  );
  // ~36k tokens: over the trigger.
  const history = () =>
    Array.from({ length: 6 }, (_, i) => pastTurn(i, 24_000)).flat();

  it("hands the summarizer no more than its own model's window", async () => {
    const core = bootCore([probe()]);
    await core.warm();
    const summarizer = new RecordingSummarizer();
    const { agent } = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient: ambientFor(core, llmWith(summarizer, {})),
      requestCtx,
      state: {},
      contextBudget: budget,
    });
    const result = (await agent.invoke(
      { messages: [...history(), new HumanMessage('and now?')] },
      { configurable: { thread_id: 'summary-window' } },
    )) as { messages: BaseMessage[] };
    expect(summarizer.inputs).toHaveLength(1);
    expect(Math.ceil(summarizer.inputs[0]!.length / 4)).toBeLessThanOrEqual(
      16_000,
    );
    expect(result.messages.filter(isSummarizationMessage)).toHaveLength(1);
  });

  it('tries a failing summary once per turn and gives its tokens back, so the turn completes', async () => {
    const core = bootCore([probe()]);
    await core.warm();
    const script: Script = [
      [{ name: 'get_probe', args: { step: 1 }, id: 's1' }],
      [{ name: 'get_probe', args: { step: 2 }, id: 's2' }],
      [],
    ];
    const run = async (tokens: number) => {
      const summarizer = new RecordingSummarizer(
        new Error("400 This model's maximum context length is 16000 tokens"),
      );
      const turnBudget = new TurnBudget({
        tokens,
        tools: 20,
        durationMs: 60_000,
      });
      const reserve = vi.spyOn(turnBudget, 'reserveModel');
      const metered = budgetedLlm(llmWith(summarizer, { main: script }), {
        budget: turnBudget,
        outputReserveTokens: budget.outputReserveTokens,
      });
      const { agent } = await createMainAgent({
        registries: core.registries,
        identity: core.identity,
        config: core.validatedEnv,
        availablePlugins: core.availablePlugins,
        ambient: ambientFor(core, metered),
        requestCtx,
        state: {},
        contextBudget: budget,
        turnBudget,
      });
      const result = (await agent.invoke(
        { messages: [...history(), new HumanMessage('and now?')] },
        {
          configurable: { thread_id: `summary-fails-${tokens}` },
          callbacks: [metered.callback],
        },
      )) as { messages: BaseMessage[] };
      return { result, summarizer, turnBudget, reserve };
    };

    const { result, summarizer, turnBudget, reserve } = await run(10_000_000);
    expect(summarizer.inputs).toHaveLength(1);
    // The summary and the three model steps were reserved; only the steps
    // are still charged.
    const reservations = reserve.mock.results.map((r) => Number(r.value));
    expect(reservations).toHaveLength(4);
    const steps = reservations.slice(1).reduce((a, b) => a + b, 0);
    expect(turnBudget.snapshot().tokens).toBe(steps);
    expect(
      toolMessages(result.messages)
        .slice(-2)
        .map((m) => m.content),
    ).toEqual(['ok', 'ok']);
    expect(result.messages.some(isSummarizationMessage)).toBe(false);

    // A limit that only the model steps fit: the turn still completes.
    const tight = await run(steps + 1_000);
    expect(toolMessages(tight.result.messages).slice(-2)).toHaveLength(2);
  }, 30_000);

  it('a summary written mid-turn keeps the turn: an identical write after it is still refused', async () => {
    let writes = 0;
    const notes = makePlugin({
      name: 'notes',
      manifest: makeManifest({ title: 'Notes', visibility: 'always' }),
      getTools: () => [
        makeTool('record_note', {
          handler: async () => {
            writes += 1;
            return `recorded #${writes}`;
          },
        }),
        makeTool('get_big', { handler: async () => 'b'.repeat(84_000) }),
      ],
    });
    const core = bootCore([notes]);
    await core.warm();
    const note = (id: string) => ({
      name: 'record_note',
      args: { text: 'buy milk' },
      id,
    });
    const { agent } = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient: ambientFor(
        core,
        llmWith(new FakeListChatModel({ responses: ['the gist'] }), {
          main: [
            [note('n1')],
            [{ name: 'get_big', args: {}, id: 'b1' }],
            [note('n2')],
            [],
          ],
        }),
      ),
      requestCtx,
      state: {},
      // 40k window (summarize at 20k tokens), keeping only the last two
      // messages: the big result pushes the history over the trigger and
      // the summary condenses the turn's first write away.
      contextBudget: contextBudgetFor(
        { model: 'm', tokens: 40_000, origin: 'override' },
        { ...DEFAULT_CONTEXT_KNOBS, keepMessages: 2 },
      ),
    });
    const result = (await agent.invoke(
      {
        messages: [
          new HumanMessage('Note: buy milk, then check the big file.'),
        ],
      },
      { configurable: { thread_id: 'mid-turn-summary' } },
    )) as { messages: BaseMessage[] };
    expect(result.messages.some(isSummarizationMessage)).toBe(true);
    expect(writes).toBe(1);
    const second = toolMessages(result.messages).find(
      (m) => m.tool_call_id === 'n2',
    );
    expect(second?.status).toBe('error');
    expect(String(second?.content)).toContain('would repeat its effect');
  }, 30_000);
});

describe('createMainAgent — sub-agent dispatches', () => {
  const pingSchema = z.object({ to: z.string() });
  function pinger(runs: { pings: string[] }) {
    return makePlugin({
      name: 'pinger',
      manifest: makeManifest({ title: 'Pinger', visibility: 'always' }),
      getSubAgents: () => [
        makeSubAgent('Ping Agent', {
          tools: [
            makeTool('send_ping', {
              schema: pingSchema,
              handler: async (args) => {
                const { to } = pingSchema.parse(args);
                runs.pings.push(to);
                return `pinged ${to}`;
              },
            }),
          ],
          forwardTools: true,
        }),
      ],
    });
  }

  it("caps a sub-agent's identical writes like the main agent's", async () => {
    const runs = { pings: [] as string[] };
    const core = bootCore([pinger(runs)]);
    await core.warm();
    const { agent } = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient: ambientFor(
        core,
        scriptedLlm({
          main: [
            [{ name: 'call_ping_agent', args: { task: 'Ping a.' }, id: 'p1' }],
            [],
          ],
          subagent: [
            [{ name: 'send_ping', args: { to: 'a' }, id: 's1' }],
            [{ name: 'send_ping', args: { to: 'a' }, id: 's2' }],
            [],
          ],
        }),
      ),
      requestCtx,
      state: {},
      checkpointer: new MemorySaver(),
    });
    const result = (await agent.invoke(
      { messages: [new HumanMessage('Ping a.')] },
      { configurable: { thread_id: 'subagent-cap' } },
    )) as { messages: BaseMessage[] };
    expect(runs.pings).toEqual(['a']);
    const repeated = toolMessages(result.messages).find(
      (m) => m.tool_call_id === 'p1_s2',
    );
    expect(String(repeated?.content)).toContain('would repeat its effect');
  });

  it('classifies the tools of a sub-agent built by a factory by their declared effect', async () => {
    let polls = 0;
    const poller = makePlugin({
      name: 'poller',
      manifest: makeManifest({ title: 'Poller', visibility: 'always' }),
      getSubAgents: () => [
        makeSubAgent('Poll Agent', {
          tools: () => [
            makeTool('poll_job', {
              effect: 'read',
              handler: async () => `pending ${(polls += 1)}`,
            }),
          ],
        }),
      ],
    });
    const core = bootCore([poller]);
    await core.warm();
    const poll = (id: string) => ({ name: 'poll_job', args: { job: 'j' }, id });
    const { agent } = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient: ambientFor(
        core,
        scriptedLlm({
          main: [
            [{ name: 'call_poll_agent', args: { task: 'Poll j.' }, id: 'p1' }],
            [],
          ],
          subagent: [[poll('s1')], [poll('s2')], [poll('s3')], []],
        }),
      ),
      requestCtx,
      state: {},
      checkpointer: new MemorySaver(),
    });
    await agent.invoke(
      { messages: [new HumanMessage('Poll job j.')] },
      { configurable: { thread_id: 'subagent-factory' } },
    );
    // A read may repeat within the cap; a write would have run once.
    expect(polls).toBe(3);
  });

  it('keeps the tool marks of two dispatches apart when their models reuse a call id', async () => {
    const runs = { pings: [] as string[] };
    const core = bootCore([pinger(runs)]);
    await core.warm();
    const marks = new Map<string, ToolMark>();
    const store: ToolMarkStore = {
      async startMark(input) {
        const key = `${input.runId}:${input.toolCallId}`;
        const existing = marks.get(key);
        if (existing) return existing;
        marks.set(key, {
          ...input,
          startedAt: 'now',
          doneAt: null,
          outcome: null,
          attempts: 1,
        });
        return undefined;
      },
      async bumpMark() {},
      async finishMark(runId, toolCallId, outcome) {
        const mark = marks.get(`${runId}:${toolCallId}`);
        if (mark) Object.assign(mark, { doneAt: 'now', outcome });
      },
    };
    const { agent } = await createMainAgent({
      registries: core.registries,
      identity: core.identity,
      config: core.validatedEnv,
      availablePlugins: core.availablePlugins,
      ambient: ambientFor(
        core,
        scriptedLlm({
          main: [
            [{ name: 'call_ping_agent', args: { task: 'Ping a.' }, id: 'p1' }],
            [{ name: 'call_ping_agent', args: { task: 'Ping b.' }, id: 'p2' }],
            [],
          ],
          // Every dispatch is a new conversation: the model numbers its
          // calls from scratch, so both use `s1`.
          subagent: [[{ name: 'send_ping', args: { to: 'x' }, id: 's1' }], []],
        }),
      ),
      requestCtx,
      state: {},
      checkpointer: new MemorySaver(),
      hooks: {
        toolMiddlewares: [
          createToolMarksMiddleware({
            runId: 'run-1',
            store,
            effectOf: (name) => toolEffectOf({ name }),
          }),
        ],
      },
    });
    const result = (await agent.invoke(
      { messages: [new HumanMessage('Ping twice.')] },
      { configurable: { thread_id: 'subagent-marks' } },
    )) as { messages: BaseMessage[] };
    expect(runs.pings).toEqual(['x', 'x']);
    expect([...marks.keys()]).toEqual(
      expect.arrayContaining([
        'run-1:p1',
        'run-1:p2',
        'run-1:p1/s1',
        'run-1:p2/s1',
      ]),
    );
    // The forwarded results carry the model's own id, under the dispatch prefix.
    expect(
      toolMessages(result.messages)
        .filter((m) => m.name === 'send_ping')
        .map((m) => [m.tool_call_id, m.content]),
    ).toEqual([
      ['p1_s1', 'pinged x'],
      ['p2_s1', 'pinged x'],
    ]);
  });
});

describe('createMainAgent — per-turn isolation and a stable prompt', () => {
  it("load_capability lists the building turn's request tools, even when another turn's build finishes in between", async () => {
    let releaseA: () => void = () => undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const dyn = makePlugin({
      name: 'dyn',
      manifest: makeManifest({ title: 'Dynamic', visibility: 'on-demand' }),
      getRequestTools: async (rtCtx) => {
        if (rtCtx.user.did === 'did:ixo:a') await gateA;
        return [makeTool(`dyn_${rtCtx.user.did.slice(-1)}`)];
      },
    });
    const core = bootCore([dyn]);
    await core.warm();
    const build = (did: string) =>
      createMainAgent({
        registries: core.registries,
        identity: core.identity,
        config: core.validatedEnv,
        availablePlugins: core.availablePlugins,
        ambient: ambientFor(
          core,
          scriptedLlm({
            main: [
              [
                {
                  name: 'load_capability',
                  args: { names: ['dyn'] },
                  id: 'l1',
                },
              ],
              [],
            ],
          }),
        ),
        requestCtx: { ...requestCtx, user: { ...requestCtx.user, did } },
        state: {},
        checkpointer: new MemorySaver(),
      });
    // A's collection is still waiting when B's build completes; A finishes last.
    const pendingA = build('did:ixo:a');
    const b = await build('did:ixo:b');
    releaseA();
    const a = await pendingA;
    const listed = async (built: Awaited<typeof b>, thread: string) => {
      const result = (await built.agent.invoke(
        { messages: [new HumanMessage('load dyn')] },
        { configurable: { thread_id: thread } },
      )) as { messages: BaseMessage[] };
      const [entry] = JSON.parse(
        String(toolMessages(result.messages)[0]?.content),
      ) as Array<{ tools: Array<{ name: string }> }>;
      return entry?.tools.map((t) => t.name);
    };
    expect(await listed(b, 'iso-b')).toEqual(['dyn_b']);
    expect(await listed(a, 'iso-a')).toEqual(['dyn_a']);
  });

  it('builds a byte-identical system prompt for two turns of the same day', async () => {
    const core = bootCore();
    await core.warm();
    const promptAt = async (currentTime: string, requestId: string) =>
      (
        await createMainAgent({
          registries: core.registries,
          identity: core.identity,
          config: core.validatedEnv,
          availablePlugins: core.availablePlugins,
          ambient: ambientFor(core, scriptedLlm({})),
          requestCtx: {
            user: { ...requestCtx.user, currentTime },
            session: { ...requestCtx.session, requestId },
          },
          state: {},
        })
      ).systemPrompt;
    const first = await promptAt('2026-08-25T08:00:00.000Z', 'req-1');
    const second = await promptAt('2026-08-25T08:00:07.412Z', 'req-2');
    expect(second).toBe(first);
  });
});

describe('createMainAgent — plugin operating guides', () => {
  const GUIDE = '### Probe mode\n\nAlways probe twice before reporting.';
  const guided = (
    name: string,
    guide: string | undefined,
    overrides: Parameters<typeof makeManifest>[0] = {},
    tools = [makeTool(`${name}_run`)],
  ) =>
    makePlugin({
      name,
      manifest: makeManifest({
        title: name,
        summary: `The ${name} plugin.`,
        visibility: 'on-demand',
        ...overrides,
      }),
      ...(guide !== undefined ? { operatingGuide: guide } : {}),
      getTools: () => tools,
    });

  const promptOf = async (
    plugins: OraclePlugin[],
    options: {
      loaded?: string[];
      preloaded?: string[];
      currentTime?: string;
      requestId?: string;
    } = {},
  ) => {
    const core = bootCore(plugins);
    await core.warm();
    return (
      await createMainAgent({
        registries: core.registries,
        identity: core.identity,
        config: core.validatedEnv,
        availablePlugins: core.availablePlugins,
        ambient: ambientFor(core, scriptedLlm({})),
        requestCtx: {
          user: {
            ...requestCtx.user,
            currentTime: options.currentTime ?? requestCtx.user.currentTime,
          },
          session: {
            ...requestCtx.session,
            requestId: options.requestId ?? 'req-1',
          },
        },
        state: { loadedPlugins: options.loaded ?? [] },
        ...(options.preloaded
          ? { preloadedPlugins: new Set(options.preloaded) }
          : {}),
      })
    ).systemPrompt;
  };

  it('contributes nothing while the plugin is not loaded, and its guide after every other section once it is', async () => {
    const off = await promptOf([guided('probe', GUIDE)]);
    expect(off).not.toContain('Probe mode');
    expect(off).not.toContain('## Capabilities in use');

    const on = await promptOf([guided('probe', GUIDE)], { loaded: ['probe'] });
    expect(on.endsWith(`## Capabilities in use\n\n${GUIDE}\n`)).toBe(true);
    expect(on.indexOf('## Operational mode')).toBeLessThan(
      on.indexOf('## Capabilities in use'),
    );
    // Everything before the guides is the prompt of the turn without them.
    expect(on.startsWith(off)).toBe(true);
  });

  it('gives byte-identical prompts on consecutive turns with the same loaded plugins, guides in name order', async () => {
    const plugins = () => [
      guided('zeta', '### Zeta mode\n\nZ.'),
      guided('alpha', '### Alpha mode\n\nA.'),
    ];
    const first = await promptOf(plugins(), {
      loaded: ['zeta', 'alpha'],
      currentTime: '2026-08-25T08:00:00.000Z',
      requestId: 'req-1',
    });
    const second = await promptOf(plugins(), {
      loaded: ['alpha', 'zeta'],
      currentTime: '2026-08-25T08:03:41.120Z',
      requestId: 'req-2',
    });
    expect(second).toBe(first);
    expect(first.indexOf('### Alpha mode')).toBeLessThan(
      first.indexOf('### Zeta mode'),
    );
  });

  it("keeps a router preload's guide out of the system prompt, which stays as it was", async () => {
    const preloaded = await promptOf([guided('probe', GUIDE)], {
      preloaded: ['probe'],
    });
    expect(preloaded).not.toContain(GUIDE);
    expect(preloaded).toBe(await promptOf([guided('probe', GUIDE)]));
  });

  it('never shows the guide of a plugin the delegation cannot use, loaded or preloaded', async () => {
    const unmet = await promptOf(
      [
        guided('files', '### Files mode\n\nF.', {
          requires: [{ resource: 'ixo:filesystem', action: 'fs/read' }],
        }),
      ],
      { loaded: ['files'], preloaded: ['files'] },
    );
    expect(unmet).not.toContain('Files mode');
    const withheld = await promptOf(
      [
        guided('ops', '### Ops mode\n\nO.', {}, [
          makeTool('ops_reset', { plane: 'admin' }),
        ]),
      ],
      { loaded: ['ops'], preloaded: ['ops'] },
    );
    expect(withheld).not.toContain('Ops mode');
    expect(withheld).not.toContain('## Capabilities in use');
  });

  it('leaves the prompt exactly as before for a plugin without a guide', async () => {
    const plain = await promptOf([guided('probe', undefined)], {
      loaded: ['probe'],
    });
    const blank = await promptOf([guided('probe', '   \n ')], {
      loaded: ['probe'],
    });
    const notLoaded = await promptOf([guided('probe', undefined)]);
    expect(plain).toBe(notLoaded);
    expect(blank).toBe(notLoaded);
  });

  it('the flows plugin supplies its operating contract as its guide, outside the manifest', () => {
    const flows = new FlowsPlugin();
    expect(flows.operatingGuide).toBe(FLOWS_OPERATING_GUIDE);
    expect(JSON.stringify(flows.manifest)).not.toContain('Flow Builder mode');
  });

  it('reports every guide size at boot and warns about one over the ceiling', () => {
    const log = vi.fn();
    const warn = vi.fn();
    createRuntimeCore({
      config: { name: 'X' },
      plugins: [
        guided('probe', GUIDE),
        guided('huge', `### Huge\n\n${'h'.repeat(12_100)}`),
      ],
      env: makeEnv(),
      logger: { log, warn, error: vi.fn() },
    });
    const line = log.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.startsWith('[boot] operating guides:'));
    expect(line).toBe(
      `[boot] operating guides: huge=12110 chars (~3028 tokens), probe=${GUIDE.length} chars (~${Math.ceil(GUIDE.length / 4)} tokens)`,
    );
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((w) => w.includes('operating guide of'))).toEqual([
      "[boot] operating guide of 'huge' is ~3028 tokens (over 3000); it is in the system prompt of every turn that has the plugin loaded",
    ]);
  });
});
