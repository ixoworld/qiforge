import { DurableObject } from 'cloudflare:workers';
import type { ExecutionReceipt, WakeSubscription } from '@ixo/common/work';
import { DoSqliteDatabase } from '../sqlite/database';
import type { PreparedExecution } from './contracts';
import { ExecutionReceiptStore } from './execution-store';
import { WakeSubscriptionStore, type WakeEvent } from './wake-store';

export class WorkTestDO extends DurableObject {
  private db: DoSqliteDatabase | undefined;
  private async database() {
    this.db ??= await DoSqliteDatabase.open(this.ctx, 'work.db');
    return this.db;
  }
  async begin(operationId: string, input: PreparedExecution) {
    return new ExecutionReceiptStore(await this.database()).begin(
      operationId,
      input,
    );
  }
  async record(operationId: string, receipt: ExecutionReceipt) {
    return new ExecutionReceiptStore(await this.database()).record(
      operationId,
      receipt,
    );
  }
  async beginError(operationId: string, input: PreparedExecution) {
    try {
      await this.begin(operationId, input);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  async recordError(operationId: string, receipt: ExecutionReceipt) {
    try {
      await this.record(operationId, receipt);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  async wakeError(id: string, event: WakeEvent) {
    try {
      await this.wake(id, event, true);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  async reopen() {
    this.db = undefined;
  }
  async register(input: WakeSubscription) {
    await new WakeSubscriptionStore(await this.database()).register(input);
  }
  async revoke(id: string) {
    await new WakeSubscriptionStore(await this.database()).revoke(id);
  }
  async wake(id: string, event: WakeEvent, authorized: boolean) {
    const db = await this.database();
    return new WakeSubscriptionStore(db).accept(
      id,
      event,
      async () => authorized,
      async () => {
        await db.run(
          'CREATE TABLE IF NOT EXISTS work_wakes(id TEXT PRIMARY KEY)',
        );
        await db.run('INSERT INTO work_wakes(id) VALUES (?)', [event.id]);
        return event.id;
      },
    );
  }
  async subscription(id: string) {
    return new WakeSubscriptionStore(await this.database()).get(id);
  }
}
