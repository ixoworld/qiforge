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
  private async topics() {
    await this.proposals();
    const store = new TopicProposalStore(this.db!, () => this.now);
    await store.setup();
    return store;
  }
  async topicCreate(raw: string) {
    return JSON.stringify(
      await (
        await this.topics()
      ).create(TopicProposalSubjectSchema.parse(JSON.parse(raw))),
    );
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
  async topicReconcile(
    owner: string,
    id: string,
    input: string,
    events: string,
    state: string,
  ) {
    const store = await this.topics();
    const p = await store.get(owner, id);
    if (!p) return null;
    const values = JSON.parse(events);
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
          rpc: undefined,
        },
      ),
    );
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
