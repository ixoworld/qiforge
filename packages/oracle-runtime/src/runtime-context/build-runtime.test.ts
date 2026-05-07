import { HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { describe, expect, it, vi } from 'vitest';
import type {
  Logger,
  MatrixEvent,
  RoomStateSnapshot,
  SecretIndex,
} from '../plugin-api/types.js';
import type { AmbientServices, EmitAdapter } from './ambient.js';
import { buildRuntimeContext, type RunConfig } from './build-runtime.js';
import { EVENT_NAMES } from '../events/scoped-emitter.js';

const noopLogger: Logger = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

interface AmbientMockOverrides {
  emit?: EmitAdapter;
}

function makeAmbient(overrides: AmbientMockOverrides = {}): AmbientServices {
  const emit: EmitAdapter = overrides.emit ?? { emit: vi.fn() };
  const fakeChatModel = { invoke: vi.fn() } as unknown as BaseChatModel;
  return {
    config: { FOO: 'bar' },
    identity: {
      name: 'TestOracle',
      org: 'Acme',
      description: 'desc',
      entityDid: 'did:ixo:test',
    },
    availablePlugins: new Set(['memory']),
    secrets: {
      getIndex: vi.fn(
        async (): Promise<SecretIndex> => ({
          OPENAI_API_KEY: { key: 'event123' },
        }),
      ),
      getValues: vi.fn(async () => ({ OPENAI_API_KEY: 'sk-xxx' })),
    },
    matrix: {
      postToRoom: vi.fn(async () => 'event-id-1'),
      getRoomState: vi.fn(
        async (roomId: string): Promise<RoomStateSnapshot> => ({
          roomId,
          state: [],
        }),
      ),
      getEventById: vi.fn(
        async (_roomId: string, eventId: string): Promise<MatrixEvent> => ({
          eventId,
          type: 'm.room.message',
          content: { body: 'hi' },
        }),
      ),
    },
    llm: {
      get: vi.fn(() => fakeChatModel),
    },
    emit,
    ucan: {
      hasCapability: vi.fn(() => true),
      requireCapability: vi.fn(),
      mintInvocation: vi.fn(async () => 'invocation-cid'),
    },
    logger: noopLogger,
  };
}

function makeRunConfig(): RunConfig {
  return {
    context: {
      user: {
        did: 'did:ixo:user1',
        matrixUserId: '@did-ixo-user1:ixo.world',
        timezone: 'UTC',
      },
      session: {
        id: 'session-abc',
        client: 'portal',
        requestId: 'req-1',
        roomId: '!room:ixo.world',
      },
    },
  };
}

describe('buildRuntimeContext', () => {
  it('maps user and session from runtime.context', () => {
    const ambient = makeAmbient();
    const ctx = buildRuntimeContext(makeRunConfig(), ambient, {
      messages: [],
    });

    expect(ctx.user.did).toBe('did:ixo:user1');
    expect(ctx.user.matrixUserId).toBe('@did-ixo-user1:ixo.world');
    expect(ctx.session.id).toBe('session-abc');
    expect(ctx.session.client).toBe('portal');
    expect(ctx.session.requestId).toBe('req-1');
    expect(ctx.session.roomId).toBe('!room:ixo.world');
  });

  it('maps history from state, including a typed view', () => {
    const ambient = makeAmbient();
    const messages = [new HumanMessage('hi'), new HumanMessage('there')];
    const ctx = buildRuntimeContext(makeRunConfig(), ambient, {
      messages,
      userContext: { identity: { name: 'Alice' } },
      loadedPlugins: new Set(['portal']),
    });

    expect(ctx.history.messages).toBe(messages);
    expect(ctx.history.userContext).toEqual({ identity: { name: 'Alice' } });
    expect(ctx.history.recent(1)).toEqual([messages[1]]);
    expect(ctx.history.state.messages).toEqual(messages);
    expect(ctx.loadedPlugins.has('portal')).toBe(true);
  });

  it('exposes config and availablePlugins from ambient', () => {
    const ambient = makeAmbient();
    const ctx = buildRuntimeContext(makeRunConfig(), ambient, { messages: [] });

    expect(ctx.config).toEqual({ FOO: 'bar' });
    expect(ctx.availablePlugins.has('memory')).toBe(true);
  });

  it('forwards secrets calls to ambient.secrets with the session roomId', async () => {
    const ambient = makeAmbient();
    const ctx = buildRuntimeContext(makeRunConfig(), ambient, { messages: [] });

    const idx = await ctx.secrets.getIndex();
    expect(ambient.secrets.getIndex).toHaveBeenCalledWith('!room:ixo.world');
    expect(idx).toEqual({ OPENAI_API_KEY: { key: 'event123' } });

    const values = await ctx.secrets.getValues(['OPENAI_API_KEY']);
    expect(ambient.secrets.getValues).toHaveBeenCalledWith('!room:ixo.world', [
      'OPENAI_API_KEY',
    ]);
    expect(values.OPENAI_API_KEY).toBe('sk-xxx');
  });

  it('returns empty results from secrets when no roomId is in session', async () => {
    const ambient = makeAmbient();
    const runConfig = makeRunConfig();
    runConfig.context.session.roomId = undefined;

    const ctx = buildRuntimeContext(runConfig, ambient, { messages: [] });
    expect(await ctx.secrets.getIndex()).toEqual({});
    expect(ambient.secrets.getIndex).not.toHaveBeenCalled();
  });

  it('forwards matrix.postToRoom and friends to ambient.matrix', async () => {
    const ambient = makeAmbient();
    const ctx = buildRuntimeContext(makeRunConfig(), ambient, { messages: [] });

    await ctx.matrix.postToRoom('!room:ixo.world', { hello: 'world' });
    expect(ambient.matrix.postToRoom).toHaveBeenCalledWith('!room:ixo.world', {
      hello: 'world',
    });

    await ctx.matrix.getRoomState('!room:ixo.world');
    expect(ambient.matrix.getRoomState).toHaveBeenCalledWith('!room:ixo.world');

    await ctx.matrix.getEventById('!room:ixo.world', 'evt-1');
    expect(ambient.matrix.getEventById).toHaveBeenCalledWith(
      '!room:ixo.world',
      'evt-1',
    );
  });

  it('llm.get returns a BaseChatModel via ambient.llm', () => {
    const ambient = makeAmbient();
    const ctx = buildRuntimeContext(makeRunConfig(), ambient, { messages: [] });

    const model = ctx.llm.get('main');
    expect(ambient.llm.get).toHaveBeenCalledWith('main', undefined);
    expect(typeof model.invoke).toBe('function');
  });

  it('ucan helpers thread the user delegation through', () => {
    const ambient = makeAmbient();
    const runConfig = makeRunConfig();
    runConfig.context.user.ucanDelegation = {
      raw: 'cid:abc',
      capabilities: [{ resource: 'ixo:sandbox', action: '*' }],
    };

    const ctx = buildRuntimeContext(runConfig, ambient, { messages: [] });

    expect(ctx.ucan.hasCapability('ixo:sandbox', '*')).toBe(true);
    expect(ambient.ucan.hasCapability).toHaveBeenCalledWith(
      runConfig.context.user.ucanDelegation,
      'ixo:sandbox',
      '*',
    );

    ctx.ucan.requireCapability('ixo:sandbox', '*');
    expect(ambient.ucan.requireCapability).toHaveBeenCalled();
  });

  it('shared accessors are a frozen empty object', () => {
    const ambient = makeAmbient();
    const ctx = buildRuntimeContext(makeRunConfig(), ambient, { messages: [] });

    expect(ctx.shared).toEqual({});
    expect(Object.isFrozen(ctx.shared)).toBe(true);
  });

  it('exposes an abortSignal from runConfig when provided', () => {
    const ambient = makeAmbient();
    const controller = new AbortController();
    const runConfig = makeRunConfig();
    (runConfig).signal = controller.signal;

    const ctx = buildRuntimeContext(runConfig, ambient, { messages: [] });
    expect(ctx.abortSignal).toBe(controller.signal);
  });

  describe('emit', () => {
    it('attaches sessionId and requestId to every event', () => {
      const sink: EmitAdapter = { emit: vi.fn() };
      const ambient = makeAmbient({ emit: sink });
      const ctx = buildRuntimeContext(makeRunConfig(), ambient, {
        messages: [],
      });

      ctx.emit.toolCall({ toolName: 'echo', args: { a: 1 } });

      expect(sink.emit).toHaveBeenCalledWith(EVENT_NAMES.toolCall, {
        toolName: 'echo',
        args: { a: 1 },
        sessionId: 'session-abc',
        requestId: 'req-1',
      });
    });

    it('wires all 7 event types', () => {
      const sink: EmitAdapter = { emit: vi.fn() };
      const ambient = makeAmbient({ emit: sink });
      const ctx = buildRuntimeContext(makeRunConfig(), ambient, {
        messages: [],
      });

      ctx.emit.toolCall({ toolName: 't' });
      ctx.emit.actionCall({ toolCallId: 'c', toolName: 'a' });
      ctx.emit.renderComponent({ componentName: 'X' });
      ctx.emit.reasoning({ reasoning: '...' });
      ctx.emit.browserToolCall({ toolCallId: 'c', toolName: 'b', args: {} });
      ctx.emit.router({ step: 'plan' });
      ctx.emit.messageCacheInvalidation({ status: 'done' });

      const calls = (sink.emit as unknown as { mock: { calls: unknown[][] } })
        .mock.calls;
      const eventNames = calls.map((c) => c[0]);
      expect(eventNames).toEqual([
        EVENT_NAMES.toolCall,
        EVENT_NAMES.actionCall,
        EVENT_NAMES.renderComponent,
        EVENT_NAMES.reasoning,
        EVENT_NAMES.browserToolCall,
        EVENT_NAMES.router,
        EVENT_NAMES.messageCacheInvalidation,
      ]);

      for (const [, payload] of calls as Array<
        [string, { sessionId?: string; requestId?: string }]
      >) {
        expect(payload.sessionId).toBe('session-abc');
        expect(payload.requestId).toBe('req-1');
      }
    });
  });
});
