import { indexedTransaction } from './fixtures/transaction';
import { parseActionProposal } from '@ixo/ixo-transaction/action-proposals';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ActionProposalTestDO } from './test-do';
import { OWNER, NOW, proposalSubject } from './fixtures/proposal';
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      ACTION_PROPOSAL_TEST: DurableObjectNamespace<ActionProposalTestDO>;
    }
  }
}
function stub(name: string) {
  const s = env.ACTION_PROPOSAL_TEST.get(
    env.ACTION_PROPOSAL_TEST.idFromName(name),
  );
  const parse = (p: string | null) =>
    p ? parseActionProposal(JSON.parse(p)) : null;
  return {
    create: async (...args: Parameters<typeof s.create>) =>
      parseActionProposal(JSON.parse(await s.create(...args))),
    get: async (...args: Parameters<typeof s.get>) =>
      parse(await s.get(...args)),
    transition: async (...args: Parameters<typeof s.transition>) =>
      parse(await s.transition(...args)),
    verified: async (...args: Parameters<typeof s.verified>) =>
      parse(await s.verified(...args)),
    refresh: async (...args: Parameters<typeof s.refresh>) =>
      parse(await s.refresh(...args)),
    outcomes: (...args: Parameters<typeof s.outcomes>) => s.outcomes(...args),
    due: (owner: string) => s.due(owner),
    nextVerification: (owner: string) => s.nextVerification(owner),
    prune: (owner: string) => s.prune(owner),
    legacyTable: () => s.legacyTable(),
    closeUnexecuted: (owner: string) => s.closeUnexecuted(owner),
    nextClose: (owner: string) => s.nextClose(owner),
    hashColumn: (id: string) => s.hashColumn(id),
    verifyAttempts: (id: string) => s.verifyAttempts(id),
    queryPlan: (sql: string, params: unknown[]) => s.queryPlan(sql, params),
    setNow: (now: number) => s.setNow(now),
    reopen: () => s.reopen(),
  };
}
describe('durable action proposals', () => {
  it('persists exact subject across reopen and scopes reads to owner', async () => {
    const s = stub('reopen');
    const p = await s.create(proposalSubject());
    await s.reopen();
    expect(await s.get(OWNER, p.id)).toEqual(p);
    expect(await s.get('did:ixo:other', p.id)).toBeNull();
    expect(
      await s.transition('did:ixo:other', p.id, {
        kind: 'claim',
        digest: p.digest,
      }),
    ).toBeNull();
  });
  it('claims once across concurrent devices and never retries unknown effects', async () => {
    const s = stub('concurrent');
    const p = await s.create(proposalSubject());
    const claims = await Promise.allSettled([
      s.transition(OWNER, p.id, { kind: 'claim', digest: p.digest }),
      s.transition(OWNER, p.id, { kind: 'claim', digest: p.digest }),
    ]);
    expect(claims.filter((c) => c.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await s.transition(OWNER, p.id, { kind: 'reconcile' }))?.lifecycle
        .status,
    ).toBe('unknown');
    await s.reopen();
    await expect(
      s.transition(OWNER, p.id, { kind: 'claim', digest: p.digest }),
    ).rejects.toThrow('already consumed');
  });
  it('rejects mutated digests, fixed expiry, revocation, and supersession', async () => {
    for (const kind of ['revoke', 'supersede'] as const) {
      const s = stub(kind);
      const p = await s.create(proposalSubject());
      await s.transition(OWNER, p.id, { kind, digest: p.digest });
      await expect(
        s.transition(OWNER, p.id, { kind: 'claim', digest: p.digest }),
      ).rejects.toThrow('already consumed');
    }
    const s = stub('expiry');
    const p = await s.create(proposalSubject());
    await expect(
      s.transition(OWNER, p.id, { kind: 'claim', digest: '0'.repeat(64) }),
    ).rejects.toThrow('changed');
    await s.setNow(NOW + 900001);
    await expect(
      s.transition(OWNER, p.id, { kind: 'claim', digest: p.digest }),
    ).rejects.toThrow('expired');
  });
  it('returns original proposal for retry while allowing intentional repeated actions', async () => {
    const s = stub('retry');
    const subject = proposalSubject();
    const p = await s.create(subject);
    // The retried call mints a new id and memo for the same invocation.
    expect(
      await s.create(proposalSubject({ id: `ap_${crypto.randomUUID()}` })),
    ).toEqual(p);
    const next = await s.create(
      proposalSubject({
        origin: {
          ...subject.origin,
          invocationId: 'run-2:call-2',
          runId: 'run-2',
        },
      }),
    );
    expect(next.id).not.toBe(p.id);
    await expect(s.create({ ...subject, title: 'Changed' })).rejects.toThrow(
      'different values',
    );
  });
  it('eventually verifies a recorded transaction after indexing without another signing or Portal reconcile', async () => {
    const s = stub('index-later');
    const p = await s.create(proposalSubject());
    const tx = await indexedTransaction(p);
    await s.transition(OWNER, p.id, { kind: 'claim', digest: p.digest });
    await s.transition(OWNER, p.id, {
      kind: 'reconcile',
      transactionHash: tx.hash,
    });
    expect((await s.refresh(OWNER, p.id, null))?.lifecycle.status).toBe(
      'unknown',
    );
    await s.reopen();
    await s.setNow(NOW + 30_001);
    expect((await s.refresh(OWNER, p.id, tx.json))?.lifecycle.status).toBe(
      'succeeded',
    );
    expect((await s.outcomes(OWNER, 'session-1', 'run-1'))[0]?.status).toBe(
      'succeeded',
    );
    await expect(
      s.transition(OWNER, p.id, { kind: 'claim', digest: p.digest }),
    ).rejects.toThrow('already consumed');
  });
  it('refuses a transaction hash another card of the owner already recorded', async () => {
    const s = stub('one-tx-one-card');
    const first = await s.create(proposalSubject());
    const second = await s.create(
      proposalSubject({
        origin: {
          sessionId: 'session-1',
          runId: 'run-2',
          invocationId: 'run-2:call-1',
        },
      }),
    );
    const hash = 'B'.repeat(64);
    for (const p of [first, second])
      await s.transition(OWNER, p.id, { kind: 'claim', digest: p.digest });
    await s.transition(OWNER, first.id, {
      kind: 'reconcile',
      transactionHash: hash,
    });
    await expect(
      s.transition(OWNER, second.id, {
        kind: 'reconcile',
        transactionHash: hash,
      }),
    ).rejects.toThrow('already recorded for another proposal');
    expect(
      (await s.transition(OWNER, second.id, { kind: 'reconcile' }))?.lifecycle,
    ).toEqual({ status: 'unknown', claimedAt: expect.any(String) });
  });
  it('schedules background lookups with a doubling cooldown and gives up after the cap', async () => {
    const s = stub('verify-backoff');
    const p = await s.create(proposalSubject());
    const tx = await indexedTransaction(p);
    await s.transition(OWNER, p.id, { kind: 'claim', digest: p.digest });
    expect(await s.due(OWNER)).toEqual([]);
    expect(await s.nextVerification(OWNER)).toBeUndefined();
    await s.transition(OWNER, p.id, {
      kind: 'reconcile',
      transactionHash: tx.hash,
    });
    // The first lookup waits 30 s: the Portal may report the hash of the
    // signed bytes before it broadcasts them.
    expect(await s.due(OWNER)).toEqual([]);
    expect(await s.nextVerification(OWNER)).toBe(NOW + 30_000);
    let now = NOW + 30_000;
    const waits: number[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await s.setNow(now);
      expect(await s.due(OWNER)).toEqual([p.id]);
      await s.refresh(OWNER, p.id, 'unavailable');
      const next = await s.nextVerification(OWNER);
      if (next === undefined) break;
      waits.push(next - now);
      expect(await s.due(OWNER)).toEqual([]);
      now = next;
    }
    expect(waits).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000,
      600_000,
    ]);
    expect(await s.nextVerification(OWNER)).toBeUndefined();
    expect(await s.due(OWNER)).toEqual([]);
    // A Portal reconcile still looks the transaction up once the cooldown
    // has passed, however many attempts the alarm made.
    await s.setNow(now + 600_000);
    expect((await s.refresh(OWNER, p.id, tx.json))?.lifecycle.status).toBe(
      'succeeded',
    );
  });
  it('accepts a hash the chain does not know yet, waits before the first lookup and is idempotent on the same hash', async () => {
    const s = stub('pre-broadcast-hash');
    const p = await s.create(proposalSubject());
    const tx = await indexedTransaction(p);
    await s.transition(OWNER, p.id, { kind: 'claim', digest: p.digest });
    // (a) The Portal's fire-and-forget reconcile with the hash of the
    // signed bytes, before broadcast: accepted, scheduled, not looked up.
    const first = await s.transition(OWNER, p.id, {
      kind: 'reconcile',
      transactionHash: tx.hash,
    });
    expect(first?.lifecycle).toMatchObject({
      status: 'unknown',
      transactionHash: tx.hash,
    });
    expect(await s.nextVerification(OWNER)).toBe(NOW + 30_000);
    expect((await s.refresh(OWNER, p.id, null))?.lifecycle.status).toBe(
      'unknown',
    );
    // (c) The normal reconcile after broadcast, same hash: same card, same
    // schedule (no reset, no conflict).
    await s.setNow(NOW + 10_000);
    const second = await s.transition(OWNER, p.id, {
      kind: 'reconcile',
      transactionHash: tx.hash.toLowerCase(),
    });
    expect(second?.lifecycle).toEqual(first?.lifecycle);
    expect(await s.nextVerification(OWNER)).toBe(NOW + 30_000);
    // (b) Not found inside the two-minute grace: rescheduled, the attempt
    // given back. Three not-founds in the grace window spend nothing.
    for (const at of [NOW + 30_000, NOW + 60_000, NOW + 90_000]) {
      await s.setNow(at);
      expect((await s.refresh(OWNER, p.id, null))?.lifecycle.status).toBe(
        'unknown',
      );
      expect(await s.nextVerification(OWNER)).toBe(at + 30_000);
    }
    expect(await s.verifyAttempts(p.id)).toBe(0);
    // Past the grace window a not-found is an ordinary attempt.
    await s.setNow(NOW + 120_000);
    await s.refresh(OWNER, p.id, null);
    expect(await s.verifyAttempts(p.id)).toBe(1);
    await s.setNow(NOW + 150_000);
    expect((await s.refresh(OWNER, p.id, tx.json))?.lifecycle.status).toBe(
      'succeeded',
    );
  });
  it('rebuilds the pre-release table shape instead of failing every request', async () => {
    const s = stub('legacy-shape');
    await s.legacyTable();
    const p = await s.create(proposalSubject());
    expect(await s.get(OWNER, p.id)).toEqual(p);
    expect(
      await s.get('did:ixo:legacy', 'ap_00000000-0000-4000-8000-00000000dead'),
    ).toBeNull();
    await s.reopen();
    expect(await s.get(OWNER, p.id)).toEqual(p);
  });
  it('lets the owner replace a recorded hash the verifier proved is another transaction', async () => {
    const s = stub('wrong-hash');
    const p = await s.create(proposalSubject());
    const other = await s.create(
      proposalSubject({
        origin: {
          sessionId: 'session-1',
          runId: 'run-2',
          invocationId: 'run-2:call-1',
        },
      }),
    );
    // A real transaction, but signed for the OTHER card (its memo).
    const wrong = await indexedTransaction(other);
    const right = await indexedTransaction(p);
    await s.transition(OWNER, p.id, { kind: 'claim', digest: p.digest });
    await s.transition(OWNER, p.id, {
      kind: 'reconcile',
      transactionHash: wrong.hash,
    });
    // Before the verifier has spoken, the recorded hash is final.
    await expect(
      s.transition(OWNER, p.id, {
        kind: 'reconcile',
        transactionHash: right.hash,
      }),
    ).rejects.toThrow('already recorded');
    // A node answering with bytes that do not hash to the hash asked for is
    // a faulty node, not a proof: the recorded hash stays final.
    const faulty = JSON.stringify({
      result: {
        hash: wrong.hash,
        height: '42',
        tx: btoa('garbage'),
        tx_result: { code: 0 },
      },
    });
    await s.setNow(NOW + 30_000);
    expect((await s.refresh(OWNER, p.id, faulty))?.lifecycle.status).toBe(
      'unknown',
    );
    await expect(
      s.transition(OWNER, p.id, {
        kind: 'reconcile',
        transactionHash: right.hash,
      }),
    ).rejects.toThrow('already recorded');
    // An unknown card that is not blocked cannot be revoked.
    await expect(
      s.transition(OWNER, p.id, { kind: 'revoke', digest: p.digest }),
    ).rejects.toThrow('already consumed');
    // The faulty answer spent the cooldown slot; the next look-up waits.
    await s.setNow(NOW + 61_000);
    expect((await s.refresh(OWNER, p.id, wrong.json))?.lifecycle.status).toBe(
      'unknown',
    );
    // Memo mismatch proved it is not this card's: the right hash may replace it.
    const replaced = await s.transition(OWNER, p.id, {
      kind: 'reconcile',
      transactionHash: right.hash,
    });
    expect(replaced?.lifecycle).toMatchObject({
      status: 'unknown',
      transactionHash: right.hash,
    });
    // A replacing hash gets a fresh schedule, first lookup after 30 s.
    await s.setNow(NOW + 91_000);
    expect((await s.refresh(OWNER, p.id, right.json))?.lifecycle.status).toBe(
      'succeeded',
    );
  });
  it('blocks a card whose memo-bound transaction carries other messages instead of forgetting it', async () => {
    const s = stub('memo-bound-mismatch');
    const p = await s.create(proposalSubject());
    // Signed with THIS card's memo, but for twice the amount: the owner's
    // card-bound effect went wrong, which is not the same as a wrong hash.
    const tampered = await indexedTransaction({
      ...p,
      action: proposalSubject({ id: p.id }, '3000000').action,
    });
    const right = await indexedTransaction(p);
    await s.transition(OWNER, p.id, { kind: 'claim', digest: p.digest });
    await s.transition(OWNER, p.id, {
      kind: 'reconcile',
      transactionHash: tampered.hash,
    });
    await s.setNow(NOW + 30_000);
    const blocked = await s.refresh(OWNER, p.id, tampered.json);
    expect(blocked?.lifecycle).toMatchObject({
      status: 'unknown',
      transactionHash: tampered.hash,
      executionBlockedAt: expect.any(String),
    });
    // The hash stays listed and may not be replaced; nothing is scheduled.
    await expect(
      s.transition(OWNER, p.id, {
        kind: 'reconcile',
        transactionHash: right.hash,
      }),
    ).rejects.toThrow('Execution is blocked');
    expect(await s.due(OWNER)).toEqual([]);
    expect(await s.nextVerification(OWNER)).toBeUndefined();
    expect((await s.refresh(OWNER, p.id, right.json))?.lifecycle).toMatchObject(
      { status: 'unknown', transactionHash: tampered.hash },
    );
    // Asking about the listed hash again returns the card (Portal recovery);
    // revoking is the one command the blocked card still takes.
    expect(
      (
        await s.transition(OWNER, p.id, {
          kind: 'reconcile',
          transactionHash: tampered.hash,
        })
      )?.lifecycle.status,
    ).toBe('unknown');
    expect(
      (await s.transition(OWNER, p.id, { kind: 'revoke', digest: p.digest }))
        ?.lifecycle,
    ).toMatchObject({ status: 'revoked' });
    // The memo-bound hash survives the revoke in the indexed column: no
    // other card may record it.
    expect(await s.hashColumn(p.id)).toBe(tampered.hash);
    const other = await s.create(
      proposalSubject({
        origin: {
          sessionId: 'session-1',
          runId: 'run-2',
          invocationId: 'run-2:call-1',
        },
      }),
    );
    await s.transition(OWNER, other.id, {
      kind: 'claim',
      digest: other.digest,
    });
    await expect(
      s.transition(OWNER, other.id, {
        kind: 'reconcile',
        transactionHash: tampered.hash,
      }),
    ).rejects.toThrow('already recorded for another proposal');
  });
  it('closes a claimed card that never recorded a transaction after the execution window, never back to prepared', async () => {
    const s = stub('unexecuted-close');
    const cancelled = await s.create(proposalSubject());
    await s.transition(OWNER, cancelled.id, {
      kind: 'claim',
      digest: cancelled.digest,
    });
    // A wallet cancel: Portal reconciles with no hash.
    await s.transition(OWNER, cancelled.id, { kind: 'reconcile' });
    const signed = await s.create(
      proposalSubject({
        origin: {
          sessionId: 'session-1',
          runId: 'run-2',
          invocationId: 'run-2:call-1',
        },
      }),
    );
    await s.transition(OWNER, signed.id, {
      kind: 'claim',
      digest: signed.digest,
    });
    await s.transition(OWNER, signed.id, {
      kind: 'reconcile',
      transactionHash: 'B'.repeat(64),
    });
    expect(await s.nextClose(OWNER)).toBe(NOW + 60 * 60_000);
    expect(await s.closeUnexecuted(OWNER)).toBe(0);
    await s.setNow(NOW + 60 * 60_000);
    expect(await s.closeUnexecuted(OWNER)).toBe(1);
    expect((await s.get(OWNER, cancelled.id))?.lifecycle).toEqual({
      status: 'revoked',
      endedAt: new Date(NOW + 60 * 60_000).toISOString(),
    });
    // A card with a recorded hash is the verifier's, not this sweep's.
    expect((await s.get(OWNER, signed.id))?.lifecycle.status).toBe('unknown');
    expect(await s.nextClose(OWNER)).toBeUndefined();
    await expect(
      s.transition(OWNER, cancelled.id, {
        kind: 'claim',
        digest: cancelled.digest,
      }),
    ).rejects.toThrow('already consumed');
  });
  it('caps cards per run and open cards per owner', async () => {
    const s = stub('caps');
    const subject = (run: number, call: number) =>
      proposalSubject({
        origin: {
          sessionId: 'session-1',
          runId: `run-${run}`,
          invocationId: `run-${run}:call-${call}`,
        },
      });
    for (let call = 0; call < 8; call++) await s.create(subject(1, call));
    await expect(s.create(subject(1, 8))).rejects.toThrow(
      'Too many action cards in this request',
    );
    for (let call = 0; call < 8; call++) await s.create(subject(2, call));
    await expect(s.create(subject(3, 0))).rejects.toThrow(
      'Too many action cards are open',
    );
    // Expired prepared cards no longer count as open.
    await s.setNow(NOW + 21 * 60_000);
    await s.create({
      ...subject(3, 0),
      createdAt: new Date(NOW + 21 * 60_000).toISOString(),
      expiresAt: new Date(NOW + 36 * 60_000).toISOString(),
    });
  });
  it('indexes the alarm queries', async () => {
    const s = stub('plans');
    await s.create(proposalSubject());
    const plans = [
      await s.queryPlan(
        `SELECT proposal_id FROM action_proposal_receipts WHERE owner_did=? AND state='pending' AND next_attempt<=? ORDER BY next_attempt,proposal_id LIMIT 4`,
        [OWNER, NOW],
      ),
      await s.queryPlan(
        `SELECT id FROM action_proposals WHERE owner_did=? AND created_at<? LIMIT 64`,
        [OWNER, NOW],
      ),
    ];
    for (const plan of plans) expect(plan.join(' ')).not.toMatch(/\bSCAN\b/);
  });
  it('drops finished cards after the retention window and keeps open ones', async () => {
    const s = stub('retention');
    const done = await s.create(proposalSubject());
    await s.transition(OWNER, done.id, { kind: 'reject', digest: done.digest });
    const open = await s.create(
      proposalSubject({
        origin: {
          sessionId: 'session-1',
          runId: 'run-2',
          invocationId: 'run-2:call-1',
        },
      }),
    );
    await s.transition(OWNER, open.id, { kind: 'claim', digest: open.digest });
    expect(await s.prune(OWNER)).toBe(0);
    await s.setNow(NOW + 91 * 24 * 60 * 60 * 1000);
    expect(await s.prune(OWNER)).toBe(1);
    expect(await s.get(OWNER, done.id)).toBeNull();
    expect((await s.get(OWNER, open.id))?.lifecycle.status).toBe('claimed');
    // Unresolved cards go too, after the longer window.
    await s.setNow(NOW + 181 * 24 * 60 * 60 * 1000);
    expect(await s.prune(OWNER)).toBe(1);
    expect(await s.get(OWNER, open.id)).toBeNull();
  });
  it('only emits verified outcomes for the original owner session and run', async () => {
    const s = stub('receipt');
    const p = await s.create(proposalSubject());
    const hash = 'A'.repeat(64);
    await s.transition(OWNER, p.id, { kind: 'claim', digest: p.digest });
    await s.transition(OWNER, p.id, {
      kind: 'reconcile',
      transactionHash: hash,
    });
    await s.verified(OWNER, p.id, {
      transactionHash: hash,
      code: 0,
      height: 12,
      verifiedAt: new Date(NOW).toISOString(),
    });
    expect(await s.outcomes(OWNER, 'session-1', 'run-1')).toEqual([
      {
        proposalId: p.id,
        digest: p.digest,
        status: 'succeeded',
        transactionHash: hash,
        code: 0,
        height: 12,
      },
    ]);
    expect(await s.outcomes(OWNER, 'session-2', 'run-1')).toEqual([]);
    expect(await s.outcomes('did:ixo:other', 'session-1', 'run-1')).toEqual([]);
  });
});
