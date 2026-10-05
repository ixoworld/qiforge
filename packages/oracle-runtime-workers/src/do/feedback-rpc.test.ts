/**
 * The real `UserOracleDO.reserveMessageFeedback` over a real DO database:
 * its session lookup, its transcript (the saver + `transformTranscript`) and
 * its run check against the durable run store.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { describe, expect, it } from 'vitest';
import { createRuntimeCore } from '../core';
import { makeEnv } from '../core/test-fixtures';
import { FeedbackMarkers } from '../feedback/reservation';
import { DoSqliteDatabase } from '../sqlite/database';
import { SqliteSaver } from '../sqlite/sqlite-saver';
import { SessionsStore } from '../sqlite/sessions-store';
import { RunStore } from './run-store';
import { createUserOracleDO } from './user-oracle-do';

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

const identity = { userDid: 'did:ixo:alice' };
const QUESTION = '0b6f7c5e-4a63-4d6e-9d55-000000000001';
const REPLY = '0b6f7c5e-4a63-4d6e-9d55-000000000002';
const FOLLOW_UP = '0b6f7c5e-4a63-4d6e-9d55-000000000003';
const LATEST = '0b6f7c5e-4a63-4d6e-9d55-000000000004';
const submissionId = '8103aeac-96e5-441b-9f87-000000000001';

describe('UserOracleDO.reserveMessageFeedback', () => {
  it('reserves a completed reply, refuses the reply of a running or recovering turn, and ignores a queued run', async () => {
    const stub = env.SQLITE_TEST.get(
      env.SQLITE_TEST.idFromName('feedback-rpc'),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const db = await DoSqliteDatabase.open(state, 'feedback-rpc.db');
      try {
        const saver = new SqliteSaver(db);
        await saver.setup();
        const sessions = new SessionsStore(db);
        await sessions.setup();
        const runStore = new RunStore(db);
        await runStore.setup();
        // Each reservation a minute after the last: the per-user limit is
        // not what this test is about.
        let clock = Date.parse('2026-10-05T09:00:00.000Z');
        const feedbackMarkers = new FeedbackMarkers(
          db,
          () => (clock += 61_000),
        );
        await feedbackMarkers.setup();
        const core = createRuntimeCore({
          config: { name: 'Test' },
          env: makeEnv(),
          plugins: [],
        });
        const UserOracleDO = createUserOracleDO({ core: () => core });
        const host: object = Object.create(UserOracleDO.prototype);
        Object.assign(host, {
          db,
          saver,
          sessions,
          runStore,
          feedbackMarkers,
          runs: null,
          ctx: state,
          env: { ORACLE_DID: 'did:ixo:test' },
          // The stores above are the working copy `ready` would open.
          ready: async () => undefined,
          markDirty: () => undefined,
        });

        /** A session with two turns; the latest reply is `LATEST`. */
        const seed = async (sessionId: string) => {
          await sessions.createSession({
            sessionId,
            oracleName: 'Test',
            oracleDid: 'did:ixo:test',
            oracleEntityDid: 'did:ixo:test',
          });
          const checkpoint = emptyCheckpoint();
          checkpoint.channel_values.messages = [
            new HumanMessage({ id: QUESTION, content: 'What is staking?' }),
            new AIMessage({ id: REPLY, content: 'Staking is…' }),
            new HumanMessage({ id: FOLLOW_UP, content: 'And unbonding?' }),
            new AIMessage({ id: LATEST, content: 'Unbonding is…' }),
          ];
          await saver.put(
            { configurable: { thread_id: sessionId } },
            checkpoint,
            {
              source: 'update',
              step: 1,
              parents: {},
            },
          );
        };
        const withRun = async (
          sessionId: string,
          status: 'queued' | 'running' | 'recovering',
        ) => {
          await seed(sessionId);
          const runId = `run-${sessionId}`;
          await runStore.create({
            runId,
            sessionId,
            requestId: `request-${sessionId}`,
            client: 'portal',
            status: status === 'queued' ? 'queued' : 'running',
            request: '{}',
            checkpointId: null,
            instanceId: 'test',
          });
          // A reset run is marked recovering by the coordinator.
          if (status === 'recovering')
            await runStore.update(runId, { status: 'recovering' });
        };
        const reserve = (sessionId: string, messageId: string) =>
          call(host, 'reserveMessageFeedback', identity, {
            sessionId,
            messageId,
            submissionId,
          });

        await seed('idle');
        expect(await reserve('idle', LATEST)).toMatchObject({
          kind: 'reserved',
          replacesOtherSubmission: false,
        });
        expect(await reserve('missing', LATEST)).toEqual({ kind: 'not_found' });
        expect(await reserve('idle', FOLLOW_UP)).toEqual({ kind: 'not_found' });

        for (const status of ['running', 'recovering'] as const) {
          await withRun(status, status);
          // The latest reply belongs to the turn still running…
          expect(await reserve(status, LATEST)).toEqual({ kind: 'not_found' });
          // …an earlier turn's reply is complete.
          expect(await reserve(status, REPLY)).toMatchObject({
            kind: 'reserved',
          });
        }

        // A queued run has not written its user message yet: the latest
        // reply is complete.
        await withRun('queued', 'queued');
        expect(await reserve('queued', LATEST)).toMatchObject({
          kind: 'reserved',
        });
      } finally {
        await db.close();
      }
    });
  });
});
