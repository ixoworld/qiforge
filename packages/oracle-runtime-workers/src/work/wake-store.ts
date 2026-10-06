import {
  WakeSubscriptionSchema,
  type WakeSubscription,
} from '@ixo/common/work';
import type { DoSqliteDatabase } from '../sqlite/database';

export interface WakeEvent {
  id: string;
  cursor: string;
  eventType: string;
  resourceRef: string;
}
export class WakeSubscriptionStore {
  constructor(private readonly db: DoSqliteDatabase) {}
  async setup(): Promise<void> {
    await this.db.run(
      'CREATE TABLE IF NOT EXISTS wake_subscriptions (id TEXT PRIMARY KEY, subscription_json TEXT NOT NULL)',
    );
    await this.db.run(
      'CREATE TABLE IF NOT EXISTS wake_operations (subscription_id TEXT NOT NULL,event_id TEXT NOT NULL,cursor TEXT NOT NULL,PRIMARY KEY(subscription_id,event_id))',
    );
  }
  async get(id: string): Promise<WakeSubscription | null> {
    await this.setup();
    const row = await this.db.get<{ subscription_json: string }>(
      'SELECT subscription_json FROM wake_subscriptions WHERE id=?',
      [id],
    );
    return row
      ? WakeSubscriptionSchema.parse(JSON.parse(row.subscription_json))
      : null;
  }
  async register(input: WakeSubscription): Promise<void> {
    await this.setup();
    const subscription = WakeSubscriptionSchema.parse(input);
    await this.db.transaction(async () => {
      await this.db.run(
        'INSERT OR IGNORE INTO wake_subscriptions(id,subscription_json) VALUES (?,?)',
        [subscription.subscriptionId, JSON.stringify(subscription)],
      );
      const existing = await this.get(subscription.subscriptionId);
      if (!existing) throw new Error('Wake registration was not persisted');
      const binding = (value: WakeSubscription) => ({
        version: value.version,
        subscriptionId: value.subscriptionId,
        principalDID: value.principalDID,
        source: value.source,
        resourceRef: value.resourceRef,
        filter: value.filter,
        deliveryPolicy: value.deliveryPolicy,
      });
      if (
        JSON.stringify(binding(existing)) !==
        JSON.stringify(binding(subscription))
      )
        throw new Error('Wake subscription is bound to different input');
    });
  }

  async revoke(id: string): Promise<void> {
    const current = await this.get(id);
    if (!current) return;
    await this.db.run(
      'UPDATE wake_subscriptions SET subscription_json=? WHERE id=?',
      [JSON.stringify({ ...current, state: 'revoked' }), id],
    );
  }
  async accept<T>(
    id: string,
    event: WakeEvent,
    reread: (subscription: WakeSubscription) => Promise<boolean>,
    operation: () => Promise<T>,
  ): Promise<{ accepted: boolean; result?: T }> {
    const subscription = await this.get(id);
    if (
      !subscription ||
      subscription.state !== 'active' ||
      Date.parse(subscription.expiresAt) <= Date.now() ||
      event.resourceRef !== subscription.resourceRef ||
      !subscription.filter.eventTypes.includes(event.eventType)
    )
      return { accepted: false };
    if (!(await reread(subscription))) return { accepted: false };
    return this.db.transaction(async () => {
      const current = await this.get(id);
      if (
        !current ||
        current.state !== 'active' ||
        Date.parse(current.expiresAt) <= Date.now()
      )
        return { accepted: false };
      const prior = await this.db.get<{ cursor: string }>(
        'SELECT cursor FROM wake_operations WHERE subscription_id=? AND event_id=?',
        [id, event.id],
      );
      if (prior) {
        if (prior.cursor !== event.cursor)
          throw new Error('Wake event is bound to a different cursor');
        return { accepted: false };
      }
      const result = await operation();
      await this.db.run(
        'INSERT INTO wake_operations(subscription_id,event_id,cursor) VALUES (?,?,?)',
        [id, event.id, event.cursor],
      );
      await this.db.run(
        'UPDATE wake_subscriptions SET subscription_json=? WHERE id=?',
        [JSON.stringify({ ...current, cursor: event.cursor }), id],
      );
      return { accepted: true, result };
    });
  }
}
