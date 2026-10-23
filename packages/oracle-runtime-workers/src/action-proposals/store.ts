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
 * A hash recorded for the first time is looked up no sooner than this: the
 * Portal reports the hash of the signed bytes BEFORE it broadcasts them.
 */
export const VERIFY_FIRST_DELAY_MS = 30_000;
/**
 * "Not found" this soon after the hash arrived is the broadcast or the
 * indexer still in flight: the lookup is rescheduled without spending one
 * of the ten attempts.
 */
export const VERIFY_NOT_FOUND_GRACE_MS = 2 * 60_000;
/**
 * Receipt posts into the originating room: the same doubling cooldown, up to
 * an hour apart, abandoned after twelve attempts (about five hours) so a
 * room that refuses the oracle does not keep its owner object awake for ever.
 */
export const RECEIPT_RETRY_BASE_MS = 30_000;
export const RECEIPT_RETRY_MAX_MS = 60 * 60_000;
export const RECEIPT_MAX_ATTEMPTS = 12;
/** Finished cards older than this are dropped; `/a/<id>` then answers 404. */
export const ACTION_PROPOSAL_RETENTION_MS = 90 * 24 * 60 * 60_000;
/**
 * Cards that never reached an outcome the chain proved (a hash whose
 * lookups ran out, a blocked card nobody revoked) are kept twice as long,
 * then dropped too, so no row stays in the owner copy for ever.
 */
export const ACTION_PROPOSAL_UNRESOLVED_RETENTION_MS = 180 * 24 * 60 * 60_000;
/**
 * How long after its claim a card with no recorded transaction may still
 * receive one. After it the card is closed as `revoked` (the existing
 * terminal state; a new status would break strict readers of the contract):
 * a wallet cancel or a lost claim reply must not leave it `claimed` for
 * ever. It never goes back to `prepared`: a broadcast nobody observed is
 * still possible, so the link stays used up.
 */
export const ACTION_PROPOSAL_EXECUTION_WINDOW_MS = 60 * 60_000;
/** Cards one agent run may prepare; more is a looping run, refused. */
export const ACTION_PROPOSALS_PER_RUN = 8;
/** Cards still awaiting the owner (live `prepared`, `claimed`, hash-less `unknown`) per owner. */
export const ACTION_PROPOSALS_OPEN_PER_OWNER = 16;
/** A `prepared` card counts as open this long after creation (its TTL plus clock skew). */
export const OPEN_PREPARED_MS = 20 * 60_000;

const backoff = (base: number, max: number, attempts: number) =>
  Math.min(base * 2 ** attempts, max);

/** The verifier's answers that prove a recorded hash is not this card's transaction. */
/**
 * The verifier's proof that a recorded hash is ANOTHER transaction (the
 * chain holds it, signed under another card's memo or none): the owner may
 * replace it. A hash mismatch is not in it: an honest node answers
 * `/tx?hash=` with bytes that hash to the hash asked for, so that one is a
 * faulty RPC, retried like any other read failure.
 */
export const TRANSACTION_REJECTIONS = new Set(['Transaction memo mismatch']);
/**
 * The verifier's proof that the recorded transaction carries THIS card's
 * memo but other messages: an effect the owner bound to the card that went
 * wrong. It is never set aside; the card is blocked instead.
 */
export const TRANSACTION_CARD_BOUND_MISMATCH = 'Transaction subject mismatch';

export class ActionProposalStore {
  constructor(
    private readonly db: DoSqliteDatabase,
    readonly now = Date.now,
  ) {}

