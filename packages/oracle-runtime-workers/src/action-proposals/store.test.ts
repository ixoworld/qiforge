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
    expect(
      await s.create({ ...subject, id: `ap_${crypto.randomUUID()}` }),
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
