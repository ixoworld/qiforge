import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { HumanMessage, fakeModel } from 'langchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompiledMainAgent,
  MainAgentArgs,
} from '../../graph/main-agent-types.js';
import type { OracleIdentity } from '../../plugin-api/types.js';
import { UserPreferencesService } from '../../plugins/user-preferences/service/user-preferences.service.js';
import {
  ConfigSchemaRegistry,
  ManifestRegistry,
  MiddlewareRegistry,
  SharedStateRegistry,
  SubAgentRegistry,
  ToolRegistry,
} from '../../registries/index.js';
import type { AmbientServices } from '../../runtime-context/ambient.js';
import { AgentBuilder, type BuildAgentArgs } from './agent-builder.js';
import {
  type AuthUcanDelegation,
  type SendMessageRequest,
} from './messages.service.js';
import {
  OracleRuntimeBundleHolder,
  type OracleRuntimeBundle,
} from './oracle-runtime-bundle.js';
import { makePrepared } from './__test-fixtures__/deps.js';
import { UserContextFetcher } from './user-context-fetcher.js';

// Mock createMainAgent so the test never tries to compile a real LangGraph
// runtime. We only need a sentinel return value — every assertion in this
// file is about the inputs AgentBuilder hands to it (and the BuiltAgent
// shape it returns to its own callers).
const createMainAgentMock = vi.fn();
vi.mock('../../graph/main-agent.js', () => ({
  createMainAgent: (...args: unknown[]) => createMainAgentMock(...args),
}));

const USER_DID = 'did:ixo:user-1';
const SESSION_ID = 'sess-1';
const ROOM_ID = '!room:home';
const HOME_SERVER = 'home.server';

function makeIdentity(): OracleIdentity {
  return {
    name: 'TestOracle',
    org: 'Acme',
    description: 'a test oracle',
    entityDid: 'did:ixo:test-entity',
  };
}

