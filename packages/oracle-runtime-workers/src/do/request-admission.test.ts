import { env, runInDurableObject } from 'cloudflare:test';
import { HumanMessage } from '@langchain/core/messages';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../core';
import { makeEnv, makePlugin } from '../core/test-fixtures';
import { DoSqliteDatabase } from '../sqlite/database';
import { SqliteSaver } from '../sqlite/sqlite-saver';
import { SessionsStore } from '../sqlite/sessions-store';
import { createUserOracleDO } from './user-oracle-do';
import { RunStore, type RunDurabilityConfig } from './run-store';
import { RunBuffer, type RunFrame } from './run-buffer';
import {
  RunCoordinator,
  type LiveRun,
  type RunOutcome,
} from './run-coordinator';
import { storedRunRequest } from './run-request';
import { SessionEventRouter } from './ambient';
import type { TurnRequest } from './contracts';
import type { DeliveryProfile } from '../delivery/types';
import type { OraclePlugin } from '../plugin-api/oracle-plugin';
import type { RequestDisposition } from '../plugin-api/request-admission';

async function call(
  object: object,
  name: string,
  ...args: unknown[]
): Promise<unknown> {
  const method: unknown = Reflect.get(object, name);
  if (typeof method !== 'function')
    throw new Error(`Missing host method ${name}`);
  return Reflect.apply(method, object, args);
}

describe('UserOracleDO pre-agent admission', () => {
  it.each([
    { priorCount: 0, client: 'portal' as const },
    { priorCount: 25, client: 'portal' as const },
    { priorCount: 0, client: 'matrix' as const },
  ])(
    'persists and recovers direct reads for $client with $priorCount prior messages and no generative preparation',
    async ({ priorCount, client }) => {
      const stub = env.SQLITE_TEST.get(
        env.SQLITE_TEST.idFromName(`admission-${client}-${priorCount}`),
      );
      await runInDurableObject(stub, async (_instance, state) => {
        const db = await DoSqliteDatabase.open(state, 'admission.db');
        const saver = new SqliteSaver(db);
        const sessions = new SessionsStore(db);
        const runStore = new RunStore(db);
        const admission = vi.fn(async () => ({
          kind: 'handled' as const,
          text: 'Flow is waiting.',
          title: 'Flow status',
        }));
        const core = createRuntimeCore({
          config: { name: 'Test' },
          env: makeEnv(),
          plugins: [
            makePlugin({ name: 'status', getRequestAdmission: admission }),
          ],
        });
        const UserOracleDO = createUserOracleDO({ core: () => core });
        const host: object = Object.create(UserOracleDO.prototype);
        const forbidden = vi.fn(() => {
          throw new Error('Generative preparation forbidden');
        });
        Object.assign(host, {
          db,
          saver,
          sessions,
          runStore,
          ctx: state,
          env: { ORACLE_DID: 'did:ixo:test' },
          prepareTurn: forbidden,
          generateTitle: forbidden,
          compareShadowRoute: forbidden,
          markDirty: () => undefined,
        });
        const sessionId = `local-${priorCount}`;
        if (client === 'portal')
          await sessions.createSession({
            sessionId,
            oracleName: 'Test',
            oracleDid: 'did:ixo:test',
            oracleEntityDid: 'did:ixo:test',
          });
        if (priorCount) {
          const checkpoint = emptyCheckpoint();
          checkpoint.channel_values.messages = Array.from(
            { length: priorCount },
            (_, n) =>
              new HumanMessage({ id: `prior-${n}`, content: 'x'.repeat(8000) }),
          );
          await saver.put(
            { configurable: { thread_id: sessionId } },
            checkpoint,
            { source: 'update', step: 1, parents: {} },
          );
        }
        const req: TurnRequest = {
          sessionId,
          requestId: 'request',
          client,
          message: '/status',
          identity: { userDid: 'did:ixo:alice' },
        };
        await runStore.create({
          runId: 'run',
          sessionId,
          requestId: req.requestId,
          client,
          status: 'running',
          request: JSON.stringify(storedRunRequest(req)),
          checkpointId: null,
          instanceId: 'test',
        });
        const record = await runStore.get('run');
        if (!record) throw new Error('Missing run');
        const makeBuffer = () =>
          new RunBuffer({
            flushMs: 60000,
            flushBytes: 100000,
            onPack: () => undefined,
          });
        const live: LiveRun = {
          runId: 'run',
          sessionId,
          requestId: req.requestId,
          record,
          buffer: makeBuffer(),
          abort: new AbortController(),
          continuation: null,
          done: Promise.resolve({ status: 'finished', text: '' }),
          resolve: () => undefined,
          attemptInFlight: true,
        };
        expect(await call(host, 'runAttempt', live, false)).toMatchObject({
          status: 'finished',
          text: 'Flow is waiting.',
          toolCalls: [],
        });
        expect(await saver.listThreadMessages(sessionId)).toHaveLength(
          priorCount + 2,
        );
        expect((await sessions.getSession(sessionId))?.title).toBe(
          'Flow status',
        );
        expect(live.buffer.tailAfter(0).map((frame) => frame.event)).toEqual([
          'run',
          'message',
          'done',
        ]);
        const persisted = await runStore.get('run');
        if (!persisted) throw new Error('Missing persisted run');
        expect(JSON.parse(persisted.request).disposition.kind).toBe(
          'direct-read',
        );
        await live.buffer.close();
        const recovered: LiveRun = {
          ...live,
          record: persisted,
          buffer: makeBuffer(),
          continuation: 'Flow is waiting.',
        };
        expect(await call(host, 'runAttempt', recovered, true)).toMatchObject({
          status: 'finished',
          text: 'Flow is waiting.',
        });
        expect(
          recovered.buffer.tailAfter(0).map((frame) => frame.event),
        ).toEqual(['done']);
        expect(await saver.listThreadMessages(sessionId)).toHaveLength(
          priorCount + 2,
        );
        expect(admission).toHaveBeenCalledTimes(1);
        expect(forbidden).not.toHaveBeenCalled();
        await recovered.buffer.close();
        await db.close();
      });
    },
  );
});

