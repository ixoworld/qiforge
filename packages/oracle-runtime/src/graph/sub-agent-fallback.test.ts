import { AIMessage } from '@langchain/core/messages';
import { fakeModel, type ToolRuntime } from 'langchain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  makeManifest,
  makePlugin,
  makeSubAgent,
  makeTool,
} from '../registries/test-fixtures.js';
import { SubAgentRegistry } from '../registries/index.js';
import { buildPluginContext } from '../runtime-context/build-plugin.js';
import type { AmbientServices } from '../runtime-context/ambient.js';
import type { RuntimeStateInput } from '../runtime-context/build-runtime.js';
import type {
  LlmAdapter,
  OracleIdentity,
  PluginTool,
  RuntimeContext,
} from '../plugin-api/types.js';
import {
  mockEmit,
  mockLogger,
  mockMatrix,
  mockSecrets,
  mockUcan,
} from '../testing/mocks.js';
import { collectSubAgentsWithFallback } from './sub-agent-fallback.js';
import { wrapPluginTool } from './wrap-plugin-tool.js';
import * as SubagentAsTool from './subagent-as-tool.js';

// Spy on createSubagentAsTool while passing through to the real impl, so
// existing real-flow tests stay green AND we can inspect the options the
// fallback path forwards into the wrapper. Reset between tests via the
// top-level `vi.clearAllMocks()` in beforeEach.
vi.mock('./subagent-as-tool.js', async () => {
  const actual =
    await vi.importActual<typeof SubagentAsTool>('./subagent-as-tool.js');
  return {
    ...actual,
    createSubagentAsTool: vi.fn(actual.createSubagentAsTool),
  };
});

const IDENTITY: OracleIdentity = {
  name: 'TestOracle',
  org: 'Acme',
  description: 'test',
  entityDid: 'did:ixo:oracle1',
};

const STATE: RuntimeStateInput = {
  messages: [],
  userContext: { name: 'Yousef' },
  loadedPlugins: new Set(['memory']),
};

function makeAmbient(overrides: Partial<AmbientServices> = {}): AmbientServices {
  return {
    config: { FOO: 'bar' },
    identity: IDENTITY,
    availablePlugins: new Set(['memory']),
    secrets: mockSecrets({}),
    matrix: mockMatrix(),
    llm: {
      // Each get call returns a fresh fake model that always replies "ok"
      // (no tool calls). Tests that need tool-calling behaviour override.
      get: vi.fn(() => fakeModel().respond(new AIMessage('ok'))),
    } satisfies LlmAdapter,
    emit: mockEmit(),
    ucan: mockUcan(),
    logger: mockLogger(),
    ...overrides,
  };
}

function makeBuildCtx() {
  return buildPluginContext({
    config: {},
    identity: IDENTITY,
    availablePlugins: new Set(['memory']),
    logger: mockLogger(),
    pluginName: 'test',
  });
}

