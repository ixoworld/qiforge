import { canonicalizeIxoJson } from '@ixo/ixo-transaction/action-proposals';
import {
  digestTopicEffect,
  ExpectedTopicEffectSchema,
  TopicLifecycleSchema,
  TopicProposalSubjectSchema,
  TopicProposalV2Schema,
  TopicReceiptReferencesSchema,
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
import {
  ActionProposalConflict,
  ACTION_PROPOSAL_RETENTION_MS,
  RECEIPT_MAX_ATTEMPTS,
  RECEIPT_RETRY_BASE_MS,
  RECEIPT_RETRY_MAX_MS,
  VERIFY_MAX_ATTEMPTS,
  VERIFY_RETRY_BASE_MS,
  VERIFY_RETRY_MAX_MS,
  type ActionReceiptOrigin,
} from './store';

type VerifiedEffect = z.infer<typeof VerifiedTopicEffectSchema>;
/**
 * How long after the claim a topic's remaining steps may still start. The
 * card's own expiry bounds the FIRST step only: a topic whose anchor and
 * body are posted at minute fourteen must be allowed its operation and
 * snapshot, or the room is left with a half-created topic.
 */
export const TOPIC_EXECUTION_WINDOW_MS = 60 * 60_000;
const backoff = (base: number, max: number, attempts: number) =>
  Math.min(base * 2 ** attempts, max);
export class TopicProposalStore {
  constructor(
    private readonly db: DoSqliteDatabase,
    private readonly now = Date.now,
  ) {}
  async setup(): Promise<void> {
    // The unreleased first shape of these tables (no status, session, run or
    // attempt columns) exists only where a pre-release build of the branch
    // ran; it is rebuilt rather than migrated, and the fact logged, so an
    // object holding it boots instead of failing every request on the
    // index below.
    const columns = await this.db.exec<{ name: string }>(
      `PRAGMA table_info(topic_action_proposals)`,
    );
    if (columns.length && !columns.some((c) => c.name === 'session_id')) {
      console.warn(
        '[topic-actions] rebuilding pre-release topic_action_proposals tables',
      );
      await this.db.run(`DROP TABLE IF EXISTS topic_action_steps`);
      await this.db.run(`DROP TABLE IF EXISTS topic_action_proposals`);
    }
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS topic_action_proposals(id TEXT PRIMARY KEY,owner_did TEXT NOT NULL,invocation_id TEXT NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,subject TEXT NOT NULL,digest TEXT NOT NULL,lifecycle TEXT NOT NULL,status TEXT NOT NULL,origin TEXT,receipt_state TEXT NOT NULL DEFAULT 'waiting',receipt_attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,verify_after INTEGER NOT NULL DEFAULT 0,verify_attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL, UNIQUE(owner_did,invocation_id))`,
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS topic_action_proposals_run ON topic_action_proposals(owner_did,session_id,run_id)`,
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS topic_action_proposals_status ON topic_action_proposals(owner_did,status,verify_after)`,
    );
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS topic_action_steps(proposal_id TEXT NOT NULL,step TEXT NOT NULL,status TEXT NOT NULL,expected TEXT,expected_digest TEXT,executor TEXT,started_at TEXT,reference TEXT,receipt TEXT, PRIMARY KEY(proposal_id,step))`,
    );
  }
  /** Every lifecycle write keeps the indexed `status` column in step with the JSON. */
  private async writeLifecycle(
    owner: string,
    id: string,
    lifecycle: TopicActionProposal['lifecycle'],
    receipt?: { state: 'pending' | 'waiting'; nextAttempt: number },
  ): Promise<void> {
    await this.db.run(
      receipt
        ? `UPDATE topic_action_proposals SET lifecycle=?,status=?,receipt_state=?,next_attempt=? WHERE owner_did=? AND id=?`
        : `UPDATE topic_action_proposals SET lifecycle=?,status=? WHERE owner_did=? AND id=?`,
      receipt
        ? [
            JSON.stringify(lifecycle),
            lifecycle.status,
            receipt.state,
            receipt.nextAttempt,
            owner,
            id,
          ]
        : [JSON.stringify(lifecycle), lifecycle.status, owner, id],
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
        `INSERT INTO topic_action_proposals(id,owner_did,invocation_id,session_id,run_id,subject,digest,lifecycle,status,origin,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          subject.id,
          subject.ownerDid,
          subject.origin.invocationId,
          subject.origin.sessionId,
          subject.origin.runId,
          JSON.stringify(subject),
          digest,
          JSON.stringify(lifecycle),
          'prepared',
          origin ? JSON.stringify(origin) : null,
          Date.parse(subject.createdAt),
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
      `SELECT id FROM topic_action_proposals WHERE owner_did=? AND session_id=? AND run_id=? ORDER BY verify_after,id LIMIT 32`,
      [owner, session, run],
    );
    const values = await Promise.all(rows.map((r) => this.get(owner, r.id)));
    return values.filter((p): p is TopicActionProposal => p !== null);
  }
  /**
   * Cards whose started steps have references the chain or room has not
   * confirmed yet, cooldown passed, attempts not used up; the alarm
   * reconciles these so a card the owner walked away from still completes.
   */
  async dueVerifications(
    owner: string,
    limit = 2,
  ): Promise<TopicActionProposal[]> {
    // A revoked card's started step may still land: its reference is
    // reconciled too, so the effect is receipted and the grant lock released.
    const rows = await this.db.exec<{ id: string }>(
      `SELECT DISTINCT p.id FROM topic_action_proposals p JOIN topic_action_steps s ON s.proposal_id=p.id WHERE p.owner_did=? AND p.status IN ('unknown','revoked') AND p.verify_after<=? AND p.verify_attempts<? AND s.reference IS NOT NULL AND s.status!='verified' ORDER BY p.verify_after,p.id LIMIT ?`,
      [owner, this.now(), VERIFY_MAX_ATTEMPTS, limit],
    );
    const proposals: TopicActionProposal[] = [];
    for (const row of rows) {
      try {
        const p = await this.get(owner, row.id);
        if (p) proposals.push(p);
      } catch (error) {
        // A row this build cannot read drops out of the schedule instead of
        // failing the alarm every tick.
        await this.db.run(
          `UPDATE topic_action_proposals SET verify_attempts=? WHERE owner_did=? AND id=?`,
          [VERIFY_MAX_ATTEMPTS, owner, row.id],
        );
        console.error(
          `[topic-actions] verification of ${row.id} quarantined: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return proposals;
  }
  async nextVerificationAt(owner: string): Promise<number | undefined> {
    const row = await this.db.get<{ due: number | null }>(
      `SELECT MIN(p.verify_after) AS due FROM topic_action_proposals p JOIN topic_action_steps s ON s.proposal_id=p.id WHERE p.owner_did=? AND p.status IN ('unknown','revoked') AND p.verify_attempts<? AND s.reference IS NOT NULL AND s.status!='verified'`,
      [owner, VERIFY_MAX_ATTEMPTS],
    );
    return row?.due ?? undefined;
  }
  /** Finished cards past retention go, with their steps; open ones stay. */
  async prune(owner: string): Promise<number> {
    const before = this.now() - ACTION_PROPOSAL_RETENTION_MS;
    return this.db.transaction(async () => {
      const rows = await this.db.exec<{ id: string }>(
        `SELECT id FROM topic_action_proposals WHERE owner_did=? AND created_at<? AND status IN ('prepared','succeeded','failed','rejected','revoked','superseded') AND receipt_state<>'pending' LIMIT 64`,
        [owner, before],
      );
      for (const row of rows) {
        await this.db.run(
          `DELETE FROM topic_action_steps WHERE proposal_id=?`,
          [row.id],
        );
        await this.db.run(
          `DELETE FROM topic_action_proposals WHERE owner_did=? AND id=?`,
          [owner, row.id],
        );
      }
      return rows.length;
    });
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
      await this.writeLifecycle(
        owner,
        id,
        TopicProposalV2Schema.shape.lifecycle.parse(lifecycle),
      );
      return TopicProposalV2Schema.parse({ ...p, lifecycle });
    });
  }
  /**
   * The local refusals `begin` applies, without writing anything: the owner
   * object runs these before the remote authority read, so a card that is
   * not claimed, expired, out of order or in another executor's hands is
   * answered in milliseconds instead of after a ten second budget.
   */
  async assertBeginnable(
    owner: string,
    id: string,
    input: BeginTopicStep,
  ): Promise<void> {
    const p = await this.get(owner, id);
    if (!p) throw new ActionProposalConflict('Proposal missing');
    await this.checkBegin(p, input);
  }
  private async checkBegin(
    p: TopicActionProposal,
    input: BeginTopicStep,
  ): Promise<TopicActionProposal['lifecycle']['steps'][number]> {
    if (p.digest !== input.digest)
      throw new ActionProposalConflict('Proposal changed');
    if (
      p.lifecycle.executionBlockedAt ||
      !['claimed', 'unknown'].includes(p.lifecycle.status)
    )
      throw new ActionProposalConflict('Proposal was not claimed');
    const now = this.now();
    if (!p.lifecycle.claimedAt)
      throw new ActionProposalConflict('Proposal was not claimed');
    // An effect may exist in the world once a step has a reference or is
    // verified; until then the card's own expiry bounds every attempt to
    // start, a permitted-but-never-sent first step included.
    const effects = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM topic_action_steps WHERE proposal_id=? AND (reference IS NOT NULL OR status='verified')`,
      [p.id],
    );
    const started = (effects?.n ?? 0) > 0;
    if (!started && Date.parse(p.expiresAt) <= now)
      throw new ActionProposalConflict('Proposal expired');
    if (
      started &&
      Date.parse(p.lifecycle.claimedAt) + TOPIC_EXECUTION_WINDOW_MS <= now
    )
      throw new ActionProposalConflict('Execution window closed');
    if (
      input.executor.matrixUserId !== p.action.owner.matrixUserId ||
      input.executor.homeserver !== p.action.owner.homeserver
    )
      throw new ActionProposalConflict('Execution identity changed');
    const index = p.lifecycle.steps.findIndex((s) => s.step === input.step);
    if (index < 0) throw new ActionProposalConflict('Invalid step');
    if (p.lifecycle.steps.slice(0, index).some((s) => s.status !== 'verified'))
      throw new ActionProposalConflict('Predecessor is not verified');
    if (input.step === 'grant') await this.assertNoConcurrentGrant(p);
    return p.lifecycle.steps[index]!;
  }
  /**
   * Two cards granting the same account the same role under the same admin,
   * both started and neither confirmed, would overwrite each other on chain
   * while both receipts said "granted". The lock follows the other card's
   * grant STEP, not its status: it holds while that step may still be
   * broadcast (no reference yet, inside its holder's execution window) or
   * may still land (a reference recorded, verification not given up), a
   * revoked card included.
   */
  private async assertNoConcurrentGrant(p: TopicActionProposal): Promise<void> {
    if (p.action.name !== 'grant_topic_access') return;
    const admin = p.action.adminAddress;
    const keys = new Set(
      p.action.grants.map((g) => `${admin}\0${g.address}\0${g.role}`),
    );
    const now = this.now();
    const rows = await this.db.exec<{
      id: string;
      subject: string;
      lifecycle: string;
      verify_attempts: number;
      reference: string | null;
    }>(
      `SELECT p.id,p.subject,p.lifecycle,p.verify_attempts,s.reference FROM topic_action_proposals p JOIN topic_action_steps s ON s.proposal_id=p.id WHERE p.owner_did=? AND p.id<>? AND s.step='grant' AND s.status='started'`,
      [p.ownerDid, p.id],
    );
    for (const row of rows) {
      let action: TopicProposalSubject['action'];
      let claimedAt: string | undefined;
      try {
        action = TopicProposalSubjectSchema.parse(
          JSON.parse(row.subject),
        ).action;
        claimedAt = TopicLifecycleSchema.parse(
          JSON.parse(row.lifecycle),
        ).claimedAt;
      } catch (error) {
        console.warn(
          `[topic-actions] grant lock skips unreadable card ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (action.name !== 'grant_topic_access') continue;
      if (
        !action.grants.some((g) =>
          keys.has(`${action.adminAddress}\0${g.address}\0${g.role}`),
        )
      )
        continue;
      const holds = row.reference
        ? row.verify_attempts < VERIFY_MAX_ATTEMPTS
        : !!claimedAt &&
          Date.parse(claimedAt) + TOPIC_EXECUTION_WINDOW_MS > now;
      if (holds)
        throw new ActionProposalConflict(
          `Another grant for this account is still in progress (${row.id})`,
        );
    }
  }
  async begin(
    owner: string,
    id: string,
    input: BeginTopicStep,
    effect: ExpectedTopicEffect,
  ): Promise<BeginTopicStepResult | null> {
    const expectedDigest = await digestTopicEffect(effect);
    // The device id binds the permit to its holder and is compared from the
    // journal row only; what goes out in step records and permits is the
    // identity every consumer's contract already knows.
    const executor = {
      matrixUserId: input.executor.matrixUserId,
      homeserver: input.executor.homeserver,
    };
    return this.db.transaction(async () => {
      const p = await this.get(owner, id);
      if (!p) return null;
      const current = await this.checkBegin(p, input);
      if (current.status !== 'pending') {
        // A started step with no reference yet is the same executor's to
        // retry with the SAME frozen effect: a failed Portal pre-check or a
        // wallet cancel must not burn the step until the card expires.
        const row = await this.db.get<{
          status: string;
          expected: string | null;
          expected_digest: string | null;
          executor: string | null;
          reference: string | null;
        }>(
          `SELECT status,expected,expected_digest,executor,reference FROM topic_action_steps WHERE proposal_id=? AND step=?`,
          [id, input.step],
        );
        if (
          row?.status === 'started' &&
          !row.reference &&
          row.expected &&
          row.expected_digest === expectedDigest &&
          row.executor &&
          canonicalizeIxoJson(JSON.parse(row.executor)) ===
            canonicalizeIxoJson(input.executor)
        )
          return {
            status: 'permitted',
            permit: {
              proposalId: id,
              digest: p.digest,
              step: input.step,
              executor,
              expectedDigest,
              effect: ExpectedTopicEffectSchema.parse(JSON.parse(row.expected)),
            },
          };
        return { status: 'already_started', proposal: p };
      }
      const startedAt = new Date(this.now()).toISOString();
      const record = {
        step: input.step,
        status: 'started' as const,
        startedAt,
        expectedDigest,
        executor,
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
      const lifecycle = TopicProposalV2Schema.shape.lifecycle.parse({
        ...p.lifecycle,
        status: 'unknown',
        steps: p.lifecycle.steps.map((s) =>
          s.step === input.step ? record : s,
        ),
      });
      await this.writeLifecycle(owner, id, lifecycle);
      return {
        status: 'permitted',
        permit: {
          proposalId: id,
          digest: p.digest,
          step: input.step,
          executor,
          expectedDigest,
          effect,
        },
      };
    });
  }
  /** One reconciliation per cooldown; the wait doubles with every attempt (see `store.ts`). */
  async claimVerification(owner: string, id: string): Promise<boolean> {
    const now = this.now();
    const row = await this.db.get<{ verify_attempts: number }>(
      `SELECT verify_attempts FROM topic_action_proposals WHERE owner_did=? AND id=? AND verify_after<=?`,
      [owner, id, now],
    );
    if (!row) return false;
    const result = await this.db.run(
      `UPDATE topic_action_proposals SET verify_after=?,verify_attempts=verify_attempts+1 WHERE owner_did=? AND id=? AND verify_after<=?`,
      [
        now +
          backoff(
            VERIFY_RETRY_BASE_MS,
            VERIFY_RETRY_MAX_MS,
            row.verify_attempts,
          ),
        owner,
        id,
        now,
      ],
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
      await this.writeLifecycle(
        owner,
        id,
        TopicProposalV2Schema.shape.lifecycle.parse(lifecycle),
        {
          state: finalReceipt ? 'pending' : 'waiting',
          nextAttempt: this.now(),
        },
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
    if (!rows.length) return [];
    return TopicReceiptReferencesSchema.parse({
      v: 2,
      references: rows.map((r) => JSON.parse(r.reference)),
    }).references;
  }
  /**
   * Receipts due now, at most four, each moved to its next attempt (or
   * abandoned on the last) before it is handed out; a row this build can
   * no longer read is quarantined rather than retried for ever. Same
   * schedule as the transfer receipts in `store.ts`.
   */
  async takeReceipts(
    owner: string,
  ): Promise<{ proposal: TopicActionProposal; origin: ActionReceiptOrigin }[]> {
    return this.db.transaction(async () => {
      const now = this.now();
      const rows = await this.db.exec<{
        id: string;
        origin: string;
        receipt_attempts: number;
      }>(
        `SELECT id,origin,receipt_attempts FROM topic_action_proposals WHERE owner_did=? AND receipt_state='pending' AND origin IS NOT NULL AND next_attempt<=? ORDER BY next_attempt,id LIMIT 4`,
        [owner, now],
      );
      const results = [];
      for (const row of rows) {
        let proposal: TopicActionProposal | null;
        try {
          proposal = await this.get(owner, row.id);
        } catch (error) {
          await this.db.run(
            `UPDATE topic_action_proposals SET receipt_state='quarantined' WHERE owner_did=? AND id=?`,
            [owner, row.id],
          );
          console.error(
            `[topic-actions] receipt ${row.id} quarantined: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        if (!proposal) continue;
        const attempts = row.receipt_attempts + 1;
        await this.db.run(
          attempts >= RECEIPT_MAX_ATTEMPTS
            ? `UPDATE topic_action_proposals SET receipt_state='abandoned',receipt_attempts=? WHERE owner_did=? AND id=?`
            : `UPDATE topic_action_proposals SET next_attempt=?,receipt_attempts=? WHERE owner_did=? AND id=?`,
          attempts >= RECEIPT_MAX_ATTEMPTS
            ? [attempts, owner, row.id]
            : [
                now +
                  backoff(
                    RECEIPT_RETRY_BASE_MS,
                    RECEIPT_RETRY_MAX_MS,
                    row.receipt_attempts,
                  ),
                attempts,
                owner,
                row.id,
              ],
        );
        results.push({ proposal, origin: JSON.parse(row.origin) });
      }
      return results;
    });
  }
  async receiptMirrored(owner: string, id: string): Promise<void> {
    await this.db.run(
      `UPDATE topic_action_proposals SET receipt_state='delivered' WHERE owner_did=? AND id=? AND receipt_state IN ('pending','abandoned')`,
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
