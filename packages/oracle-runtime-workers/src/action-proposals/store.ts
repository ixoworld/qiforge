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

/**
 * Chain lookups for a recorded transaction: a cooldown that doubles from 30 s
 * to 10 min between attempts, and the alarm stops asking after ten of them
 * (about an hour). A Portal reconcile still looks the transaction up once
 * the cooldown has passed, however many attempts the alarm made.
 */
export const VERIFY_RETRY_BASE_MS = 30_000;
export const VERIFY_RETRY_MAX_MS = 10 * 60_000;
export const VERIFY_MAX_ATTEMPTS = 10;
/**
 * Receipt posts into the originating room: the same doubling cooldown, up to
 * an hour apart, abandoned after twelve attempts (roughly seven hours) so a
 * room that refuses the oracle does not keep its owner object awake for ever.
 */
export const RECEIPT_RETRY_BASE_MS = 30_000;
export const RECEIPT_RETRY_MAX_MS = 60 * 60_000;
export const RECEIPT_MAX_ATTEMPTS = 12;
/** Finished cards older than this are dropped; `/a/<id>` then answers 404. */
export const ACTION_PROPOSAL_RETENTION_MS = 90 * 24 * 60 * 60_000;

const backoff = (base: number, max: number, attempts: number) =>
  Math.min(base * 2 ** attempts, max);

export class ActionProposalStore {
  constructor(
    private readonly db: DoSqliteDatabase,
    private readonly now = Date.now,
  ) {}