describe('collectSubAgentsWithFallback — real flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the sub-agent\'s inner PluginTool handler with a real RuntimeContext', async () => {
    const captured: { args?: unknown; ctx?: RuntimeContext } = {};

    const doSearch: PluginTool = {
      name: 'do_search',
      description: 'inner sub-agent tool',
      schema: z.object({ q: z.string() }),
      handler: async (args, ctx) => {
        captured.args = args;
        captured.ctx = ctx;
        return { hits: ['a', 'b'] };
      },
    };

    // Sub-agent fires `do_search` then replies with the result text.
    const subagentModel = fakeModel()
      .respondWithTools([
        { name: 'do_search', args: { q: 'climate' }, id: 'call-1' },
      ])
      .respond(new AIMessage('search done'));

    const ambient = makeAmbient({
      llm: {
        get: vi.fn(() => subagentModel),
      },
    });

    const registry = new SubAgentRegistry();
    registry.register(
      makePlugin({
        name: 'search-plugin',
        manifest: makeManifest({ visibility: 'silent' }),
        getSubAgents: () => [
          makeSubAgent('search_agent', { tools: [doSearch] }),
        ],
      }),
    );

    const [subAgentTool] = await collectSubAgentsWithFallback({
      registry,
      buildCtx: makeBuildCtx(),
      ambient,
      state: STATE,
      userDid: 'did:ixo:user1',
      sessionId: 'sess-1',
    });

    expect(subAgentTool).toBeDefined();

    await subAgentTool!.invoke(
      { task: 'find climate stuff' },
      {
        configurable: { thread_id: 'parent-thread' },
        context: {
          user: {
            did: 'did:ixo:user1',
            matrixUserId: '@did-ixo-user1:ixo.world',
            ucanDelegation: { raw: 'eyJtest', capabilities: [] },
          },
          session: {
            id: 'sess-1',
            client: 'portal',
            requestId: 'req-1',
            roomId: '!r:ixo.world',
          },
        },
      } as unknown as ToolRuntime,
    );

    // The PluginTool handler must have been invoked with the model's args
    // and observed a fully-built RuntimeContext (no NOOP).
    expect(captured.args).toEqual({ q: 'climate' });
    expect(captured.ctx).toBeDefined();
    expect(captured.ctx!.user.did).toBe('did:ixo:user1');
    expect(captured.ctx!.session.id).toBe('sess-1');
    expect(captured.ctx!.config).toBe(ambient.config);
    expect(captured.ctx!.logger).toBe(ambient.logger);
  });

  it('resolves subAgent.model via ambient.llm.get(subAgent.model)', async () => {
    const ambient = makeAmbient();
    const registry = new SubAgentRegistry();
    registry.register(
      makePlugin({
        name: 'p',
        getSubAgents: () => [
          makeSubAgent('custom_agent', { model: 'utility' }),
        ],
      }),
    );

    const tools = await collectSubAgentsWithFallback({
      registry,
      buildCtx: makeBuildCtx(),
      ambient,
      state: STATE,
      userDid: 'did:ixo:user1',
      sessionId: 'sess-1',
    });

    expect(tools).toHaveLength(1);
    expect(ambient.llm.get).toHaveBeenCalledWith('utility');
  });

  it('defaults the LLM role to "subagent" when PluginSubAgent.model is unset', async () => {
    const ambient = makeAmbient();
    const registry = new SubAgentRegistry();
    registry.register(
      makePlugin({
        name: 'p',
        getSubAgents: () => [makeSubAgent('default_agent')],
      }),
    );

    await collectSubAgentsWithFallback({
      registry,
      buildCtx: makeBuildCtx(),
      ambient,
      state: STATE,
      userDid: 'did:ixo:user1',
      sessionId: 'sess-1',
    });

    expect(ambient.llm.get).toHaveBeenCalledWith('subagent');
  });

  it('exposes the passthrough tool to the sub-agent (firable end-to-end)', async () => {
    // Sub-agent fires `save_memory` (the passthrough, NOT its own tool). If
    // the passthrough is missing from the inner agent's tool list, the call
    // will not resolve and the handler will never run.
    const passthroughCalls: unknown[] = [];

    const passthroughPluginTool: PluginTool = {
      name: 'save_memory',
      description: 'passthrough',
      schema: z.object({ content: z.string() }),
      handler: async (args) => {
        passthroughCalls.push(args);
        return 'saved';
      },
    };

    const subagentModel = fakeModel()
      .respondWithTools([
        { name: 'save_memory', args: { content: 'note' }, id: 'c1' },
      ])
      .respond(new AIMessage('done'));

    const ambient = makeAmbient({
      llm: { get: vi.fn(() => subagentModel) },
    });

    const passthroughWrapped = wrapPluginTool(passthroughPluginTool, {
      ambient,
      state: STATE,
    });

    const registry = new SubAgentRegistry();
    registry.register(
      makePlugin({
        name: 'search-plugin',
        getSubAgents: () => [
          // Sub-agent's own tool list is empty — only the passthrough can
          // resolve `save_memory`. This makes the assertion unambiguous.
          makeSubAgent('search_agent', { tools: [] }),
        ],
      }),
    );

    const [subAgentTool] = await collectSubAgentsWithFallback({
      registry,
      buildCtx: makeBuildCtx(),
      ambient,
      state: STATE,
      userDid: 'did:ixo:user1',
      sessionId: 'sess-1',
      passthroughTools: [passthroughWrapped],
    });

    await subAgentTool!.invoke(
      { task: 'do work' },
      {
        configurable: { thread_id: 'parent' },
        context: {
          user: {
            did: 'did:ixo:user1',
            matrixUserId: '@did-ixo-user1:ixo.world',
            ucanDelegation: { raw: 'eyJtest', capabilities: [] },
          },
          session: { id: 'sess-1', client: 'portal', requestId: 'req-1' },
        },
      } as unknown as ToolRuntime,
    );

    expect(passthroughCalls).toEqual([{ content: 'note' }]);
  });

  it('drops sub-agents whose toAgentSpec conversion throws but keeps the rest', async () => {
    const ambient = makeAmbient();
    const registry = new SubAgentRegistry();
    registry.register(
      makePlugin({
        name: 'good-plugin',
        getSubAgents: () => [makeSubAgent('ok_agent')],
      }),
    );
    registry.register(
      makePlugin({
        name: 'bad-plugin',
        getSubAgents: () => [makeSubAgent('bad_agent')],
      }),
    );

    const tools = await collectSubAgentsWithFallback({
      registry,
      buildCtx: makeBuildCtx(),
      ambient,
      state: STATE,
      userDid: 'did:ixo:user1',
      sessionId: 'sess-1',
      toAgentSpec: (sub, _buildCtx) => {
        if (sub.name === 'bad_agent') {
          throw new Error('boom');
        }
        return {
          name: sub.name,
          description: sub.description,
          systemPrompt: 'p',
          userDid: 'did:ixo:user1',
          sessionId: 'sess-1',
          model: ambient.llm.get('subagent'),
        };
      },
    });

    expect(tools.map((t) => t.name)).toEqual(['call_ok_agent']);
    expect(ambient.logger.error).toHaveBeenCalled();
  });
});

