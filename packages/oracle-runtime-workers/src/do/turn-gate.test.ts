/**
 * The pre-turn gate on each way a turn reaches the user object: a refusal
 * answers the turn before a run, a stored message, a room mirror, a ledger
 * entry or a model call exists. (Channel requests: `src/channels/turns.test.ts`;
 * the Matrix notice: `src/matrix/gateway-do.test.ts`; task runs:
 * `src/tasks/scheduler.test.ts`; the policy: `src/core/turn-gate.test.ts`.)
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../core';
import { createNoopAmbient } from '../core/runtime-context';
import { makeEnv, makePlugin } from '../core/test-fixtures';
import { DoSqliteDatabase } from '../sqlite/database';
import { SessionsStore } from '../sqlite/sessions-store';
import { createUserOracleDO } from './user-oracle-do';
import type { TurnRequest, TurnResult } from './contracts';
import type { TurnGateContext, TurnGateResult } from '../plugin-api/turn-gate';

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

const TOP_UP = {
  status: 402,
  code: 'credits_exhausted',
  message: 'Top up to continue.',
  details: { topUpUrl: 'https://example.org/top-up' },
};

/**
 * A user object with a gating plugin and every step after the gate made
 * to fail the test if reached (`forbidden`), unless the gate allows.
 */
async function hostWith(
  state: DurableObjectState,
  answer: (ctx: TurnGateContext) => TurnGateResult | undefined,
) {
  const db = await DoSqliteDatabase.open(state, 'gate.db');
  const sessions = new SessionsStore(db);
  await sessions.createSession({
    sessionId: 'portal-session',
    oracleName: 'Test',
    oracleDid: 'did:ixo:test',
    oracleEntityDid: 'did:ixo:test',
  });
  const seen: TurnGateContext[] = [];
  const core = createRuntimeCore({
    config: { name: 'Test' },
    env: makeEnv(),
    plugins: [
      makePlugin({
        name: 'billing',
        gateTurn: (ctx) => {
          seen.push(ctx);
          return answer(ctx);
        },
      }),
    ],
  });
  const UserOracleDO = createUserOracleDO({ core: () => core });
  const host: object = Object.create(UserOracleDO.prototype);
  const reached = vi.fn((step: string) => {
    throw new Error(`reached ${step} after the gate`);
  });
  Object.assign(host, {
    db,
    sessions,
    ctx: state,
    env: { ORACLE_DID: 'did:ixo:test' },
    ambient: createNoopAmbient(),
    byo: null,
    ready: async () => undefined,
    turnDelegation: async () => ({ raw: '' }),
    replayToRoom: () => reached('the room mirror'),
    runs: { begin: () => reached('the run') },
    runTurnOnce: () => reached('the run'),
    roomTurnClaims: new Map(),
    matrixTurnRuns: new Map(),
    freshInvocations: { enter: async () => ({ end: () => undefined }) },
    matrixLedger: {
      get: async () => undefined,
      start: () => reached('the Matrix ledger'),
    },
  });
  return { host, seen, reached };
}

function portalRequest(body: Record<string, unknown>): Request {
  return new Request('https://user-object/turn/portal-session', {
    method: 'POST',
    headers: {
      'x-identity': JSON.stringify({ userDid: 'did:ixo:alice' }),
      'x-request-id': 'req-portal',
    },
    body: JSON.stringify(body),
  });
}

