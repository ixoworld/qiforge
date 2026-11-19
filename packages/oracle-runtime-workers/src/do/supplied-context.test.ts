import { CallbackManager } from '@langchain/core/callbacks/manager';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import {
  MODEL_CALL_METADATA_KEY,
  type ModelCallRecord,
  type ModelCallReport,
  type TurnModelUsage,
} from '../llm/model-call';
import type { OraclePlugin } from '../plugin-api/oracle-plugin';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../core';
import {
  langsmithEnvFromWorkerEnv,
  resolveLangsmithTracing,
} from '../core/llm';
import { createNoopAmbient } from '../core/runtime-context';
import { makeEnv, makePlugin } from '../core/test-fixtures';
import { TurnModelCalls } from '../core/model-call-reporter';
import { PlatformModelsDeniedError } from '../llm/platform-models-policy';
import { ToolScheduler } from '../core/tool-scheduler';
import {
  LANGCHAIN_TRACING_SWITCHES,
  removeLangChainTracingSwitches,
} from '../core/tracing-env';
import type { ModelRole } from '../plugin-api/types';
import { UNTITLED_SESSION } from '../sqlite/sessions-store';
import type { TurnRequest } from './contracts';
import { storedRunRequest } from './run-request';
import { createUserOracleDO } from './user-oracle-do';

const TASK_SESSION = 'task:task_brief_0000001a';

/** The request the scheduler sends for a supplied-context task run. */
const taskRequest: TurnRequest = {
  identity: { userDid: 'did:ixo:owner', matrixUserId: '@owner:example.org' },
  sessionId: TASK_SESSION,
  message: 'Only authorized text',
  client: 'matrix',
  roomId: '!main:example.org',
  requestId: 'request',
  taskRunId: 'task-run',
  executionProfile: 'supplied-context-markdown',
};

interface SessionRow {
  sessionId: string;
  title: string;
  lastUpdatedAt: string;
}

/**
 * A `UserOracleDO` without its constructor: the real prototype (prepareTurn,
 * runAttempt, afterTurn, createSession, scheduleHistoryIndexing) over
 * recording fakes. Every service a restricted turn must not reach throws.
 */
