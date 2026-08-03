/**
 * @fileoverview Publishes the entity's decision chain to its decisions room.
 *
 * The chain itself is pure and lives in `constitution/decision-record.ts`.
 * This is the half that has to deal with the world: Matrix comes up long
 * after the gate starts deciding, rooms reject writes, networks fail, and
 * none of that may be allowed to let an action happen with no record of why.
 *
 * Three properties.
 *
 * **Recording is synchronous and happens before execution.** A record written
 * after the handler returns would leave a window in which the entity has
 * acted and nothing says on what authority. So `record()` appends to the
 * in-memory chain and returns; publishing is a separate, slower problem.
 *
 * **The chain never gains a gap.** When a record cannot be queued for
 * publication it is not appended either. An auditor reading the room sees a
 * shorter chain rather than a broken one — and cannot tell a dropped record
 * from a deleted one, which is exactly the confusion a gap would create.
 *
 * **Failure to record is itself a decision.** `record()` returns null when it
 * cannot promise the record will be published. The gate turns that into a
 * refusal for effectful actions under strict enforcement: an entity that acts
 * while its own audit trail is down is an entity acting unaccountably, and
 * the constitution's whole claim is that it does not do that.
 */
import type { Amount } from '../../constitution/schema.js';
import {
  DecisionChain,
  type DecisionRecord,
} from '../../constitution/decision-record.js';
import type { DomainContext } from '../../constitution/domain-context.js';
import type { GateDecisionRecord } from '../../graph/middlewares/constitution-gate-middleware.js';
import type { Logger } from '../../plugin-api/types.js';

/** Timeline event carrying one decision. */
export const DECISION_EVENT_TYPE = 'ixo.constitution.decision';

/** State event naming the chain's head, so a reader knows what to expect. */
export const DECISION_HEAD_EVENT_TYPE = 'ixo.constitution.decision_head';

/**
 * How many records may wait for Matrix before the ledger reports unavailable.
 *
 * Sized for the window between the gate becoming live and Matrix finishing
 * init — a bounded startup gap, not a sustained backlog. If it fills, the
 * transport is down rather than slow, and continuing to accept records would
 * turn a visible refusal into an invisible loss.
 */
export const DEFAULT_MAX_BUFFERED = 1000;

const RETRY_DELAYS_MS = [250, 1000, 4000];

/** Whether a publishing pass emptied the queue or gave up part-way. */
type DrainOutcome = 'drained' | 'stalled';

/** The transport, injected so the ledger can be tested without Matrix. */
export interface DecisionTransport {
  sendEvent(roomId: string, type: string, content: object): Promise<string>;
  setState(
    roomId: string,
    type: string,
    stateKey: string,
    content: object,
  ): Promise<void>;
}

