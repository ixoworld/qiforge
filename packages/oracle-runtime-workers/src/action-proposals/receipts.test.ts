import { subject as topicSubject, executor } from './fixtures/topic';
import { topicExpectedEffect } from './topic-effects';
import { verifyTopicReference } from './topic-verify';
import { TopicProposalStore } from './topic-store';
import { TopicReadUnavailable, typedTopicError } from './topic-errors';
import { readTopicEvent, resolveTopicIdentity } from './topic-matrix';
import { TopicChainReader } from './topic-chain';
import { TopicProtocolError } from '@ixo/topic-protocol';
import { ZodError } from 'zod';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { ActionProposal } from '@ixo/ixo-transaction/action-proposals';
import { createRuntimeCore } from '../core';
import { makeEnv } from '../core/test-fixtures';
import type { TurnRequest } from '../do/contracts';
import type { ChannelTurnResponse } from '../channels/contract';
import { RoomMirror, type MirrorSend } from '../do/room-mirror';
import { RunStore } from '../do/run-store';
import { storedRunRequest } from '../do/run-request';
import { createUserOracleDO } from '../do/user-oracle-do';
import { DoSqliteDatabase } from '../sqlite/database';
import { NOW, OWNER, RECIPIENT, proposalSubject } from './fixtures/proposal';
import { ActionProposalConflict, ActionProposalStore } from './store';

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
      env: {
        ACTION_PROPOSALS_ENABLED: 'true',
        ACTION_PROPOSALS_RPC_TESTNET: 'https://rpc.test',
      },
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
    store: () => store,
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
    async corruptTopicReference(id: string) {
      await db.run(
        `UPDATE topic_action_steps SET reference='{"kind":"forged"}' WHERE proposal_id=?`,
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
      // An unmarked Matrix turn is not trusted to be a direct chat either.
      await expect(
        h.prepare(2, '$unmarked-thread', {
          client: 'matrix',
          channel: undefined,
        }),
      ).rejects.toThrow('direct chats only');
      const origin = (n: number) => ({
        sessionId: `$thread-${n}`,
        runId: `run-${n}`,
        invocationId: `run-${n}:call`,
      });
      const base = proposalSubject();
      const refused = async (subject: unknown, message: string) =>
        expect(call(h.host, 'prepareActionProposal', subject)).rejects.toThrow(
          message,
        );
      await refused(
        {
          ...proposalSubject({ origin: origin(3) }),
          ownerDid: 'did:ixo:other',
        },
        'owner mismatch',
      );
      await refused(
        {
          ...proposalSubject({ origin: origin(4) }),
          action: { ...base.action, network: 'mainnet', chainId: 'ixo-5' },
        },
        'Mainnet action proposals are disabled',
      );
      await refused(
        {
          ...proposalSubject({ origin: origin(5) }),
          action: { ...base.action, signerAddress: RECIPIENT },
        },
        'signer must be the authenticated account',
      );
      await refused(
        {
          ...proposalSubject({ origin: origin(6) }),
          action: { ...base.action, chainId: 'pandora-9' },
        },
        'Chain ID does not match',
      );
      await refused(
        {
          ...proposalSubject({ origin: origin(7) }),
          action: { ...base.action, network: 'devnet', chainId: 'devnet-1' },
        },
        'No chain endpoint is configured for devnet',
      );
      await refused(
        {
          ...proposalSubject({ origin: origin(8) }),
          expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
        },
        'expiry exceeds the policy window',
      );
      await refused(
        {
          ...proposalSubject({ origin: origin(9) }),
          createdAt: new Date(NOW - 60 * 60_000).toISOString(),
          expiresAt: new Date(NOW - 45 * 60_000).toISOString(),
        },
        'timestamp is not current',
      );
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
      // An unknown card is not found whatever the switches say.
      Object.assign(h.host, { env: {} });
      expect(
        await call(
          h.host,
          'beginTopicStep',
          { userDid: OWNER },
          'ap_00000000-0000-4000-8000-000000000404',
          input,
        ),
      ).toBeNull();
      Object.assign(h.host, {
        env: {
          ACTION_PROPOSALS_ENABLED: 'true',
          ACTION_TOPIC_PROPOSALS_ENABLED: 'true',
        },
      });
      // A step whose reference is recorded is already started, answered
      // from the journal: the host still has no resolver, so an authority
      // read would have been refused as unavailable.
      await topics.begin(
        OWNER,
        p.id,
        input,
        await topicExpectedEffect(p, 'anchor'),
      );
      await topics.recordReference(OWNER, p.id, {
        kind: 'matrix',
        step: 'anchor',
        eventId: '$sent',
      });
      expect(await begin()).toEqual({
        ok: true,
        result: {
          status: 'already_started',
          proposal: expect.objectContaining({ id: p.id }),
        },
      });
      // No topic store at all (it failed to open): retry later, not a conflict.
      Object.assign(h.host, { topicProposals: null });
      expect(await begin()).toEqual({
        ok: false,
        kind: 'unavailable',
        error: 'Topic authority is unavailable',
      });
    });
  });

  it('serves transfer cards, turn outcomes and the alarm when the topic store failed to open', async () => {
    await withReceipts('topic-store-missing', async (h) => {
      const proposal = await h.prepare(1);
      await h.verify(proposal);
      Object.assign(h.host, {
        topicProposals: null,
        ready: async () => undefined,
      });
      const read = JSON.parse(
        (await call<string | null>(
          h.host,
          'actionProposal',
          { userDid: OWNER },
          proposal.id,
        ))!,
      );
      expect(read.proposal.lifecycle.status).toBe('succeeded');
      const outcomes = await call<ChannelTurnResponse>(
        h.host,
        'withActionOutcomes',
        OWNER,
        {
          requestId: 'request-1',
          runId: 'run-1',
          sessionId: '$thread-1',
          status: 'finished',
        },
      );
      expect(outcomes.actionOutcomes).toHaveLength(1);
      expect(await call(h.host, 'tickActionProposals')).toBeUndefined();
      expect(h.send).toHaveBeenCalledTimes(1);
      // An id the transfer store does not know may be a topic card: the
      // Portal is told to retry, not that the card is gone.
      const unavailable = {
        ok: false,
        kind: 'unavailable',
        error: 'Topic authority is unavailable',
      };
      const missing = 'ap_00000000-0000-4000-8000-000000000404';
      expect(
        JSON.parse(
          (await call<string | null>(
            h.host,
            'actionProposal',
            { userDid: OWNER },
            missing,
          ))!,
        ),
      ).toEqual(unavailable);
      expect(
        JSON.parse(
          (await call<string | null>(
            h.host,
            'actionProposal',
            { userDid: OWNER },
            proposal.id,
            { kind: 'topic-reconcile', input: { v: 2, references: [] } },
          ))!,
        ),
      ).toEqual(unavailable);
    });
  });

  it('types authority read failures: rejected content is a conflict, a failed read is unavailable', async () => {
    expect(
      typedTopicError(
        new TopicProtocolError('CONTRACT_VALIDATION_FAILED', 'bad body'),
      ),
    ).toBeInstanceOf(ActionProposalConflict);
    expect(typedTopicError(new ZodError([]))).toBeInstanceOf(
      ActionProposalConflict,
    );
    expect(typedTopicError(new SyntaxError('not json'))).toBeInstanceOf(
      TopicReadUnavailable,
    );
    expect(typedTopicError(new TypeError('fetch failed'))).toBeInstanceOf(
      TopicReadUnavailable,
    );
    expect(() => typedTopicError(new Error('a bug'))).toThrow('a bug');
    // An event the gateway cannot hand over yet.
    await expect(
      readTopicEvent(
        {
          state: async () => [],
          event: async () => null,
          history: async () => [],
        },
        '!room:mx.test',
        '$pending',
      ),
    ).rejects.toBeInstanceOf(TopicReadUnavailable);
    // A GraphQL error envelope from the DID resolver.
    const envelope: typeof fetch = async () =>
      Response.json({ data: null, errors: [{ message: 'boom' }] });
    await expect(
      resolveTopicIdentity(OWNER, 'https://blocksync.test/graphql', envelope),
    ).rejects.toBeInstanceOf(TopicReadUnavailable);
    // A node answer the chain reader does not understand.
    const node: typeof fetch = async () =>
      Response.json({ jsonrpc: '2.0', error: { code: -32601 } });
    await expect(
      new TopicChainReader('https://rpc.test', 'pandora-8', node).checkChain(),
    ).rejects.toBeInstanceOf(TopicReadUnavailable);
  });

  it('serves topic cards, turn outcomes and the alarm when the transfer store failed to open', async () => {
    await withReceipts('transfer-store-missing', async (h) => {
      const topics = h.topics();
      const p = await topics.create(await topicSubject());
      Object.assign(h.host, { ready: async () => undefined });
      // Both stores up: an id neither knows is simply not found.
      expect(
        await call(
          h.host,
          'actionProposal',
          { userDid: OWNER },
          'ap_00000000-0000-4000-8000-000000000404',
        ),
      ).toBeNull();
      Object.assign(h.host, { actionProposals: null });
      expect(
        JSON.parse(
          (await call<string | null>(
            h.host,
            'actionProposal',
            { userDid: OWNER },
            p.id,
          ))!,
        ),
      ).toEqual({ ok: true, proposal: expect.objectContaining({ id: p.id }) });
      const outcomes = await call<ChannelTurnResponse>(
        h.host,
        'withActionOutcomes',
        OWNER,
        {
          requestId: 'request-1',
          runId: p.origin.runId,
          sessionId: p.origin.sessionId,
          status: 'finished',
        },
      );
      expect(outcomes.actionOutcomes).toHaveLength(1);
      expect(await call(h.host, 'tickActionProposals')).toBeUndefined();
      // A transfer card's id is unavailable, not gone, while its store is down.
      expect(
        JSON.parse(
          (await call<string | null>(
            h.host,
            'actionProposal',
            { userDid: OWNER },
            'ap_00000000-0000-4000-8000-000000000001',
          ))!,
        ),
      ).toEqual({
        ok: false,
        kind: 'unavailable',
        error: 'Action cards are unavailable',
      });
    });
  });

  it('quarantines a topic card whose recorded reference no longer parses instead of ticking every second', async () => {
    await withReceipts('topic-tick-quarantine', async (h) => {
      const topics = h.topics();
      const p = await topics.create(await topicSubject());
      await topics.transition(OWNER, p.id, 'claim', p.digest);
      const input = { digest: p.digest, step: 'anchor' as const, executor };
      await topics.begin(
        OWNER,
        p.id,
        input,
        await topicExpectedEffect(p, 'anchor'),
      );
      await topics.recordReference(OWNER, p.id, {
        kind: 'matrix',
        step: 'anchor',
        eventId: '$sent',
      });
      expect(await topics.nextVerificationAt(OWNER)).toBe(NOW);
      await h.corruptTopicReference(p.id);
      // The attempt is spent, the row quarantined, nothing scheduled again.
      expect(await call(h.host, 'tickActionProposals')).toBeUndefined();
      expect(await topics.nextVerificationAt(OWNER)).toBeUndefined();
      expect(await topics.dueVerifications(OWNER)).toEqual([]);
    });
  });

  it('backs off a card whose network lost its RPC instead of ticking every second', async () => {
    await withReceipts('receipt-no-rpc', async (h) => {
      const proposal = await h.prepare(1);
      await h.store().transition(OWNER, proposal.id, {
        kind: 'claim',
        digest: proposal.digest,
      });
      await h.store().transition(OWNER, proposal.id, {
        kind: 'reconcile',
        transactionHash: 'D'.repeat(64),
      });
      Object.assign(h.host, { env: { ACTION_PROPOSALS_ENABLED: 'true' } });
      let now = NOW;
      const waits: number[] = [];
      for (let i = 0; i < 12; i++) {
        h.setNow(now);
        const next = await call<number | undefined>(
          h.host,
          'tickActionProposals',
        );
        if (next === undefined) break;
        expect(next).toBeGreaterThanOrEqual(now + 30_000);
        waits.push(next - now);
        now = next;
      }
      // Ten attempts spent: nine waits between them, then nothing scheduled.
      expect(waits).toHaveLength(9);
      expect(waits[0]).toBe(30_000);
      expect(waits.at(-1)).toBe(600_000);
      expect(await call(h.host, 'tickActionProposals')).toBeUndefined();
      // A row this build cannot read drops out of the schedule too. (The
      // clock goes back: a card stamped an hour ago is refused as stale.)
      h.setNow(NOW);
      Object.assign(h.host, {
        env: {
          ACTION_PROPOSALS_ENABLED: 'true',
          ACTION_PROPOSALS_RPC_TESTNET: 'https://rpc.test',
        },
      });
      const second = await h.prepare(2);
      await h.store().transition(OWNER, second.id, {
        kind: 'claim',
        digest: second.digest,
      });
      await h.store().transition(OWNER, second.id, {
        kind: 'reconcile',
        transactionHash: 'E'.repeat(64),
      });
      await h.corruptSubject(second.id);
      expect(await h.store().dueVerifications(OWNER)).toEqual([]);
      expect(await call(h.host, 'tickActionProposals')).toBeUndefined();
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
