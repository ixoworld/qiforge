import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  ConfigSchemaRegistry,
  ManifestRegistry,
  MiddlewareRegistry,
  SharedStateRegistry,
  SubAgentRegistry,
  ToolRegistry,
} from '../registries/index.js';
import {
  makeBuildCtx,
  makeManifest,
  makeMiddleware,
  makePlugin,
  makeSubAgent,
  makeTool,
} from '../registries/test-fixtures.js';
import type { AmbientServices } from '../runtime-context/ambient.js';

// Capture every createAgent invocation so the tests can introspect the
// arguments without spinning up a real LangGraph runtime.
const createAgentCalls: Parameters<
  typeof import('langchain').createAgent
>[0][] = [];
const fakeCompiledAgent = {
  invoke: vi.fn(),
  stream: vi.fn(),
};

vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof import('langchain')>('langchain');
  return {
    ...actual,
    createAgent: vi.fn((args: unknown) => {
      createAgentCalls.push(
        args as Parameters<typeof import('langchain').createAgent>[0],
      );
      return fakeCompiledAgent;
    }),
    toolRetryMiddleware: vi.fn(() => ({ name: 'ToolRetryMiddleware' })),
  };
});

import { createMainAgent, type MainAgentArgs } from './main-agent.js';

function makeAmbient(): AmbientServices {
  return {
    config: { FOO: 'bar' },
    identity: {
      name: 'TestOracle',
      org: 'Acme',
      description: 'desc',
      entityDid: 'did:ixo:test',
    },
    availablePlugins: new Set(),
    secrets: {
      getIndex: vi.fn(async () => ({})),
      getValues: vi.fn(async () => ({})),
    },
    matrix: {
      postToRoom: vi.fn(async () => 'event-id'),
      getRoomState: vi.fn(async (roomId: string) => ({ roomId, state: [] })),
      getEventById: vi.fn(async (_roomId: string, eventId: string) => ({
        eventId,
        type: 'm.room.message',
        content: {},
      })),
    },
    llm: {
      get: vi.fn(() => ({ invoke: vi.fn() } as unknown as ReturnType<AmbientServices['llm']['get']>)),
    },
    emit: { emit: vi.fn() },
    ucan: {
      hasCapability: vi.fn(() => true),
      requireCapability: vi.fn(),
      mintInvocation: vi.fn(async () => 'inv'),
    },
    logger: {
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      child: vi.fn(function (this: unknown) {
        return this;
      }) as never,
    },
  };
}

function emptyRegistries(): MainAgentArgs['registries'] {
  return {
    tools: new ToolRegistry(),
    subAgents: new SubAgentRegistry(),
    middlewares: new MiddlewareRegistry(),
    manifests: new ManifestRegistry(),
    configSchema: new ConfigSchemaRegistry(),
    sharedState: new SharedStateRegistry(),
  };
}

function baseArgs(
  overrides: Partial<MainAgentArgs> = {},
): MainAgentArgs {
  return {
    registries: overrides.registries ?? emptyRegistries(),
    identity: {
      name: 'TestOracle',
      org: 'Acme',
      description: 'a test oracle',
      entityDid: 'did:ixo:test',
    },
    config: { FOO: 'bar' },
    requestCtx: {
      user: { did: 'did:ixo:user1' },
      session: { id: 'sess-1', client: 'portal' },
      history: { userContext: undefined },
    },
    ambient: overrides.ambient ?? makeAmbient(),
    state: {},
    availablePlugins: new Set(),
    ...overrides,
  };
}

