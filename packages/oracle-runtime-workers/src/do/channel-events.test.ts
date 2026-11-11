import { env, runInDurableObject } from 'cloudflare:test';
import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_DELIVERY_NOTICE_KWARG } from '../channels/replies';
import { createRuntimeCore } from '../core';
import { createNoopAmbient } from '../core/runtime-context';
import { makeEnv, makePlugin } from '../core/test-fixtures';
import type { DeliveryProfile } from '../delivery/types';
import type { ChannelEventResult } from '../plugin-api/channel-events';
import { DoSqliteDatabase } from '../sqlite/database';
import { SessionsStore } from '../sqlite/sessions-store';
import { SqliteSaver } from '../sqlite/sqlite-saver';
import { SessionEventRouter } from './ambient';
import type { TurnRequest } from './contracts';
import { RunBuffer } from './run-buffer';
import type { LiveRun } from './run-coordinator';
import { storedRunRequest } from './run-request';
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

const USER = 'did:ixo:alice';
const SESSION = 'channel-session';

/** A WhatsApp turn carrying a permission event, as `ChannelTurns.start` begins it. */
const eventTurn: TurnRequest = {
  sessionId: SESSION,
  requestId: 'permission:card_1:allowed',
  client: 'channel',
  message: '',
  identity: { userDid: USER },
  channel: {
    provider: 'whatsapp',
    bindingId: 'chb_1',
    bindingRevision: 3,
    remoteMessageRef: `hmac:${'a'.repeat(64)}`,
    channelEvent: {
      kind: 'permission_answered',
      permissionId: 'card_1',
      status: 'allowed',
    },
  },
};

/**
 * A `UserOracleDO` on a real DO database whose one plugin answers permission
 * events with `answer`; the agent build is a stub that records the request.
 */
async function withEventHost(
  name: string,
  answer: () => Promise<ChannelEventResult>,
  body: (setup: {
    host: object;
    saver: SqliteSaver;
    runStore: RunStore;
    handler: ReturnType<typeof vi.fn>;
    prepareTurn: ReturnType<typeof vi.fn>;
    attempt: (resumed: boolean) => Promise<{ outcome: unknown; live: LiveRun }>;
  }) => Promise<void>,
): Promise<void> {
  const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const db = await DoSqliteDatabase.open(state, 'events.db');
    const saver = new SqliteSaver(db);
    const sessions = new SessionsStore(db);
    const runStore = new RunStore(db);
    await runStore.setup();
    const handler = vi.fn(answer);
    const plugin = makePlugin({ name: 'cards' });
    plugin.handleChannelEvent = handler;
    const core = createRuntimeCore({
      config: { name: 'Test' },
      env: makeEnv(),
      plugins: [plugin],
    });
    const UserOracleDO = createUserOracleDO({ core: () => core });
    const host: object = Object.create(UserOracleDO.prototype);
    const prepareTurn = vi.fn(async () => ({
      agent: {
        streamEvents: (): AsyncIterable<never> => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: true, value: undefined }),
          }),
        }),
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
      ambient: createNoopAmbient(),
      channelTurns: { isCancelled: async () => false },
      delegations: new Map([
        [USER, { raw: 'DELEGATION', expiration: Date.now() / 1000 + 86_400 }],
      ]),
      turnDelegation: async () => ({ raw: 'DELEGATION' }),
      prepareTurn,
      afterTurn: async () => undefined,
      markDirty: () => undefined,
    });
    await runStore.create({
      runId: 'run',
      sessionId: SESSION,
      requestId: eventTurn.requestId,
      client: 'channel',
      status: 'running',
      request: JSON.stringify(storedRunRequest(eventTurn)),
      checkpointId: null,
      instanceId: 'test',
    });
    const attempt = async (resumed: boolean) => {
      const record = await runStore.get('run');
      if (!record) throw new Error('Missing run');
      const live: LiveRun = {
        runId: 'run',
        sessionId: SESSION,
        requestId: eventTurn.requestId,
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
        attemptSource: 'begin',
      };
      return { outcome: await call(host, 'runAttempt', live, resumed), live };
    };
    try {
      await body({ host, saver, runStore, handler, prepareTurn, attempt });
    } finally {
      await db.close();
    }
  });
}

