import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { createAgent, fakeModel, type ToolRuntime } from 'langchain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  mockDomain,
  mockEmit,
  mockLogger,
  mockMatrix,
  mockSecrets,
  mockUcan,
} from '../testing/mocks.js';
import type { AmbientServices } from '../runtime-context/ambient.js';
import type {
  PluginTool,
  RuntimeContext,
  OracleIdentity,
} from '../plugin-api/types.js';
import type {
  RuntimeStateInput,
  RunConfig,
} from '../runtime-context/build-runtime.js';
import { wrapPluginTool } from './wrap-plugin-tool.js';

const IDENTITY: OracleIdentity = {
  name: 'TestOracle',
  org: 'Acme',
  description: 'test',
  entityDid: 'did:ixo:oracle1',
};

function makeAmbient(
  overrides: Partial<AmbientServices> = {},
): AmbientServices {
  return {
    domain: mockDomain(),
    config: { FOO_KEY: 'foo-value' },
    identity: IDENTITY,
    availablePlugins: new Set(['climate']),
    secrets: mockSecrets({ API_KEY: 'sk-test' }),
    matrix: mockMatrix(),
    llm: {
      get: () => ({}) as unknown as ReturnType<AmbientServices['llm']['get']>,
    },
    emit: mockEmit(),
    ucan: mockUcan(),
    logger: mockLogger(),
    ...overrides,
  };
}

const STATE: RuntimeStateInput = {
  messages: [],
  userContext: { name: 'Yousef' },
  loadedPlugins: new Set(['memory']),
};

function makeRunConfig(extras: Record<string, unknown> = {}): RunConfig {
  return {
    context: {
      user: {
        did: 'did:ixo:user1',
        matrixUserId: '@did-ixo-user1:ixo.world',
        ucanDelegation: {
          raw: 'eyJ-test',
          capabilities: [{ resource: 'r', action: 'a' }],
        },
        timezone: 'UTC',
      },
      session: {
        id: 'thr-1',
        client: 'portal',
        requestId: 'req-1',
        roomId: '!room:ixo.world',
      },
    },
    ...extras,
  };
}

