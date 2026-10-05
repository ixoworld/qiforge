import {
  INTERACTION_EMOJI,
  isTerminalInteraction,
  type OracleInteraction,
} from '@ixo/oracles-events/interactions';
import { matrixTxnId } from '../matrix/txn-id';

interface Reaction {
  eventId: string;
  emoji: string;
}
export interface InteractionRecord {
  update: OracleInteraction;
  current?: Reaction;
  retired: string[];
  pending: boolean;
  sending?: { update: OracleInteraction; emoji: string; txnId: string };
}
export interface InteractionStorage {
  get(key: string): Promise<InteractionRecord | undefined>;
  put(key: string, value: InteractionRecord): Promise<void>;
  list(): Promise<Map<string, InteractionRecord>>;
}
export interface InteractionCoordinatorDeps {
  storage: InteractionStorage;
  send(
    update: OracleInteraction,
    emoji: string,
    txnId: string,
  ): Promise<string>;
  redact(roomId: string, eventId: string): Promise<void>;
  keepAlive(work: Promise<unknown>): void;
  warn(error: unknown): void;
}
/** Persists intent before delivery. Each chain changes only reactions it owns. */
export class InteractionCoordinator {
  private chains = new Map<string, Promise<void>>();
  constructor(private readonly deps: InteractionCoordinatorDeps) {}
  private async key(update: OracleInteraction): Promise<string> {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify([update.oracleDid, update.sessionId, update.requestId]),
      ),
    );
    return `interaction-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  async update(update: OracleInteraction): Promise<OracleInteraction> {
    const key = await this.key(update);
    // Serialize storage admission too, so concurrent heartbeats cannot overwrite a terminal update.
    let admitted = update;
    const work = (this.chains.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const old = await this.deps.storage.get(key);
        if (
          old &&
          (old.update.revision > update.revision ||
            (isTerminalInteraction(old.update.state) &&
              !isTerminalInteraction(update.state)))
        ) {
          admitted = old.update;
          return;
        }
        if (old && old.update.revision === update.revision) {
          admitted = old.update;
          return;
        }
        const record: InteractionRecord = {
          update,
          retired: old?.retired ?? [],
          ...(old?.current ? { current: old.current } : {}),
          ...(old?.sending ? { sending: old.sending } : {}),
          pending: true,
        };
        await this.deps.storage.put(key, record);
      });
    this.chains.set(key, work);
    await work;
    this.schedule(key);
    return admitted;
  }
  async transition(
    update: OracleInteraction,
    state: OracleInteraction['state'],
  ): Promise<void> {
    const key = await this.key(update);
    const work = (this.chains.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const record = await this.deps.storage.get(key);
        const latest = record?.update ?? update;
        if (latest.state === state) return;
        await this.deps.storage.put(key, {
          ...record,
          update: {
            ...latest,
            state,
            revision: latest.revision + 1,
            updatedAt: new Date().toISOString(),
          },
          retired: record?.retired ?? [],
          pending: true,
        });
      });
    this.chains.set(key, work);
    await work;
    this.schedule(key);
  }
  private schedule(key: string): void {
    const work = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.reconcile(key))
      .catch((error: unknown) => this.deps.warn(error))
      .finally(() => {
        if (this.chains.get(key) === work) this.chains.delete(key);
      });
    this.chains.set(key, work);
    this.deps.keepAlive(work);
  }
  async reconcilePending(): Promise<void> {
    for (const [key, record] of await this.deps.storage.list())
      if (record.pending) this.schedule(key);
    await this.settle();
  }
  async settle(): Promise<void> {
    await Promise.all(this.chains.values());
  }
  private async reconcile(key: string): Promise<void> {
    const record = await this.deps.storage.get(key);
    if (
      !record?.pending ||
      !record.update.roomId ||
      !record.update.sourceEventId?.startsWith('$')
    )
      return;
    await this.confirmPending(key, record);
    const emoji = INTERACTION_EMOJI[record.update.state];
    if (record.current?.emoji !== emoji && record.current) {
      record.retired.push(record.current.eventId);
      delete record.current;
      await this.deps.storage.put(key, record);
    }
    while (record.retired.length) {
      const eventId = record.retired[0]!;
      await this.deps.redact(record.update.roomId, eventId);
      record.retired.shift();
      await this.deps.storage.put(key, record);
    }
    if (!record.current) {
      record.sending = {
        update: record.update,
        emoji,
        txnId: matrixTxnId('reaction', key, String(record.update.revision)),
      };
      await this.deps.storage.put(key, record);
      await this.confirmPending(key, record);
    }
    record.pending = false;
    await this.deps.storage.put(key, record);
  }
  private async confirmPending(
    key: string,
    record: InteractionRecord,
  ): Promise<void> {
    const sending = record.sending;
    if (!sending) return;
    const eventId = await this.deps.send(
      sending.update,
      sending.emoji,
      sending.txnId,
    );
    if (!eventId.startsWith('$'))
      throw new Error('Reaction has no confirmed Matrix event ID');
    record.current = { eventId, emoji: sending.emoji };
    delete record.sending;
    await this.deps.storage.put(key, record);
  }
}
