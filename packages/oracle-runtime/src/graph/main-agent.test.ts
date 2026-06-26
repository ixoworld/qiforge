import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import type * as Langchain from 'langchain';

// Capture every createAgent invocation so the tests can introspect the
// arguments without spinning up a real LangGraph runtime.
const createAgentCalls: Parameters<typeof Langchain.createAgent>[0][] = [];
const fakeCompiledAgent = {
  invoke: vi.fn(),
  stream: vi.fn(),
};

vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof Langchain>('langchain');
  return {
    ...actual,
    createAgent: vi.fn((args: unknown) => {
      createAgentCalls.push(
        args as Parameters<typeof Langchain.createAgent>[0],
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
      get: vi.fn(
        () =>
          ({ invoke: vi.fn() }) as unknown as ReturnType<
            AmbientServices['llm']['get']
          >,
      ),
    },
    emit: { emit: vi.fn() },
    ucan: {
      hasCapability: vi.fn(() => true),
      requireCapability: vi.fn(),
      mintInvocation: vi.fn(async () => 'inv'),
      resolveServiceDid: vi.fn(async () => 'did:web:example.com'),
      hasSigningKey: vi.fn(() => true),
      createInvocationFromDelegation: vi.fn(async () => ({
        invocation: 'mock-invocation-car',
      })),
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

function baseArgs(overrides: Partial<MainAgentArgs> = {}): MainAgentArgs {
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
      user: {
        did: 'did:ixo:user1',
        matrixUserId: '@did-ixo-user1:ixo.world',
        ucanDelegation: { raw: 'test-ucan' },
      },
      session: { id: 'sess-1', client: 'portal', requestId: 'req-1' },
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

  it('always includes the two meta-tools at the head of the tools list', async () => {
    await createMainAgent(baseArgs());

    const [params] = createAgentCalls;
    const toolNames =
      (params?.tools as { name: string }[] | undefined)?.map((t) => t.name) ??
      [];

    expect(toolNames.slice(0, 2)).toEqual([
      'load_capability',
      'list_capabilities',
    ]);
  });

  it('includes always-on middlewares in the expected order with plugin contributions appended', async () => {
    const registries = emptyRegistries();
    const ambient = makeAmbient();
    const safetyModel = {
      invoke: vi.fn(),
    } as unknown as Parameters<
      typeof createMainAgent
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

    const params = createAgentCalls[0];
    if (!params) throw new Error('createAgent was not called');
    const middleware = params.middleware as readonly { name?: string }[];
    const names = middleware.map((m) => m.name);

    expect(names).toEqual([
      'CapabilityGateMiddleware',
      'ToolValidationMiddleware',
      'ToolRepetitionGuardMiddleware',
      'ToolRetryMiddleware',
      'PageContextMiddleware',
      'SafetyGuardrailMiddleware',
      'PluginMw',
    ]);
  });

  it('continues to build when one sub-agent throws during creation', async () => {
    const registries = emptyRegistries();

    // Plugin contributes one good sub-agent, one whose tools accessor throws.
    const goodPlugin = makePlugin({
      name: 'good',
      manifest: makeManifest({ visibility: 'silent' }),
      getSubAgents: () => [
        makeSubAgent('search_agent', {
          tools: [makeTool('search', { schema: z.object({ q: z.string() }) })],
        }),
      ],
    });
    registries.subAgents.register(goodPlugin);
    registries.manifests.register(goodPlugin);

    const brokenPlugin = makePlugin({
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
    });
    registries.subAgents.register(brokenPlugin);
    registries.manifests.register(brokenPlugin);

    const ambient = makeAmbient();
    const agent = await createMainAgent(baseArgs({ registries, ambient }));

    expect(agent).toBe(fakeCompiledAgent);
    expect(ambient.logger.error).toHaveBeenCalled();

    const params = createAgentCalls[0];
    if (!params) throw new Error('createAgent was not called');
    const toolNames = (params.tools as { name: string }[]).map((t) => t.name);
    // The good sub-agent surfaces as `call_search_agent`; the broken one is
    // skipped silently.
    expect(toolNames).toContain('call_search_agent');
    expect(toolNames).not.toContain('call_broken_agent');
  });

  it('binds all on-demand plugins at compile time; gating happens via CapabilityGateMiddleware', async () => {
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

    // On-demand tools are bound regardless of `loadedPlugins` — runtime
    // gating is the middleware's job, not the bind step.
    await createMainAgent(baseArgs({ registries }));
    {
      const params = createAgentCalls[0];
      if (!params) throw new Error('createAgent was not called');
      const names = (params.tools as { name: string }[]).map((t) => t.name);
      expect(names).toContain('composio_search');

      const mwNames = (params.middleware as { name?: string }[]).map(
        (m) => m.name,
      );
      expect(mwNames).toContain('CapabilityGateMiddleware');
    }

    createAgentCalls.length = 0;

    // Same shape when the plugin is already loaded — the bound tools array
    // doesn't change between builds; only the middleware's filter result does.
    await createMainAgent(
      baseArgs({
        registries,
        state: { loadedPlugins: ['composio'] },
      }),
    );
    {
      const params = createAgentCalls[0];
      if (!params) throw new Error('createAgent was not called');
      const names = (params.tools as { name: string }[]).map((t) => t.name);
      expect(names).toContain('composio_search');
    }
  });

  it('binds the access-denied stub and the unavailable notice when editorRoomId is set but the editor did not bind', async () => {
    // Regression: the editor plugin can refuse to contribute its sub-agent
    // even when `state.editorRoomId` is set (membership check failed, Matrix
    // down, build error). Injecting "EDITOR MODE ACTIVE — use the Editor
    // Agent tool" without the tool bound makes the model emit its sub-agent
    // task as user-facing text instead of calling anything. The runtime now
    // (a) swaps the editor-mode prompt for an explicit unavailable notice and
    // (b) binds a stub `call_editor_agent` that returns the denial reason.
    const ambient = makeAmbient();
    await createMainAgent(
      baseArgs({
        ambient,
        state: { editorRoomId: '!room:ixo.world' },
      }),
    );

    const params = createAgentCalls[0];
    if (!params) throw new Error('createAgent was not called');

    const prompt = params.systemPrompt as string;
    expect(prompt).not.toContain('EDITOR MODE ACTIVE');
    expect(prompt).toContain('PAGE OPEN BUT NOT ACCESSIBLE');
    // MatrixManager is not initialised in unit tests, so the membership
    // re-check fails closed — same as the plugin's own guard. The wording is
    // unified (user OR oracle missing) because the lookup runs with the
    // oracle's admin identity and can't tell which side is absent.
    expect(prompt).toContain('could not be verified');
    expect(prompt).toContain('BOTH must be members');

    // The stub is bound under the real tool name and answers with the denial.
    const boundTools = params.tools as {
      name: string;
      invoke: (args: { task: string }) => Promise<string>;
    }[];
    const stub = boundTools.find((t) => t.name === 'call_editor_agent');
    if (!stub) throw new Error('access-denied stub was not bound');
    const denial = await stub.invoke({ task: 'read the current page' });
    expect(denial).toContain('could not be verified');
    expect(denial).toContain('!room:ixo.world');

    // The desync is loud, not silent.
    expect(ambient.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('call_editor_agent did not bind'),
    );
  });

  it('renders the editor-mode prompt when editorRoomId is set and call_editor_agent is bound', async () => {
    const registries = emptyRegistries();
    const editorPlugin = makePlugin({
      name: 'editor',
      manifest: makeManifest({ title: 'Editor', visibility: 'always' }),
      // 'Editor Agent' → computeSubAgentToolName → 'call_editor_agent'.
      getSubAgents: () => [makeSubAgent('Editor Agent')],
    });
    registries.subAgents.register(editorPlugin);
    registries.manifests.register(editorPlugin);

    await createMainAgent(
      baseArgs({
        registries,
        state: { editorRoomId: '!room:ixo.world' },
      }),
    );

    const params = createAgentCalls[0];
    if (!params) throw new Error('createAgent was not called');
    const toolNames = (params.tools as { name: string }[]).map((t) => t.name);
    expect(toolNames).toContain('call_editor_agent');

    const prompt = params.systemPrompt as string;
    expect(prompt).toContain('EDITOR MODE ACTIVE');
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

    const params = createAgentCalls[0];
    if (!params) throw new Error('createAgent was not called');
    const prompt = params.systemPrompt as string;

    expect(prompt).toContain('Available Capabilities');
    expect(prompt).toContain('**memory** — Recall and store user knowledge.');
    // Operational mode default is rendered.
    expect(prompt).toContain('General conversation mode');
  });

  it('injects the Flow Builder guide under Custom Instructions when flows is loaded', async () => {
    await createMainAgent(baseArgs({ state: { loadedPlugins: ['flows'] } }));

    const params = createAgentCalls[0];
    if (!params) throw new Error('createAgent was not called');
    const prompt = params.systemPrompt as string;

    expect(prompt).toContain('## Custom Instructions');
    expect(prompt).toContain('### Flow Builder mode');
    expect(prompt).toContain('discover → plan → confirm → build → hand off');
  });

  it('omits the Custom Instructions section when nothing contributes to it', async () => {
    await createMainAgent(baseArgs());

    const params = createAgentCalls[0];
    if (!params) throw new Error('createAgent was not called');
    const prompt = params.systemPrompt as string;

    expect(prompt).not.toContain('## Custom Instructions');
    expect(prompt).not.toContain('Flow Builder mode');
  });

  it('renders author-supplied custom instructions from config.prompt.customInstructions', async () => {
    await createMainAgent(
      baseArgs({
        identity: {
          name: 'TestOracle',
          org: 'Acme',
          description: 'a test oracle',
          entityDid: 'did:ixo:test',
          prompt: { customInstructions: 'Always greet the user in French.' },
        },
      }),
    );

    const params = createAgentCalls[0];
    if (!params) throw new Error('createAgent was not called');
    const prompt = params.systemPrompt as string;

    expect(prompt).toContain('## Custom Instructions');
    expect(prompt).toContain('Always greet the user in French.');
  });
});
