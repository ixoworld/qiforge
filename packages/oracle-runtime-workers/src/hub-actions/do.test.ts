import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { ActionOutcomeV1, ActionReferenceV1 } from '@ixo/action-protocol';
import type { ChannelTurnResponse } from '../channels/contract';
import { createRuntimeCore } from '../core';
import { makeEnv } from '../core/test-fixtures';
import { RunStore } from '../do/run-store';
import { storedRunRequest } from '../do/run-request';
import type { TurnRequest } from '../do/contracts';
import { createUserOracleDO } from '../do/user-oracle-do';
import { DoSqliteDatabase } from '../sqlite/database';
import { HubActionClient } from './client';
import { HubActionStore } from './store';

/**
 * The owner object's Hub wiring, driven through `createUserOracleDO`'s own
 * methods over a real SQLite store and a real client, with a fake
 * `AUTH_HUB` that counts its calls.
 */
const core = createRuntimeCore({
  config: { name: 'Qi' },
  env: makeEnv(),
  plugins: [],
});
const UserOracleDO = createUserOracleDO({ core: () => core });
const OWNER = 'did:ixo:ixo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdxlvf0';
const SESSION = '$session';
const RUN = 'run-one';
const digest = 'a'.repeat(64);

async function call<T>(
  host: object,
  name: string,
  ...args: unknown[]
): Promise<T> {
  return Reflect.apply(Reflect.get(host, name), host, args);
}

function reference(n: number): ActionReferenceV1 {
  const id = String(n).padStart(32, 'A');
  return {
    version: 'ixo.auth-action/1',
    id,
    accountId: 'account-one',
    bindingId: 'chb_one',
    bindingRevision: 2,
    revision: 1,
    digest,
    url: `https://hub.test/a/${id}`,
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    title: `Review ${n}`,
  };
}
function outcome(
  ref: ActionReferenceV1,
  sequence: number,
  status: ActionOutcomeV1['status'],
): ActionOutcomeV1 {
  return {
    version: 'ixo.auth-outcome/1',
    eventId: `event-${ref.id}-${sequence}`,
    reference: ref,
    ownerDid: OWNER,
    authorizedRevision: 1,
    authorizedDigest: digest,
    sequence,
    status,
    receipt:
      status === 'succeeded'
        ? {
            kind: 'form.submission.v1',
            actionId: ref.id,
            revision: 1,
            digest,
            valuesDigest: 'b'.repeat(64),
            submittedAt: 1770000000000,
            submissionId: `submission-${ref.id}`,
          }
        : null,
    occurredAt: 1770000000000 + sequence,
  };
}

type HubMode = 'up' | 'down' | 'hang';
const GMAIL = { id: 'gmail-one', label: 'alex@example.test' };

