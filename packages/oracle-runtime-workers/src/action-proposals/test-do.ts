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
