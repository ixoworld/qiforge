import { subject as topicSubject, executor } from './fixtures/topic';
import { topicExpectedEffect } from './topic-effects';
import { verifyTopicReference } from './topic-verify';
import { TopicProposalStore } from './topic-store';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { ActionProposal } from '@ixo/ixo-transaction/action-proposals';
import { createRuntimeCore } from '../core';
import { makeEnv } from '../core/test-fixtures';
import type { TurnRequest } from '../do/contracts';
import { RoomMirror, type MirrorSend } from '../do/room-mirror';
import { RunStore } from '../do/run-store';
import { storedRunRequest } from '../do/run-request';
import { createUserOracleDO } from '../do/user-oracle-do';
import { DoSqliteDatabase } from '../sqlite/database';
import { NOW, OWNER, proposalSubject } from './fixtures/proposal';
import { ActionProposalStore } from './store';

async function call<T>(
  host: object,
  name: string,
  ...args: unknown[]
): Promise<T> {
  return Reflect.apply(Reflect.get(host, name), host, args);
}

const core = createRuntimeCore({
  config: { name: 'Qi' },
  env: makeEnv(),
  plugins: [],
});
const UserOracleDO = createUserOracleDO({ core: () => core });

async function withReceipts(
  name: string,
  test: (setup: Awaited<ReturnType<typeof harness>>) => Promise<void>,
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

async function harness(state: DurableObjectState) {
  let now = NOW;
  let db = await DoSqliteDatabase.open(state, 'receipts.db');
  let store = new ActionProposalStore(db, () => now);
  let topicStore = new TopicProposalStore(db, () => now);
  let runStore = new RunStore(db, () => now);
  await store.setup();
  await topicStore.setup();
  const send = vi.fn(async (_message: MirrorSend) => '$receipt');
  const host: object = Object.create(UserOracleDO.prototype);
  const assignHost = () =>
    Object.assign(host, {
      ctx: state,
      userDid: OWNER,
      env: { ACTION_PROPOSALS_ENABLED: 'true' },
      runStore,
      actionProposals: store,
      topicProposals: topicStore,
      sessionRooms: new Map<string, string>(),
      markDirty: vi.fn(),
      mirror: new RoomMirror({
        sendText: send,
        keepAlive: () => undefined,
        log: () => undefined,
        warn: () => undefined,
        retry: { delaysMs: [] },
      }),
    });
  assignHost();
  return {
    host,
    topics: () => topicStore,
    send,
    async prepare(
      index: number,
      sessionId = `$thread-${index}`,
      turn: Partial<TurnRequest> = {},
    ) {
      const subject = proposalSubject({
        id: `ap_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        origin: {
          sessionId,
          runId: `run-${index}`,
          invocationId: `run-${index}:call`,
        },
      });
      const request: TurnRequest = {
        identity: { userDid: OWNER },
        sessionId,
        requestId: `request-${index}`,
        client: 'channel',
        roomId: '!origin:matrix.test',
        message: 'Send the tokens',
        channel: {
          provider: 'whatsapp',
          bindingId: 'chb_original',
          remoteMessageRef: `hmac:${'a'.repeat(64)}`,
        },
        ...turn,
      };
      await runStore.create({
        runId: subject.origin.runId,
        sessionId,
        requestId: request.requestId,
        client: request.client,
        status: 'running',
        request: JSON.stringify(storedRunRequest(request)),
        checkpointId: null,
        instanceId: 'instance',
      });
      return call<ActionProposal>(host, 'prepareActionProposal', subject);
    },
    async verify(proposal: ActionProposal) {
      // One transaction per card: the hash is unique to the proposal.
      const hash = 'A'.repeat(52) + proposal.id.slice(-12);
      await store.transition(OWNER, proposal.id, {
        kind: 'claim',
        digest: proposal.digest,
      });
      await store.transition(OWNER, proposal.id, {
        kind: 'reconcile',
        transactionHash: hash,
      });
      await store.recordVerified(OWNER, proposal.id, {
        transactionHash: hash,
        code: 0,
        height: 12,
        verifiedAt: new Date(now).toISOString(),
      });
    },
    drain: () => call<number | undefined>(host, 'mirrorActionReceipts'),
    setNow(value: number) {
      now = value;
    },
    async deleteRuns() {
      await db.run('DELETE FROM turn_runs');
    },
    async runExists(id: string) {
      return Boolean(await runStore.get(id));
    },
    async receiptState(id: string) {
      return (await this.receiptRow(id))?.state;
    },
    async receiptRow(id: string) {
      return db.get<{ state: string; next_attempt: number; attempts: number }>(
        'SELECT state,next_attempt,attempts FROM action_proposal_receipts WHERE proposal_id=?',
        [id],
      );
    },
    async corruptSubject(id: string) {
      await db.run(
        `UPDATE action_proposals SET subject=json_set(subject,'$.title','Tampered') WHERE id=?`,
        [id],
      );
    },
    async restart() {
      await db.close();
      db = await DoSqliteDatabase.open(state, 'receipts.db');
      store = new ActionProposalStore(db, () => now);
      topicStore = new TopicProposalStore(db, () => now);
      runStore = new RunStore(db, () => now);
      await store.setup();
      await topicStore.setup();
      assignHost();
    },
    async wrongOwnerReceipts() {
      return store.takeReceipts('did:ixo:other');
    },
    async close() {
      await db.close();
    },
  };
}

describe('durable canonical action receipts', () => {
  it('handles four local sessions without calling them delivered or starving the next canonical receipt', async () => {
    await withReceipts('receipt-local-fairness', async (h) => {
      const local = [];
      for (let i = 1; i <= 4; i++) {
        const proposal = await h.prepare(i, `local-${i}`);
        await h.verify(proposal);
        local.push(proposal);
      }
      const valid = await h.prepare(5);
      await h.verify(valid);
      expect(await h.drain()).toBeUndefined();
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.send.mock.calls[0]?.[0].threadId).toBe('$thread-5');
      for (const proposal of local)
        expect(await h.receiptState(proposal.id)).toBe('unavailable');
      expect(await h.receiptState(valid.id)).toBe('delivered');
      expect(await h.drain()).toBeUndefined();
    });
  });

  it('keeps the trusted original room and channel across run pruning and owner restart', async () => {
    await withReceipts('receipt-pruned-run', async (h) => {
      const proposal = await h.prepare(1);
      await h.verify(proposal);
      await h.deleteRuns();
      expect(await h.runExists(proposal.origin.runId)).toBe(false);
      h.setNow(NOW + 8 * 24 * 60 * 60 * 1000);
      await h.restart();
      expect(await h.wrongOwnerReceipts()).toEqual([]);
      expect(await h.drain()).toBeUndefined();
      expect(h.send).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: '!origin:matrix.test',
          threadId: '$thread-1',
          origin: expect.objectContaining({ bindingId: 'chb_original' }),
          body: expect.stringContaining('confirmed on chain'),
        }),
      );
      await h.restart();
      expect(await h.drain()).toBeUndefined();
      expect(h.send).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses a card asked for in a group room and enforces the owner policy', async () => {
    await withReceipts('receipt-policy', async (h) => {
      await expect(
        h.prepare(1, '$group-thread', {
          client: 'matrix',
          roomKind: 'group',
          channel: undefined,
        }),
      ).rejects.toThrow('direct chats only');
      await expect(
        call(h.host, 'prepareActionProposal', {
          ...proposalSubject({
            origin: {
              sessionId: '$thread-2',
              runId: 'run-2',
              invocationId: 'run-2:call',
            },
          }),
          action: {
            ...proposalSubject().action,
            network: 'mainnet',
            chainId: 'ixo-5',
          },
        }),
      ).rejects.toThrow('Mainnet action proposals are disabled');
      expect(h.send).not.toHaveBeenCalled();
    });
  });

  it('answers topic step requests with the switch, the local checks and then the authority read', async () => {
    await withReceipts('topic-begin-kinds', async (h) => {
      const topics = h.topics();
      const p = await topics.create(await topicSubject());
      const input = { digest: p.digest, step: 'anchor' as const, executor };
      const begin = async () =>
        JSON.parse(
          (await call<string | null>(
            h.host,
            'beginTopicStep',
            { userDid: OWNER },
            p.id,
            input,
          ))!,
        );
      Object.assign(h.host, { ready: async () => undefined });
      // Both switches off: a conflict, no reads.
      expect(await begin()).toEqual({
        ok: false,
        kind: 'conflict',
        error: 'Topic action execution is disabled',
      });
      Object.assign(h.host, {
        env: {
          ACTION_PROPOSALS_ENABLED: 'true',
          ACTION_TOPIC_PROPOSALS_ENABLED: 'true',
        },
      });
      // Not claimed: refused locally before any authority read (the host
      // has no gateway at all, so a remote read would not be a conflict).
      expect(await begin()).toEqual({
        ok: false,
        kind: 'conflict',
        error: 'Proposal was not claimed',
      });
      await topics.transition(OWNER, p.id, 'claim', p.digest);
      // Claimed, but no DID resolver configured: the authority read fails,
      // and the Portal is told to retry later rather than that it conflicted.
      expect(await begin()).toEqual({
        ok: false,
        kind: 'unavailable',
        error: 'Topic authority is unavailable',
      });
      expect(h.send).not.toHaveBeenCalled();
    });
  });

  it('quarantines a receipt whose card no longer verifies instead of retrying it for ever', async () => {
    await withReceipts('receipt-quarantine', async (h) => {
      const bad = await h.prepare(1);
      await h.verify(bad);
      const good = await h.prepare(2);
      await h.verify(good);
      await h.corruptSubject(bad.id);
      expect(await h.drain()).toBeUndefined();
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.send.mock.calls[0]?.[0].threadId).toBe('$thread-2');
      expect(await h.receiptState(bad.id)).toBe('quarantined');
      expect(await h.receiptState(good.id)).toBe('delivered');
    });
  });

  it('backs off a failing receipt exponentially and abandons it after the cap', async () => {
    await withReceipts('receipt-backoff', async (h) => {
      const proposal = await h.prepare(1);
      await h.verify(proposal);
      h.send.mockRejectedValue(new Error('room refuses the oracle'));
      let now = NOW;
      const waits: number[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        h.setNow(now);
        const next = await h.drain();
        if (next === undefined) break;
        waits.push(next - now);
        now = next;
      }
      expect(waits).toEqual([
        30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000,
        3_600_000, 3_600_000, 3_600_000, 3_600_000,
      ]);
      expect(await h.receiptRow(proposal.id)).toMatchObject({
        state: 'abandoned',
        attempts: 12,
      });
      expect(h.send).toHaveBeenCalledTimes(12);
    });
  });

  it('moves failures behind other due receipts and retries with the same transaction id after restart', async () => {
    await withReceipts('receipt-retry-fairness', async (h) => {
      for (let i = 1; i <= 5; i++) await h.verify(await h.prepare(i));
      h.send.mockRejectedValue(new Error('permanent gateway failure'));
      expect(await h.drain()).toBe(NOW);
      expect(h.send).toHaveBeenCalledTimes(4);
      const original = h.send.mock.calls.map(([message]) => message);
      h.send.mockResolvedValue('$receipt');
      expect(await h.drain()).toBe(NOW + 30_000);
      expect(h.send).toHaveBeenCalledTimes(5);
      expect(h.send.mock.calls[4]?.[0].threadId).toBe('$thread-5');
      await h.restart();
      expect(await h.drain()).toBe(NOW + 30_000);
      expect(h.send).toHaveBeenCalledTimes(5);
      h.setNow(NOW + 30_001);
      expect(await h.drain()).toBeUndefined();
      expect(
        h.send.mock.calls.slice(5).map(([message]) => message.txnId),
      ).toEqual(original.map((message) => message.txnId));
      expect(h.send).toHaveBeenCalledTimes(9);
    });
  });
});

it('a delayed topic completion found by GET schedules the original conversation receipt', async () => {
  await withReceipts('topic-read-completion', async (h) => {
    const store = h.topics();
    const input = await topicSubject();
    let p = await store.create(input, {
      sessionId: '$original',
      roomId: '!origin:matrix.test',
      client: 'channel',
    });
    p = (await store.transition(OWNER, p.id, 'claim', p.digest))!;
    const events = new Map<string, unknown>();
    const states: unknown[] = [];
    const reader = {
      state: async () => states,
      event: async (_room: string, id: string) => events.get(id),
      history: async () => [events.get('$operation')],
    };
    for (const step of ['anchor', 'body', 'operation', 'snapshot'] as const) {
      const effect = await topicExpectedEffect(p, step);
      await store.begin(
        OWNER,
        p.id,
        { digest: p.digest, step, executor },
        effect,
      );
      if (effect.kind !== 'matrix') throw new Error('Expected Matrix');
      const eventId = `$${step}`;
      events.set(eventId, {
        event_id: eventId,
        room_id: effect.roomId,
        sender: effect.sender,
        type: effect.eventType,
        content: effect.content,
        ...(effect.stateKey ? { state_key: effect.stateKey } : {}),
      });
      const reference = { kind: 'matrix' as const, step, eventId };
      await store.recordReference(OWNER, p.id, reference);
      if (step === 'snapshot') states.push(events.get(eventId));
      else
        p = await store.verifyStep(
          OWNER,
          p.id,
          step,
          await verifyTopicReference(p, effect, reference, {
            reader,
            blocksync: undefined,
            rpc: undefined,
          }),
        );
    }
    const requestHousekeeping = vi.fn(async () => {});
    Object.assign(h.host, {
      ready: async () => {},
      requestHousekeeping,
    });
    Object.defineProperty(h.host, 'gateway', {
      value: {
        getTopicRoomState: async () => JSON.stringify(states),
        getTopicEvent: async (_room: string, id: string) =>
          JSON.stringify(events.get(id)),
        getTopicHistory: async () => JSON.stringify([events.get('$operation')]),
      },
      configurable: true,
    });
    const result = JSON.parse(
      (await call<string>(h.host, 'actionProposal', { userDid: OWNER }, p.id))!,
    );
    expect(result.proposal.lifecycle.status).toBe('succeeded');
    expect(requestHousekeeping).toHaveBeenCalledOnce();
    await h.drain();
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: '!origin:matrix.test',
        threadId: '$original',
        body: expect.stringContaining('created'),
      }),
    );
  });
});