async function harness(state: DurableObjectState) {
  const db = await DoSqliteDatabase.open(state, 'hub-do.db');
  const store = new HubActionStore(db);
  await store.setup();
  const runStore = new RunStore(db);
  const outcomes = new Map<string, ActionOutcomeV1 | null>();
  const calls: string[] = [];
  let mode: HubMode = 'up';
  const hubState = {
    bindingActive: true,
    optionsOwner: OWNER,
    optionsBinding: 'chb_one',
  };
  const hub = {
    fetch: async (request: Request): Promise<Response> => {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (mode === 'down') return new Response('down', { status: 503 });
      if (path === '/api/internal/channels/validate-binding')
        return Response.json({ active: hubState.bindingActive });
      if (path === '/api/internal/actions/operations/options')
        return Response.json({
          version: 'ixo.auth-options/2',
          accountId: 'account-one',
          ownerDid: hubState.optionsOwner,
          bindingId: hubState.optionsBinding,
          bindingRevision: 2,
          connections: [
            {
              service: 'gmail',
              id: GMAIL.id,
              label: GMAIL.label,
              scopes: ['https://www.googleapis.com/auth/gmail.compose'],
            },
          ],
          targets: [],
          resources: [],
        });
      if (request.method === 'POST')
        return new Response('unexpected prepare', { status: 500 });
      if (mode === 'hang')
        return new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        );
      const id = new URL(request.url).pathname.split('/').at(-1)!;
      const held = await store.get(OWNER, id);
      if (!held) return new Response('missing', { status: 404 });
      return Response.json({
        reference: held.reference,
        ownerDid: OWNER,
        revision: 1,
        digest,
        reviewStatus: 'authorized',
        operationStatus: 'submitted',
        outcome: outcomes.get(id) ?? null,
      });
    },
  };
  const markDirty = vi.fn();
  const host: object = Object.create(UserOracleDO.prototype);
  Object.assign(host, {
    ctx: state,
    userDid: OWNER,
    env: {
      HUB_ACTIONS_ENABLED: 'true',
      ORACLE_DID: 'did:ixo:oracle',
      AUTH_HUB_CHANNEL_SERVICE_KEY: 'oracle-secret',
      AUTH_HUB: hub,
    },
    runStore,
    actionProposals: null,
    topicProposals: null,
    hubActionStore: store,
    hubActionClient: new HubActionClient({
      origin: 'https://hub.test',
      key: 'oracle-secret',
      fetcher: hub,
    }),
    markDirty,
    ready: async () => undefined,
  });
  const origin = (ref: ActionReferenceV1) => ({
    ownerDid: OWNER,
    sessionId: SESSION,
    runId: RUN,
    requestId: 'request-one',
    bindingId: ref.bindingId,
    bindingRevision: ref.bindingRevision,
    requestKey: `key-${ref.id}`,
  });
  return {
    host,
    store,
    calls,
    markDirty,
    outcomes,
    runStore,
    hubState,
    setMode(next: HubMode) {
      mode = next;
    },
    /** A run an inbound channel message started, as the run store holds it. */
    async channelRun(runId: string) {
      const request: TurnRequest = {
        identity: { userDid: OWNER },
        sessionId: SESSION,
        requestId: `request-${runId}`,
        client: 'channel',
        message: 'Send it',
        channel: {
          provider: 'whatsapp',
          bindingId: 'chb_one',
          bindingRevision: 2,
          remoteMessageRef: `hmac:${'a'.repeat(64)}`,
        },
      };
      await runStore.create({
        runId,
        sessionId: SESSION,
        requestId: request.requestId,
        client: 'channel',
        status: 'running',
        request: JSON.stringify(storedRunRequest(request)),
        checkpointId: null,
        instanceId: 'instance',
      });
    },
    async prepared(n: number) {
      const ref = reference(n);
      await store.record(origin(ref), ref);
      return ref;
    },
    async poll() {
      const result = await call<ChannelTurnResponse>(
        host,
        'withActionOutcomes',
        OWNER,
        {
          requestId: 'request-one',
          runId: RUN,
          sessionId: SESSION,
          status: 'finished',
        },
      );
      return result.hubActionOutcomes ?? [];
    },
    close: () => db.close(),
  };
}

async function withHub(
  name: string,
  test: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>,
) {
  const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const h = await harness(state);
    try {
      await test(h);
    } finally {
      await h.close();
    }
  });
}