const RUN_CONFIG: RunDurabilityConfig = {
  keepAliveMs: 20_000,
  segmentFlushMs: 60_000,
  segmentBytes: 100_000,
  recoveryAttempts: 4,
  recoveryDelaysMs: [5_000, 15_000, 30_000, 60_000],
  multitaskDefault: 'interrupt',
};

interface AdmissionHost {
  host: object;
  saver: SqliteSaver;
  runStore: RunStore;
  prepareTurn: ReturnType<typeof vi.fn>;
  streamed: unknown[];
}

/**
 * A `UserOracleDO` with its stores on a real DO database and the agent
 * build replaced by a stub that records the graph input it is handed.
 */
async function withAdmissionHost(
  name: string,
  admission: OraclePlugin['getRequestAdmission'],
  body: (setup: AdmissionHost) => Promise<void>,
): Promise<void> {
  const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const db = await DoSqliteDatabase.open(state, 'admission.db');
    const saver = new SqliteSaver(db);
    const sessions = new SessionsStore(db);
    const runStore = new RunStore(db);
    await runStore.setup();
    const core = createRuntimeCore({
      config: { name: 'Test' },
      env: makeEnv(),
      plugins: [makePlugin({ name: 'status', getRequestAdmission: admission })],
    });
    const UserOracleDO = createUserOracleDO({ core: () => core });
    const host: object = Object.create(UserOracleDO.prototype);
    const streamed: unknown[] = [];
    const prepareTurn = vi.fn(async () => ({
      agent: {
        streamEvents: (input: unknown): AsyncIterable<never> => {
          streamed.push(input);
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => ({ done: true, value: undefined }),
            }),
          };
        },
      },
      stateInput: { messages: [new HumanMessage('agent input')] },
      config: {},
      turnDisposables: new Set<() => void>(),
      byoNotice: undefined,
      byoProvider: undefined,
      toolOutputCapChars: 10_000,
      delivery: { kind: 'stream' } satisfies DeliveryProfile,
      usage: () => '{"tokens":0}',
    }));
    Object.assign(host, {
      db,
      saver,
      sessions,
      runStore,
      ctx: state,
      env: { ORACLE_DID: 'did:ixo:test' },
      events: new SessionEventRouter(),
      aborts: new Map<string, AbortController>(),
      prepareTurn,
      afterTurn: async () => undefined,
      markDirty: () => undefined,
    });
    try {
      await body({ host, saver, runStore, prepareTurn, streamed });
    } finally {
      await db.close();
    }
  });
}

