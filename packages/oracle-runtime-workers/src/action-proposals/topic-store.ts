import { canonicalizeIxoJson } from '@ixo/ixo-transaction/action-proposals';
import {
  digestTopicEffect,
  TopicProposalSubjectSchema,
  TopicProposalV2Schema,
  assertTopicProposalUnchanged,
  digestTopicProposal,
  type TopicProposalSubject,
  type TopicActionProposal,
  type BeginTopicStep,
  type BeginTopicStepResult,
  type ExpectedTopicEffect,
  type TopicStepId,
  type TopicReceiptReferences,
  type TopicActionReceipt,
  type VerifiedTopicEffectSchema,
} from '@ixo/ixo-transaction/topic-proposals';
import type { z } from 'zod';
import type { DoSqliteDatabase } from '../sqlite/database';
import { ActionProposalConflict, type ActionReceiptOrigin } from './store';

type VerifiedEffect = z.infer<typeof VerifiedTopicEffectSchema>;
export class TopicProposalStore {
  constructor(
    private readonly db: DoSqliteDatabase,
    private readonly now = Date.now,
  ) {}
  async setup(): Promise<void> {
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS topic_action_proposals(id TEXT PRIMARY KEY,owner_did TEXT NOT NULL,invocation_id TEXT NOT NULL,subject TEXT NOT NULL,digest TEXT NOT NULL,lifecycle TEXT NOT NULL,origin TEXT,receipt_state TEXT NOT NULL DEFAULT 'waiting',next_attempt INTEGER NOT NULL DEFAULT 0,verify_after INTEGER NOT NULL DEFAULT 0, UNIQUE(owner_did,invocation_id))`,
    );
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS topic_action_steps(proposal_id TEXT NOT NULL,step TEXT NOT NULL,status TEXT NOT NULL,expected TEXT,expected_digest TEXT,executor TEXT,started_at TEXT,reference TEXT,receipt TEXT, PRIMARY KEY(proposal_id,step))`,
    );
  }
  async create(
    input: TopicProposalSubject,
    origin: ActionReceiptOrigin | null = null,
  ): Promise<TopicActionProposal> {
    const subject = TopicProposalSubjectSchema.parse(
      JSON.parse(canonicalizeIxoJson(input)),
    );
    const digest = await digestTopicProposal(subject);
    return this.db.transaction(async () => {
      const prior = await this.db.get<{ id: string }>(
        `SELECT id FROM topic_action_proposals WHERE owner_did=? AND invocation_id=?`,
        [subject.ownerDid, subject.origin.invocationId],
      );
      if (prior) {
        const p = await this.get(subject.ownerDid, prior.id);
        if (!p) throw new ActionProposalConflict('Proposal missing');
        if (
          (await digestTopicProposal({
            ...subject,
            id: p.id,
            createdAt: p.createdAt,
            expiresAt: p.expiresAt,
          })) !== p.digest
        )
          throw new ActionProposalConflict(
            'Invocation already prepared different values',
          );
        return p;
      }
      if (Date.parse(subject.expiresAt) <= this.now())
        throw new ActionProposalConflict('Proposal expired');
      const steps: TopicStepId[] =
        subject.action.name === 'create_topic'
          ? ['anchor', 'body', 'operation', 'snapshot']
          : ['grant'];
      const lifecycle = {
        status: 'prepared',
        steps: steps.map((step) => ({ step, status: 'pending' })),
      };
      await this.db.run(
        `INSERT INTO topic_action_proposals(id,owner_did,invocation_id,subject,digest,lifecycle,origin) VALUES(?,?,?,?,?,?,?)`,
        [
          subject.id,
          subject.ownerDid,
          subject.origin.invocationId,
          JSON.stringify(subject),
          digest,
          JSON.stringify(lifecycle),
          origin ? JSON.stringify(origin) : null,
        ],
      );
      for (const step of steps)
        await this.db.run(
          `INSERT INTO topic_action_steps(proposal_id,step,status) VALUES(?,?,'pending')`,
          [subject.id, step],
        );
      return TopicProposalV2Schema.parse({ ...subject, digest, lifecycle });
    });
  }
  async get(owner: string, id: string): Promise<TopicActionProposal | null> {
    const row = await this.db.get<{
      subject: string;
      digest: string;
      lifecycle: string;
    }>(
      `SELECT subject,digest,lifecycle FROM topic_action_proposals WHERE owner_did=? AND id=?`,
      [owner, id],
    );
    return row
      ? assertTopicProposalUnchanged({
          ...JSON.parse(row.subject),
          digest: row.digest,
          lifecycle: JSON.parse(row.lifecycle),
        })
      : null;
  }
  async replayPreparation(
    owner: string,
    origin: TopicProposalSubject['origin'],
    candidate: unknown,
    evidenceRefs: string[],
  ): Promise<TopicActionProposal | null> {
    const row = await this.db.get<{ id: string }>(
      `SELECT id FROM topic_action_proposals WHERE owner_did=? AND invocation_id=?`,
      [owner, origin.invocationId],
    );
    if (!row) return null;
    const prior = await this.get(owner, row.id);
    if (!prior) throw new ActionProposalConflict('Proposal missing');
    const candidateDigest = await digestTopicProposalEffect(candidate);
    if (
      prior.origin.sessionId !== origin.sessionId ||
      prior.origin.runId !== origin.runId ||
      !prior.evidenceRefs.includes(`candidate:${candidateDigest}`) ||
      evidenceRefs.some((ref) => !prior.evidenceRefs.includes(ref))
    )
      throw new ActionProposalConflict(
        'Invocation already prepared different values',
      );
    return prior;
  }
  async forRun(
    owner: string,
    session: string,
    run: string,
  ): Promise<TopicActionProposal[]> {
    const rows = await this.db.exec<{ id: string }>(
      `SELECT id FROM topic_action_proposals WHERE owner_did=? AND json_extract(subject,'$.origin.sessionId')=? AND json_extract(subject,'$.origin.runId')=? ORDER BY verify_after,id LIMIT 32`,
      [owner, session, run],
    );
    const values = await Promise.all(rows.map((r) => this.get(owner, r.id)));
    return values.filter((p): p is TopicActionProposal => p !== null);
  }
  async transition(
    owner: string,
    id: string,
    kind: 'claim' | 'reject' | 'revoke' | 'supersede',
    digest: string,
  ): Promise<TopicActionProposal | null> {
    return this.db.transaction(async () => {
      const p = await this.get(owner, id);
      if (!p) return null;
      if (p.digest !== digest)
        throw new ActionProposalConflict('Proposal changed');
      if (
        p.lifecycle.status !== 'prepared' &&
        !(
          kind === 'revoke' &&
          ['claimed', 'unknown'].includes(p.lifecycle.status)
        )
      )
        throw new ActionProposalConflict('Proposal already consumed');
      if (kind === 'claim' && Date.parse(p.expiresAt) <= this.now())
        throw new ActionProposalConflict('Proposal expired');
      const at = new Date(this.now()).toISOString();
      const lifecycle = {
        ...p.lifecycle,
        ...(kind === 'claim'
          ? { status: 'claimed', claimedAt: at }
          : {
              status:
                kind === 'reject'
                  ? 'rejected'
                  : kind === 'revoke'
                    ? 'revoked'
                    : 'superseded',
              endedAt: at,
              ...(kind === 'revoke' ? { executionBlockedAt: at } : {}),
            }),
      };
      await this.db.run(
        `UPDATE topic_action_proposals SET lifecycle=? WHERE owner_did=? AND id=?`,
        [JSON.stringify(lifecycle), owner, id],
      );
      return TopicProposalV2Schema.parse({ ...p, lifecycle });
    });
  }
  async begin(
    owner: string,
    id: string,
    input: BeginTopicStep,
    effect: ExpectedTopicEffect,
  ): Promise<BeginTopicStepResult | null> {
    const expectedDigest = await digestTopicEffect(effect);
    return this.db.transaction(async () => {
      const p = await this.get(owner, id);
      if (!p) return null;
      if (p.digest !== input.digest)
        throw new ActionProposalConflict('Proposal changed');
      if (
        p.lifecycle.executionBlockedAt ||
        !['claimed', 'unknown'].includes(p.lifecycle.status)
      )
        throw new ActionProposalConflict('Proposal was not claimed');
      if (Date.parse(p.expiresAt) <= this.now())
        throw new ActionProposalConflict('Proposal expired');
      if (
        input.executor.matrixUserId !== p.action.owner.matrixUserId ||
        input.executor.homeserver !== p.action.owner.homeserver
      )
        throw new ActionProposalConflict('Execution identity changed');
      const index = p.lifecycle.steps.findIndex((s) => s.step === input.step);
      if (index < 0) throw new ActionProposalConflict('Invalid step');
      if (
        p.lifecycle.steps.slice(0, index).some((s) => s.status !== 'verified')
      )
        throw new ActionProposalConflict('Predecessor is not verified');
      const current = p.lifecycle.steps[index]!;
      if (current.status !== 'pending')
        return { status: 'already_started', proposal: p };
      const startedAt = new Date(this.now()).toISOString();
      const record = {
        step: input.step,
        status: 'started' as const,
        startedAt,
        expectedDigest,
        executor: input.executor,
      };
      const changed = await this.db.run(
        `UPDATE topic_action_steps SET status='started',expected=?,expected_digest=?,executor=?,started_at=? WHERE proposal_id=? AND step=? AND status='pending'`,
        [
          JSON.stringify(effect),
          expectedDigest,
          JSON.stringify(input.executor),
          startedAt,
          id,
          input.step,
        ],
      );
      if (changed.changes !== 1)
        throw new ActionProposalConflict('Step already started');
      const lifecycle = {
        ...p.lifecycle,
        status: 'unknown',
        steps: p.lifecycle.steps.map((s) =>
          s.step === input.step ? record : s,
        ),
      };
      await this.db.run(
        `UPDATE topic_action_proposals SET lifecycle=? WHERE owner_did=? AND id=?`,
        [JSON.stringify(lifecycle), owner, id],
      );
      return {
        status: 'permitted',
        permit: {
          proposalId: id,
          digest: p.digest,
          step: input.step,
          executor: input.executor,
          expectedDigest,
          effect,
        },
      };
    });
  }
  async claimVerification(owner: string, id: string): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE topic_action_proposals SET verify_after=? WHERE owner_did=? AND id=? AND verify_after<=?`,
      [this.now() + 30000, owner, id, this.now()],
    );
    return result.changes === 1;
  }
  async hasReference(
    owner: string,
    id: string,
    step: TopicStepId,
  ): Promise<boolean> {
    if (!(await this.get(owner, id))) return false;
    const row = await this.db.get<{ reference: string | null }>(
      `SELECT reference FROM topic_action_steps WHERE proposal_id=? AND step=?`,
      [id, step],
    );
    return !!row?.reference;
  }
  async recordReference(
    owner: string,
    id: string,
    reference: TopicReceiptReferences['references'][number],
  ): Promise<ExpectedTopicEffect> {
    return this.db.transaction(async () => {
      const p = await this.get(owner, id);
      if (!p) throw new ActionProposalConflict('Proposal missing');
      const row = await this.db.get<{
        status: string;
        expected: string | null;
        reference: string | null;
      }>(
        `SELECT status,expected,reference FROM topic_action_steps WHERE proposal_id=? AND step=?`,
        [id, reference.step],
      );
      if (!row || row.status === 'pending' || !row.expected)
        throw new ActionProposalConflict('Step was not started');
      const serialized = JSON.stringify(reference);
      if (row.reference && row.reference !== serialized)
        throw new ActionProposalConflict('Step reference already recorded');
      await this.db.run(
        `UPDATE topic_action_steps SET reference=? WHERE proposal_id=? AND step=?`,
        [serialized, id, reference.step],
      );
      const { ExpectedTopicEffectSchema } =
        await import('@ixo/ixo-transaction/topic-proposals');
      return ExpectedTopicEffectSchema.parse(JSON.parse(row.expected));
    });
  }
  async verifyStep(
    owner: string,
    id: string,
    step: TopicStepId,
    receipt: VerifiedEffect,
  ): Promise<TopicActionProposal> {
    return this.db.transaction(async () => {
      const p = await this.get(owner, id);
      if (!p) throw new ActionProposalConflict('Proposal missing');
      const current = p.lifecycle.steps.find((s) => s.step === step);
      if (!current || current.status === 'pending')
        throw new ActionProposalConflict('Step was not started');
      if (current.status === 'verified') {
        if (
          canonicalizeIxoJson(current.receipt) !== canonicalizeIxoJson(receipt)
        )
          throw new ActionProposalConflict('Verified step changed');
        return p;
      }
      const steps = p.lifecycle.steps.map((s) =>
        s.step === step ? { step, status: 'verified' as const, receipt } : s,
      );
      let finalReceipt: TopicActionReceipt | undefined;
      if (p.action.name === 'grant_topic_access' && receipt.kind === 'chain')
        finalReceipt =
          receipt.code === 0
            ? {
                kind: 'topic-access-granted',
                transactionHash: receipt.transactionHash,
                chainId: receipt.chainId,
                height: receipt.height,
                code: 0,
                verifiedAt: receipt.verifiedAt,
              }
            : {
                kind: 'topic-access-failed',
                transactionHash: receipt.transactionHash,
                chainId: receipt.chainId,
                height: receipt.height,
                code: receipt.code,
                verifiedAt: receipt.verifiedAt,
              };
      if (
        p.action.name === 'create_topic' &&
        steps.every((s) => s.status === 'verified')
      ) {
        const event = (key: TopicStepId) => {
          const s = steps.find((s) => s.step === key);
          if (s?.status !== 'verified' || s.receipt.kind !== 'matrix')
            throw new ActionProposalConflict('Missing Matrix receipt');
          return s.receipt.eventId;
        };
        const { topicIdFromPlan } = await import('./topic-effects');
        finalReceipt = {
          kind: 'topic-created',
          roomId: p.action.roomId,
          topicId: topicIdFromPlan(p.action.plan),
          rootEventId: event('anchor'),
          bodyEventId: event('body'),
          operationEventId: event('operation'),
          stateEventId: event('snapshot'),
          verifiedAt: receipt.verifiedAt,
        };
      }
      const lifecycle = {
        ...p.lifecycle,
        steps,
        ...(finalReceipt
          ? {
              status:
                finalReceipt.kind === 'topic-access-failed'
                  ? 'failed'
                  : 'succeeded',
              receipt: finalReceipt,
            }
          : { status: p.lifecycle.executionBlockedAt ? 'revoked' : 'unknown' }),
      };
      await this.db.run(
        `UPDATE topic_action_steps SET status='verified',receipt=? WHERE proposal_id=? AND step=?`,
        [JSON.stringify(receipt), id, step],
      );
      await this.db.run(
        `UPDATE topic_action_proposals SET lifecycle=?,receipt_state=?,next_attempt=? WHERE owner_did=? AND id=?`,
        [
          JSON.stringify(lifecycle),
          finalReceipt ? 'pending' : 'waiting',
          this.now(),
          owner,
          id,
        ],
      );
      return TopicProposalV2Schema.parse({ ...p, lifecycle });
    });
  }
  async references(
    owner: string,
    id: string,
  ): Promise<TopicReceiptReferences['references']> {
    if (!(await this.get(owner, id))) return [];
    const rows = await this.db.exec<{ reference: string }>(
      `SELECT reference FROM topic_action_steps WHERE proposal_id=? AND reference IS NOT NULL AND status!='verified' ORDER BY rowid`,
      [id],
    );
    const { TopicReceiptReferencesSchema } =
      await import('@ixo/ixo-transaction/topic-proposals');
    if (!rows.length) return [];
    return TopicReceiptReferencesSchema.parse({
      v: 2,
      references: rows.map((r) => JSON.parse(r.reference)),
    }).references;
  }
  async takeReceipts(
    owner: string,
  ): Promise<{ proposal: TopicActionProposal; origin: ActionReceiptOrigin }[]> {
    const rows = await this.db.exec<{ id: string; origin: string }>(
      `SELECT id,origin FROM topic_action_proposals WHERE owner_did=? AND receipt_state='pending' AND origin IS NOT NULL AND next_attempt<=? LIMIT 4`,
      [owner, this.now()],
    );
    const results = [];
    for (const row of rows) {
      const proposal = await this.get(owner, row.id);
      if (proposal) {
        await this.db.run(
          `UPDATE topic_action_proposals SET next_attempt=? WHERE id=?`,
          [this.now() + 30000, row.id],
        );
        results.push({ proposal, origin: JSON.parse(row.origin) });
      }
    }
    return results;
  }
  async receiptMirrored(owner: string, id: string): Promise<void> {
    await this.db.run(
      `UPDATE topic_action_proposals SET receipt_state='delivered' WHERE owner_did=? AND id=?`,
      [owner, id],
    );
  }
  async nextReceiptAttempt(owner: string): Promise<number | undefined> {
    const r = await this.db.get<{ due: number | null }>(
      `SELECT MIN(next_attempt) AS due FROM topic_action_proposals WHERE owner_did=? AND receipt_state='pending' AND origin IS NOT NULL`,
      [owner],
    );
    return r?.due ?? undefined;
  }
}
export async function digestTopicProposalEffect(
  effect: unknown,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeIxoJson(effect));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