function restrictedObject(
  opts: {
    env?: Record<string, unknown>;
    withScheduler?: boolean;
    sessions?: SessionRow[];
    /** Runs while the turn is prepared (inside the awaited context-window lookup). */
    duringPrepare?: () => void;
    plugins?: OraclePlugin[];
    /** The turn model; default a fake that keeps no call record. */
    model?: () => FakeListChatModel;
  } = {},
) {
  const forbidden = vi.fn((): never => {
    throw new Error('Unapproved enrichment');
  });
  const core = createRuntimeCore({
    config: { name: 'Test', org: 'Test', description: 'Test' },
    plugins: opts.plugins ?? [],
    env: makeEnv(),
  });
  const platformGet = vi.spyOn(core.llm, 'get');
  const models: FakeListChatModel[] = [];
  const llmGet = vi.fn((_role: ModelRole, _params?: unknown) => {
    // A second response so a call moves the model's cursor (`i`) off 0.
    const model =
      opts.model?.() ??
      new FakeListChatModel({ responses: ['# Brief', '# Again'] });
    models.push(model);
    return model;
  });
  const ambient = createNoopAmbient({
    config: core.validatedEnv,
    identity: core.identity,
    availablePlugins: core.availablePlugins,
    llm: { get: llmGet },
  });
  const rows = new Map(
    (opts.sessions ?? []).map((row) => [row.sessionId, row]),
  );
  const sessions = {
    getSession: vi.fn(async (id: string) => rows.get(id)),
    createSession: vi.fn(async (input: { sessionId: string }) => {
      const row = {
        sessionId: input.sessionId,
        title: UNTITLED_SESSION,
        lastUpdatedAt: new Date().toISOString(),
      };
      rows.set(row.sessionId, row);
      return row;
    }),
    touchSession: vi.fn(async () => undefined),
    setTitle: vi.fn(async () => true),
    listSessions: vi.fn(
      async (
        _roomId: string | undefined,
        limit: number,
        offset: number,
        excludeIdPrefix?: string,
      ) => {
        const listed = [...rows.values()]
          .filter(
            (row) =>
              !excludeIdPrefix || !row.sessionId.startsWith(excludeIdPrefix),
          )
          .sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt));
        return {
          sessions: listed.slice(offset, offset + limit),
          total: listed.length,
        };
      },
    ),
  };
  const scheduler = {
    assertTurnProfile: vi.fn(async () => {}),
    isRestrictedSession: vi.fn(async (id: string) => id === TASK_SESSION),
  };
  const indexed = vi.fn(async (_sessionId: string) => {});
  const runStore = { update: vi.fn(async () => {}) };
  /** Work the object kept alive (`ctx.waitUntil`): the background hooks. */
  const background: Promise<unknown>[] = [];
  const Oracle = createUserOracleDO({
    core: () => core,
    hooks: { getRoomTitle: forbidden, safetyModel: forbidden },
  });
  const host: object = Object.create(Oracle.prototype);
  Object.defineProperty(host, 'gateway', { get: forbidden });
  Object.assign(host, {
    env: opts.env ?? {},
    ctx: {
      waitUntil: vi.fn((work: Promise<unknown>) => background.push(work)),
    },
    userDid: 'did:ixo:owner',
    ambient,
    saver: Object.assign(new MemorySaver(), {
      getTupleWithoutMessages: async () => undefined,
    }),
    sessions,
    taskScheduler: opts.withScheduler === false ? null : scheduler,
    contextWindows: {
      resolve: async () => {
        opts.duringPrepare?.();
        return {
          model: 'test',
          tokens: 100000,
          origin: 'default',
        };
      },
    },
    aborts: new Map(),
    shadowRoutes: new Map(),
    delegations: new Map(),
    historySnapshots: new Map(),
    toolScheduler: new ToolScheduler(),
    runStore,
    runs: { touchKeepAlive: vi.fn() },
    events: { register: vi.fn(), unregister: vi.fn(), emitToTaps: vi.fn() },
    historyIndexer: { process: indexed },
    preferences: { get: forbidden },
    capabilityRouter: forbidden,
    attachmentViewSurface: forbidden,
    sandboxArchiveConfig: forbidden,
    ready: vi.fn(async () => {}),
    markDirty: vi.fn(),
  });
  const call = async (method: string, ...args: unknown[]): Promise<unknown> =>
    Reflect.apply(Reflect.get(host, method), host, args);
  return {
    call,
    forbidden,
    llmGet,
    models,
    platformGet,
    sessions,
    scheduler,
    indexed,
    runStore,
    /** Settle every background job so far (and those they start). */
    settle: async () => {
      for (let i = 0; i < background.length; i += 1) await background[i];
    },
  };
}

function attempt(resumed: boolean) {
  return {
    runId: 'run',
    abortController: new AbortController(),
    resumed,
    continuation: null,
    modelCalls: new TurnModelCalls(),
    reportCall: () => undefined,
  };
}

describe('supplied-context turn preparation', () => {
  it.each([false, true])(
    'skips external context and tracing and keeps the model budget (resumed=%s)',
    async (resumed) => {
      const o = restrictedObject({
        // Global tracing on: a restricted turn still gets no tracer.
        env: { LANGSMITH_API_KEY: 'test-key', LANGSMITH_TRACING: 'true' },
      });
      const prepared = await o.call(
        'prepareTurn',
        taskRequest,
        { message: taskRequest.message },
        attempt(resumed),
      );
      if (typeof prepared !== 'object' || prepared === null)
        throw new Error('prepareTurn returned no turn');
      await o.call(
        'runTurnDisposables',
        Reflect.get(prepared, 'turnDisposables'),
      );
      expect(prepared).toMatchObject({ config: { metadata: {} } });
      expect(prepared).not.toMatchObject({
        config: {
          callbacks: expect.arrayContaining([expect.any(LangChainTracer)]),
        },
      });
      expect(o.forbidden).not.toHaveBeenCalled();
      expect(o.scheduler.assertTurnProfile).toHaveBeenCalledWith(taskRequest);
    },
  );

  it('refuses a restricted turn when the object has no task scheduler', async () => {
    const o = restrictedObject({ withScheduler: false });
    await expect(
      o.call(
        'prepareTurn',
        taskRequest,
        { message: taskRequest.message },
        attempt(false),
      ),
    ).rejects.toThrow('Task scheduler unavailable');
  });
});

