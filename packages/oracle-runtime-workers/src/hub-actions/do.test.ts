import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
  parseOutcome,
  type ActionOutcomeV1,
  type ActionReferenceV1,
  type ChainTxCapabilities,
} from '@ixo/action-protocol';
import { parseOutcome as parseOutcome041 } from '@ixo/action-protocol-041';
import type { ChannelTurnResponse } from '../channels/contract';
import { createRuntimeCore } from '../core';
import { makeEnv, makeRuntimeContext } from '../core/test-fixtures';
import { HubActionsPlugin } from '../plugins/hub-actions/hub-actions.plugin';
import { chainTxOperation } from './request';
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
  const hubState: {
    bindingActive: boolean;
    optionsOwner: string;
    optionsBinding: string;
    /** null: the Hub lists no tokens (it does so while `ixo.bank.send.v1` is off for the account). */
    tokens:
      | {
          denom: string;
          symbol: string;
          decimals: number;
          verified: boolean;
          balanceBaseUnits: string;
        }[]
      | null;
    limits: { denom: string; maxAmountBaseUnits: string }[];
    chainTx: ChainTxCapabilities;
    operations: string[];
    prepare:
      | 'unexpected'
      | 'ok'
      | 'insufficient_funds'
      | 'operation_not_registered';
    posted: unknown[];
    optionsVersions: string[];
  } = {
    bindingActive: true,
    optionsOwner: OWNER,
    optionsBinding: 'chb_one',
    tokens: [],
    limits: [],
    chainTx: {
      messageTypes: [
        'cosmos.bank.send',
        'ixo.claims.submit',
        'ixo.claims.evaluate',
        'ixo.token.transfer',
      ],
      maxMessages: 8,
    },
    operations: [
      'ixo.bank.send.v1',
      'gmail.message.send.v1',
      'ixo.chain.tx.v1',
    ],
    prepare: 'unexpected',
    posted: [],
    optionsVersions: [],
  };
  const hub = {
    fetch: async (request: Request): Promise<Response> => {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (mode === 'down') return new Response('down', { status: 503 });
      if (path === '/api/internal/channels/validate-binding')
        return Response.json({ active: hubState.bindingActive });
      if (path === '/api/internal/actions/operations/options') {
        // Version 3 adds the owner's tokens (the Hub reads balances for it);
        // versions 4 and 5 answer as version 3.
        const version = new URL(request.url).searchParams.get('version') ?? '';
        const v3 = version === '3' || version === '4' || version === '5';
        hubState.optionsVersions.push(version);
        return Response.json({
          version: v3 ? 'ixo.auth-options/3' : 'ixo.auth-options/2',
          accountId: 'account-one',
          ownerDid: hubState.optionsOwner,
          bindingId: hubState.optionsBinding,
          bindingRevision: 2,
          ...(v3
            ? {
                transfer:
                  hubState.tokens === null ? null : { tokens: hubState.tokens },
              }
            : {}),
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
      }
      if (path === '/api/internal/actions/operations/capabilities')
        return Response.json({
          version: 'ixo.auth-capabilities/2',
          accountId: 'account-one',
          oracleDid: 'did:ixo:oracle',
          network: 'ixo testnet',
          resourceOrigin: null,
          operations: hubState.operations,
          transfer: { limits: hubState.limits, maxFeeUixo: '100000' },
          chainTx: hubState.operations.includes('ixo.chain.tx.v1')
            ? hubState.chainTx
            : null,
          forms: [],
        });
      if (request.method === 'POST') {
        if (hubState.prepare === 'unexpected')
          return new Response('unexpected prepare', { status: 500 });
        hubState.posted.push(await request.json());
        if (hubState.prepare === 'insufficient_funds')
          return Response.json(
            { error: 'insufficient_funds', reason: 'balance 5 < 7' },
            { status: 400 },
          );
        if (hubState.prepare === 'operation_not_registered')
          return Response.json(
            {
              error: 'operation_not_registered',
              reason: 'invalid_message: messages[1].toAddress',
            },
            { status: 400 },
          );
        // Each accepted prepare is its own action: 9, 10, ...
        return Response.json({
          reference: reference(8 + hubState.posted.length),
        });
      }
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
      IXO_TRANSACTION_CHAIN_ID_TESTNET: 'pandora-77',
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
      // So is a chain transaction, a coin send included, before any Hub
      // read (no binding check, no options and balances read).
      await expect(
        call(h.host, 'chainTransactionHubAction', {
          ownerDid: OWNER,
          sessionId: request.sessionId,
          runId: 'task-run',
          requestId: request.requestId,
          provider: 'whatsapp',
          bindingId: 'chb_one',
          bindingRevision: 2,
          requestKey: 'k'.repeat(64),
          messages: [
            {
              type: 'cosmos.bank.send',
              toAddress: 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze',
              amount: '1',
            },
          ],
          memo: '',
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
      // The Gmail check reads options at version 2: no token list, so the
      // Hub does not read the owner's balances for an email.
      expect(h.hubState.optionsVersions.length).toBeGreaterThan(0);
      expect(new Set(h.hubState.optionsVersions)).toEqual(new Set(['2']));
    });
  });

  it('allows one Gmail send in flight per mailbox, across a reconnect', async () => {
    await withHub('hub-gmail-in-flight', async (h) => {
      await h.channelRun('run-mail');
      const send = () =>
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
            connectionId: GMAIL.id,
            accountLabel: GMAIL.label,
            to: 'sam@example.test',
            subject: 'Garden plans',
            body: 'See you Tuesday.',
          },
        }).catch((error: unknown) => error);
      // An earlier send through the mailbox's previous connection (it was
      // reconnected under a new id), approved and handed to Gmail.
      const prior = reference(8);
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
          connectionId: 'gmail-before-reconnect',
          accountLabel: GMAIL.label.toUpperCase(),
          to: 'sam@example.test',
          subject: 'Garden plans',
          body: 'See you Tuesday.',
        },
        Math.floor(Date.now() / 1000) + 900,
      );
      await h.store.record(priorOrigin, prior);
      for (const status of ['authorized', 'submitted'] as const) {
        await h.store.recordOutcome(
          outcome(prior, status === 'authorized' ? 1 : 2, status),
        );
        expect(await send()).toMatchObject({
          name: 'HubActionRefused',
          kind: 'refused',
          priorActionId: prior.id,
        });
      }
      // Finished: the mailbox is free again (the request goes on to the
      // Hub, which this fake does not serve).
      await h.store.recordOutcome(outcome(prior, 4, 'succeeded'));
      const next = await send();
      expect(next).toBeInstanceOf(Error);
      expect(next).not.toMatchObject({ name: 'HubActionRefused' });
    });
  });

  it("still shows an older runtime's bank-send card outcome and emits its 0.4.1 receipt", async () => {
    await withHub('hub-old-bank-send', async (h) => {
      // An ixo.bank.send.v1 card an older runtime prepared, with the token
      // it stored next to it.
      const ref = await h.prepared(9);
      const usdc = {
        denom: `ibc/${'A'.repeat(64)}`,
        symbol: 'USDC',
        decimals: 6,
        verified: true,
      };
      await h.store.setToken(ref.id, usdc);
      // The status line names the amount from the stored token.
      h.outcomes.set(ref.id, {
        ...outcome(ref, 2, 'succeeded'),
        version: 'ixo.auth-outcome/2',
        receipt: {
          kind: 'ixo.bank.send.v1',
          actionId: ref.id,
          revision: 1,
          digest,
          chainId: 'pandora-77',
          txHash: 'f'.repeat(64),
          height: 120,
          code: 0,
          denom: usdc.denom,
          amountBaseUnits: '1250000',
        },
      });
      expect(
        await call(h.host, 'hubActionStatusForTool', OWNER, ref.id),
      ).toMatchObject({
        outcome: { status: 'succeeded' },
        summary: `Transfer of 1.25 USDC (${usdc.denom}) confirmed on chain. Transaction ${'f'.repeat(64)}, block 120.`,
      });
      // The channel poll emits the 0.4.1 receipt shape the gateway parses:
      // no denom or amount fields.
      await h.store.recordOutcome(h.outcomes.get(ref.id)!);
      const emitted = await h.poll();
      // The gateway's own parser (0.4.1) accepts what the poll emits, and
      // would have refused the outcome as the Hub sent it.
      expect(() => parseOutcome041(emitted[0])).not.toThrow();
      expect(() => parseOutcome041(h.outcomes.get(ref.id))).toThrow(
        'Invalid receipt',
      );
      expect(emitted[0]?.receipt).toEqual({
        kind: 'ixo.bank.send.v1',
        actionId: ref.id,
        revision: 1,
        digest,
        chainId: 'pandora-77',
        txHash: 'f'.repeat(64),
        height: 120,
        code: 0,
      });
    });
  });

  it('confirms a version-2 callback against a version-3 status read, and acks a replay without a Hub read', async () => {
    await withHub('hub-mixed-level', async (h) => {
      const ref = await h.prepared(11);
      const bank = {
        kind: 'ixo.bank.send.v1' as const,
        actionId: ref.id,
        revision: 1,
        digest,
        chainId: 'pandora-8',
        txHash: 'e'.repeat(64),
        height: 77,
        code: 0,
      };
      const base = outcome(ref, 2, 'succeeded');
      // The Hub's status read (version 3) carries the 0.5.0 bank fields...
      h.outcomes.set(ref.id, {
        ...base,
        version: 'ixo.auth-outcome/2',
        receipt: { ...bank, denom: 'uixo', amountBaseUnits: '5' },
      });
      // ...while the callback for an action prepared at version 2 does not.
      const callback: ActionOutcomeV1 = {
        ...base,
        version: 'ixo.auth-outcome/2',
        receipt: bank,
      };
      await call(h.host, 'recordHubActionOutcome', callback);
      const reads = () =>
        h.calls.filter(
          (c) => c === `GET /api/internal/actions/operations/${ref.id}`,
        ).length;
      expect(reads()).toBe(1);
      expect(await h.store.outcomeAt(OWNER, ref.id, 2)).toMatchObject({
        receipt: { denom: 'uixo', amountBaseUnits: '5' },
      });
      // The same callback again (a Hub retry): acknowledged from SQLite.
      await call(h.host, 'recordHubActionOutcome', callback);
      expect(reads()).toBe(1);
      // A callback that differs from the stored one is confirmed again,
      // and refused when the Hub disagrees.
      await expect(
        call(h.host, 'recordHubActionOutcome', {
          ...callback,
          receipt: { ...bank, code: 5 },
        }),
      ).rejects.toThrow('not confirmed');
      expect(reads()).toBe(2);
    });
  });

  const RECIPIENT = 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze';
  const ADMIN = 'ixo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdxlvf0';
  const SIGNER = OWNER.replace('did:ixo:', '');
  /** The owner's IXO as hub_action_options lists it: 5 IXO. */
  const IXO_LISTED = {
    denom: 'uixo',
    symbol: 'IXO',
    decimals: 6,
    verified: true,
    balanceBaseUnits: '5000000',
  };
  // The model's messages carry no owner identity; the runtime adds it.
  const submit = {
    type: 'ixo.claims.submit' as const,
    collectionId: '42',
    claimId: 'bafyclaimone',
    adminAddress: ADMIN,
  };
  const evaluate = {
    type: 'ixo.claims.evaluate' as const,
    claimId: 'bafyclaimtwo',
    collectionId: '42',
    oracle: 'did:ixo:entity:evaluator',
    adminAddress: ADMIN,
    status: 1 as const,
  };
  // What reaches the Hub: the evaluator (and filer) is the signer.
  const submitted = { ...submit, agentDid: OWNER };
  const evaluated = { ...evaluate, agentDid: OWNER, agentAddress: SIGNER };
  const token = {
    type: 'ixo.token.transfer' as const,
    recipient: RECIPIENT,
    tokens: [
      { id: 'CARBON:bafytoken', amount: '3' },
      { id: 'CARBON:bafyother', amount: '2' },
    ],
  };
  const chainInput = (requestKey: string, messages: unknown[], memo = '') => ({
    ownerDid: OWNER,
    sessionId: SESSION,
    runId: 'run-chain',
    requestId: 'request-run-chain',
    provider: 'whatsapp',
    bindingId: 'chb_one',
    bindingRevision: 2,
    requestKey,
    messages,
    memo,
  });

  it('builds the chain operation with the signer as the owner identity, and refuses a runtime field in fixed words', () => {
    const base = {
      ownerDid: OWNER,
      chainId: 'pandora-77',
      network: 'ixo testnet' as const,
      memo: '',
    };
    // A stray identity field (bypassing the tool schema) is replaced.
    expect(
      chainTxOperation({
        ...base,
        messages: [
          submit,
          { ...evaluate, agentAddress: RECIPIENT, agentDid: 'did:ixo:x' },
        ] as never,
      }),
    ).toEqual({
      kind: 'ixo.chain.tx.v1',
      chainId: 'pandora-77',
      network: 'ixo testnet',
      signer: SIGNER,
      memo: '',
      messages: [submitted, evaluated],
    });
    // An owner DID that is not did:ixo:<address> has no signer.
    for (const ownerDid of ['did:key:z6Mkone', 'did:ixo:entity:abc'])
      expect(() =>
        chainTxOperation({ ...base, ownerDid, messages: [submit] }),
      ).toThrow(
        "This transaction cannot be prepared for this owner and oracle (Invalid signer: the runtime sets it from the owner's account and this oracle's configuration); retrying or changing the fields will not help.",
      );
    // A field from the model's messages: the protocol's words.
    expect(() =>
      chainTxOperation({
        ...base,
        messages: [{ ...token, tokens: [{ id: 'CARBON\u202e', amount: '1' }] }],
      }),
    ).toThrow(
      'The transaction is incomplete (Invalid messages[0].tokens[0].id).',
    );
  });

  it('sends one chain transaction with the account network, this Worker chain id and the owner as signer', async () => {
    await withHub('hub-chain-tx-body', async (h) => {
      await h.channelRun('run-chain');
      h.hubState.prepare = 'ok';
      h.hubState.tokens = [IXO_LISTED];
      const first = Math.floor(Date.now() / 1000) + 900;
      // One step (a single coin send, in display units), with a memo.
      expect(
        await call(
          h.host,
          'chainTransactionHubAction',
          chainInput(
            'a'.repeat(64),
            [{ type: 'cosmos.bank.send', toAddress: RECIPIENT, amount: '1.5' }],
            'Lunch',
          ),
        ),
      ).toMatchObject({ id: reference(9).id });
      // Three steps, in order, as one transaction.
      expect(
        await call(
          h.host,
          'chainTransactionHubAction',
          chainInput('b'.repeat(64), [submit, evaluate, token]),
        ),
      ).toMatchObject({ id: reference(10).id });
      const last = Math.floor(Date.now() / 1000) + 900;
      expect(h.hubState.posted).toHaveLength(2);
      const bodies = h.hubState.posted.map((body) => {
        const { expiresAt, ...rest } = body as { expiresAt: number };
        expect(expiresAt).toBeGreaterThanOrEqual(first);
        expect(expiresAt).toBeLessThanOrEqual(last);
        return rest;
      });
      expect(bodies).toEqual([
        {
          bindingId: 'chb_one',
          bindingRevision: 2,
          requestKey: 'a'.repeat(64),
          operation: {
            kind: 'ixo.chain.tx.v1',
            chainId: 'pandora-77',
            network: 'ixo testnet',
            signer: SIGNER,
            memo: 'Lunch',
            messages: [
              {
                type: 'cosmos.bank.send',
                toAddress: RECIPIENT,
                amountBaseUnits: '1500000',
                denom: 'uixo',
              },
            ],
          },
        },
        {
          bindingId: 'chb_one',
          bindingRevision: 2,
          requestKey: 'b'.repeat(64),
          operation: {
            kind: 'ixo.chain.tx.v1',
            chainId: 'pandora-77',
            network: 'ixo testnet',
            signer: SIGNER,
            memo: '',
            messages: [submitted, evaluated, token],
          },
        },
      ]);
      expect(
        h.calls.filter((c) => c.startsWith('POST /api/internal/actions')),
      ).toEqual([
        'POST /api/internal/actions/operations',
        'POST /api/internal/actions/operations',
      ]);
      // The binding is checked once per prepare.
      expect(
        h.calls.filter((c) => c.endsWith('/validate-binding')),
      ).toHaveLength(2);
    });
  });

  it('converts each bank step from a listed token and a display amount, reading options once per call and only with a bank step', async () => {
    await withHub('hub-chain-bank-steps', async (h) => {
      await h.channelRun('run-chain');
      const eth = {
        denom: `ibc/${'B'.repeat(64)}`,
        symbol: 'ETH',
        decimals: 18,
        verified: true,
        balanceBaseUnits: '2000000000000000000',
      };
      const meme = {
        denom: 'factory/ixo1creator/meme',
        symbol: 'USDC',
        decimals: 0,
        verified: false,
        balanceBaseUnits: '1000',
      };
      h.hubState.tokens = [IXO_LISTED, eth, meme];
      h.hubState.prepare = 'ok';
      const send = (amount: string, denom?: string) => ({
        type: 'cosmos.bank.send',
        toAddress: RECIPIENT,
        amount,
        ...(denom ? { denom } : {}),
      });
      const prepare = (key: string, messages: unknown[]) =>
        call(
          h.host,
          'chainTransactionHubAction',
          chainInput(key.repeat(64), messages),
        ).catch((error: unknown) => error);
      const optionReads = () =>
        h.calls.filter((c) => c.endsWith('/options')).length;
      // Refused before any POST, each after one options read: a token not
      // in the list, more decimals than the token has (6, 18, an
      // unverified token's 0), zero, more than the balance, and two steps
      // of one token over its balance together.
      for (const [messages, words] of [
        [
          [send('1', 'ibc/unknown')],
          "messages[0].denom: ibc/unknown is not in the owner's token list; use a denom exactly as hub_action_options lists it (uixo, ",
        ],
        [
          [send('1.0000001')],
          'messages[0].amount: This token has 6 decimals: use at most 6 digits after the point.',
        ],
        [
          [send('0.0000000000000000001', eth.denom)],
          'messages[0].amount: This token has 18 decimals: use at most 18 digits after the point.',
        ],
        [
          [send('1.5', meme.denom)],
          'messages[0].amount: This token is counted in whole base units: use an amount without decimals.',
        ],
        [[send('0')], 'messages[0].amount: The amount must be above zero.'],
        [
          [send('5.000001')],
          'messages[0].amount: the owner holds 5 IXO, less than this send.',
        ],
        [
          [token, send('3', eth.denom)],
          `messages[1].amount: the owner holds 2 ETH (${eth.denom}), less than this send.`,
        ],
        [
          [send('3'), token, send('2.5')],
          'messages[2].amount: the owner holds 5 IXO, less than the bank steps of this token in this transaction.',
        ],
      ] as const) {
        const before = optionReads();
        expect(await prepare('r', [...messages])).toMatchObject({
          name: 'HubActionRefused',
          message: expect.stringContaining(words),
        });
        expect(optionReads()).toBe(before + 1);
      }
      expect(h.hubState.posted).toEqual([]);
      // Converted exactly (no floats) from the listed decimals: IXO, an
      // 18-decimal token, an unverified token in base units, around an
      // impact-token transfer; trailing zeros carry no value.
      const before = optionReads();
      expect(
        await prepare('a', [
          send('1.50'),
          send('1.000000000000000001', eth.denom),
          token,
          send('7', meme.denom),
          send('3.5'),
        ]),
      ).toMatchObject({ id: reference(9).id });
      expect(optionReads()).toBe(before + 1);
      const operation = (h.hubState.posted[0] as { operation: unknown })
        .operation;
      expect(operation).toMatchObject({
        kind: 'ixo.chain.tx.v1',
        signer: SIGNER,
        messages: [
          {
            type: 'cosmos.bank.send',
            toAddress: RECIPIENT,
            amountBaseUnits: '1500000',
            denom: 'uixo',
          },
          {
            type: 'cosmos.bank.send',
            toAddress: RECIPIENT,
            amountBaseUnits: '1000000000000000001',
            denom: eth.denom,
          },
          token,
          {
            type: 'cosmos.bank.send',
            toAddress: RECIPIENT,
            amountBaseUnits: '7',
            denom: meme.denom,
          },
          {
            type: 'cosmos.bank.send',
            toAddress: RECIPIENT,
            amountBaseUnits: '3500000',
            denom: 'uixo',
          },
        ],
      });
      // No display amount and no fee reach the Hub.
      expect(JSON.stringify(operation)).not.toMatch(/"amount":"1\.5|fee/i);
      // Options read at the protocol version (5, answered as options
      // version 3), with the owner's balances.
      expect(new Set(h.hubState.optionsVersions)).toEqual(new Set(['5']));
      // No bank step: no options read at all.
      const reads = optionReads();
      expect(await prepare('b', [submit, token])).toMatchObject({
        id: reference(10).id,
      });
      expect(optionReads()).toBe(reads);
    });
  });

  it('refuses a bank step when Auth Hub lists no tokens for the owner, before any POST', async () => {
    await withHub('hub-chain-no-tokens', async (h) => {
      await h.channelRun('run-chain');
      h.hubState.prepare = 'ok';
      // Auth Hub answers `transfer: null` while ixo.bank.send.v1 is off for
      // the account, when the owner has no address, or when the chain did
      // not answer.
      h.hubState.tokens = null;
      expect(
        await call(
          h.host,
          'chainTransactionHubAction',
          chainInput('n'.repeat(64), [
            { type: 'cosmos.bank.send', toAddress: RECIPIENT, amount: '1' },
          ]),
        ).catch((error: unknown) => error),
      ).toMatchObject({
        name: 'HubActionRefused',
        message:
          'Coin sends are not available for this owner right now (no token list from Auth Hub).',
      });
      expect(h.hubState.posted).toEqual([]);
    });
  });

  it('refuses a chain transaction the account capabilities do not cover, before any POST', async () => {
    await withHub('hub-chain-tx-capabilities', async (h) => {
      await h.channelRun('run-chain');
      h.hubState.prepare = 'ok';
      h.hubState.chainTx = {
        messageTypes: ['cosmos.bank.send'],
        maxMessages: 2,
      };
      expect(
        await call(
          h.host,
          'chainTransactionHubAction',
          chainInput('c'.repeat(64), [submit]),
        ).catch((error: unknown) => error),
      ).toMatchObject({
        name: 'HubActionRefused',
        message:
          'This account cannot use ixo.claims.submit messages (it may use cosmos.bank.send).',
      });
      h.hubState.tokens = [IXO_LISTED];
      const send = {
        type: 'cosmos.bank.send',
        toAddress: RECIPIENT,
        amount: '0.000001',
      };
      expect(
        await call(
          h.host,
          'chainTransactionHubAction',
          chainInput('d'.repeat(64), [send, send, send]),
        ).catch((error: unknown) => error),
      ).toMatchObject({
        name: 'HubActionRefused',
        message: 'This account allows at most 2 messages in one transaction.',
      });
      h.hubState.chainTx = {
        messageTypes: ['ixo.claims.evaluate', 'ixo.token.transfer'],
        maxMessages: 8,
      };
      // A field the protocol refuses (a token line with a control
      // character) is the model's to fix, in the protocol's words.
      expect(
        await call(
          h.host,
          'chainTransactionHubAction',
          chainInput('e'.repeat(64), [
            { ...token, tokens: [{ id: 'CARBON‮', amount: '1' }] },
          ]),
        ).catch((error: unknown) => error),
      ).toMatchObject({
        name: 'HubActionRefused',
        message:
          'The transaction is incomplete (Invalid messages[0].tokens[0].id).',
      });
      expect(h.hubState.posted).toEqual([]);
    });
  });

  it('relays a Hub 400 with its reason through request_chain_transaction', async () => {
    await withHub('hub-chain-tx-400', async (h) => {
      await h.channelRun('run-chain');
      h.hubState.prepare = 'operation_not_registered';
      h.hubState.tokens = [IXO_LISTED];
      const unused = async () => {
        throw new Error('unused');
      };
      const ctx = makeRuntimeContext({
        config: { HUB_ACTIONS_ENABLED: 'true' },
        user: {
          did: OWNER,
          matrixUserId: '@owner:test',
          ucanDelegation: { raw: 'delegation' },
        },
        session: {
          id: SESSION,
          client: 'channel',
          requestId: 'request-run-chain',
          runId: 'run-chain',
          channel: {
            provider: 'whatsapp',
            bindingId: 'chb_one',
            bindingRevision: 2,
          },
        },
        toolCallId: 'tool-chain-400',
        hubActions: {
          capabilities: unused,
          options: unused,
          request: unused,
          chainTransaction: (input) =>
            call(h.host, 'chainTransactionHubAction', input),
          status: unused,
        },
      });
      const tool = new HubActionsPlugin()
        .getTools()
        .find((item) => item.name === 'request_chain_transaction');
      if (!tool) throw new Error('chain transaction tool missing');
      expect(
        await tool.handler(
          {
            messages: [
              {
                type: 'cosmos.bank.send',
                toAddress: RECIPIENT,
                amount: '0.000001',
              },
              {
                type: 'cosmos.bank.send',
                toAddress: ADMIN,
                amount: '0.000002',
              },
            ],
          },
          ctx,
        ),
      ).toEqual({
        status: 'unavailable',
        reason:
          'Auth Hub did not accept this transaction as written: invalid_message: messages[1].toAddress.',
      });
      expect(h.hubState.posted).toHaveLength(1);
      // Not enough for the fee: the Hub's words, as a transaction.
      h.hubState.prepare = 'insufficient_funds';
      expect(
        await tool.handler(
          {
            messages: [
              {
                type: 'cosmos.bank.send',
                toAddress: RECIPIENT,
                amount: '0.000007',
              },
            ],
          },
          makeRuntimeContext({ ...ctx, toolCallId: 'tool-chain-funds' }),
        ),
      ).toEqual({
        status: 'unavailable',
        reason:
          'The account does not hold enough to cover this transaction and its network fee: balance 5 < 7.',
      });
    });
  });

  it('stores a chain transaction outcome with its steps and relays it to the channel unchanged', async () => {
    await withHub('hub-chain-tx-outcome', async (h) => {
      const done = await h.prepared(21);
      const refused = await h.prepared(22);
      const receipt = (ref: ActionReferenceV1) => ({
        kind: 'ixo.chain.tx.v1' as const,
        actionId: ref.id,
        revision: 1,
        digest,
        chainId: 'pandora-77',
        txHash: 'd'.repeat(64),
        steps: [
          { type: 'ixo.claims.submit' as const },
          { type: 'ixo.claims.evaluate' as const },
          { type: 'ixo.token.transfer' as const },
        ],
      });
      const succeeded: ActionOutcomeV1 = {
        ...outcome(done, 3, 'succeeded'),
        version: 'ixo.auth-outcome/2',
        receipt: { ...receipt(done), height: 321, code: 0 },
      };
      const failed: ActionOutcomeV1 = {
        ...outcome(refused, 3, 'failed'),
        version: 'ixo.auth-outcome/2',
        receipt: {
          ...receipt(refused),
          height: 322,
          code: 5,
          reason: 'tx_failed',
          message:
            'The network refused this: you are not authorized to file claims for this collection.',
        },
      };
      // The Hub's callback, confirmed through its status read, is stored.
      for (const event of [succeeded, failed]) {
        h.outcomes.set(event.reference.id, event);
        await call(h.host, 'recordHubActionOutcome', event);
      }
      expect(await h.store.outcomeAt(OWNER, done.id, 3)).toEqual(succeeded);
      expect(await h.store.outcomeAt(OWNER, refused.id, 3)).toEqual(failed);
      // A poll returns both from SQLite, receipts untouched (only the bank
      // receipt is reduced to its 0.4.1 shape), and the 0.6.0 parser a
      // gateway must use accepts them.
      h.setMode('down');
      const relayed = await h.poll();
      expect(relayed).toEqual([succeeded, failed]);
      for (const event of relayed) expect(parseOutcome(event)).toEqual(event);
      // A gateway on the 0.4.1 parser cannot read them.
      expect(() => parseOutcome041(relayed[0])).toThrow();
      // hub_action_status: the outcome, no bank summary line.
      h.setMode('up');
      expect(
        await call(h.host, 'hubActionStatusForTool', OWNER, refused.id),
      ).toEqual({ outcome: failed, summary: null });
    });
  });
});
