import {
  isTerminalInteraction,
  type InteractionAchievement,
  type InteractionState,
  type OracleInteraction,
} from '@ixo/oracles-events/interactions';
export interface InteractionEvidence {
  achievement?: InteractionAchievement;
  unconfirmed?: boolean;
}
export interface InteractionHost {
  save(update: OracleInteraction, evidence: InteractionEvidence): Promise<void>;
  publish(update: OracleInteraction): Promise<void>;
  emit(update: OracleInteraction): void;
  keepAlive(work: Promise<unknown>): void;
  warn(error: unknown): void;
}
/** One request, independent of which browser currently displays it. */
export class InteractionProducer {
  private chain = Promise.resolve();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private achievement?: InteractionAchievement;
  private unconfirmed = false;
  constructor(
    public snapshot: OracleInteraction,
    private readonly host: InteractionHost,
    evidence: InteractionEvidence = {},
  ) {
    this.achievement = evidence.achievement;
    this.unconfirmed = evidence.unconfirmed ?? false;
  }
  update(state: InteractionState): void {
    if (isTerminalInteraction(this.snapshot.state)) return;
    this.snapshot = {
      ...this.snapshot,
      state,
      revision: this.snapshot.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.flush();
  }
  bind(roomId: string, eventId: string): void {
    if (!eventId.startsWith('$')) return;
    this.snapshot = {
      ...this.snapshot,
      roomId,
      sourceEventId: eventId,
      revision: this.snapshot.revision + 1,
    };
    this.flush();
  }
  verifiedAchievement(achievement: InteractionAchievement): void {
    if (achievement.reference.trim()) {
      this.achievement = achievement;
      this.flush();
    }
  }
  get confirmedAchievement(): InteractionAchievement | undefined {
    return this.achievement;
  }
  setWaiting(waiting: boolean): void {
    this.update(waiting ? 'waiting' : 'working');
  }
  accept(): void {
    if (this.snapshot.state === 'seen') this.update('accepted');
  }
  needsAttention(): void {
    this.unconfirmed = true;
    this.flush();
  }
  start(): void {
    this.stop();
    this.accept();
    this.update('working');
    this.heartbeat = setInterval(() => {
      const snapshot = this.snapshot;
      this.host.keepAlive(this.host.publish(snapshot).catch(this.host.warn));
    }, 20_000);
  }
  finish(
    state: 'completed' | 'failed' | 'cancelled' | 'superseded',
    celebrate = true,
  ): void {
    if (state !== 'completed' || this.snapshot.state !== 'waiting')
      this.update(
        state === 'completed' && this.unconfirmed
          ? 'failed'
          : state === 'completed' && celebrate && this.achievement
            ? 'achieved'
            : state,
      );
    this.stop();
  }
  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
  settle(): Promise<void> {
    return this.chain;
  }
  private flush(): void {
    const snapshot = this.snapshot;
    const evidence = {
      achievement: this.achievement,
      unconfirmed: this.unconfirmed,
    };
    this.host.emit(snapshot);
    this.chain = this.chain
      .then(async () => {
        await this.host.save(snapshot, evidence);
        this.host.keepAlive(this.host.publish(snapshot).catch(this.host.warn));
      })
      .catch(this.host.warn);
    this.host.keepAlive(this.chain);
  }
}
