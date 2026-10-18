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
  let runStore = new RunStore(db, () => now);
  await store.setup();
  const send = vi.fn(async (_message: MirrorSend) => '$receipt');
  const host: object = Object.create(UserOracleDO.prototype);
  const assignHost = () =>
    Object.assign(host, {
      ctx: state,
      userDid: OWNER,
      env: { ACTION_PROPOSALS_ENABLED: 'true' },
      runStore,
      actionProposals: store,
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
    send,
    async prepare(index: number, sessionId = `$thread-${index}`) {
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
      const hash = 'A'.repeat(64);
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
      return (
        await db.get<{ state: string }>(
          'SELECT state FROM action_proposal_receipts WHERE proposal_id=?',
          [id],
        )
      )?.state;
    },
    async restart() {
      await db.close();
      db = await DoSqliteDatabase.open(state, 'receipts.db');
      store = new ActionProposalStore(db, () => now);
      runStore = new RunStore(db, () => now);
      await store.setup();
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