describe('a complete supplied-context run', () => {
  it('uses only the metered turn model and leaves no title, memory, trace or room trail', async () => {
    const o = restrictedObject();
    const live = {
      runId: 'run',
      sessionId: TASK_SESSION,
      requestId: taskRequest.requestId,
      record: { request: JSON.stringify(storedRunRequest(taskRequest)) },
      buffer: { isClosed: false, push: vi.fn() },
      abort: new AbortController(),
      continuation: null,
    };
    const outcome = await o.call('runAttempt', live, false);
    expect(outcome).toMatchObject({ status: 'finished', text: '# Brief' });
    // The only model is the turn's own `main` model from the (metered)
    // ambient adapter — never the platform adapter, never `session-title`.
    expect(o.llmGet.mock.calls.map(([role]) => role)).toEqual(['main']);
    expect(o.platformGet).not.toHaveBeenCalled();
    expect(o.sessions.setTitle).not.toHaveBeenCalled();
    expect(o.scheduler.isRestrictedSession).toHaveBeenCalledWith(TASK_SESSION);
    // No memory-engine indexing, no gateway (room) traffic, no enrichment.
    expect(o.indexed).not.toHaveBeenCalled();
    expect(o.forbidden).not.toHaveBeenCalled();
    // The turn budget charged the one model call, reported with the
    // outcome (written with the run's terminal status, no row update).
    expect(outcome).toMatchObject({
      usage: expect.stringContaining('"modelCalls":1'),
    });
    expect(
      o.runStore.update.mock.calls.some((call: unknown[]) =>
        JSON.stringify(call).includes('usage'),
      ),
    ).toBe(false);
  });
});

describe('a turn a gate restricted to the person’s own provider', () => {
  it('fails before any model is built when it would not run on the person’s provider', async () => {
    const usages: TurnModelUsage[] = [];
    const o = restrictedObject({
      plugins: [
        makePlugin({
          name: 'meter',
          onTurnUsage: (usage) => {
            usages.push(usage);
          },
        }),
      ],
    });
    const restricted: TurnRequest = { ...taskRequest, platformModels: 'deny' };
    const live = {
      runId: 'run',
      sessionId: TASK_SESSION,
      requestId: restricted.requestId,
      record: { request: JSON.stringify(storedRunRequest(restricted)) },
      buffer: { isClosed: false, push: vi.fn() },
      abort: new AbortController(),
      continuation: null,
    };
    await expect(o.call('runAttempt', live, false)).rejects.toBeInstanceOf(
      PlatformModelsDeniedError,
    );
    expect(o.llmGet).not.toHaveBeenCalled();
    expect(o.platformGet).not.toHaveBeenCalled();
    await o.settle();
    // No call was made and the agent was never built: no usage report.
    expect(usages).toEqual([]);
  });
});

/** A turn model that keeps a call record, like the platform model. */
const RECORD: ModelCallRecord = {
  role: 'main',
  paidBy: 'platform',
  requestedModel: 'openai/gpt-5.6-luna',
  fallback: false,
  modelFallback: false,
  providerFallback: false,
  promptTokens: 120,
  outputTokens: 8,
  costUsd: 0.0007,
  durationMs: 15,
  ok: true,
};

class RecordedModel extends FakeListChatModel {
  // The fake's own `bindTools` builds a plain `FakeListChatModel`; keep this
  // one, as the platform model's `bindTools` does.
  override bindTools(): ReturnType<FakeListChatModel['bindTools']> {
    return this.withConfig({});
  }

  override async *_streamResponseChunks(
    ...args: Parameters<FakeListChatModel['_streamResponseChunks']>
  ): AsyncGenerator<ChatGenerationChunk> {
    yield* super._streamResponseChunks(...args);
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({
        content: '',
        response_metadata: { [MODEL_CALL_METADATA_KEY]: RECORD },
      }),
    });
  }
}

