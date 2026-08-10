import type { Cache } from '@nestjs/cache-manager';
import type { ConfigService } from '@nestjs/config';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { HumanMessage, fakeModel } from 'langchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UcanService } from '../ucan/ucan.service.js';
import type {
  ByoLlmService,
  ByoTurnState,
} from '../byo-llm/byo-llm.service.js';
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
  type OracleRuntimeBundleHolder,
  type OracleRuntimeBundle,
} from './oracle-runtime-bundle.js';
import { makePrepared } from './__test-fixtures__/deps.js';
import { type UserContextFetcher } from './user-context-fetcher.js';

// Mock createMainAgent so the test never tries to compile a real LangGraph
// runtime. We only need a sentinel return value — every assertion in this
// file is about the inputs AgentBuilder hands to it (and the BuiltAgent
// shape it returns to its own callers).
const createMainAgentMock = vi.fn();
vi.mock('../../graph/main-agent.js', () => ({
  createMainAgent: (...args: unknown[]) => createMainAgentMock(...args),
}));

// Mock MatrixManager.getInstance().sendMatrixEvent so the re-auth nudge path
// can be asserted without a real Matrix client. Keep the rest of @ixo/matrix
// intact (other modules import from it) by spreading the actual module.
const { sendMatrixEventMock } = vi.hoisted(() => ({
  sendMatrixEventMock: vi.fn(async () => 'event-id'),
}));
vi.mock('@ixo/matrix', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ixo/matrix')>();
  return {
    ...actual,
    MatrixManager: {
      ...actual.MatrixManager,
      getInstance: () => ({ sendMatrixEvent: sendMatrixEventMock }),
    },
  };
});

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
      postEvent: vi.fn(async () => 'event-id'),
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
  getDelegationMock: ReturnType<typeof vi.fn>;
  cacheGetMock: ReturnType<typeof vi.fn>;
  cacheSetMock: ReturnType<typeof vi.fn>;
  byoResolveForTurnMock: ReturnType<typeof vi.fn>;
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
    getDelegationImpl?: (userDid: string) => Promise<string | null>;
    byoResolveImpl?: (params: {
      userDid: string;
      homeServerName: string;
      requestedModel?: string;
    }) => Promise<ByoTurnState | null>;
    configValues?: Record<string, unknown>;
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
      (async () => undefined as Record<string, unknown> | undefined),
  );
  const userContextFetcher = {
    fetch: fetchMock,
  } as unknown as UserContextFetcher;

  const getDelegationMock = vi.fn(
    overrides.getDelegationImpl ?? (async () => null),
  );
  const ucan = {
    getDelegationForUser: getDelegationMock,
  } as unknown as UcanService;

  const configValues = overrides.configValues ?? {};
  const config = {
    get: vi.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;

  const cacheStore = new Map<string, unknown>();
  const cacheGetMock = vi.fn(async (k: string) => cacheStore.get(k));
  const cacheSetMock = vi.fn(async (k: string, v: unknown) => {
    cacheStore.set(k, v);
  });
  const cacheManager = {
    get: cacheGetMock,
    set: cacheSetMock,
  } as unknown as Cache;

  const byoResolveForTurnMock = vi.fn(
    overrides.byoResolveImpl ?? (async () => null),
  );
  const byoLlm = {
    resolveForTurn: byoResolveForTurnMock,
  } as unknown as ByoLlmService;

  const builder = new AgentBuilder(
    bundleHolder as unknown as OracleRuntimeBundleHolder,
    userContextFetcher,
    ucan,
    config,
    byoLlm,
    cacheManager,
  );

  return {
    builder,
    bundleHolder,
    fetchMock,
    getDelegationMock,
    cacheGetMock,
    cacheSetMock,
    byoResolveForTurnMock,
    bundle,
  };
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
    sendMatrixEventMock.mockResolvedValue('event-id');
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
      const priorPrefs = {
        userName: 'PriorName',
        updatedAt: '2026-01-01T00:00:00Z',
      };
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

    it('seeds loadedPlugins with "editor" when an editor session is active (plugin is on-demand)', async () => {
      const getTuple = vi.fn().mockResolvedValue({
        checkpoint: { channel_values: { loadedPlugins: ['flows'] } },
      });
      const checkpointer = { getTuple } as unknown as BaseCheckpointSaver;
      const checkpointerForUser = vi.fn(async () => checkpointer);
      const { builder } = buildHarness({
        bundle: makeBundle({ hooks: { checkpointerForUser } }),
      });

      const result = await builder.build(
        makeArgs({
          payload: { metadata: { editorRoomId: '!editor:home' } },
        }),
      );

      // Build-time state carries prior loads + the seed; the stateInput seed
      // unions into the thread's checkpoint via the set-union reducer so the
      // capability gate exposes `call_editor_agent` without a load step.
      expect(lastMainAgentArgs().state.loadedPlugins).toEqual([
        'flows',
        'editor',
      ]);
      expect(result.stateInput.loadedPlugins).toEqual(['editor']);
    });

    it('does not seed loadedPlugins when no editor session is active', async () => {
      const { builder } = buildHarness();

      const result = await builder.build(makeArgs());

      expect(result.stateInput.loadedPlugins).toBeUndefined();
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

    it('does NOT read-through a delegation on the portal path (delegation absent)', async () => {
      const { builder, getDelegationMock } = buildHarness();

      await builder.build(makeArgs({ payload: { ucanDelegation: undefined } }));

      expect(getDelegationMock).not.toHaveBeenCalled();
      expect(sendMatrixEventMock).not.toHaveBeenCalled();
    });

    it('reads the stored delegation through on a Matrix turn and uses it as raw', async () => {
      const { builder, getDelegationMock } = buildHarness({
        getDelegationImpl: async () => 'stored-raw-delegation',
      });

      await builder.build(
        makeArgs({
          payload: { clientType: 'matrix', ucanDelegation: undefined },
        }),
      );

      expect(getDelegationMock).toHaveBeenCalledWith(USER_DID);
      const ctxUcan = lastMainAgentArgs().requestCtx.user.ucanDelegation as {
        raw: string;
      };
      expect(ctxUcan.raw).toBe('stored-raw-delegation');
      // Found a delegation → no re-auth nudge.
      expect(sendMatrixEventMock).not.toHaveBeenCalled();
    });

    it('falls back to {raw: ""} and emits a throttled delegation-required event when a Matrix turn has no stored delegation', async () => {
      const { builder, getDelegationMock, cacheSetMock } = buildHarness({
        getDelegationImpl: async () => null,
        configValues: {
          ORACLE_ENTITY_DID: 'did:ixo:entity',
          ORACLE_DID: 'did:ixo:oracleacct',
        },
      });

      await builder.build(
        makeArgs({
          payload: { clientType: 'matrix', ucanDelegation: undefined },
        }),
      );

      expect(getDelegationMock).toHaveBeenCalledWith(USER_DID);
      const ctxUcan = lastMainAgentArgs().requestCtx.user.ucanDelegation as {
        raw: string;
      };
      expect(ctxUcan.raw).toBe('');
      expect(sendMatrixEventMock).toHaveBeenCalledTimes(1);
      expect(sendMatrixEventMock).toHaveBeenCalledWith(
        ROOM_ID,
        'ixo.oracle.delegation_required',
        { oracleEntityDid: 'did:ixo:entity', oracleDid: 'did:ixo:oracleacct' },
      );
      // Throttle key written so the next miss is suppressed.
      expect(cacheSetMock).toHaveBeenCalledWith(
        `ucan_reauth_prompt_${USER_DID}`,
        true,
        expect.any(Number),
      );
    });

    it('skips the re-auth prompt when the throttle key is already set', async () => {
      const { builder, cacheGetMock } = buildHarness({
        getDelegationImpl: async () => null,
      });
      cacheGetMock.mockResolvedValue(true);

      await builder.build(
        makeArgs({
          payload: { clientType: 'matrix', ucanDelegation: undefined },
        }),
      );

      expect(sendMatrixEventMock).not.toHaveBeenCalled();
    });

    it('honours UCAN_REAUTH_PROMPT_THROTTLE_SECONDS for the throttle TTL', async () => {
      const { builder, cacheSetMock } = buildHarness({
        getDelegationImpl: async () => null,
        configValues: { UCAN_REAUTH_PROMPT_THROTTLE_SECONDS: 100 },
      });

      await builder.build(
        makeArgs({
          payload: { clientType: 'matrix', ucanDelegation: undefined },
        }),
      );

      expect(cacheSetMock).toHaveBeenCalledWith(
        `ucan_reauth_prompt_${USER_DID}`,
        true,
        100 * 1000,
      );
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

    it('always attaches user + timing metadata to langGraphConfig, without callbacks when LangSmith is unconfigured', async () => {
      const { builder } = buildHarness();

      const result = await builder.build(makeArgs());

      const metadata = result.langGraphConfig.metadata as Record<
        string,
        unknown
      >;
      expect(metadata.user_did).toBe(USER_DID);
      expect(metadata.client).toBe('portal');
      expect(typeof metadata.agent_build_duration_ms).toBe('number');
      expect(result.langGraphConfig).not.toHaveProperty('callbacks');
    });

    it('attaches a LangChainTracer callback when the user DID is in LANGSMITH_TRACED_DIDS', async () => {
      const { builder } = buildHarness({
        configValues: {
          LANGSMITH_API_KEY: 'ls-key',
          LANGSMITH_PROJECT: 'test-project',
          LANGSMITH_TRACED_DIDS: `did:ixo:someone-else,${USER_DID}`,
        },
      });

      const result = await builder.build(makeArgs());

      const callbacks = result.langGraphConfig.callbacks as LangChainTracer[];
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0]).toBeInstanceOf(LangChainTracer);
      expect(callbacks[0]?.projectName).toBe('test-project');
    });

    it('does not attach a tracer for a DID outside the allowlist', async () => {
      const { builder } = buildHarness({
        configValues: {
          LANGSMITH_API_KEY: 'ls-key',
          LANGSMITH_TRACED_DIDS: 'did:ixo:someone-else',
        },
      });

      const result = await builder.build(makeArgs());

      expect(result.langGraphConfig).not.toHaveProperty('callbacks');
    });

    it('does not attach an explicit tracer when global LANGSMITH_TRACING=true (LangChain auto-attaches)', async () => {
      const { builder } = buildHarness({
        configValues: {
          LANGSMITH_TRACING: 'true',
          LANGSMITH_API_KEY: 'ls-key',
        },
      });

      const result = await builder.build(makeArgs());

      expect(result.langGraphConfig).not.toHaveProperty('callbacks');
      const metadata = result.langGraphConfig.metadata as Record<
        string,
        unknown
      >;
      expect(metadata.user_did).toBe(USER_DID);
    });

    it('carries prepareDurationMs from the prepared request into trace metadata', async () => {
      const { builder } = buildHarness();

      const result = await builder.build(
        makeArgs({ prepared: { prepareDurationMs: 77 } }),
      );

      const metadata = result.langGraphConfig.metadata as Record<
        string,
        unknown
      >;
      expect(metadata.prepare_duration_ms).toBe(77);
    });
  });

  describe('BYO turns', () => {
    const byoTurn: ByoTurnState = {
      provider: 'openai',
      credential: { provider: 'openai', apiKey: 'sk-user' },
      mainModelId: 'gpt-5.6-terra',
      byoModelId: 'byo:openai/gpt-5.6-terra',
    };

    it('skips BYO resolution entirely when an allowed platform model is requested', async () => {
      const { builder, byoResolveForTurnMock } = buildHarness();

      await builder.build(
        makeArgs({ payload: { model: 'openai/gpt-5.4-nano' } }),
      );

      expect(byoResolveForTurnMock).not.toHaveBeenCalled();
      const args = lastMainAgentArgs();
      expect(args.requestCtx.model).toBe('openai/gpt-5.4-nano');
      expect(args.requestCtx.byo).toBeUndefined();
    });

    it('routes a byo: model request through the resolver and marks the turn BYO', async () => {
      const { builder, byoResolveForTurnMock, bundle } = buildHarness({
        byoResolveImpl: async () => byoTurn,
      });

      await builder.build(
        makeArgs({ payload: { model: 'byo:openai/gpt-5.6-terra' } }),
      );

      expect(byoResolveForTurnMock).toHaveBeenCalledWith({
        userDid: USER_DID,
        homeServerName: HOME_SERVER,
        requestedModel: 'byo:openai/gpt-5.6-terra',
      });
      const args = lastMainAgentArgs();
      expect(args.requestCtx.model).toBe('byo:openai/gpt-5.6-terra');
      expect(args.requestCtx.byo).toEqual({ provider: 'openai', active: true });
      expect(args.ambient).not.toBe(bundle.ambient);
      expect(args.ambient.llm).not.toBe(bundle.ambient.llm);
    });

    it('falls back to a platform turn when the resolver returns null', async () => {
      const { builder, bundle } = buildHarness({
        byoResolveImpl: async () => null,
      });

      await builder.build(
        makeArgs({ payload: { model: 'byo:openai/gpt-5.6-terra' } }),
      );

      const args = lastMainAgentArgs();
      expect(args.requestCtx.model).toBeUndefined();
      expect(args.requestCtx.byo).toBeUndefined();
      expect(args.ambient).toBe(bundle.ambient);
    });

    it('resolves BYO with no requested model (Matrix ingress auto-preference)', async () => {
      const { builder, byoResolveForTurnMock } = buildHarness({
        byoResolveImpl: async () => byoTurn,
      });

      await builder.build(makeArgs());

      expect(byoResolveForTurnMock).toHaveBeenCalledWith({
        userDid: USER_DID,
        homeServerName: HOME_SERVER,
        requestedModel: undefined,
      });
      const args = lastMainAgentArgs();
      expect(args.requestCtx.model).toBe('byo:openai/gpt-5.6-terra');
      expect(args.requestCtx.byo).toEqual({ provider: 'openai', active: true });
    });

    it('degrades to a platform turn when the resolver rejects', async () => {
      const { builder, bundle } = buildHarness({
        byoResolveImpl: async () => {
          throw new Error('matrix down');
        },
      });

      await builder.build(makeArgs());

      const args = lastMainAgentArgs();
      expect(args.requestCtx.byo).toBeUndefined();
      expect(args.ambient).toBe(bundle.ambient);
    });
  });
});