describe('createMainAgent', () => {
  beforeEach(() => {
    createAgentCalls.length = 0;
    fakeCompiledAgent.invoke.mockReset();
    fakeCompiledAgent.stream.mockReset();
  });

  it('compiles an agent given empty registries', async () => {
    const agent = await createMainAgent(baseArgs());
    expect(agent).toBe(fakeCompiledAgent);
    expect(createAgentCalls).toHaveLength(1);
  });

  it('always includes the four meta-tools at the head of the tools list', async () => {
    await createMainAgent(baseArgs());

    const [params] = createAgentCalls;
    const toolNames =
      (params.tools as { name: string }[] | undefined)?.map((t) => t.name) ??
      [];

    expect(toolNames.slice(0, 4)).toEqual([
      'find_capability',
      'load_capability',
      'list_capabilities',
      'list_capability_details',
    ]);
  });

  it('includes always-on middlewares in the expected order with plugin contributions appended', async () => {
    const registries = emptyRegistries();
    const ambient = makeAmbient();
    const safetyModel = {
      invoke: vi.fn(),
    } as unknown as Parameters<
      typeof import('./main-agent.js').createMainAgent
    >[0]['hooks'] extends infer H
      ? H extends { safetyModel?: infer M }
        ? M
        : never
      : never;

    const pluginMw = makeMiddleware('PluginMw');
    registries.middlewares.register(
      makePlugin({
        name: 'mw-plugin',
        manifest: makeManifest({ visibility: 'silent' }),
        getMiddlewares: () => [pluginMw],
      }),
    );

    await createMainAgent(
      baseArgs({
        registries,
        ambient,
        hooks: {
          getRoomTitle: async () => 'Room',
          safetyModel: safetyModel as never,
        },
      }),
    );

    const [params] = createAgentCalls;
    const middleware = params.middleware as readonly { name?: string }[];
    const names = middleware.map((m) => m.name);

    expect(names).toEqual([
      'ToolValidationMiddleware',
      'ToolRetryMiddleware',
      'PageContextMiddleware',
      'SafetyGuardrailMiddleware',
      'PluginMw',
    ]);
  });

  it('continues to build when one sub-agent throws during creation', async () => {
    const registries = emptyRegistries();

    // Plugin contributes one good sub-agent, one whose tools accessor throws.
    registries.subAgents.register(
      makePlugin({
        name: 'good',
        manifest: makeManifest({ visibility: 'silent' }),
        getSubAgents: () => [
          makeSubAgent('search_agent', {
            tools: [makeTool('search', { schema: z.object({ q: z.string() }) })],
          }),
        ],
      }),
    );

    registries.subAgents.register(
      makePlugin({
        name: 'broken',
        manifest: makeManifest({ visibility: 'silent' }),
        getSubAgents: () => [
          makeSubAgent('broken_agent', {
            // A function-tools accessor that throws when sub-agent-fallback
            // tries to materialise it.
            tools: () => {
              throw new Error('boom');
            },
          }),
        ],
      }),
    );

    const ambient = makeAmbient();
    const agent = await createMainAgent(baseArgs({ registries, ambient }));

    expect(agent).toBe(fakeCompiledAgent);
    expect(ambient.logger.error).toHaveBeenCalled();

    const [params] = createAgentCalls;
    const toolNames = (params.tools as { name: string }[]).map((t) => t.name);
    // The good sub-agent surfaces as `call_search_agent`; the broken one is
    // skipped silently.
    expect(toolNames).toContain('call_search_agent');
    expect(toolNames).not.toContain('call_broken_agent');
  });

  it('binds an on-demand plugin only when state.loadedPlugins includes it', async () => {
    const registries = emptyRegistries();
    registries.tools.register(
      makePlugin({
        name: 'composio',
        manifest: makeManifest({ visibility: 'on-demand' }),
        getTools: () => [makeTool('composio_search')],
      }),
    );
    registries.manifests.register(
      makePlugin({
        name: 'composio',
        manifest: makeManifest({ visibility: 'on-demand' }),
      }),
    );

    // First build: nothing loaded — composio_search should NOT be present.
    await createMainAgent(baseArgs({ registries }));
    {
      const [params] = createAgentCalls;
      const names = (params.tools as { name: string }[]).map((t) => t.name);
      expect(names).not.toContain('composio_search');
    }

    createAgentCalls.length = 0;

    // Second build: agent has called load_capability — composio is loaded.
    await createMainAgent(
      baseArgs({
        registries,
        state: { loadedPlugins: ['composio'] },
      }),
    );
    {
      const [params] = createAgentCalls;
      const names = (params.tools as { name: string }[]).map((t) => t.name);
      expect(names).toContain('composio_search');
    }
  });

  it('renders the Tier-1 capability block in the prompt for visibility=always plugins', async () => {
    const registries = emptyRegistries();

    registries.manifests.register(
      makePlugin({
        name: 'memory',
        manifest: makeManifest({
          title: 'Memory',
          summary: 'Recall and store user knowledge.',
          visibility: 'always',
        }),
      }),
    );

    const ctx = makeBuildCtx();
    await registries.tools.collect(ctx);

    await createMainAgent(baseArgs({ registries }));

    const [params] = createAgentCalls;
    const prompt = params.systemPrompt as string;

    expect(prompt).toContain('Available Capabilities');
    expect(prompt).toContain('memory: Recall and store user knowledge.');
    // Operational mode default is rendered.
    expect(prompt).toContain('General Conversation Mode');
  });
});