describe('Hub actions in the owner object', () => {
  it('answers a poll from SQLite: a terminal stored outcome makes no Hub call', async () => {
    await withHub('hub-terminal', async (h) => {
      const ref = await h.prepared(1);
      expect(await h.store.recordOutcome(outcome(ref, 3, 'succeeded'))).toBe(
        true,
      );
      expect(await h.poll()).toEqual([outcome(ref, 3, 'succeeded')]);
      expect(await h.poll()).toEqual([outcome(ref, 3, 'succeeded')]);
      expect(h.calls).toEqual([]);
      expect(h.markDirty).not.toHaveBeenCalled();
    });
  });

  it('treats a v2 expired or cancelled outcome as terminal', async () => {
    await withHub('hub-v2-terminal', async (h) => {
      const expired = await h.prepared(1);
      const cancelled = await h.prepared(2);
      for (const [ref, status] of [
        [expired, 'expired'],
        [cancelled, 'cancelled'],
      ] as const)
        await h.store.recordOutcome({
          ...outcome(ref, 5, status),
          version: 'ixo.auth-outcome/2',
        });
      expect((await h.poll()).map((o) => o.status)).toEqual([
        'expired',
        'cancelled',
      ]);
      expect(h.calls).toEqual([]);
    });
  });

  it('refreshes at most one non-terminal action per poll, then backs off', async () => {
    await withHub('hub-one-per-poll', async (h) => {
      const refs = [
        await h.prepared(1),
        await h.prepared(2),
        await h.prepared(3),
      ];
      for (const ref of refs)
        h.outcomes.set(ref.id, outcome(ref, 1, 'submitted'));
      expect(await h.poll()).toHaveLength(1);
      expect(h.calls).toHaveLength(1);
      // The refresh schedule and the new outcome are both owner-copy state.
      expect(h.markDirty).toHaveBeenCalled();
      expect(await h.poll()).toHaveLength(2);
      expect(h.calls).toHaveLength(2);
      expect(await h.poll()).toHaveLength(3);
      expect(h.calls).toHaveLength(3);
      // Every action is inside its 15 s backoff now: no call at all, and
      // a poll that refreshed nothing writes nothing.
      const marks = h.markDirty.mock.calls.length;
      expect(await h.poll()).toHaveLength(3);
      expect(h.calls).toHaveLength(3);
      expect(h.markDirty).toHaveBeenCalledTimes(marks);
    });
  });

  it('returns the stored outcomes within the poll budget while the Hub hangs', async () => {
    await withHub('hub-hangs', async (h) => {
      const done = await h.prepared(1);
      await h.store.recordOutcome(outcome(done, 2, 'declined'));
      const pending = await h.prepared(2);
      await h.store.recordOutcome(outcome(pending, 1, 'authorized'));
      h.setMode('hang');
      const started = Date.now();
      expect(await h.poll()).toEqual([
        outcome(done, 2, 'declined'),
        outcome(pending, 1, 'authorized'),
      ]);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(h.calls).toHaveLength(1);
    });
  });

  it('returns a callback-delivered outcome while the Hub is down', async () => {
    await withHub('hub-callback', async (h) => {
      const ref = await h.prepared(1);
      h.outcomes.set(ref.id, outcome(ref, 2, 'succeeded'));
      await call(
        h.host,
        'recordHubActionOutcome',
        outcome(ref, 2, 'succeeded'),
      );
      expect(h.markDirty).toHaveBeenCalledTimes(1);
      // The same callback again stores nothing new.
      await call(
        h.host,
        'recordHubActionOutcome',
        outcome(ref, 2, 'succeeded'),
      );
      expect(h.markDirty).toHaveBeenCalledTimes(1);
      h.setMode('down');
      const before = h.calls.length;
      expect(await h.poll()).toEqual([outcome(ref, 2, 'succeeded')]);
      expect(h.calls.length).toBe(before);
    });
  });

  it('prepares a review only in a run an inbound channel message started', async () => {
    await withHub('hub-origin', async (h) => {
      const request: TurnRequest = {
        identity: { userDid: OWNER },
        sessionId: '$task-nightly',
        requestId: 'task-request',
        client: 'portal',
        message: 'scheduled',
      };
      await h.runStore.create({
        runId: 'task-run',
        sessionId: request.sessionId,
        requestId: request.requestId,
        client: request.client,
        status: 'running',
        request: JSON.stringify(storedRunRequest(request)),
        checkpointId: null,
        instanceId: 'instance',
      });
      await expect(
        call(h.host, 'requestHubAction', {
          ownerDid: OWNER,
          sessionId: request.sessionId,
          runId: 'task-run',
          requestId: request.requestId,
          provider: 'whatsapp',
          bindingId: 'chb_one',
          bindingRevision: 2,
          requestKey: 'k'.repeat(64),
          operation: {
            kind: 'form.submit.v1',
            formId: 'form-one',
            destination: 'registered-form',
            fields: [],
            declaration: null,
          },
        }),
      ).rejects.toThrow('only in reply to a message from the user');
      expect(h.calls).toEqual([]);
    });
  });

  const options = (over: Partial<{ ownerDid: string; bindingId: string }>) => ({
    ownerDid: OWNER,
    provider: 'whatsapp',
    bindingId: 'chb_one',
    bindingRevision: 2,
    ...over,
  });

  it('guards hub_action_options on owner, binding and the Hub answer', async () => {
    await withHub('hub-options-guards', async (h) => {
      expect(
        (
          await call<{ connections: unknown[] }>(
            h.host,
            'hubActionOptions',
            options({}),
          )
        ).connections,
      ).toHaveLength(1);
      // Another owner than this object's: refused before any Hub call.
      const before = h.calls.length;
      await expect(
        call(
          h.host,
          'hubActionOptions',
          options({ ownerDid: 'did:ixo:other' }),
        ),
      ).rejects.toThrow('unavailable for this owner');
      expect(h.calls.length).toBe(before);
      // The Hub answering for another binding or owner.
      h.hubState.optionsBinding = 'chb_other';
      await expect(
        call(h.host, 'hubActionOptions', options({})),
      ).rejects.toThrow('do not match this owner and binding');
      h.hubState.optionsBinding = 'chb_one';
      h.hubState.optionsOwner = 'did:ixo:other';
      await expect(
        call(h.host, 'hubActionOptions', options({})),
      ).rejects.toThrow('do not match this owner and binding');
      h.hubState.optionsOwner = OWNER;
      // An inactive binding: refused, no options read.
      h.hubState.bindingActive = false;
      const reads = h.calls.filter((c) => c.endsWith('/options')).length;
      await expect(
        call(h.host, 'hubActionOptions', options({})),
      ).rejects.toThrow();
      expect(h.calls.filter((c) => c.endsWith('/options')).length).toBe(reads);
    });
  });

  it('refuses an unknown Gmail connection and a new email while an earlier send is unconfirmed', async () => {
    await withHub('hub-gmail-guards', async (h) => {
      await h.channelRun('run-mail');
      const send = (connectionId: string, accountLabel: string) =>
        call(h.host, 'requestHubAction', {
          ownerDid: OWNER,
          sessionId: SESSION,
          runId: 'run-mail',
          requestId: 'request-run-mail',
          provider: 'whatsapp',
          bindingId: 'chb_one',
          bindingRevision: 2,
          requestKey: 'k'.repeat(64),
          operation: {
            kind: 'gmail.message.send.v1',
            connectionId,
            accountLabel,
            to: 'sam@example.test',
            subject: 'Garden plans',
            body: 'See you Tuesday.',
          },
        });
      await expect(send('gmail-two', GMAIL.label)).rejects.toThrow(
        'not one of this owner',
      );
      await expect(send(GMAIL.id, 'someone@example.test')).rejects.toThrow(
        'not one of this owner',
      );
      // An earlier send through this connection whose outcome is unknown.
      const prior = reference(7);
      const priorOrigin = {
        ownerDid: OWNER,
        sessionId: SESSION,
        runId: 'run-earlier',
        requestId: 'request-earlier',
        bindingId: prior.bindingId,
        bindingRevision: prior.bindingRevision,
        requestKey: 'earlier-key',
      };
      await h.store.reserve(
        priorOrigin,
        {
          kind: 'gmail.message.send.v1',
          connectionId: GMAIL.id,
          accountLabel: GMAIL.label,
          to: 'sam@example.test',
          subject: 'Garden plans',
          body: 'See you Tuesday.',
        },
        Math.floor(Date.now() / 1000) + 900,
      );
      await h.store.record(priorOrigin, prior);
      await h.store.recordOutcome(outcome(prior, 1, 'unknown'));
      const refused = await send(GMAIL.id, GMAIL.label).catch(
        (error: unknown) => error,
      );
      expect(refused).toMatchObject({
        name: 'HubActionRefused',
        kind: 'refused',
        priorActionId: prior.id,
      });
      expect(
        h.calls.filter((c) => c.startsWith('POST /api/internal/actions')),
      ).toEqual([]);
    });
  });
});
