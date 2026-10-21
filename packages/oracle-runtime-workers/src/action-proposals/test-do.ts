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
  private async proposals() {
    if (!this.db) {
      this.db = await DoSqliteDatabase.open(
        this.ctx,
        'action-proposals-test.db',
      );
      this.store = new ActionProposalStore(this.db, () => this.now);
      await this.store.setup();
    }
    return this.store!;
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
  async setNow(now: number) {
    this.now = now;
  }
  async reopen() {
    await this.db?.close();
    this.db = undefined;
    this.store = undefined;
  }
}