const NOTE = '[Permission answer from the wallet. Test note.]';

describe('UserOracleDO permission events', () => {
  it('ends an ignored event as a finished run with no reply and no transcript', async () => {
    await withEventHost(
      'event-ignored',
      async () => ({ kind: 'ignore' }),
      async ({ saver, handler, prepareTurn, attempt }) => {
        const { outcome, live } = await attempt(false);
        expect(outcome).toEqual({
          status: 'finished',
          text: '',
          toolCalls: [],
        });
        expect(live.buffer.tailAfter(0).map((f) => f.event)).toEqual([
          'run',
          'done',
        ]);
        expect(await saver.listThreadMessages(SESSION)).toEqual([]);
        expect(prepareTurn).not.toHaveBeenCalled();
        // The plugin got the event, the binding and the user's object.
        expect(handler).toHaveBeenCalledTimes(1);
        const [event, ctx] = handler.mock.calls[0] as [
          unknown,
          { session: { channel?: unknown }; user: { did: string } },
        ];
        expect(event).toEqual({
          kind: 'permission_answered',
          permissionId: 'card_1',
          status: 'allowed',
          requestId: 'permission:card_1:allowed',
        });
        expect(ctx.session.channel).toEqual({
          provider: 'whatsapp',
          bindingId: 'chb_1',
          bindingRevision: 3,
        });
        expect(ctx.user.did).toBe(USER);
      },
    );
  });

  it('sends a fixed reply without the model, the note hidden as the turn input, and decides once', async () => {
    await withEventHost(
      'event-reply',
      async () => ({
        kind: 'reply',
        text: 'No problem, nothing was shared. Tell me if you change your mind.',
        note: NOTE,
      }),
      async ({ saver, runStore, handler, prepareTurn, attempt }) => {
        const { outcome } = await attempt(false);
        expect(outcome).toMatchObject({
          status: 'finished',
          text: 'No problem, nothing was shared. Tell me if you change your mind.',
        });
        const messages = await saver.listThreadMessages(SESSION);
        expect(messages).toHaveLength(2);
        const human = messages[0]!;
        expect(human.content).toBe(NOTE);
        expect(human.additional_kwargs[CHANNEL_DELIVERY_NOTICE_KWARG]).toBe(
          NOTE,
        );
        expect(prepareTurn).not.toHaveBeenCalled();
        const stored = JSON.parse((await runStore.get('run'))!.request);
        expect(stored.disposition.kind).toBe('direct-read');
        expect(stored.turn.channel.eventNote).toBe(NOTE);
        // A restarted attempt reads the stored decision: the plugin is not asked again.
        await attempt(true);
        expect(handler).toHaveBeenCalledTimes(1);
      },
    );
  });

  it('runs the agent with the note in place of a message', async () => {
    await withEventHost(
      'event-agent',
      async () => ({ kind: 'agent', note: NOTE }),
      async ({ runStore, handler, prepareTurn, attempt }) => {
        await attempt(false);
        expect(prepareTurn).toHaveBeenCalledTimes(1);
        const req = (prepareTurn.mock.calls[0] as unknown[])[0] as TurnRequest;
        expect(req.channel?.eventNote).toBe(NOTE);
        const stored = JSON.parse((await runStore.get('run'))!.request);
        expect(stored.disposition).toEqual({ kind: 'agent' });
        expect(stored.turn.channel.eventNote).toBe(NOTE);
        await attempt(true);
        expect(handler).toHaveBeenCalledTimes(1);
      },
    );
  });

  it('ignores the event when the plugin throws', async () => {
    await withEventHost(
      'event-throws',
      async () => {
        throw new Error('hub down');
      },
      async ({ saver, attempt }) => {
        const { outcome } = await attempt(false);
        expect(outcome).toMatchObject({ status: 'finished', text: '' });
        expect(await saver.listThreadMessages(SESSION)).toEqual([]);
      },
    );
  });
});