describe('collectSubAgentsWithFallback — forwardTools plumbing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function collectOne(forwardTools: PluginTool[] | boolean | undefined) {
    const ambient = makeAmbient();
    const registry = new SubAgentRegistry();
    registry.register(
      makePlugin({
        name: 'p',
        manifest: makeManifest({ visibility: 'silent' }),
        getSubAgents: () => [
          makeSubAgent('fwd_agent', {
            tools: [makeTool('toolA'), makeTool('toolB')],
            ...(forwardTools === undefined
              ? {}
              : Array.isArray(forwardTools)
                ? { forwardTools: forwardTools.map((t) => t.name) }
                : { forwardTools }),
          }),
        ],
      }),
    );

    await collectSubAgentsWithFallback({
      registry,
      buildCtx: makeBuildCtx(),
      ambient,
      state: STATE,
      userDid: 'did:ixo:user1',
      sessionId: 'sess-1',
    });

    return vi.mocked(SubagentAsTool.createSubagentAsTool);
  }

  it('forwardTools: true → passes all own tool names to createSubagentAsTool', async () => {
    const spy = await collectOne(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0]![1];
    expect(opts?.forwardTools).toEqual(['toolA', 'toolB']);
  });

  it('forwardTools: string[] → passes the list as-is', async () => {
    const spy = await collectOne([makeTool('toolA')]);
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0]![1];
    expect(opts?.forwardTools).toEqual(['toolA']);
  });

  it('forwardTools: omitted → no options passed (forwardTools undefined)', async () => {
    const spy = await collectOne(undefined);
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0]![1];
    expect(opts?.forwardTools).toBeUndefined();
  });
});