  async setup(): Promise<void> {
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS action_proposals (id TEXT PRIMARY KEY, owner_did TEXT NOT NULL, invocation_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL, subject TEXT NOT NULL, digest TEXT NOT NULL, lifecycle TEXT NOT NULL, status TEXT NOT NULL, transaction_hash TEXT, verify_after INTEGER NOT NULL DEFAULT 0, verify_attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE(owner_did, invocation_id))`,
    );
    // One signed transaction verifies one card: the memo already pins it,
    // the index refuses a second card recording the same hash.
    await this.db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS action_proposals_transaction ON action_proposals(owner_did, transaction_hash)`,
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS action_proposals_run ON action_proposals(owner_did, session_id, run_id)`,
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS action_proposals_status ON action_proposals(owner_did, status, verify_after)`,
    );
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS action_proposal_receipts (proposal_id TEXT PRIMARY KEY, owner_did TEXT NOT NULL, origin TEXT, state TEXT NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0)`,
    );
  }

  /**
   * Every lifecycle write goes through here so the indexed `status` and
   * `transaction_hash` columns always mirror the JSON, and a hash another
   * card of this owner already recorded is refused before the index does.
   */
  private async writeLifecycle(
    ownerDid: string,
    id: string,
    lifecycle: ActionProposal['lifecycle'],
  ): Promise<void> {
    const hash =
      'transactionHash' in lifecycle && lifecycle.transactionHash
        ? lifecycle.transactionHash.toUpperCase()
        : null;
    if (hash) {
      const other = await this.db.get<{ id: string }>(
        `SELECT id FROM action_proposals WHERE owner_did=? AND transaction_hash=? AND id<>?`,
        [ownerDid, hash, id],
      );
      if (other)
        throw new ActionProposalConflict(
          'Transaction already recorded for another proposal',
        );
    }
    await this.db.run(
      `UPDATE action_proposals SET lifecycle=?,status=?,transaction_hash=? WHERE id=? AND owner_did=?`,
      [JSON.stringify(lifecycle), lifecycle.status, hash, id, ownerDid],
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
        // A resumed tool call returns its original immutable proposal: the
        // retry minted its own id (and memo) and timestamps, everything else
        // must be what the first call prepared.
        const retry = {
          ...subject,
          id: prior.id,
          createdAt: prior.createdAt,
          expiresAt: prior.expiresAt,
          action: {
            ...subject.action,
            inputs: { ...subject.action.inputs, memo: prior.id },
          },
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
        `INSERT INTO action_proposals (id,owner_did,invocation_id,session_id,run_id,subject,digest,lifecycle,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          subject.id,
          subject.ownerDid,
          subject.origin.invocationId,
          subject.origin.sessionId,
          subject.origin.runId,
          JSON.stringify(subject),
          digest,
          JSON.stringify({ status: 'prepared' }),
          'prepared',
          Date.parse(subject.createdAt),
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

  /**
   * The receipts due now, at most four, each moved to its next attempt (or
   * abandoned on the last one) before it is handed out, so a crash between
   * here and the post retries on schedule instead of immediately. A row this
   * build cannot read any more is quarantined rather than retried for ever.
   */
  async takeReceipts(
    ownerDid: string,
  ): Promise<{ proposal: ActionProposal; origin: ActionReceiptOrigin }[]> {
    return this.db.transaction(async () => {
      const now = this.now();
      const rows = await this.db.exec<{
        proposal_id: string;
        origin: string;
        attempts: number;
      }>(
        `SELECT proposal_id,origin,attempts FROM action_proposal_receipts WHERE owner_did=? AND state='pending' AND next_attempt<=? ORDER BY next_attempt,proposal_id LIMIT 4`,
        [ownerDid, now],
      );
      const receipts: {
        proposal: ActionProposal;
        origin: ActionReceiptOrigin;
      }[] = [];
      for (const row of rows) {
        let proposal: ActionProposal | null;
        try {
          proposal = await this.get(ownerDid, row.proposal_id);
        } catch (error) {
          await this.db.run(
            `UPDATE action_proposal_receipts SET state='quarantined' WHERE owner_did=? AND proposal_id=?`,
            [ownerDid, row.proposal_id],
          );
          console.error(
            `[action-proposals] receipt ${row.proposal_id} quarantined: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        if (!proposal) continue;
        const attempts = row.attempts + 1;
        await this.db.run(
          attempts >= RECEIPT_MAX_ATTEMPTS
            ? `UPDATE action_proposal_receipts SET state='abandoned',attempts=? WHERE owner_did=? AND proposal_id=?`
            : `UPDATE action_proposal_receipts SET next_attempt=?,attempts=? WHERE owner_did=? AND proposal_id=?`,
          attempts >= RECEIPT_MAX_ATTEMPTS
            ? [attempts, ownerDid, row.proposal_id]
            : [
                now +
                  backoff(
                    RECEIPT_RETRY_BASE_MS,
                    RECEIPT_RETRY_MAX_MS,
                    row.attempts,
                  ),
                attempts,
                ownerDid,
                row.proposal_id,
              ],
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
      `UPDATE action_proposal_receipts SET state='delivered' WHERE owner_did=? AND proposal_id=? AND state IN ('pending','abandoned')`,
      [ownerDid, id],
    );
  }
  async forRun(
    ownerDid: string,
    sessionId: string,
    runId: string,
  ): Promise<ActionProposal[]> {
    const rows = await this.db.exec<{ id: string }>(
      `SELECT id FROM action_proposals WHERE owner_did=? AND session_id=? AND run_id=? ORDER BY verify_after,id LIMIT 32`,
      [ownerDid, sessionId, runId],
    );
    const proposals: ActionProposal[] = [];
    for (const row of rows) {
      const p = await this.get(ownerDid, row.id);
      if (p) proposals.push(p);
    }
    return proposals;
  }
  /**
   * Cards with a recorded transaction the chain has not confirmed yet, whose
   * cooldown has passed and whose attempts are not used up, oldest first.
   */
  async dueVerifications(
    ownerDid: string,
    limit = 2,
  ): Promise<ActionProposal[]> {
    const rows = await this.db.exec<{ id: string }>(
      `SELECT id FROM action_proposals WHERE owner_did=? AND status='unknown' AND transaction_hash IS NOT NULL AND verify_after<=? AND verify_attempts<? ORDER BY verify_after,id LIMIT ?`,
      [ownerDid, this.now(), VERIFY_MAX_ATTEMPTS, limit],
    );
    const proposals: ActionProposal[] = [];
    for (const row of rows) {
      const p = await this.get(ownerDid, row.id);
      if (p) proposals.push(p);
    }
    return proposals;
  }
  /** When the alarm should next look a recorded transaction up, if ever. */
  async nextVerificationAt(ownerDid: string): Promise<number | undefined> {
    const row = await this.db.get<{ due: number | null }>(
      `SELECT MIN(verify_after) AS due FROM action_proposals WHERE owner_did=? AND status='unknown' AND transaction_hash IS NOT NULL AND verify_attempts<?`,
      [ownerDid, VERIFY_MAX_ATTEMPTS],
    );
    return row?.due ?? undefined;
  }
  /**
   * Drop finished cards past the retention window, with their receipts; a
   * card still claimed or unknown stays, as does one whose receipt is still
   * being posted.
   */
  async prune(ownerDid: string): Promise<number> {
    const before = this.now() - ACTION_PROPOSAL_RETENTION_MS;
    return this.db.transaction(async () => {
      const rows = await this.db.exec<{ id: string }>(
        `SELECT p.id FROM action_proposals p LEFT JOIN action_proposal_receipts r ON r.proposal_id=p.id WHERE p.owner_did=? AND p.created_at<? AND p.status IN ('prepared','succeeded','failed','rejected','revoked','superseded') AND (r.state IS NULL OR r.state<>'pending') LIMIT 64`,
        [ownerDid, before],
      );
      for (const row of rows) {
        await this.db.run(
          `DELETE FROM action_proposal_receipts WHERE owner_did=? AND proposal_id=?`,
          [ownerDid, row.id],
        );
        await this.db.run(
          `DELETE FROM action_proposals WHERE owner_did=? AND id=?`,
          [ownerDid, row.id],
        );
      }
      return rows.length;
    });
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
  /**
   * Take the one chain lookup the cooldown allows: the next one may run only
   * after a wait that doubles with every attempt made so far.
   */
  async claimVerification(ownerDid: string, id: string): Promise<boolean> {
    const now = this.now();
    const row = await this.db.get<{ verify_attempts: number }>(
      'SELECT verify_attempts FROM action_proposals WHERE id=? AND owner_did=? AND verify_after<=?',
      [id, ownerDid, now],
    );
    if (!row) return false;
    const result = await this.db.run(
      'UPDATE action_proposals SET verify_after=?,verify_attempts=verify_attempts+1 WHERE id=? AND owner_did=? AND verify_after<=?',
      [
        now +
          backoff(
            VERIFY_RETRY_BASE_MS,
            VERIFY_RETRY_MAX_MS,
            row.verify_attempts,
          ),
        id,
        ownerDid,
        now,
      ],
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
      await this.writeLifecycle(ownerDid, id, lifecycle);
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
      await this.writeLifecycle(ownerDid, id, lifecycle);
      return { ...p, lifecycle };
    });
  }
}