  async setup(): Promise<void> {
    // The unreleased first shape of these tables (no status, hash or attempt
    // columns) exists only where a pre-release build of this branch ran: a
    // local harness, a wrangler state directory, a devnet test user. Nothing
    // in them is worth a migration; the tables are rebuilt and the fact
    // logged, so an object holding the old shape boots instead of failing
    // every request on the index below.
    const columns = await this.db.exec<{ name: string }>(
      `PRAGMA table_info(action_proposals)`,
    );
    if (columns.length && !columns.some((c) => c.name === 'transaction_hash')) {
      console.warn(
        '[action-proposals] rebuilding pre-release action_proposals tables',
      );
      await this.db.run(`DROP TABLE IF EXISTS action_proposal_receipts`);
      await this.db.run(`DROP TABLE IF EXISTS action_proposals`);
    }
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS action_proposals (id TEXT PRIMARY KEY, owner_did TEXT NOT NULL, invocation_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL, subject TEXT NOT NULL, digest TEXT NOT NULL, lifecycle TEXT NOT NULL, status TEXT NOT NULL, transaction_hash TEXT, transaction_hash_rejected INTEGER NOT NULL DEFAULT 0, verify_after INTEGER NOT NULL DEFAULT 0, verify_attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE(owner_did, invocation_id))`,
    );
    // One signed transaction verifies one card: the memo already pins it,
    // the index refuses a second card recording the same hash.
    // Added after the first released shape: when the current hash arrived
    // (the not-found grace window counts from it). Adding a column is
    // instant in SQLite.
    const shape = await this.db.exec<{ name: string }>(
      `PRAGMA table_info(action_proposals)`,
    );
    if (!shape.some((c) => c.name === 'hash_recorded_at'))
      await this.db.run(
        `ALTER TABLE action_proposals ADD COLUMN hash_recorded_at INTEGER NOT NULL DEFAULT 0`,
      );
    await this.db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS action_proposals_transaction ON action_proposals(owner_did, transaction_hash)`,
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS action_proposals_run ON action_proposals(owner_did, session_id, run_id)`,
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS action_proposals_status ON action_proposals(owner_did, status, verify_after)`,
    );
    // The retention sweep reads `created_at` per row; without the index it
    // walks every card's JSON overflow pages.
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS action_proposals_created ON action_proposals(owner_did, created_at)`,
    );
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS action_proposal_receipts (proposal_id TEXT PRIMARY KEY, owner_did TEXT NOT NULL, origin TEXT, state TEXT NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0)`,
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS action_proposal_receipts_due ON action_proposal_receipts(owner_did, state, next_attempt)`,
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
    /**
     * A hash the indexed column keeps although the lifecycle variant has no
     * field for it (a revoked blocked card): the "one hash, one card" index
     * and the audit trail survive without changing the wire contract.
     */
    retainedHash?: string,
  ): Promise<void> {
    const hash =
      'transactionHash' in lifecycle && lifecycle.transactionHash
        ? lifecycle.transactionHash.toUpperCase()
        : retainedHash
          ? retainedHash.toUpperCase()
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
      await this.assertCapacity(
        subject.ownerDid,
        subject.origin.sessionId,
        subject.origin.runId,
      );
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

  /**
   * A looping or injected run must not mint cards without bound: at most
   * `ACTION_PROPOSALS_PER_RUN` per run and `ACTION_PROPOSALS_OPEN_PER_OWNER`
   * still awaiting the owner. A resumed tool call never reaches here (it
   * returns its original card above).
   */
  private async assertCapacity(
    ownerDid: string,
    sessionId: string,
    runId: string,
  ): Promise<void> {
    const run = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM action_proposals WHERE owner_did=? AND session_id=? AND run_id=?`,
      [ownerDid, sessionId, runId],
    );
    if ((run?.n ?? 0) >= ACTION_PROPOSALS_PER_RUN)
      throw new ActionProposalConflict(
        'Too many action cards in this request; finish the open ones first',
      );
    const open = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM action_proposals WHERE owner_did=? AND ((status='prepared' AND created_at>?) OR status='claimed' OR (status='unknown' AND transaction_hash IS NULL))`,
      [ownerDid, this.now() - OPEN_PREPARED_MS],
    );
    if ((open?.n ?? 0) >= ACTION_PROPOSALS_OPEN_PER_OWNER)
      throw new ActionProposalConflict(
        'Too many action cards are open; finish or decline them first',
      );
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
        if (!proposal) {
          // A receipt whose card is gone would stay due for ever.
          await this.db.run(
            `UPDATE action_proposal_receipts SET state='quarantined' WHERE owner_did=? AND proposal_id=?`,
            [ownerDid, row.proposal_id],
          );
          continue;
        }
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
      try {
        const p = await this.get(ownerDid, row.id);
        if (p) proposals.push(p);
      } catch (error) {
        // A row this build cannot read must not fail the alarm every tick:
        // its attempts are spent and it drops out of the schedule.
        await this.db.run(
          `UPDATE action_proposals SET verify_attempts=? WHERE owner_did=? AND id=?`,
          [VERIFY_MAX_ATTEMPTS, ownerDid, row.id],
        );
        console.error(
          `[action-proposals] verification of ${row.id} quarantined: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return proposals;
  }
  /**
   * The verifier proved the recorded hash is another transaction (another
   * card's memo or none): the owner may record the right one with a later
   * reconcile instead of the card staying `unknown` for ever.
   */
  async markTransactionRejected(
    ownerDid: string,
    id: string,
    transactionHash: string,
  ): Promise<void> {
    // Guarded on the hash: a verification still in flight for a hash the
    // owner has since replaced must not reject its successor.
    await this.db.run(
      `UPDATE action_proposals SET transaction_hash_rejected=1 WHERE owner_did=? AND id=? AND status='unknown' AND transaction_hash=?`,
      [ownerDid, id, transactionHash],
    );
  }
  /**
   * The recorded transaction carries this card's memo but other messages:
   * an effect the owner bound to the card that went wrong. The hash stays
   * listed and may not be replaced, verification stops, the card stays
   * `unknown` with `executionBlockedAt`; the owner revokes it and prepares
   * another.
   */
  async blockExecution(
    ownerDid: string,
    id: string,
    reason: string,
    transactionHash: string,
  ): Promise<void> {
    const blocked = await this.db.transaction(async () => {
      const p = await this.get(ownerDid, id);
      if (
        !p ||
        p.lifecycle.status !== 'unknown' ||
        p.lifecycle.transactionHash !== transactionHash ||
        p.lifecycle.executionBlockedAt
      )
        return false;
      await this.writeLifecycle(ownerDid, id, {
        ...p.lifecycle,
        executionBlockedAt: new Date(this.now()).toISOString(),
      });
      await this.db.run(
        `UPDATE action_proposals SET transaction_hash_rejected=0,verify_attempts=? WHERE owner_did=? AND id=?`,
        [VERIFY_MAX_ATTEMPTS, ownerDid, id],
      );
      return true;
    });
    if (blocked)
      console.error(`[action-proposals] ${id} execution blocked: ${reason}`);
  }
  /**
   * The lookup just made found no transaction, inside the grace window
   * after the hash arrived: give the attempt back and look again after the
   * first-lookup delay. Guarded on the hash. Returns whether it applied.
   */
  async deferNotFound(
    ownerDid: string,
    id: string,
    transactionHash: string,
  ): Promise<boolean> {
    const now = this.now();
    const result = await this.db.run(
      `UPDATE action_proposals SET verify_attempts=MAX(verify_attempts-1,0),verify_after=? WHERE owner_did=? AND id=? AND status='unknown' AND transaction_hash=? AND hash_recorded_at>?`,
      [
        now + VERIFY_FIRST_DELAY_MS,
        ownerDid,
        id,
        transactionHash.toUpperCase(),
        now - VERIFY_NOT_FOUND_GRACE_MS,
      ],
    );
    return result.changes === 1;
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
   * Close the cards claimed more than `ACTION_PROPOSAL_EXECUTION_WINDOW_MS`
   * ago that never recorded a transaction (a wallet cancel, a lost claim
   * reply): `revoked`, ended now. Bounded per call; returns how many closed.
   */
  async closeUnexecuted(ownerDid: string): Promise<number> {
    const now = this.now();
    return this.db.transaction(async () => {
      const rows = await this.db.exec<{ id: string }>(
        `SELECT id FROM action_proposals WHERE owner_did=? AND status IN ('claimed','unknown') AND transaction_hash IS NULL LIMIT 16`,
        [ownerDid],
      );
      let closed = 0;
      for (const row of rows) {
        let p: ActionProposal | null;
        try {
          p = await this.get(ownerDid, row.id);
        } catch {
          // An unreadable row is the prune's to drop, not this sweep's.
          continue;
        }
        if (
          !p ||
          (p.lifecycle.status !== 'claimed' &&
            p.lifecycle.status !== 'unknown') ||
          ('transactionHash' in p.lifecycle && p.lifecycle.transactionHash) ||
          Date.parse(p.lifecycle.claimedAt) +
            ACTION_PROPOSAL_EXECUTION_WINDOW_MS >
            now
        )
          continue;
        await this.writeLifecycle(ownerDid, row.id, {
          status: 'revoked',
          endedAt: new Date(now).toISOString(),
        });
        closed++;
      }
      return closed;
    });
  }
  /** When the next hash-less claimed card's execution window ends, if any. */
  async nextUnexecutedCloseAt(ownerDid: string): Promise<number | undefined> {
    const row = await this.db.get<{ claimed: string | null }>(
      `SELECT MIN(json_extract(lifecycle,'$.claimedAt')) AS claimed FROM action_proposals WHERE owner_did=? AND status IN ('claimed','unknown') AND transaction_hash IS NULL`,
      [ownerDid],
    );
    const claimed = row?.claimed ? Date.parse(row.claimed) : NaN;
    return Number.isFinite(claimed)
      ? claimed + ACTION_PROPOSAL_EXECUTION_WINDOW_MS
      : undefined;
  }
  /**
   * Drop finished cards past the retention window, with their receipts, and
   * unresolved ones (claimed, hash-less or out of lookups, blocked) past the
   * longer window; a card whose transaction is still being looked up stays,
   * as does one whose receipt is still being posted.
   */
  async prune(ownerDid: string): Promise<number> {
    const now = this.now();
    return this.db.transaction(async () => {
      const rows = await this.db.exec<{ id: string }>(
        `SELECT p.id FROM action_proposals p LEFT JOIN action_proposal_receipts r ON r.proposal_id=p.id WHERE p.owner_did=? AND p.created_at<? AND (r.state IS NULL OR r.state<>'pending') AND (p.status IN ('prepared','succeeded','failed','rejected','revoked','superseded') OR (p.created_at<? AND (p.status='claimed' OR (p.status='unknown' AND (p.transaction_hash IS NULL OR p.verify_attempts>=?))))) LIMIT 64`,
        [
          ownerDid,
          now - ACTION_PROPOSAL_RETENTION_MS,
          now - ACTION_PROPOSAL_UNRESOLVED_RETENTION_MS,
          VERIFY_MAX_ATTEMPTS,
        ],
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
          p.lifecycle.executionBlockedAt
        ) {
          // The listed hash may be asked about again (Portal recovery); no
          // other hash may take its place.
          if (
            !command.transactionHash ||
            p.lifecycle.transactionHash ===
              command.transactionHash.toUpperCase()
          )
            return p;
          throw new ActionProposalConflict('Execution is blocked');
        }
        let replacing = false;
        const firstHash =
          !!command.transactionHash &&
          !(p.lifecycle.status === 'unknown' && p.lifecycle.transactionHash);
        if (
          p.lifecycle.status === 'unknown' &&
          p.lifecycle.transactionHash &&
          command.transactionHash &&
          p.lifecycle.transactionHash !== command.transactionHash.toUpperCase()
        ) {
          const row = await this.db.get<{ transaction_hash_rejected: number }>(
            `SELECT transaction_hash_rejected FROM action_proposals WHERE owner_did=? AND id=?`,
            [ownerDid, id],
          );
          if (!row?.transaction_hash_rejected)
            throw new ActionProposalConflict(
              'Transaction reference already recorded',
            );
          replacing = true;
        }
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
        if (replacing || firstHash)
          // A fresh hash gets a fresh verification schedule, its first
          // lookup no sooner than `VERIFY_FIRST_DELAY_MS` (the Portal may
          // report it before broadcasting). The same hash again changes
          // nothing.
          await this.db.run(
            `UPDATE action_proposals SET transaction_hash_rejected=0,verify_after=?,verify_attempts=0,hash_recorded_at=? WHERE owner_did=? AND id=?`,
            [this.now() + VERIFY_FIRST_DELAY_MS, this.now(), ownerDid, id],
          );
      } else {
        if (p.digest !== command.digest)
          throw new ActionProposalConflict('Confirmed values changed');
        if (
          command.kind === 'revoke' &&
          p.lifecycle.status === 'unknown' &&
          p.lifecycle.executionBlockedAt
        ) {
          // A blocked card never confirms or fails: revoking it is the
          // owner's way to close it, expiry or not. Its memo-bound hash stays
          // in the indexed column (the `revoked` variant has no field for
          // it), so no other card can record it and the audit trail holds.
          await this.writeLifecycle(
            ownerDid,
            id,
            { status: 'revoked', endedAt: at },
            p.lifecycle.transactionHash,
          );
          return { ...p, lifecycle: { status: 'revoked', endedAt: at } };
        } else {
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
      }
      await this.writeLifecycle(ownerDid, id, lifecycle);
      return { ...p, lifecycle };
    });
  }
}