describe('wrapPluginTool — direct invocation', () => {
  let captured: { args?: unknown; ctx?: RuntimeContext } = {};

  beforeEach(() => {
    captured = {};
  });

  const climateTool: PluginTool = {
    name: 'get_emissions',
    description: 'Fetch emissions for a facility.',
    schema: z.object({ facilityId: z.string(), period: z.string() }),
    handler: async (args, ctx) => {
      captured.args = args;
      captured.ctx = ctx;
      return {
        co2: 1234,
        facility: (args as { facilityId: string }).facilityId,
      };
    },
  };

  it('prefixes description with the plugin title when provided', () => {
    const wrapped = wrapPluginTool(climateTool, {
      ambient: makeAmbient(),
      state: STATE,
      pluginTitle: 'Climate Data',
    });
    expect(wrapped.description).toBe(
      '[Climate Data] Fetch emissions for a facility.',
    );
  });

  it('leaves description untouched when no title given', () => {
    const wrapped = wrapPluginTool(climateTool, {
      ambient: makeAmbient(),
      state: STATE,
    });
    expect(wrapped.description).toBe('Fetch emissions for a facility.');
  });

  it('preserves the plugin tool name and schema', () => {
    const wrapped = wrapPluginTool(climateTool, {
      ambient: makeAmbient(),
      state: STATE,
    });
    expect(wrapped.name).toBe('get_emissions');
    expect(wrapped.schema).toBe(climateTool.schema);
  });

  it('handler receives validated args and a fully built RuntimeContext', async () => {
    const ambient = makeAmbient();
    const wrapped = wrapPluginTool(climateTool, {
      ambient,
      state: STATE,
      pluginTitle: 'Climate Data',
    });

    const runConfig = makeRunConfig();
    const result = await wrapped.invoke(
      { facilityId: 'plant-42', period: 'Q1-2026' },
      runConfig as unknown as ToolRuntime,
    );

    expect(result).toEqual({ co2: 1234, facility: 'plant-42' });
    expect(captured.args).toEqual({
      facilityId: 'plant-42',
      period: 'Q1-2026',
    });

    expect(captured.ctx).toBeDefined();
    const ctx = captured.ctx!;
    expect(ctx.user.did).toBe('did:ixo:user1');
    expect(ctx.user.matrixUserId).toBe('@did-ixo-user1:ixo.world');
    expect(ctx.user.ucanDelegation.raw).toBe('eyJ-test');
    expect(ctx.session.id).toBe('thr-1');
    expect(ctx.session.client).toBe('portal');
    expect(ctx.session.roomId).toBe('!room:ixo.world');
    expect(ctx.history.userContext).toEqual({ name: 'Yousef' });
    expect(ctx.loadedPlugins.has('memory')).toBe(true);
    expect(ctx.availablePlugins.has('climate')).toBe(true);
    expect(ctx.config).toBe(ambient.config);
    expect(ctx.logger).toBe(ambient.logger);
    expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('tolerates the full LangChain ToolRuntime shape (ignores extra keys)', async () => {
    const wrapped = wrapPluginTool(climateTool, {
      ambient: makeAmbient(),
      state: STATE,
    });

    const fullToolRuntime = makeRunConfig({
      state: { messages: [] },
      toolCallId: 'call_abc',
      toolCall: { name: 'get_emissions', args: {}, id: 'call_abc' },
      configurable: { thread_id: 'thr-1' },
      callbacks: undefined,
      runId: 'run-xyz',
      runName: 'agent-step-1',
      store: undefined,
      writer: vi.fn(),
    });

    await wrapped.invoke(
      { facilityId: 'plant-7', period: 'Q1-2026' },
      fullToolRuntime as unknown as ToolRuntime,
    );

    expect(captured.ctx?.user.did).toBe('did:ixo:user1');
    expect(captured.ctx?.session.requestId).toBe('req-1');
  });

  it('threads runConfig.signal through to ctx.abortSignal', async () => {
    const wrapped = wrapPluginTool(climateTool, {
      ambient: makeAmbient(),
      state: STATE,
    });

    const controller = new AbortController();
    const runConfig = makeRunConfig({ signal: controller.signal });

    await wrapped.invoke(
      { facilityId: 'plant-42', period: 'Q1-2026' },
      runConfig as unknown as ToolRuntime,
    );

    expect(captured.ctx?.abortSignal).toBe(controller.signal);
  });

  it('zod rejects invalid args before reaching the plugin handler', async () => {
    const handler = vi.fn();
    const strictTool: PluginTool = {
      name: 'strict_tool',
      description: 'rejects bad input',
      schema: z.object({ id: z.string() }),
      handler,
    };
    const wrapped = wrapPluginTool(strictTool, {
      ambient: makeAmbient(),
      state: STATE,
    });

    await expect(
      wrapped.invoke(
        { id: 42 } as unknown as { id: string },
        makeRunConfig() as unknown as ToolRuntime,
      ),
    ).rejects.toBeDefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it('propagates handler errors', async () => {
    const errorTool: PluginTool = {
      name: 'broken',
      description: 'always throws',
      schema: z.object({}),
      handler: async () => {
        throw new Error('boom');
      },
    };
    const wrapped = wrapPluginTool(errorTool, {
      ambient: makeAmbient(),
      state: STATE,
    });

    await expect(
      wrapped.invoke({}, makeRunConfig() as unknown as ToolRuntime),
    ).rejects.toThrow('boom');
  });
});

describe('wrapPluginTool — end-to-end through createAgent + fakeModel', () => {
  it('invokes the wrapped tool when the model emits a tool call, receiving the real LangChain ToolRuntime', async () => {
    let capturedCtx: RuntimeContext | undefined;
    let capturedArgs: unknown;

    const climateTool: PluginTool = {
      name: 'get_emissions',
      description: 'Fetch emissions for a facility.',
      schema: z.object({ facilityId: z.string() }),
      handler: async (args, ctx) => {
        capturedArgs = args;
        capturedCtx = ctx;
        return { co2: 999 };
      },
    };

    const ambient = makeAmbient();
    const wrapped = wrapPluginTool(climateTool, {
      ambient,
      state: STATE,
      pluginTitle: 'Climate Data',
    });

    const model = fakeModel()
      .respondWithTools([
        { name: 'get_emissions', args: { facilityId: 'plant-99' }, id: 'c1' },
      ])
      .respond(new AIMessage('Emissions: 999'));

    const contextSchema = z.object({
      user: z.object({
        did: z.string(),
        matrixUserId: z.string(),
        ucanDelegation: z.object({
          raw: z.string(),
          capabilities: z
            .array(z.object({ resource: z.string(), action: z.string() }))
            .optional(),
        }),
        timezone: z.string().optional(),
      }),
      session: z.object({
        id: z.string(),
        client: z.enum(['portal', 'matrix', 'slack']),
        requestId: z.string(),
        roomId: z.string().optional(),
      }),
    });

    const agent = createAgent({
      model,
      tools: [wrapped],
      contextSchema,
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage('What are plant-99 emissions?')] },
      {
        context: {
          user: {
            did: 'did:ixo:e2e-user',
            matrixUserId: '@did-ixo-e2e-user:ixo.world',
            ucanDelegation: { raw: 'eyJe2e', capabilities: [] },
            timezone: 'UTC',
          },
          session: {
            id: 'thr-e2e',
            client: 'portal',
            requestId: 'req-e2e',
            roomId: '!room-e2e:ixo.world',
          },
        },
      },
    );

    expect(capturedArgs).toEqual({ facilityId: 'plant-99' });
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.user.did).toBe('did:ixo:e2e-user');
    expect(capturedCtx?.user.matrixUserId).toBe('@did-ixo-e2e-user:ixo.world');
    expect(capturedCtx?.user.ucanDelegation.raw).toBe('eyJe2e');
    expect(capturedCtx?.session.id).toBe('thr-e2e');
    expect(capturedCtx?.session.requestId).toBe('req-e2e');
    expect(capturedCtx?.session.roomId).toBe('!room-e2e:ixo.world');
    expect(capturedCtx?.config).toBe(ambient.config);

    // The agent reached our wrapped tool through the real LangChain machinery —
    // that's the contract this test asserts. The tool result lands in the
    // message list as a ToolMessage; whether createAgent loops again into a
    // final AIMessage is its concern, not ours.
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    expect(model.callCount).toBeGreaterThanOrEqual(1);
  });
});
