import { HumanMessage, AIMessage } from '@langchain/core/messages';
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
import { MemoryPlugin } from '../plugins/memory/index.js';
import { OraclePaymentsPlugin } from '../plugins/oracle-payments/oracle-payments.plugin.js';

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
      postEvent: vi.fn(async () => 'event-id'),
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
      mintSelfSignedInvocation: vi.fn(async () => ({
        invocation: 'mock-invocation-car',
      })),
      getServiceDelegation: vi.fn(async () => ({
        error: 'no-delegation' as const,
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
      'WorkStatusMiddleware',
      'ByoHistorySanitizerMiddleware',
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

  it('gives a wrapped tool the LIVE turn’s message history', async () => {
    // The guard for a bug this suite could not see. `ctx.history.messages`
    // used to come from the agent's build-time state snapshot, which is
    // empty in production — the checkpoint is read WITHOUT its messages
    // (`getTupleWithoutMessages`) and, even when it isn't, the snapshot
    // predates the turn. `deliver_work`'s work-summary extractor reads
    // exactly this and refuses to sign a claim without it, so delivery died
    // after the work was already done. It now comes from LangGraph's live
    // `ToolRuntime.state`.
    const registries = emptyRegistries();
    let seen: readonly unknown[] | undefined;
    let recent: readonly unknown[] | undefined;
    registries.tools.register(
      makePlugin({
        name: 'transcript-reader',
        manifest: makeManifest({ visibility: 'always' }),
        getTools: () => [
          makeTool('read_transcript', {
            schema: z.object({}),
            handler: async (_args, ctx) => {
              seen = ctx.history.messages;
              recent = ctx.history.recent(1);
              return 'ok';
            },
          }),
        ],
      }),
    );

    // Built from a state with no history at all — exactly what the light
    // checkpoint read gives the builder in production.
    await createMainAgent(baseArgs({ registries, state: {} }));

    const params = createAgentCalls[0];
    if (!params) throw new Error('createAgent was not called');
    const wrapped = (
      params.tools as {
        name: string;
        invoke: (args: unknown, runtime: unknown) => Promise<unknown>;
      }[]
    ).find((t) => t.name === 'read_transcript');
    if (!wrapped) throw new Error('read_transcript was not bound');

    const messages = [
      new HumanMessage('do my 2025 tax report'),
      new AIMessage('On it — reading your receipts.'),
    ];
    await wrapped.invoke(
      {},
      {
        context: {
          user: { did: 'did:ixo:user1', matrixUserId: '@u:ixo.world' },
          session: { id: 'sess-1', client: 'portal', requestId: 'req-1' },
        },
        // What LangGraph hands a tool: the state of the turn in flight.
        state: { messages },
      },
    );

    expect(seen).toEqual(messages);
    expect(recent).toEqual([messages[1]]);
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

  it("drops billing:'contracted' tools unless the turn runs in work mode", async () => {
    const makeRegistriesWithBilledTool = () => {
      const registries = emptyRegistries();
      registries.tools.register(
        makePlugin({
          name: 'tax-fork',
          manifest: makeManifest({ visibility: 'always' }),
          getTools: () => [
            makeTool('generate_tax_report', { billing: 'contracted' }),
            makeTool('free_faq'),
          ],
        }),
      );
      registries.manifests.register(
        makePlugin({
          name: 'tax-fork',
          manifest: makeManifest({ visibility: 'always' }),
        }),
      );
      return registries;
    };
    const workCommerce = {
      mode: 'work' as const,
      engagement: {
        status: 'active' as const,
        serviceId: 'tax-report',
        serviceName: 'Tax report',
        priceUsd: 20,
        collectionId: '42',
        adminAddress: 'ixo1admin',
        startedAt: '2026-07-22T00:00:00.000Z',
      },
    };
    const withCommerce = (commerce?: typeof workCommerce) => {
      const args = baseArgs({ registries: makeRegistriesWithBilledTool() });
      return {
        ...args,
        requestCtx: {
          ...args.requestCtx,
          session: { ...args.requestCtx.session, client: 'matrix' as const },
          ...(commerce ? { commerce } : {}),
        },
      };
    };
    const boundNames = () => {
      const params = createAgentCalls[0];
      if (!params) throw new Error('createAgent was not called');
      return (params.tools as { name: string }[]).map((t) => t.name);
    };

    // No commerce context (HTTP turn / inert router): the gate belongs to the
    // commerce lane, and off the lane there is no engagement to be inside — so
    // a contracted tool is just a tool and binds with everything else.
    await createMainAgent(withCommerce(undefined));
    expect(boundNames()).toContain('generate_tax_report');
    expect(boundNames()).toContain('free_faq');

    // Support mode: hidden — this IS the lane, and no job is open.
    createAgentCalls.length = 0;
    await createMainAgent(withCommerce({ ...workCommerce, mode: 'support' }));
    expect(boundNames()).not.toContain('generate_tax_report');

    // Work mode: the billed tool binds.
    createAgentCalls.length = 0;
    await createMainAgent(withCommerce(workCommerce));
    expect(boundNames()).toContain('generate_tax_report');
  });

  it('renders the commerce overlay only on Matrix turns carrying ctx.commerce', async () => {
    const commerce = { mode: 'support' as const };
    const matrixArgs = baseArgs();
    await createMainAgent({
      ...matrixArgs,
      requestCtx: {
        ...matrixArgs.requestCtx,
        session: {
          ...matrixArgs.requestCtx.session,
          client: 'matrix' as const,
        },
        commerce,
      },
    });
    {
      const params = createAgentCalls[0];
      if (!params) throw new Error('createAgent was not called');
      expect(String(params.systemPrompt)).toContain('## Commerce mode');
      expect(String(params.systemPrompt)).toContain('front desk');
    }

    // A portal turn never renders the overlay, commerce context or not.
    createAgentCalls.length = 0;
    const portalArgs = baseArgs();
    await createMainAgent({
      ...portalArgs,
      requestCtx: { ...portalArgs.requestCtx, commerce },
    });
    {
      const params = createAgentCalls[0];
      if (!params) throw new Error('createAgent was not called');
      expect(String(params.systemPrompt)).not.toContain('## Commerce mode');
    }
  });

  it('binds the access-denied stub and the unavailable notice when editorRoomId is set but the editor did not bind', async () => {
    // Regression: the editor plugin can refuse to contribute its sub-agent
    // even when `state.editorRoomId` is set (membership check failed, Matrix
    // down, build error). Telling the model a document is open without the
    // tool bound makes it emit its sub-agent task as user-facing text instead
    // of calling anything. The runtime now (a) swaps the document-mode prompt
    // for an explicit unavailable notice and (b) binds a stub
    // `call_editor_agent` that returns the denial reason.
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
    expect(prompt).not.toContain('**DOCUMENT OPEN**');
    expect(prompt).toContain('DOCUMENT OPEN BUT NOT ACCESSIBLE');
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
    const denial = await stub.invoke({ task: 'read the current document' });
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
    expect(prompt).toContain('**DOCUMENT OPEN**');
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

  /**
   * The commerce personas swap their whole tool surface through the plugin's
   * `getRequestTools(rtCtx)` hook, and the prompt overlay is chosen from the
   * SAME per-turn value a few lines later in the same build. Testing the
   * plugin hook in isolation proves nothing about that: it was always correct
   * in isolation. These exercise the seam — real plugin, real registries, real
   * `createMainAgent` — so a regression anywhere between `requestCtx.commerce`
   * and the bound tool list fails here.
   */
  describe('commerce personas (oracle-payments through the real build)', () => {
    const WORK_TOOLS = ['deliver_work', 'cancel_work'];
    /** Read-only commerce surface — bound in BOTH modes. */
    const SHARED_COMMERCE_TOOLS = [
      'list_services',
      'show_contract',
      'get_contract_status',
      'get_thread_attachment',
    ];
    const META_TOOLS = ['load_capability', 'list_capabilities'];

    const workCommerce = {
      mode: 'work' as const,
      engagement: {
        status: 'active' as const,
        serviceId: 'tax-report',
        serviceName: 'Tax report',
        priceUsd: 20,
        collectionId: '42',
        adminAddress: 'ixo1admin',
        startedAt: '2026-07-22T00:00:00.000Z',
      },
    };

    /**
     * A fork's own tools, as a fork actually contributes them: a plugin the
     * support allowlist has never heard of, with an eager manifest. One tool
     * carries `billing: 'contracted'` so the same fixture pins the billing
     * gate; the other is plain. Their presence or absence proves which
     * filters ran.
     */
    function forkPlugin() {
      return makePlugin({
        name: 'tax-fork',
        manifest: makeManifest({ visibility: 'always' }),
        getTools: () => [
          makeTool('generate_tax_report', { billing: 'contracted' }),
          makeTool('free_faq'),
        ],
      });
    }

    /** Stands in for the memory plugin — the other allowlisted contributor. */
    function memoryPlugin() {
      return makePlugin({
        name: MemoryPlugin.NAME,
        manifest: makeManifest({ visibility: 'always' }),
        getTools: () => [makeTool('memory_recall')],
      });
    }

    async function buildWith(
      commerce?: { mode: 'work' | 'support' } & Record<string, unknown>,
      client: 'matrix' | 'portal' | 'slack' = 'matrix',
    ): Promise<{ toolNames: string[]; prompt: string; name?: string }> {
      const registries = emptyRegistries();
      for (const plugin of [
        new OraclePaymentsPlugin(),
        memoryPlugin(),
        forkPlugin(),
      ]) {
        registries.tools.register(plugin);
        registries.manifests.register(plugin);
      }

      const args = baseArgs({ registries });
      await createMainAgent({
        ...args,
        requestCtx: {
          ...args.requestCtx,
          session: { ...args.requestCtx.session, client, roomId: '!r:ixo' },
          ...(commerce ? { commerce } : {}),
        },
      });

      const params = createAgentCalls[0];
      if (!params) throw new Error('createAgent was not called');
      return {
        toolNames: (params.tools as { name: string }[]).map((t) => t.name),
        prompt: String(params.systemPrompt),
        name: params.name,
      };
    }

    it('binds the work surface plus the shared commerce tools on a work turn', async () => {
      const { toolNames, prompt } = await buildWith(workCommerce);

      expect(toolNames).toEqual(expect.arrayContaining(WORK_TOOLS));
      // "What am I paying for again?" must be answerable without abandoning
      // the job, so the read-only commerce tools travel into work mode.
      expect(toolNames).toEqual(expect.arrayContaining(SHARED_COMMERCE_TOOLS));
      // Work mode is the wide surface: meta-tools and the fork's own tools.
      expect(toolNames).toEqual(expect.arrayContaining(META_TOOLS));
      expect(toolNames).toContain('generate_tax_report');
      // Already in work — there is nothing to transition into.
      expect(toolNames).not.toContain('start_work');
      // The overlay and the tool list are read from the same per-turn value:
      // a work prompt over a support tool surface is the exact divergence this
      // guards against.
      expect(prompt).toContain('under an active contract');
    });

    it('binds only memory + oracle-payments — no meta-tools, no fork tools — on a support turn', async () => {
      const { toolNames, prompt } = await buildWith({ mode: 'support' });

      expect(toolNames).toEqual(
        expect.arrayContaining([...SHARED_COMMERCE_TOOLS, 'start_work']),
      );
      for (const work of WORK_TOOLS) {
        expect(toolNames).not.toContain(work);
      }
      // The fork's tools are work tools by definition, whatever they are
      // called — the allowlist is keyed by plugin, so both of these go.
      expect(toolNames).not.toContain('generate_tax_report');
      expect(toolNames).not.toContain('free_faq');
      // Memory is the other allowlisted contributor — the front desk still
      // remembers who it is talking to.
      expect(toolNames).toContain('memory_recall');
      // Meta-tools are dropped with the rest: `load_capability` cannot reach
      // past the allowlist, so advertising capabilities would only mislead.
      for (const meta of META_TOOLS) {
        expect(toolNames).not.toContain(meta);
      }
      // …and the prompt must not describe the loading flow that just went away.
      expect(prompt).not.toContain('load_capability');
      expect(prompt).not.toContain('list_capabilities');
      expect(prompt).toContain('front desk');
    });

    it('binds the read-only commerce surface on a Matrix turn the router left inert', async () => {
      // No agent card published yet ⇒ no commerce context, but the user can
      // still ask what the oracle offers and get an honest answer.
      const { toolNames, prompt } = await buildWith(undefined, 'matrix');

      expect(toolNames).toEqual(
        expect.arrayContaining([
          ...SHARED_COMMERCE_TOOLS,
          ...META_TOOLS,
          'generate_tax_report',
        ]),
      );
      for (const work of WORK_TOOLS) {
        expect(toolNames).not.toContain(work);
      }
      // `start_work` opens an escrowed engagement nothing would read on an
      // unrouted turn, so it exists only where the router actually ran.
      expect(toolNames).not.toContain('start_work');
      expect(prompt).not.toContain('## Commerce mode');
    });

    /**
     * THE guard, both halves at once. `requestCtx.commerce` is set by the
     * Matrix router alone, but nothing stops it arriving on another transport
     * — and if it did, the support allowlist would strip every tool from an
     * oracle that has no commerce lane at all. Meanwhile the commerce tools
     * themselves are Matrix-shaped and must not leak the other way. One case
     * per non-Matrix client, because a regression here is silent.
     */
    it.each(['portal', 'slack'] as const)(
      'ignores a commerce context on a %s turn — full surface, no commerce tools, no overlay',
      async (client) => {
        const { toolNames, prompt } = await buildWith(
          { mode: 'support' },
          client,
        );

        // Every other plugin's tools survive untouched — including the
        // `billing: 'contracted'` one, whose gate belongs to the commerce lane.
        expect(toolNames).toEqual(
          expect.arrayContaining([
            ...META_TOOLS,
            'memory_recall',
            'generate_tax_report',
            'free_faq',
          ]),
        );
        // …and oracle-payments contributes nothing off Matrix.
        for (const commerceTool of [
          ...SHARED_COMMERCE_TOOLS,
          ...WORK_TOOLS,
          'start_work',
        ]) {
          expect(toolNames).not.toContain(commerceTool);
        }
        expect(prompt).not.toContain('## Commerce mode');
        // The discovery mandate is part of that full surface.
        expect(prompt).toContain('Search first, build second');
      },
    );

    it('names the compiled graph per persona so a trace shows which one ran', async () => {
      // LangSmith shows the graph name; two personas with different prompts
      // and different tools must not share one.
      expect((await buildWith(workCommerce)).name).toBe('TestOracle-work');

      createAgentCalls.length = 0;
      expect((await buildWith({ mode: 'support' })).name).toBe(
        'TestOracle-support',
      );

      // Non-commerce turns keep the plain oracle name they have always had.
      createAgentCalls.length = 0;
      expect((await buildWith(undefined, 'portal')).name).toBe('TestOracle');
      createAgentCalls.length = 0;
      expect((await buildWith(workCommerce, 'portal')).name).toBe('TestOracle');
    });

    it('logs the per-turn tool surface with the commerce mode and the request tools by plugin', async () => {
      // The line that makes "which tools did this turn actually get?"
      // answerable from a production log instead of from the source.
      const lines: string[] = [];
      const ambient: AmbientServices = {
        ...makeAmbient(),
        logger: {
          log: (message) => {
            lines.push(String(message));
          },
          warn: vi.fn(),
          error: vi.fn(),
        },
      };
      const plugin = new OraclePaymentsPlugin();
      const registries = emptyRegistries();
      registries.tools.register(plugin);
      registries.manifests.register(plugin);

      const args = baseArgs({ registries, ambient });
      await createMainAgent({
        ...args,
        requestCtx: {
          ...args.requestCtx,
          session: {
            ...args.requestCtx.session,
            client: 'matrix' as const,
            roomId: '!r:ixo',
          },
          commerce: workCommerce,
        },
      });

      const surfaceLine = lines.find((line) => line.includes('tool surface'));
      expect(surfaceLine).toBeDefined();
      expect(surfaceLine).toContain('commerce=work');
      expect(surfaceLine).toContain('oracle-payments=[deliver_work');
    });
  });
});