function turn(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    sessionId: 'local-session',
    requestId: 'request',
    client: 'portal',
    message: '/status',
    identity: { userDid: 'did:ixo:alice' },
    ...overrides,
  };
}

/** Start a run through the real coordinator; collect its frames and outcome. */
async function runThroughCoordinator(
  setup: AdmissionHost,
  req: TurnRequest,
  onStarted?: (runs: RunCoordinator) => void,
) {
  const frames: RunFrame[] = [];
  const runs = new RunCoordinator({
    store: setup.runStore,
    config: RUN_CONFIG,
    instanceId: 'test',
    log: {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    requestAlarm: () => undefined,
    runAttempt: (live, resumed) => {
      live.buffer.subscribe((frame) => frames.push(frame));
      onStarted?.(runs);
      return call(
        setup.host,
        'runAttempt',
        live,
        resumed,
      ) as Promise<RunOutcome>;
    },
    checkpointIdOf: async () => null,
  });
  const { live } = await runs.begin({
    runId: 'run',
    sessionId: req.sessionId,
    requestId: req.requestId,
    client: req.client,
    request: JSON.stringify(storedRunRequest(req)),
    multitask: 'interrupt',
  });
  const outcome = await live.done;
  const record = await setup.runStore.get('run');
  return { frames, outcome, record };
}

describe('UserOracleDO admission failures', () => {
  it('ends a refused admission with error and done frames and a redacted stored error', async () => {
    await withAdmissionHost(
      'admission-refused',
      () => {
        throw new Error('denied: flow 42 belongs to did:ixo:bob');
      },
      async (setup) => {
        const { frames, outcome, record } = await runThroughCoordinator(
          setup,
          turn(),
        );
        expect(frames.map((f) => f.event)).toEqual(['run', 'error', 'done']);
        const error = frames[1]!.data as Record<string, unknown>;
        expect(error).toMatchObject({
          kind: 'request_admission',
          source: 'platform',
          retryable: true,
          requestId: 'request',
        });
        expect(JSON.stringify(frames)).not.toContain('did:ixo:bob');
        expect(frames[2]!.data).toMatchObject({ runId: 'run', failed: true });
        expect(outcome.status).toBe('failed');
        expect(record?.status).toBe('failed');
        expect(record?.error).toBe('request admission failed');
        expect(await setup.saver.listThreadMessages('local-session')).toEqual(
          [],
        );
        expect(setup.prepareTurn).not.toHaveBeenCalled();
      },
    );
  });

  it('ends an invalid direct-read answer as a failed run without a transcript', async () => {
    await withAdmissionHost(
      'admission-invalid',
      () => ({ kind: 'handled', text: '   ', title: 'Status' }),
      async (setup) => {
        const { frames, record } = await runThroughCoordinator(setup, turn());
        expect(frames.map((f) => f.event)).toEqual(['run', 'error', 'done']);
        expect(record?.status).toBe('failed');
        expect(await setup.saver.listThreadMessages('local-session')).toEqual(
          [],
        );
        expect(setup.prepareTurn).not.toHaveBeenCalled();
      },
    );
  });

  it('ends a run aborted during admission as aborted', async () => {
    let started!: () => void;
    const admitting = new Promise<void>((resolve) => {
      started = resolve;
    });
    await withAdmissionHost(
      'admission-aborted',
      (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
          started();
        }),
      async (setup) => {
        const { frames, outcome, record } = await runThroughCoordinator(
          setup,
          turn(),
          (runs) => {
            void admitting.then(() => runs.abortSession('local-session'));
          },
        );
        expect(frames.map((f) => f.event)).toEqual(['run', 'done']);
        expect(frames[1]!.data).toMatchObject({ runId: 'run', aborted: true });
        expect(outcome.status).toBe('aborted');
        expect(record?.status).toBe('aborted');
        expect(await setup.saver.listThreadMessages('local-session')).toEqual(
          [],
        );
      },
    );
  });
});