export interface DecisionLedgerOptions {
  domain: DomainContext;
  /** Where decisions are published. Null means nowhere — see `available`. */
  roomId: string | null;
  transport: DecisionTransport;
  logger: Logger;
  maxBuffered?: number;
  /** Sleep, injected so a test does not wait out the retry backoff. */
  delay?: (ms: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class DecisionLedgerService {
  private readonly chain = new DecisionChain();

  /** Records appended but not yet published, oldest first. */
  private readonly pending: DecisionRecord[] = [];

  private readonly domain: DomainContext;

  private readonly roomId: string | null;

  private readonly transport: DecisionTransport;

  private readonly logger: Logger;

  private readonly maxBuffered: number;

  private readonly delay: (ms: number) => Promise<void>;

  /** Matrix is up. Before this, records accumulate rather than publish. */
  private transportReady = false;

  /** One drain at a time; two would publish out of order. */
  private draining: Promise<void> | null = null;

  private overflowed = false;

  constructor(options: DecisionLedgerOptions) {
    this.domain = options.domain;
    this.roomId = options.roomId;
    this.transport = options.transport;
    this.logger = options.logger;
    this.maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
    this.delay = options.delay ?? sleep;
  }

  /**
   * Whether a decision recorded now can be expected to reach the room.
   *
   * False for a ledger with no destination, or one whose buffer has filled.
   * Deliberately not false merely because Matrix has not finished starting:
   * that window is expected, bounded, and what the buffer is for.
   */
  get available(): boolean {
    return this.roomId !== null && !this.overflowed;
  }

  /** How many decisions have been recorded, published or not. */
  get length(): number {
    return this.chain.length;
  }

  /** The most recent record, or null before anything has been decided. */
  get tip(): DecisionRecord | null {
    return this.chain.tip;
  }

  /**
   * What the named account has already moved since a given instant.
   *
   * A daily limit is a claim about history, and the evaluator that enforces it
   * is pure — so the history has to come from somewhere. The ledger is the
   * honest source: it already holds every decision the gate permitted, and
   * summing its own permits is the only account of spending the entity can
   * make without trusting a second system to agree with it.
   *
   * Only permits count. A refused payment moved nothing, and counting it would
   * let a rejected attempt eat the day's allowance.
   *
   * Denominated, because a limit is: only records in the asked-for currency
   * are summed, and spending in another denomination answers to its own limit.
   *
   * Returns null when the answer would be a guess — specifically, a window
   * starting before this process did, which covers spending this ledger never
   * saw. The evaluator reads null as "cannot check" and denies, which is the
   * right reading: a limit enforced against a fraction of the day is not the
   * limit.
   */
  spentSince(
    account: string,
    sinceEpochMs: number,
    denom: string,
  ): Amount | null {
    // The chain begins when the process does. A window reaching back further
    // than the first record covers spending this ledger never saw, and a
    // total that omits it understates the day.
    const first = this.chain.at(0);
    if (first && Date.parse(first.iat) > sinceEpochMs) return null;

    let total = 0n;
    for (const record of this.chain.records()) {
      if (record.verdict.outcome !== 'permit') continue;
      if (record.request.account !== account) continue;
      const value = record.request.value;
      if (!value || value.denom !== denom) continue;
      if (Date.parse(record.iat) < sinceEpochMs) continue;
      total += BigInt(value.amount);
    }
    return { amount: total.toString(), denom };
  }

  /**
   * Records a decision and schedules its publication.
   *
   * Returns the record, or null when the ledger cannot promise to publish it.
   * A null is not a soft failure to be logged and forgotten — it is the input
   * to the caller's own fail-closed decision.
   */
  record(gate: GateDecisionRecord): DecisionRecord | null {
    if (this.roomId === null) return null;

    if (this.pending.length >= this.maxBuffered) {
      if (!this.overflowed) {
        this.overflowed = true;
        this.logger.error(
          `[constitution] Decision ledger buffer full at ${this.maxBuffered} records; ` +
            'the decisions room is unreachable. Effectful actions will be refused ' +
            'under strict enforcement until it drains. ' +
            '(event: constitution.ledger.unavailable)',
        );
      }
      return null;
    }

    const record = this.chain.append({
      toolName: gate.toolName,
      request: gate.request,
      decision: gate.decision,
      effectAssumed: gate.effectAssumed,
      rub: {
        authority: this.domain.subject,
        id: `${this.domain.domainMdCid}@${this.domain.documentRevision}`,
      },
      aud: gate.request.principal.sessionId,
    });

    this.pending.push(record);
    void this.drain();
    return record;
  }

  /**
   * Matrix is up. Publishes whatever accumulated while it was not.
   *
   * Called from the boot sequence's Matrix phase rather than polled, because
   * a ledger that discovers its own transport by retrying would report
   * unavailable for as long as its backoff lasted.
   */
  markTransportReady(): void {
    this.transportReady = true;
    void this.drain();
  }

  /** Publishes everything pending. Awaited on shutdown and in tests. */
  async flush(): Promise<void> {
    await this.drain();
  }

  /**
   * Runs the publisher, coalescing concurrent callers onto one pass.
   *
   * The re-entry at the end is not belt-and-braces. A record appended while a
   * pass was writing its head pointer would otherwise be stranded: the pass
   * has already read past the end of the queue, and the caller that appended
   * it was handed the in-flight promise and told the work was in hand. It
   * would sit unpublished until something else happened to record a decision.
   *
   * Re-entry only follows a pass that drained cleanly, so a transport that is
   * refusing writes stops the loop instead of spinning on it.
   */
  private async drain(): Promise<void> {
    if (!this.transportReady || this.roomId === null) return;
    if (this.draining) return this.draining;

    const pass = async (): Promise<void> => {
      let outcome: DrainOutcome;
      try {
        outcome = await this.drainLoop();
      } finally {
        this.draining = null;
      }
      if (outcome === 'drained' && this.pending.length > 0) await this.drain();
    };

    this.draining = pass();
    return this.draining;
  }

  private async drainLoop(): Promise<DrainOutcome> {
    const roomId = this.roomId;
    if (roomId === null) return 'drained';

    for (let record = this.pending[0]; record; record = this.pending[0]) {
      const published = await this.publish(roomId, record);
      if (!published) {
        // Left at the front on purpose. Publishing out of order would put a
        // record in the room before the one it names as its predecessor,
        // which reads to anyone verifying as a broken chain.
        this.logger.error(
          `[constitution] Could not publish decision ${record.seq} after ${RETRY_DELAYS_MS.length} attempts; ` +
            `${this.pending.length} record(s) held. (event: constitution.ledger.publish_failed)`,
        );
        return 'stalled';
      }
      this.pending.shift();
      // Cleared only once something drains: an overflow that stayed latched
      // would refuse effectful actions long after the transport recovered.
      this.overflowed = false;
    }

    await this.publishHead(roomId);
    return 'drained';
  }

  private async publish(
    roomId: string,
    record: DecisionRecord,
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.transport.sendEvent(roomId, DECISION_EVENT_TYPE, record);
        return true;
      } catch (error) {
        const backoff = RETRY_DELAYS_MS[attempt];
        if (backoff === undefined) {
          this.logger.error(
            `[constitution] Publishing decision ${record.seq} failed`,
            error,
          );
          return false;
        }
        await this.delay(backoff);
      }
    }
  }

  /**
   * Writes the head pointer.
   *
   * Without it a reader cannot tell a chain that ends at seq 40 from one that
   * ended at 60 and had twenty records removed — every remaining record still
   * verifies. The pointer is what makes truncation visible.
   */
  private async publishHead(roomId: string): Promise<void> {
    const tip = this.chain.tip;
    if (!tip) return;
    try {
      await this.transport.setState(roomId, DECISION_HEAD_EVENT_TYPE, '', {
        seq: tip.seq,
        hash: tip.hash,
        count: this.chain.length,
        rub: tip.rub,
      });
    } catch (error) {
      // The records are already in the room; a stale pointer understates the
      // chain rather than misrepresenting it, and the next drain corrects it.
      this.logger.warn(
        '[constitution] Could not update the decision head pointer',
        error,
      );
    }
  }
}
