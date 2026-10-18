import type { VerifiedActionTransaction } from './verify';
import {
  ActionProposalSchema,
  canonicalizeIxoJson,
  actionOutcome,
  type ActionOutcome,
  ActionProposalSubjectSchema,
  assertActionProposalUnchanged,
  digestActionProposal,
  type ActionProposal,
  type ActionProposalSubject,
} from '@ixo/ixo-transaction/action-proposals';
import type { DoSqliteDatabase } from '../sqlite/database';
import type { TurnRequest } from '../do/contracts';

export type ActionReceiptOrigin = {
  sessionId: string;
  roomId: string;
  client: TurnRequest['client'];
  channel?: TurnRequest['channel'];
};

export class ActionProposalConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionProposalConflict';
  }
}
export type ProposalCommand =
  | { kind: 'claim'; digest: string }
  | { kind: 'reject' | 'revoke' | 'supersede'; digest: string }
  | { kind: 'reconcile'; transactionHash?: string };

export class ActionProposalStore {
  constructor(
    private readonly db: DoSqliteDatabase,
    private readonly now = Date.now,
  ) {}

  async setup(): Promise<void> {
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS action_proposals (id TEXT PRIMARY KEY, owner_did TEXT NOT NULL, invocation_id TEXT NOT NULL, subject TEXT NOT NULL, digest TEXT NOT NULL, lifecycle TEXT NOT NULL, verify_after INTEGER NOT NULL DEFAULT 0, UNIQUE(owner_did, invocation_id))`,
    );
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS action_proposal_receipts (proposal_id TEXT PRIMARY KEY, owner_did TEXT NOT NULL, origin TEXT, state TEXT NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0)`,
    );
  }

  async create(
    input: ActionProposalSubject,
    receiptOrigin: ActionReceiptOrigin | null = null,
  ): Promise<ActionProposal> {
    const subject = ActionProposalSubjectSchema.parse(
      JSON.parse(canonicalizeIxoJson(input)),
    );
    const digest = await digestActionProposal(subject);
    return this.db.transaction(async () => {
      const existing = await this.db.get<{ id: string }>(
        `SELECT id FROM action_proposals WHERE owner_did=? AND invocation_id=?`,
        [subject.ownerDid, subject.origin.invocationId],
      );
      if (existing) {
        const prior = await this.get(subject.ownerDid, existing.id);
        if (!prior) throw new ActionProposalConflict('Proposal missing');
        // A resumed tool call returns its original immutable proposal.
        const retry = {
          ...subject,
          id: prior.id,
          createdAt: prior.createdAt,
          expiresAt: prior.expiresAt,
        };
        if ((await digestActionProposal(retry)) !== prior.digest)
          throw new ActionProposalConflict(
            'Invocation already prepared different values',
          );
        return prior;
      }
      if (Date.parse(subject.expiresAt) <= this.now())
        throw new ActionProposalConflict('Proposal expired');
      await this.db.run(
        `INSERT INTO action_proposals (id,owner_did,invocation_id,subject,digest,lifecycle) VALUES (?,?,?,?,?,?)`,
        [
          subject.id,
          subject.ownerDid,
          subject.origin.invocationId,
          JSON.stringify(subject),
          digest,
          JSON.stringify({ status: 'prepared' }),
        ],
      );
      await this.db.run(
        `INSERT INTO action_proposal_receipts (proposal_id,owner_did,origin,state) VALUES (?,?,?,?)`,
        [
          subject.id,
          subject.ownerDid,
          receiptOrigin ? JSON.stringify(receiptOrigin) : null,
          receiptOrigin ? 'waiting' : 'unavailable',
        ],
      );
      return ActionProposalSchema.parse({
        ...subject,
        digest,
        lifecycle: { status: 'prepared' },
      });
    });
  }

  async get(ownerDid: string, id: string): Promise<ActionProposal | null> {
    const row = await this.db.get<{
      subject: string;
      digest: string;
      lifecycle: string;
    }>(
      `SELECT subject,digest,lifecycle FROM action_proposals WHERE id=? AND owner_did=?`,
      [id, ownerDid],
    );
    return row
      ? assertActionProposalUnchanged({
          ...JSON.parse(row.subject),
          digest: row.digest,
          lifecycle: JSON.parse(row.lifecycle),
        })
      : null;
  }

  async takeReceipts(
    ownerDid: string,
  ): Promise<{ proposal: ActionProposal; origin: ActionReceiptOrigin }[]> {
    return this.db.transaction(async () => {
      const now = this.now();
      const rows = await this.db.exec<{ proposal_id: string; origin: string }>(
        `SELECT proposal_id,origin FROM action_proposal_receipts WHERE owner_did=? AND state='pending' AND next_attempt<=? ORDER BY next_attempt,proposal_id LIMIT 4`,
        [ownerDid, now],
      );
      const receipts: {
        proposal: ActionProposal;
        origin: ActionReceiptOrigin;
      }[] = [];
      for (const row of rows) {
        const proposal = await this.get(ownerDid, row.proposal_id);
        if (!proposal) continue;
        await this.db.run(
          `UPDATE action_proposal_receipts SET next_attempt=? WHERE owner_did=? AND proposal_id=?`,
          [now + 30_000, ownerDid, row.proposal_id],
        );
        receipts.push({ proposal, origin: JSON.parse(row.origin) });
      }
      return receipts;
    });
  }
  async nextReceiptAttempt(ownerDid: string): Promise<number | undefined> {
    const row = await this.db.get<{ due: number | null }>(
      `SELECT MIN(next_attempt) AS due FROM action_proposal_receipts WHERE owner_did=? AND state='pending'`,
      [ownerDid],
    );
    return row?.due ?? undefined;
  }
  async receiptMirrored(ownerDid: string, id: string): Promise<void> {
    await this.db.run(
      `UPDATE action_proposal_receipts SET state='delivered' WHERE owner_did=? AND proposal_id=? AND state='pending'`,
      [ownerDid, id],
    );
  }
  async forRun(
    ownerDid: string,
    sessionId: string,
    runId: string,
  ): Promise<ActionProposal[]> {
    const rows = await this.db.exec<{ id: string }>(
      `SELECT id FROM action_proposals WHERE owner_did=? AND json_extract(subject,'$.origin.sessionId')=? AND json_extract(subject,'$.origin.runId')=? ORDER BY verify_after,id LIMIT 32`,
      [ownerDid, sessionId, runId],
    );
    const proposals: ActionProposal[] = [];
    for (const row of rows) {
      const p = await this.get(ownerDid, row.id);
      if (p) proposals.push(p);
    }
    return proposals;
  }
  async outcomesForRun(
    ownerDid: string,
    sessionId: string,
    runId: string,
  ): Promise<ActionOutcome[]> {
    return (await this.forRun(ownerDid, sessionId, runId)).map((p) =>
      actionOutcome(p, this.now()),
    );
  }
  async claimVerification(ownerDid: string, id: string): Promise<boolean> {
    const result = await this.db.run(
      'UPDATE action_proposals SET verify_after=? WHERE id=? AND owner_did=? AND verify_after<=?',
      [this.now() + 30_000, id, ownerDid, this.now()],
    );
    return result.changes === 1;
  }

  async recordVerified(
    ownerDid: string,
    id: string,
    verified: VerifiedActionTransaction,
  ): Promise<ActionProposal | null> {
    return this.db.transaction(async () => {
      const p = await this.get(ownerDid, id);
      if (!p) return null;
      if (
        p.lifecycle.status !== 'unknown' ||
        p.lifecycle.transactionHash !== verified.transactionHash
      )
        throw new ActionProposalConflict(
          'Transaction is not pending verification',
        );
      const lifecycle: ActionProposal['lifecycle'] = {
        status: verified.code === 0 ? 'succeeded' : 'failed',
        claimedAt: p.lifecycle.claimedAt,
        ...verified,
      };
      await this.db.run(
        'UPDATE action_proposals SET lifecycle=? WHERE id=? AND owner_did=?',
        [JSON.stringify(lifecycle), id, ownerDid],
      );
      await this.db.run(
        `UPDATE action_proposal_receipts SET state='pending',next_attempt=? WHERE owner_did=? AND proposal_id=? AND state='waiting'`,
        [this.now(), ownerDid, id],
      );
      return ActionProposalSchema.parse({ ...p, lifecycle });
    });
  }

  async transition(
    ownerDid: string,
    id: string,
    command: ProposalCommand,
  ): Promise<ActionProposal | null> {
    return this.db.transaction(async () => {
      const p = await this.get(ownerDid, id);
      if (!p) return null;
      const at = new Date(this.now()).toISOString();
      let lifecycle: ActionProposal['lifecycle'];
      if (command.kind === 'reconcile') {
        if (
          (p.lifecycle.status === 'succeeded' ||
            p.lifecycle.status === 'failed') &&
          (!command.transactionHash ||
            p.lifecycle.transactionHash ===
              command.transactionHash.toUpperCase())
        )
          return p;
        if (
          p.lifecycle.status !== 'claimed' &&
          p.lifecycle.status !== 'unknown'
        )
          throw new ActionProposalConflict('Proposal was not claimed');
        if (
          p.lifecycle.status === 'unknown' &&
          p.lifecycle.transactionHash &&
          command.transactionHash &&
          p.lifecycle.transactionHash !== command.transactionHash.toUpperCase()
        )
          throw new ActionProposalConflict(
            'Transaction reference already recorded',
          );
        const hash =
          command.transactionHash ??
          (p.lifecycle.status === 'unknown'
            ? p.lifecycle.transactionHash
            : undefined);
        lifecycle = {
          status: 'unknown',
          claimedAt: p.lifecycle.claimedAt,
          ...(hash ? { transactionHash: hash.toUpperCase() } : {}),
        };
      } else {
        if (p.digest !== command.digest)
          throw new ActionProposalConflict('Confirmed values changed');
        if (p.lifecycle.status !== 'prepared')
          throw new ActionProposalConflict('Proposal is already consumed');
        if (Date.parse(p.expiresAt) <= this.now())
          throw new ActionProposalConflict('Proposal expired');
        lifecycle =
          command.kind === 'claim'
            ? { status: 'claimed', claimedAt: at }
            : {
                status:
                  command.kind === 'reject'
                    ? 'rejected'
                    : command.kind === 'revoke'
                      ? 'revoked'
                      : 'superseded',
                endedAt: at,
              };
      }
      await this.db.run(
        `UPDATE action_proposals SET lifecycle=? WHERE id=? AND owner_did=?`,
        [JSON.stringify(lifecycle), id, ownerDid],
      );
      return { ...p, lifecycle };
    });
  }
}