describe('UserOracleDO admission scope', () => {
  it.each([
    {
      label: 'a Matrix group-room turn',
      req: turn({
        client: 'matrix',
        sessionId: '$thread',
        roomId: '!group:example',
        roomKind: 'group',
      }),
    },
    {
      label: 'a scheduled task run',
      req: turn({
        client: 'matrix',
        sessionId: 'task:daily',
        taskRunId: 'task-run-1',
      }),
    },
  ])('never offers $label to admission handlers', async ({ req }) => {
    const admission = vi.fn(() => ({
      kind: 'handled' as const,
      text: 'Private status',
      title: 'Status',
    }));
    await withAdmissionHost(
      `admission-scope-${req.sessionId}`,
      admission,
      async (setup) => {
        const { frames, record } = await runThroughCoordinator(setup, req);
        expect(admission).not.toHaveBeenCalled();
        expect(setup.prepareTurn).toHaveBeenCalledTimes(1);
        expect(record?.status).toBe('finished');
        expect(
          frames.some((f) => JSON.stringify(f.data).includes('Private status')),
        ).toBe(false);
        expect(JSON.parse(record!.request).disposition).toEqual({
          kind: 'agent',
        });
      },
    );
  });
});

describe('UserOracleDO admission recovery', () => {
  async function recover(
    setup: AdmissionHost,
    disposition: RequestDisposition,
  ): Promise<void> {
    const req = turn({
      attachments: [
        {
          mxcUri: 'mxc://example/a',
          filename: 'a.txt',
          mimetype: 'text/plain',
        },
      ],
    });
    await setup.runStore.create({
      runId: 'run',
      sessionId: req.sessionId,
      requestId: req.requestId,
      client: req.client,
      status: 'running',
      request: JSON.stringify({ ...storedRunRequest(req), disposition }),
      checkpointId: null,
      instanceId: 'test',
    });
    const record = await setup.runStore.get('run');
    if (!record) throw new Error('Missing run');
    const live: LiveRun = {
      runId: 'run',
      sessionId: req.sessionId,
      requestId: req.requestId,
      record,
      buffer: new RunBuffer({
        flushMs: 60_000,
        flushBytes: 100_000,
        onPack: () => undefined,
      }),
      abort: new AbortController(),
      continuation: null,
      done: Promise.resolve({ status: 'finished', text: '' }),
      resolve: () => undefined,
      attemptInFlight: true,
    };
    await call(setup.host, 'runAttempt', live, true);
    await live.buffer.close();
  }

  it('runs the agent with its input when a reset interrupted admission', async () => {
    await withAdmissionHost(
      'admission-recover-admitting',
      () => ({ kind: 'pass' }),
      async (setup) => {
        await recover(setup, { kind: 'admitting' });
        expect(setup.streamed).toHaveLength(1);
        expect(setup.streamed[0]).not.toBeNull();
        const [, body, run] = setup.prepareTurn.mock.calls[0] as [
          unknown,
          { attachments?: unknown[] },
          { resumed: boolean; continuation: string | null },
        ];
        expect(body.attachments).toHaveLength(1);
        expect(run).toMatchObject({ resumed: false, continuation: null });
      },
    );
  });

  it('continues the agent from its checkpoint when admission had completed', async () => {
    await withAdmissionHost(
      'admission-recover-agent',
      () => ({ kind: 'pass' }),
      async (setup) => {
        await recover(setup, { kind: 'agent' });
        expect(setup.streamed).toEqual([null]);
        const [, body, run] = setup.prepareTurn.mock.calls[0] as [
          unknown,
          { attachments?: unknown[] },
          { resumed: boolean },
        ];
        expect(body.attachments).toBeUndefined();
        expect(run.resumed).toBe(true);
      },
    );
  });
});

