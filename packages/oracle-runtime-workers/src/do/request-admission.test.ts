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
import { RunStore } from './run-store';
import { RunBuffer } from './run-buffer';
import type { LiveRun } from './run-coordinator';
import { storedRunRequest } from './run-request';
import type { TurnRequest } from './contracts';

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
