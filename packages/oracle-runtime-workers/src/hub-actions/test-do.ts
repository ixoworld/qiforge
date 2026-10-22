import { DurableObject } from 'cloudflare:workers';
import type {
  ActionOutcomeV1,
  ActionReferenceV1,
  ActionOperationV1,
} from '@ixo/action-protocol';
import { DoSqliteDatabase } from '../sqlite/database';
import { HubActionStore, type HubActionOrigin } from './store';

export class HubActionTestDO extends DurableObject {
  private db?: DoSqliteDatabase;
  private store?: HubActionStore;

  private async actions(): Promise<HubActionStore> {
    if (!this.store) {
      this.db ??= await DoSqliteDatabase.open(this.ctx, 'hub-action-test.db');
      this.store = new HubActionStore(this.db);
      await this.store.setup();
    }
    return this.store;
  }

  async record(origin: HubActionOrigin, reference: ActionReferenceV1) {
    return (await this.actions()).record(origin, reference);
  }
  async reserve(
    origin: HubActionOrigin,
    operation: ActionOperationV1,
    expiresAt: number,
  ) {
    return (await this.actions()).reserve(origin, operation, expiresAt);
  }
  async get(ownerDid: string, id: string) {
    return (await this.actions()).get(ownerDid, id);
  }
  async outcome(input: ActionOutcomeV1) {
    await (await this.actions()).recordOutcome(input);
  }
  async forRun(ownerDid: string, sessionId: string, runId: string) {
    return (await this.actions()).outcomesForRun(ownerDid, sessionId, runId);
  }
  async reopen() {
    this.store = undefined;
  }
}