describe('UserOracleDO run rows without an admission handler', () => {
  it('records an agent turn at once and never rewrites its request', async () => {
    await withAdmissionHost('admission-none', undefined, async (setup) => {
      const req = turn();
      const request = await call(
        setup.host,
        'runRequestJson',
        req,
        storedRunRequest(req),
      );
      if (typeof request !== 'string') throw new Error('no request JSON');
      expect(JSON.parse(request).disposition).toEqual({ kind: 'agent' });
      await setup.runStore.create({
        runId: 'run',
        sessionId: req.sessionId,
        requestId: req.requestId,
        client: req.client,
        status: 'running',
        request,
        checkpointId: null,
        instanceId: 'test',
      });
      const record = await setup.runStore.get('run');
      if (!record) throw new Error('Missing run');
      const update = vi.spyOn(setup.runStore, 'update');
      const live: LiveRun = {
        runId: 'run',
        sessionId: req.sessionId,
        requestId: req.requestId,
        record,
        buffer: new RunBuffer({
          flushMs: 60_000,
          flushBytes: 100_000,
          onPack: () => undefined,
        }),
        abort: new AbortController(),
        continuation: null,
        done: Promise.resolve({ status: 'finished', text: '' }),
        resolve: () => undefined,
        attemptInFlight: true,
      };
      await call(setup.host, 'runAttempt', live, false);
      await live.buffer.close();
      expect(update).not.toHaveBeenCalled();
      // A fresh attempt runs the agent with the user's message.
      expect(setup.streamed).toHaveLength(1);
      expect(setup.streamed[0]).not.toBeNull();
    });
  });

  it('keeps admission for a turn a declared handler may answer', async () => {
    await withAdmissionHost(
      'admission-declared',
      () => ({ kind: 'pass' }),
      async (setup) => {
        const portal = turn();
        const group = turn({
          client: 'matrix',
          sessionId: '$thread',
          roomKind: 'group',
        });
        const json = async (req: TurnRequest) =>
          JSON.parse(
            String(
              await call(
                setup.host,
                'runRequestJson',
                req,
                storedRunRequest(req),
              ),
            ),
          );
        expect((await json(portal)).disposition).toBeUndefined();
        expect((await json(group)).disposition).toEqual({ kind: 'agent' });
      },
    );
  });
});

describe('UserOracleDO direct reads and the room mirror', () => {
  it.each([
    { client: 'portal' as const, mirrored: 1 },
    { client: 'channel' as const, mirrored: 0 },
  ])(
    'a $client direct read is mirrored by the object $mirrored time(s)',
    async ({ client, mirrored }) => {
      await withAdmissionHost(
        `direct-read-mirror-${client}`,
        () => ({ kind: 'pass' }),
        async (setup) => {
          // The channel mirror is the required kind: its failure rejects.
          const replayToRoom = vi.fn(async (request: TurnRequest) => {
            if (request.client === 'channel')
              throw new Error('gateway unavailable');
          });
          Object.assign(setup.host, { replayToRoom });
          const req = turn({ client, sessionId: '$session' });
          await setup.runStore.create({
            runId: 'run',
            sessionId: req.sessionId,
            requestId: req.requestId,
            client,
            status: 'running',
            request: JSON.stringify(storedRunRequest(req)),
            checkpointId: null,
            instanceId: 'test',
          });
          const record = await setup.runStore.get('run');
          if (!record) throw new Error('Missing run');
          const live: LiveRun = {
            runId: 'run',
            sessionId: req.sessionId,
            requestId: req.requestId,
            record,
            buffer: new RunBuffer({
              flushMs: 60_000,
              flushBytes: 100_000,
              onPack: () => undefined,
            }),
            abort: new AbortController(),
            continuation: null,
            done: Promise.resolve({ status: 'finished', text: '' }),
            resolve: () => undefined,
            attemptInFlight: true,
          };
          const outcome = await call(
            setup.host,
            'runDirectRead',
            live,
            req,
            {
              kind: 'direct-read',
              text: 'Flow is waiting.',
              title: 'Flow status',
              messageId: 'direct:$session:request:ai',
            },
            () => undefined,
          );
          await live.buffer.close();
          expect(outcome).toMatchObject({ status: 'finished' });
          expect(replayToRoom).toHaveBeenCalledTimes(mirrored);
        },
      );
    },
  );
});
