import { TopicProposalStore } from './topic-store';
import {
  TopicProposalSubjectSchema,
  BeginTopicStepSchema,
  TopicReceiptReferencesSchema,
} from '@ixo/ixo-transaction/topic-proposals';
import { topicExpectedEffect } from './topic-effects';
import { reconcileTopicReferences } from './topic-verify';
import { refreshActionProposal } from './reconcile';
import { DurableObject } from 'cloudflare:workers';
import { DoSqliteDatabase } from '../sqlite/database';
import { ActionProposalStore, type ProposalCommand } from './store';
import type { ActionProposalSubject } from '@ixo/ixo-transaction/action-proposals';
import type { VerifiedActionTransaction } from './verify';
export class ActionProposalTestDO extends DurableObject {
  private db: DoSqliteDatabase | undefined;
  private store: ActionProposalStore | undefined;
  private now = Date.parse('2026-10-18T10:00:00.000Z');
  private async database() {
    this.db ??= await DoSqliteDatabase.open(
      this.ctx,
      'action-proposals-test.db',
    );
    return this.db;
  }
  private async proposals() {
    if (!this.store) {
      this.store = new ActionProposalStore(
        await this.database(),
        () => this.now,
      );
      await this.store.setup();
    }
    return this.store;
  }
  /** The branch's first, unreleased table shape with one row in it, before any store opens. */
  async legacyTable() {
    const db = await this.database();
    await db.run(
      `CREATE TABLE IF NOT EXISTS action_proposals (id TEXT PRIMARY KEY, owner_did TEXT NOT NULL, invocation_id TEXT NOT NULL, subject TEXT NOT NULL, digest TEXT NOT NULL, lifecycle TEXT NOT NULL, verify_after INTEGER NOT NULL DEFAULT 0, UNIQUE(owner_did, invocation_id))`,
    );
    await db.run(
      `CREATE TABLE IF NOT EXISTS action_proposal_receipts (proposal_id TEXT PRIMARY KEY, owner_did TEXT NOT NULL, origin TEXT, state TEXT NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0)`,
    );
    await db.run(
      `INSERT INTO action_proposals (id,owner_did,invocation_id,subject,digest,lifecycle) VALUES ('ap_00000000-0000-4000-8000-00000000dead','did:ixo:legacy','run:call','{}','d','{"status":"prepared"}')`,
    );
  }
  async create(subject: ActionProposalSubject) {
    return JSON.stringify(await (await this.proposals()).create(subject));
  }
  async get(owner: string, id: string) {
    const p = await (await this.proposals()).get(owner, id);
    return p ? JSON.stringify(p) : null;
  }
  async transition(owner: string, id: string, command: ProposalCommand) {
    const p = await (await this.proposals()).transition(owner, id, command);
    return p ? JSON.stringify(p) : null;
  }
  async verified(owner: string, id: string, result: VerifiedActionTransaction) {
    const p = await (await this.proposals()).recordVerified(owner, id, result);
    return p ? JSON.stringify(p) : null;
  }
  async outcomes(owner: string, session: string, run: string) {
    return (await this.proposals()).outcomesForRun(owner, session, run);
  }
  async refresh(owner: string, id: string, indexed: string | null) {
    const store = await this.proposals();
    const proposal = await store.get(owner, id);
    if (!proposal) return null;
    const fetcher: typeof fetch = async (input) =>
      String(input).includes('/status')
        ? Response.json({ result: { node_info: { network: 'pandora-8' } } })
        : indexed === 'unavailable'
          ? new Response('', { status: 503 })
          : indexed
            ? new Response(indexed)
            : new Response('', { status: 404 });
    const refreshed = await refreshActionProposal(
      store,
      proposal,
      'https://rpc.test/rpc/',
      fetcher,
    );
    return JSON.stringify(refreshed.proposal);
  }
  private async topics() {
    await this.proposals();
    const store = new TopicProposalStore(this.db!, () => this.now);
    await store.setup();
    return store;
  }
  /** The branch's first, unreleased topic table shape with one card in it, before any store opens. */
  async topicLegacyTable() {
    const db = await this.database();
    await db.run(
      `CREATE TABLE IF NOT EXISTS topic_action_proposals(id TEXT PRIMARY KEY,owner_did TEXT NOT NULL,invocation_id TEXT NOT NULL,subject TEXT NOT NULL,digest TEXT NOT NULL,lifecycle TEXT NOT NULL,origin TEXT,receipt_state TEXT NOT NULL DEFAULT 'waiting',next_attempt INTEGER NOT NULL DEFAULT 0, UNIQUE(owner_did,invocation_id))`,
    );
    await db.run(
      `CREATE TABLE IF NOT EXISTS topic_action_steps(proposal_id TEXT NOT NULL,step TEXT NOT NULL,status TEXT NOT NULL,expected TEXT,expected_digest TEXT,executor TEXT,started_at TEXT,reference TEXT,receipt TEXT, PRIMARY KEY(proposal_id,step))`,
    );
    await db.run(
      `INSERT INTO topic_action_proposals(id,owner_did,invocation_id,subject,digest,lifecycle) VALUES ('ap_00000000-0000-4000-8000-00000000dead','did:ixo:legacy','run:call','{}','d','{"status":"prepared"}')`,
    );
  }
  /** The steps table as the branch first shipped it, without `reference_rejected`, before any store opens. */
  async topicLegacySteps() {
    const db = await this.database();
    await db.run(
      `CREATE TABLE IF NOT EXISTS topic_action_steps(proposal_id TEXT NOT NULL,step TEXT NOT NULL,status TEXT NOT NULL,expected TEXT,expected_digest TEXT,executor TEXT,started_at TEXT,reference TEXT,receipt TEXT, PRIMARY KEY(proposal_id,step))`,
    );
  }
  async topicCreate(raw: string) {
    return JSON.stringify(
      await (
        await this.topics()
      ).create(TopicProposalSubjectSchema.parse(JSON.parse(raw))),
    );
  }
  async topicPrune(owner: string) {
    return (await this.topics()).prune(owner);
  }
  async topicReceiptState(id: string) {
    await this.topics();
    return (
      await this.db!.get<{ receipt_state: string }>(
        'SELECT receipt_state FROM topic_action_proposals WHERE id=?',
        [id],
      )
    )?.receipt_state;
  }
  async topicGet(owner: string, id: string) {
    return JSON.stringify(await (await this.topics()).get(owner, id));
  }
  async topicTransition(
    owner: string,
    id: string,
    kind: 'claim' | 'reject' | 'revoke' | 'supersede',
    digest: string,
  ) {
    return JSON.stringify(
      await (await this.topics()).transition(owner, id, kind, digest),
    );
  }
  async topicReplay(
    owner: string,
    origin: string,
    candidate: string,
    evidence: string[],
  ) {
    try {
      return JSON.stringify(
        await (
          await this.topics()
        ).replayPreparation(
          owner,
          JSON.parse(origin),
          JSON.parse(candidate),
          evidence,
        ),
      );
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed',
      });
    }
  }
  async topicBegin(owner: string, id: string, input: string) {
    try {
      const store = await this.topics();
      const p = await store.get(owner, id);
      if (!p) return null;
      const parsed = BeginTopicStepSchema.parse(JSON.parse(input));
      return JSON.stringify(
        await store.begin(
          owner,
          id,
          parsed,
          await topicExpectedEffect(p, parsed.step),
        ),
      );
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed',
      });
    }
  }
  /**
   * Reconciles against a fake room (`events` by id, `state` as the room
   * state) and, when `chain` is given, a fake RPC whose `/status` names
   * `chain.network` and whose `/tx` answers `chain.tx` (404 when null).
   */
  async topicReconcile(
    owner: string,
    id: string,
    input: string,
    events: string,
    state: string,
    chain?: string,
  ) {
    const store = await this.topics();
    const p = await store.get(owner, id);
    if (!p) return null;
    const values = JSON.parse(events);
    const rpc = chain
      ? (JSON.parse(chain) as { network: string; tx: unknown | null })
      : undefined;
    const fetcher: typeof fetch = async (request) =>
      String(request).includes('/status')
        ? Response.json({ result: { node_info: { network: rpc?.network } } })
        : rpc?.tx
          ? Response.json(rpc.tx)
          : new Response('', { status: 404 });
    try {
      return JSON.stringify(
        await reconcileTopicReferences(
          store,
          p,
          TopicReceiptReferencesSchema.parse(JSON.parse(input)),
          {
            reader: {
              state: async () => JSON.parse(state),
              event: async (_room, id) => values[id],
              history: async () =>
                Object.values(values).filter(
                  (value) =>
                    typeof value === 'object' &&
                    value !== null &&
                    'type' in value &&
                    value.type === 'ixo.topic.operation',
                ),
            },
            blocksync: undefined,
            rpc: rpc ? 'https://rpc.test/rpc/' : undefined,
            ...(rpc ? { fetcher } : {}),
          },
        ),
      );
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed',
      });
    }
  }
  async topicReferences(owner: string, id: string) {
    return JSON.stringify(await (await this.topics()).references(owner, id));
  }
  async due(owner: string) {
    return (await (await this.proposals()).dueVerifications(owner)).map(
      (p) => p.id,
    );
  }
  async nextVerification(owner: string) {
    return (await this.proposals()).nextVerificationAt(owner);
  }
  async prune(owner: string) {
    return (await this.proposals()).prune(owner);
  }
  async closeUnexecuted(owner: string) {
    return (await this.proposals()).closeUnexecuted(owner);
  }
  async nextClose(owner: string) {
    return (await this.proposals()).nextUnexecutedCloseAt(owner);
  }
  /** The indexed hash column, which a revoked blocked card keeps. */
  async hashColumn(id: string) {
    await this.proposals();
    return (
      (
        await (
          await this.database()
        ).get<{ transaction_hash: string | null }>(
          'SELECT transaction_hash FROM action_proposals WHERE id=?',
          [id],
        )
      )?.transaction_hash ?? null
    );
  }
  async verifyAttempts(id: string) {
    await this.proposals();
    return (
      await (
        await this.database()
      ).get<{ verify_attempts: number }>(
        'SELECT verify_attempts FROM action_proposals WHERE id=?',
        [id],
      )
    )?.verify_attempts;
  }
  async queryPlan(sql: string, params: unknown[]) {
    await this.proposals();
    return (
      await (
        await this.database()
      ).exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params as never)
    ).map((r) => r.detail);
  }
  async setNow(now: number) {
    this.now = now;
  }
  async reopen() {
    await this.db?.close();
    this.db = undefined;
    this.store = undefined;
  }
}