function makeAmbient(): AmbientServices {
  return {
    config: {},
    identity: makeIdentity(),
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
    // The chat model slot — use LangChain's official fake.
    llm: { get: vi.fn(() => fakeModel()) },
    emit: { emit: vi.fn() },
    ucan: {
      hasCapability: vi.fn(() => true),
      requireCapability: vi.fn(),
      mintInvocation: vi.fn(async () => 'inv'),
      resolveServiceDid: vi.fn(async () => 'did:web:example.com'),
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

function makeBundle(
  overrides: Partial<OracleRuntimeBundle> = {},
): OracleRuntimeBundle {
  return {
    ambient: makeAmbient(),
    registries: {
      tools: new ToolRegistry(),
      subAgents: new SubAgentRegistry(),
      middlewares: new MiddlewareRegistry(),
      manifests: new ManifestRegistry(),
      configSchema: new ConfigSchemaRegistry(),
      sharedState: new SharedStateRegistry(),
    },
    identity: makeIdentity(),
    config: {},
    availablePlugins: new Set(),
    ...overrides,
  };
}

function makePayload(
  overrides: Partial<SendMessageRequest> = {},
): SendMessageRequest {
  return {
    message: 'hello',
    sessionId: SESSION_ID,
    did: USER_DID,
    ...overrides,
  };
}

function makeArgs(
  overrides: {
    payload?: Partial<SendMessageRequest>;
    prepared?: Parameters<typeof makePrepared>[0];
  } = {},
): BuildAgentArgs {
  return {
    payload: makePayload(overrides.payload),
    prepared: makePrepared({
      sessionId: SESSION_ID,
      langchainThreadId: SESSION_ID,
      roomId: ROOM_ID,
      homeServerName: HOME_SERVER,
      ...overrides.prepared,
    }),
    inputMessages: [new HumanMessage('hello')],
  };
}

interface Harness {
  builder: AgentBuilder;
  bundleHolder: { get: ReturnType<typeof vi.fn> };
  fetchMock: ReturnType<typeof vi.fn>;
  bundle: OracleRuntimeBundle;
}

function buildHarness(
  overrides: {
    bundle?: OracleRuntimeBundle;
    bundleGetThrows?: Error;
    fetchImpl?: (params: {
      roomId: string;
      userDid: string;
      sessionId: string;
    }) => Promise<Record<string, unknown> | undefined>;
  } = {},
): Harness {
  const bundle = overrides.bundle ?? makeBundle();

  const bundleHolder = {
    get: vi.fn(() => {
      if (overrides.bundleGetThrows) throw overrides.bundleGetThrows;
      return bundle;
    }),
  };

  const fetchMock = vi.fn(
    overrides.fetchImpl ??
      (async () =>
        undefined as Record<string, unknown> | undefined),
  );
  const userContextFetcher = {
    fetch: fetchMock,
  } as unknown as UserContextFetcher;

  const builder = new AgentBuilder(
    bundleHolder as unknown as OracleRuntimeBundleHolder,
    userContextFetcher,
  );

  return { builder, bundleHolder, fetchMock, bundle };
}

function lastMainAgentArgs(): MainAgentArgs {
  const call = createMainAgentMock.mock.calls.at(-1);
  if (!call) throw new Error('createMainAgent was not called');
  return call[0] as MainAgentArgs;
}

describe('AgentBuilder', () => {
  let prefsGetSpy: ReturnType<typeof vi.spyOn>;
  let compiledAgent: CompiledMainAgent;

  beforeEach(() => {
    vi.resetAllMocks();
    compiledAgent = {
      invoke: vi.fn(),
      streamEvents: vi.fn(),
    } as unknown as CompiledMainAgent;
    createMainAgentMock.mockResolvedValue(compiledAgent);
    // Stub the singleton's read path so the SUT never reaches into Matrix.
    prefsGetSpy = vi
      .spyOn(UserPreferencesService.getInstance(), 'get')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    prefsGetSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('build', () => {
    it('throws when bundleHolder.get() throws (populate never ran)', async () => {
      const { builder } = buildHarness({
        bundleGetThrows: new Error(
          'OracleRuntimeBundleHolder.get called before populate',
        ),
      });

      await expect(builder.build(makeArgs())).rejects.toThrow(
        /called before populate/,
      );
    });

    it('reads priorState via checkpointer.getTuple when hooks.checkpointerForUser is present', async () => {
      const priorCurrentEntityDid = 'did:ixo:entity-from-checkpoint';
      const getTuple = vi.fn().mockResolvedValue({
        checkpoint: {
          channel_values: { currentEntityDid: priorCurrentEntityDid },
        },
      });
      const checkpointer = { getTuple } as unknown as BaseCheckpointSaver;
      const checkpointerForUser = vi.fn(async () => checkpointer);

      const { builder } = buildHarness({
        bundle: makeBundle({ hooks: { checkpointerForUser } }),
      });

      await builder.build(makeArgs());

      expect(checkpointerForUser).toHaveBeenCalledWith(USER_DID);
      expect(getTuple).toHaveBeenCalledWith({
        configurable: { thread_id: SESSION_ID },
      });
      expect(lastMainAgentArgs().state.currentEntityDid).toBe(
        priorCurrentEntityDid,
      );
    });

    it('swallows getTuple errors (fresh thread) and continues with empty priorState', async () => {
      const getTuple = vi
        .fn()
        .mockRejectedValue(new Error('no checkpoint for this thread'));
      const checkpointer = { getTuple } as unknown as BaseCheckpointSaver;
      const checkpointerForUser = vi.fn(async () => checkpointer);

      const { builder } = buildHarness({
        bundle: makeBundle({ hooks: { checkpointerForUser } }),
      });

      const result = await builder.build(makeArgs());

      expect(getTuple).toHaveBeenCalledTimes(1);
      expect(result.agent).toBe(compiledAgent);
      const passedState = lastMainAgentArgs().state;
      expect(passedState.currentEntityDid).toBeUndefined();
      expect(passedState.editorRoomId).toBeUndefined();
    });

    it('skips checkpointer fetch entirely when hooks.checkpointerForUser is absent', async () => {
      const { builder } = buildHarness({
        bundle: makeBundle({ hooks: {} }),
      });

      await expect(builder.build(makeArgs())).resolves.toBeDefined();
      // priorState stayed empty — no editorRoomId/spaceId/currentEntityDid
      // bled through.
      const passedState = lastMainAgentArgs().state;
      expect(passedState.currentEntityDid).toBeUndefined();
      expect(passedState.editorRoomId).toBeUndefined();
      expect(passedState.userContext).toBeUndefined();
    });

    it('falls back to priorState.userContext when userContextFetcher rejects', async () => {
      const priorUserContext = { identity: { name: 'Prior' } };
      const getTuple = vi.fn().mockResolvedValue({
        checkpoint: { channel_values: { userContext: priorUserContext } },
      });
      const checkpointer = { getTuple } as unknown as BaseCheckpointSaver;
      const checkpointerForUser = vi.fn(async () => checkpointer);

      const { builder, fetchMock } = buildHarness({
        bundle: makeBundle({ hooks: { checkpointerForUser } }),
        fetchImpl: async () => {
          throw new Error('memory engine down');
        },
      });

      const result = await builder.build(makeArgs());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(lastMainAgentArgs().state.userContext).toEqual(priorUserContext);
      expect(result.stateInput.userContext).toEqual(priorUserContext);
    });

    it('falls back to priorState.userPreferences when the prefs read rejects', async () => {
      const priorPrefs = { userName: 'PriorName', updatedAt: '2026-01-01T00:00:00Z' };
      const getTuple = vi.fn().mockResolvedValue({
        checkpoint: { channel_values: { userPreferences: priorPrefs } },
      });
      const checkpointer = { getTuple } as unknown as BaseCheckpointSaver;
      const checkpointerForUser = vi.fn(async () => checkpointer);
      prefsGetSpy.mockRejectedValueOnce(new Error('matrix state read failed'));

      const { builder } = buildHarness({
        bundle: makeBundle({ hooks: { checkpointerForUser } }),
      });

      const result = await builder.build(makeArgs());

      expect(lastMainAgentArgs().state.userPreferences).toEqual(priorPrefs);
      expect(result.stateInput.userPreferences).toEqual(priorPrefs);
    });

    it('payload.metadata.editorRoomId wins over priorState.editorRoomId', async () => {
      const getTuple = vi.fn().mockResolvedValue({
        checkpoint: {
          channel_values: { editorRoomId: '!editor-from-checkpoint:home' },
        },
      });
      const checkpointer = { getTuple } as unknown as BaseCheckpointSaver;
      const checkpointerForUser = vi.fn(async () => checkpointer);

      const { builder } = buildHarness({
        bundle: makeBundle({ hooks: { checkpointerForUser } }),
      });

      const result = await builder.build(
        makeArgs({
          payload: { metadata: { editorRoomId: '!editor-from-payload:home' } },
        }),
      );

      expect(lastMainAgentArgs().state.editorRoomId).toBe(
        '!editor-from-payload:home',
      );
      expect(result.stateInput.editorRoomId).toBe('!editor-from-payload:home');
    });

    it('maps ucanDelegation.capabilities from {can, with} to {action, resource}', async () => {
      const ucanDelegation: AuthUcanDelegation = {
        raw: 'raw-ucan',
        issuer: 'did:ixo:issuer',
        audience: 'did:ixo:audience',
        capabilities: [
          { can: 'memory/write', with: 'ixo:memory' },
          { can: 'sandbox/exec', with: 'ixo:sandbox' },
        ],
      };

      const { builder } = buildHarness();

      await builder.build(makeArgs({ payload: { ucanDelegation } }));

      const ctxUcan = lastMainAgentArgs().requestCtx.user.ucanDelegation as {
        raw: string;
        issuer?: string;
        audience?: string;
        capabilities?: ReadonlyArray<{ resource: string; action: string }>;
      };
      expect(ctxUcan.raw).toBe('raw-ucan');
      expect(ctxUcan.issuer).toBe('did:ixo:issuer');
      expect(ctxUcan.audience).toBe('did:ixo:audience');
      expect(ctxUcan.capabilities).toEqual([
        { action: 'memory/write', resource: 'ixo:memory' },
        { action: 'sandbox/exec', resource: 'ixo:sandbox' },
      ]);
    });

    it('produces {raw: ""} delegation when payload.ucanDelegation is missing (Matrix bot path)', async () => {
      const { builder } = buildHarness();

      await builder.build(makeArgs({ payload: { ucanDelegation: undefined } }));

      const ctxUcan = lastMainAgentArgs().requestCtx.user.ucanDelegation as {
        raw: string;
        capabilities?: ReadonlyArray<{ resource: string; action: string }>;
      };
      expect(ctxUcan).toEqual({ raw: '' });
    });

    it('produces langGraphConfig with version="v2" and forwards abortController.signal', async () => {
      const { builder } = buildHarness();
      const abortController = new AbortController();

      const result = await builder.build(makeArgs(), abortController);

      expect(result.langGraphConfig.version).toBe('v2');
      expect(result.langGraphConfig.signal).toBe(abortController.signal);
    });

    it('omits signal from langGraphConfig when no abortController is passed', async () => {
      const { builder } = buildHarness();

      const result = await builder.build(makeArgs());

      expect(result.langGraphConfig.version).toBe('v2');
      expect(result.langGraphConfig).not.toHaveProperty('signal');
    });
  });
});