describe('UserOracleDO pre-turn gate', () => {
  it.each([{ stream: true }, { stream: false }])(
    'answers a refused Portal turn (stream=$stream) with the refusal, before the mirror or a run',
    async ({ stream }) => {
      const stub = env.SQLITE_TEST.get(
        env.SQLITE_TEST.idFromName(`gate-portal-${stream}`),
      );
      await runInDurableObject(stub, async (_instance, state) => {
        const { host, seen, reached } = await hostWith(state, () => ({
          refuse: TOP_UP,
        }));
        const response = (await call(
          host,
          'fetch',
          portalRequest({ message: 'hi', stream }),
        )) as Response;
        expect(response.status).toBe(402);
        expect(response.headers.get('content-type')).toContain(
          'application/json',
        );
        expect(await response.json()).toEqual({
          statusCode: 402,
          message: 'Top up to continue.',
          code: 'credits_exhausted',
          details: { topUpUrl: 'https://example.org/top-up' },
          requestId: 'req-portal',
          refused: true,
        });
        expect(reached).not.toHaveBeenCalled();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          trigger: 'portal',
          user: { did: 'did:ixo:alice' },
          session: {
            id: 'portal-session',
            client: 'portal',
            requestId: 'req-portal',
          },
          hasAttachments: false,
        });
        expect(await seen[0]!.hasByoCredentials()).toBe(false);
      });
    },
  );

  it.each([{ stream: true }, { stream: false }])(
    'carries the call to action and retry delay of a refused Portal turn (stream=$stream), with Retry-After',
    async ({ stream }) => {
      const stub = env.SQLITE_TEST.get(
        env.SQLITE_TEST.idFromName(`gate-portal-action-${stream}`),
      );
      await runInDurableObject(stub, async (_instance, state) => {
        const { host, reached } = await hostWith(state, () => ({
          refuse: {
            status: 402,
            code: 'insufficient_credits',
            message: "You're out of IXO credits. Top up to keep chatting.",
            details: {
              retryAfterSeconds: 3600,
              action: { label: 'Top up credits', url: 'https://p.example/c' },
            },
          },
        }));
        const response = (await call(
          host,
          'fetch',
          portalRequest({ message: 'hi', stream }),
        )) as Response;
        expect(response.status).toBe(402);
        expect(response.headers.get('retry-after')).toBe('3600');
        expect(await response.json()).toEqual({
          statusCode: 402,
          message: "You're out of IXO credits. Top up to keep chatting.",
          code: 'insufficient_credits',
          details: {
            retryAfterSeconds: 3600,
            action: { label: 'Top up credits', url: 'https://p.example/c' },
          },
          requestId: 'req-portal',
          refused: true,
        });
        expect(reached).not.toHaveBeenCalled();
      });
    },
  );

  it('lets an allowed Portal turn go on to its run', async () => {
    const stub = env.SQLITE_TEST.get(
      env.SQLITE_TEST.idFromName('gate-portal-ok'),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const { host, reached } = await hostWith(state, () => ({ allow: true }));
      await expect(
        call(
          host,
          'fetch',
          portalRequest({ message: 'hi', model: 'byo:openai/gpt-6' }),
        ),
      ).rejects.toThrow('after the gate');
      expect(reached).toHaveBeenCalledWith('the room mirror');
    });
  });

  it.each([
    { roomKind: 'direct' as const, trigger: 'matrix' },
    { roomKind: 'group' as const, trigger: 'matrix-group' },
  ])(
    'refuses a Matrix $roomKind-room turn before the ledger records the event',
    async ({ roomKind, trigger }) => {
      const stub = env.SQLITE_TEST.get(
        env.SQLITE_TEST.idFromName(`gate-matrix-${roomKind}`),
      );
      await runInDurableObject(stub, async (_instance, state) => {
        const { host, seen, reached } = await hostWith(state, () => ({
          refuse: TOP_UP,
        }));
        const req: TurnRequest = {
          identity: { userDid: 'did:ixo:alice' },
          sessionId: '$thread',
          message: 'hi',
          client: 'matrix',
          roomId: '!room:ixo.test',
          roomKind,
          eventId: '$event',
          requestId: 'req-matrix',
          attachments: [
            { filename: 'a.png', mimetype: 'image/png', eventId: '$file' },
          ],
        };
        const result = (await call(host, 'runTurn', req)) as TurnResult;
        expect(result).toEqual({
          sessionId: '$thread',
          requestId: 'req-matrix',
          text: '',
          toolCalls: [],
          refused: TOP_UP,
        });
        expect(reached).not.toHaveBeenCalled();
        expect(seen[0]).toMatchObject({
          trigger,
          hasAttachments: true,
          session: { roomId: '!room:ixo.test', roomKind },
        });
      });
    },
  );

  it('refuses a task run (trigger task) without starting it', async () => {
    const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName('gate-task'));
    await runInDurableObject(stub, async (_instance, state) => {
      const { host, seen, reached } = await hostWith(state, () => ({
        refuse: TOP_UP,
      }));
      const result = (await call(host, 'runTurn', {
        identity: { userDid: 'did:ixo:alice' },
        sessionId: 'task:t1',
        message: 'run',
        client: 'matrix',
        requestId: 'req-task',
        taskRunId: 'run-1',
      } satisfies TurnRequest)) as TurnResult;
      expect(result.refused).toEqual(TOP_UP);
      expect(reached).not.toHaveBeenCalled();
      expect(seen[0]).toMatchObject({
        trigger: 'task',
        session: { taskRunId: 'run-1' },
      });
    });
  });

  it('a gate that throws fails open by default: the turn goes on', async () => {
    const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName('gate-throws'));
    await runInDurableObject(stub, async (_instance, state) => {
      const { host, reached } = await hostWith(state, () => {
        throw new Error('kv read failed');
      });
      await expect(
        call(host, 'runTurn', {
          identity: { userDid: 'did:ixo:alice' },
          sessionId: 'task:t1',
          message: 'run',
          client: 'matrix',
          requestId: 'req-task',
          taskRunId: 'run-1',
        } satisfies TurnRequest),
      ).rejects.toThrow('after the gate');
      expect(reached).toHaveBeenCalledWith('the run');
    });
  });

  it('a restriction rides on the turn request: the run is restricted to the person’s provider', async () => {
    const stub = env.SQLITE_TEST.get(
      env.SQLITE_TEST.idFromName('gate-restricted'),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const { host } = await hostWith(state, () => ({
        allow: true,
        platformModels: 'deny',
      }));
      const ran: TurnRequest[] = [];
      Object.assign(host, {
        runTurnOnce: async (req: TurnRequest): Promise<TurnResult> => {
          ran.push(req);
          return {
            sessionId: req.sessionId,
            requestId: req.requestId,
            text: 'ok',
            toolCalls: [],
          };
        },
      });
      const req: TurnRequest = {
        identity: { userDid: 'did:ixo:alice' },
        sessionId: 'task:t1',
        message: 'run',
        client: 'matrix',
        requestId: 'req-task',
        taskRunId: 'run-1',
      };
      await call(host, 'runTurn', req);
      expect(ran).toHaveLength(1);
      expect(ran[0]?.platformModels).toBe('deny');
      // The caller's request object is not changed.
      expect(req.platformModels).toBeUndefined();
    });
  });

  it('an unrestricted turn carries no restriction', async () => {
    const stub = env.SQLITE_TEST.get(
      env.SQLITE_TEST.idFromName('gate-unrestricted'),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const { host } = await hostWith(state, () => ({ allow: true }));
      const ran: TurnRequest[] = [];
      Object.assign(host, {
        runTurnOnce: async (req: TurnRequest): Promise<TurnResult> => {
          ran.push(req);
          return {
            sessionId: req.sessionId,
            requestId: req.requestId,
            text: 'ok',
            toolCalls: [],
          };
        },
      });
      await call(host, 'runTurn', {
        identity: { userDid: 'did:ixo:alice' },
        sessionId: 'task:t1',
        message: 'run',
        client: 'matrix',
        requestId: 'req-task',
        taskRunId: 'run-1',
      } satisfies TurnRequest);
      expect(ran[0]).not.toHaveProperty('platformModels');
    });
  });
});