describe('model-call reports of a run', () => {
  it('hands each call to onModelCall once, then the attempt to onTurnUsage with the same calls', async () => {
    const order: string[] = [];
    const calls: ModelCallReport[] = [];
    const usages: TurnModelUsage[] = [];
    const o = restrictedObject({
      model: () => new RecordedModel({ responses: ['# Brief'] }),
      plugins: [
        makePlugin({
          name: 'meter',
          onModelCall: async (call, ctx) => {
            // Delivered in the background: the turn does not wait for it.
            await new Promise((resolve) => setTimeout(resolve, 20));
            order.push('call');
            calls.push(call);
            expect(ctx.user.did).toBe('did:ixo:owner');
            expect(ctx.session.requestId).toBe(taskRequest.requestId);
          },
          onTurnUsage: (usage, ctx) => {
            order.push('turn');
            usages.push(usage);
            expect(ctx.session.runId).toBe('run');
          },
        }),
      ],
    });
    const live = {
      runId: 'run',
      sessionId: TASK_SESSION,
      requestId: taskRequest.requestId,
      record: { request: JSON.stringify(storedRunRequest(taskRequest)) },
      buffer: { isClosed: false, push: vi.fn() },
      abort: new AbortController(),
      continuation: null,
    };
    expect(await o.call('runAttempt', live, false)).toMatchObject({
      status: 'finished',
    });
    await o.settle();
    expect(order).toEqual(['call', 'turn']);
    expect(calls).toEqual([
      {
        ...RECORD,
        purpose: 'reply',
        callId: expect.any(String),
        startedAt: expect.any(Number),
      },
    ]);
    expect(usages).toEqual([
      {
        requestId: taskRequest.requestId,
        runId: 'run',
        sessionId: TASK_SESSION,
        status: 'finished',
        calls,
        platformCostUsd: 0.0007,
        unpricedPlatformCalls: 0,
      },
    ]);
  });
});

describe('LangChain tracing switches in process.env', () => {
  // workerd fills `process.env` from the Worker's vars and secrets.
  const ENV = {
    LANGSMITH_TRACING: 'true',
    LANGCHAIN_TRACING: 'true',
    LANGSMITH_TRACING_V2: 'true',
    LANGCHAIN_TRACING_V2: 'true',
    LANGSMITH_API_KEY: 'env-key',
    LANGSMITH_TRACED_DIDS: 'did:ixo:someone-else',
  };
  const tracerNames = (manager: CallbackManager | undefined): string[] =>
    (manager?.handlers ?? [])
      .map((handler) => handler.name)
      .filter((name) => name === 'langchain_tracer');

  it('are removed, so neither a restricted turn nor an unlisted user’s turn is traced', async () => {
    Object.assign(process.env, ENV);
    // What reached LangSmith's default endpoint (its `/info` answers `{}`,
    // so uploads are not gzipped).
    const uploaded: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.includes('smith.langchain.com'))
          uploaded.push(await request.text());
        return Response.json({});
      },
    );
    const sent = (text: string) => uploaded.some((body) => body.includes(text));
    try {
      // What the switches do: core attaches its own tracer to a run that
      // carries none, and it uploads.
      expect(tracerNames(CallbackManager.configure())).toEqual([
        'langchain_tracer',
      ]);
      await new FakeListChatModel({ responses: ['control-reply'] }).invoke(
        'hi',
      );
      await vi.waitFor(() => expect(sent('control-reply')).toBe(true), {
        timeout: 5_000,
      });

      removeLangChainTracingSwitches();
      for (const name of LANGCHAIN_TRACING_SWITCHES)
        expect(process.env[name]).toBeUndefined();
      expect(tracerNames(CallbackManager.configure())).toEqual([]);

      // A restricted turn, start to finish.
      const o = restrictedObject();
      const outcome = await o.call(
        'runAttempt',
        {
          runId: 'run',
          sessionId: TASK_SESSION,
          requestId: taskRequest.requestId,
          record: { request: JSON.stringify(storedRunRequest(taskRequest)) },
          buffer: { isClosed: false, push: vi.fn() },
          abort: new AbortController(),
          continuation: null,
        },
        false,
      );
      expect(outcome).toMatchObject({ status: 'finished' });
      // A turn of a user the allowlist does not name, on an oracle that
      // traces selectively (its `LANGSMITH_TRACING` is not set; a switch the
      // runtime does not read is): the runtime attaches no tracer, and
      // nothing else does.
      const tracing = resolveLangsmithTracing({
        userDid: 'did:ixo:owner',
        client: 'portal',
        env: langsmithEnvFromWorkerEnv({
          LANGSMITH_API_KEY: ENV.LANGSMITH_API_KEY,
          LANGSMITH_TRACED_DIDS: ENV.LANGSMITH_TRACED_DIDS,
          LANGCHAIN_TRACING_V2: 'true',
        }),
      });
      expect(tracing.callbacks).toBeUndefined();
      await new FakeListChatModel({ responses: ['unlisted-reply'] }).invoke(
        'hi',
        { metadata: tracing.metadata },
      );
      // Longer than the tracing client's batch timer, which sent the
      // control run above.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(sent('# Brief')).toBe(false);
      expect(sent('Only authorized text')).toBe(false);
      expect(sent('unlisted-reply')).toBe(false);
    } finally {
      for (const name of Object.keys(ENV)) delete process.env[name];
      vi.unstubAllGlobals();
    }
  });
});

