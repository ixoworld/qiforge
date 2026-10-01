import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../core';
import { createNoopAmbient } from '../core/runtime-context';
import { makeEnv } from '../core/test-fixtures';
import { ToolScheduler } from '../core/tool-scheduler';
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
  } = {},
) {
  const forbidden = vi.fn((): never => {
    throw new Error('Unapproved enrichment');
  });
  const core = createRuntimeCore({
    config: { name: 'Test', org: 'Test', description: 'Test' },
    plugins: [],
    env: makeEnv(),
  });
  const platformGet = vi.spyOn(core.llm, 'get');
  const llmGet = vi.fn(
    (_role: ModelRole, _params?: unknown) =>
      new FakeListChatModel({ responses: ['# Brief'] }),
  );
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
  const Oracle = createUserOracleDO({
    core: () => core,
    hooks: { getRoomTitle: forbidden, safetyModel: forbidden },
  });
  const host: object = Object.create(Oracle.prototype);
  Object.defineProperty(host, 'gateway', { get: forbidden });
  Object.assign(host, {
    env: opts.env ?? {},
    ctx: { waitUntil: vi.fn() },
    userDid: 'did:ixo:owner',
    ambient,
    saver: Object.assign(new MemorySaver(), {
      getTupleWithoutMessages: async () => undefined,
    }),
    sessions,
    taskScheduler: opts.withScheduler === false ? null : scheduler,
    contextWindows: {
      resolve: async () => ({
        model: 'test',
        tokens: 100000,
        origin: 'default',
      }),
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
    retainAttachmentPayloads: vi.fn(async () => {}),
  });
  const call = async (method: string, ...args: unknown[]): Promise<unknown> =>
    Reflect.apply(Reflect.get(host, method), host, args);
  return {
    call,
    forbidden,
    llmGet,
    platformGet,
    sessions,
    scheduler,
    indexed,
    runStore,
  };
}

function attempt(resumed: boolean) {
  return {
    runId: 'run',
    abortController: new AbortController(),
    resumed,
    continuation: null,
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
    // The turn budget charged the one model call.
    expect(o.runStore.update).toHaveBeenCalledWith(
      'run',
      expect.objectContaining({
        usage: expect.stringContaining('"modelCalls":1'),
      }),
    );
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