describe('a supplied-context run cancelled while it is prepared', () => {
  it('never calls the model when the abort lands after the profile check', async () => {
    const abort = new AbortController();
    // A task cancel arriving while the turn awaits its preparation I/O:
    // the profile check already passed, the run's signal is aborted.
    const o = restrictedObject({ duringPrepare: () => abort.abort() });
    const live = {
      runId: 'run',
      sessionId: TASK_SESSION,
      requestId: taskRequest.requestId,
      record: { request: JSON.stringify(storedRunRequest(taskRequest)) },
      buffer: { isClosed: false, push: vi.fn() },
      abort,
      continuation: null,
    };
    const outcome = await o.call('runAttempt', live, false);
    expect(o.scheduler.assertTurnProfile).toHaveBeenCalledWith(taskRequest);
    expect(outcome).toMatchObject({ status: 'aborted', text: '' });
    expect(o.models.map((model) => model.i)).toEqual(o.models.map(() => 0));
    expect(live.buffer.push).toHaveBeenCalledWith('done', {
      runId: 'run',
      aborted: true,
    });
  });
});

describe('session-history indexing around task runs', () => {
  it('indexes the latest conversation, never a task-run session', async () => {
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const o = restrictedObject({
      sessions: [
        { sessionId: 's_chat', title: 'Chat', lastUpdatedAt: earlier },
        {
          sessionId: TASK_SESSION,
          title: UNTITLED_SESSION,
          lastUpdatedAt: new Date().toISOString(),
        },
      ],
    });
    await o.call('createSession', taskRequest.identity, {
      sessionId: 's_new',
      roomId: '!main:example.org',
    });
    expect(o.indexed.mock.calls).toEqual([['s_chat']]);
    // The realtime drain and session deletion go through the same gate.
    await o.call('scheduleHistoryIndexing', TASK_SESSION);
    expect(o.indexed.mock.calls).toEqual([['s_chat']]);
  });
});

describe('task Start alarm persistence', () => {
  it('returns the production storage promise and propagates a failed arm', async () => {
    const core = createRuntimeCore({
      config: { name: 'Test', org: 'Test', description: 'Test' },
      plugins: [],
      env: makeEnv(),
    });
    const Oracle = createUserOracleDO({ core: () => core });
    const arm = Reflect.get(Oracle.prototype, 'requestAlarm');
    let release: (() => void) | undefined;
    const storage = {
      getAlarm: vi.fn(async () => null),
      setAlarm: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const host = { ctx: { storage }, alarmArm: Promise.resolve() };
    const pending = Reflect.apply(arm, host, [123]);
    if (!(pending instanceof Promise))
      throw new Error('Alarm arm must be awaitable');
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await expect.poll(() => storage.setAlarm.mock.calls.length).toBe(1);
    expect(resolved).toBe(false);
    release?.();
    await pending;
    expect(resolved).toBe(true);
    storage.setAlarm.mockRejectedValueOnce(new Error('Storage failed'));
    await expect(Reflect.apply(arm, host, [123])).rejects.toThrow(
      'Storage failed',
    );
  });
  it('serializes concurrent arms so a later deadline cannot overwrite Start', async () => {
    const core = createRuntimeCore({
      config: { name: 'Test', org: 'Test', description: 'Test' },
      plugins: [],
      env: makeEnv(),
    });
    const Oracle = createUserOracleDO({ core: () => core });
    const arm = Reflect.get(Oracle.prototype, 'requestAlarm');
    let existing: number | null = null;
    const storage = {
      getAlarm: vi.fn(async () => existing),
      setAlarm: vi.fn(async (at: number) => {
        await Promise.resolve();
        existing = at;
      }),
    };
    const host = { ctx: { storage }, alarmArm: Promise.resolve() };
    await Promise.all([
      Reflect.apply(arm, host, [100]),
      Reflect.apply(arm, host, [200]),
    ]);
    expect(existing).toBe(100);
    expect(storage.setAlarm.mock.calls).toEqual([[100]]);
    storage.setAlarm.mockRejectedValueOnce(new Error('Storage failed'));
    await expect(Reflect.apply(arm, host, [50])).rejects.toThrow(
      'Storage failed',
    );
    await Reflect.apply(arm, host, [50]);
    expect(existing).toBe(50);
  });
});
