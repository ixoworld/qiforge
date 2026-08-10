import { MatrixManager } from '@ixo/matrix';
import { Logger } from '@nestjs/common';
import {
  buildOracleComponentContent,
  ORACLE_COMPONENT_EVENT_TYPE,
} from './oracle-component-event.js';

/** Lifecycle phases of the per-turn `work_status` liveness card. */
export type WorkStatusPhase =
  | 'routing'
  | 'working'
  | 'delivering'
  | 'done'
  | 'superseded';

/**
 * Phases that may CREATE the turn's status card. The closing phases
 * (`delivering`/`done`/`superseded`) only ever update an existing card — a
 * turn that never showed progress posts nothing, instead of a lone "done".
 */
const ANCHOR_PHASES: ReadonlySet<WorkStatusPhase> = new Set([
  'routing',
  'working',
]);

const DEFAULT_LABELS: Record<WorkStatusPhase, string> = {
  routing: 'Routing your request…',
  working: 'Working…',
  delivering: 'Sending your reply…',
  done: 'Done',
  superseded: 'Got your new message — restarting',
};

export interface WorkStatusTurn {
  requestId: string;
  roomId: string;
  /** Thread root event id — the turn's thread relation target. */
  threadId: string;
  sessionId: string;
  /** The user message event this card answers (`props.forEventId`). */
  forEventId: string;
}

/** One card update: what to post, resolved at post time. */
interface StatusFrame {
  phase: WorkStatusPhase;
  label?: string;
}

interface TurnEntry extends WorkStatusTurn {
  anchorEventId?: string;
  /** Steps taken this turn — drives the `Step {n} · …` prefix. */
  steps: number;
  /**
   * The newest frame waiting behind the in-flight post. A frame arriving while
   * a post is in flight replaces this one instead of queuing behind it, so the
   * card jumps straight to the latest state and an 8-tool turn costs a handful
   * of Matrix events rather than one per emission.
   */
  pending?: StatusFrame;
  /** True while `drain` owns the entry — keeps posts strictly serialized. */
  draining: boolean;
}

export interface WorkStatusProducerDeps {
  /** Event poster. Defaults to `MatrixManager.getInstance().sendMatrixEvent`. */
  postEvent?: (
    roomId: string,
    eventType: string,
    content: object,
  ) => Promise<string>;
  clock?: () => Date;
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Posts the per-turn `ixo.oracle.component` / `work_status` liveness card for
 * Matrix turns. One anchor event per user message (`forEventId`); every later
 * phase posts an `m.replace` update carrying the full new content, so clients
 * collapse to the latest state.
 *
 * Turns are registered by the Matrix listener bridge, keyed by the turn's
 * requestId. Emissions for an unregistered requestId are no-ops — which is
 * what silently disables the card on HTTP and WS turns. Posting failures are
 * logged and never thrown.
 */
export class WorkStatusProducer {
  private readonly turns = new Map<string, TurnEntry>();
  private readonly postEvent: NonNullable<WorkStatusProducerDeps['postEvent']>;
  private readonly clock: () => Date;
  private readonly logger: Pick<Logger, 'warn'>;

  constructor(deps: WorkStatusProducerDeps = {}) {
    this.postEvent =
      deps.postEvent ??
      ((roomId, eventType, content) =>
        MatrixManager.getInstance().sendMatrixEvent(
          roomId,
          eventType,
          content,
        ));
    this.clock = deps.clock ?? (() => new Date());
    this.logger = deps.logger ?? new Logger(WorkStatusProducer.name);
  }

  /** Register a turn so later `emit`/`finish` calls have a card to drive. */
  beginTurn(turn: WorkStatusTurn): void {
    this.turns.set(turn.requestId, { ...turn, steps: 0, draining: false });
  }

  /**
   * Post a status phase for a registered turn. The first anchor-capable phase
   * (`routing`/`working`) creates the card; every later phase updates it via
   * `m.replace`. Unregistered requestIds — and closing phases with no card to
   * close — are no-ops. Fire-and-forget: never throws.
   */
  emit(requestId: string, phase: WorkStatusPhase, label?: string): void {
    const entry = this.turns.get(requestId);
    if (!entry) return;
    this.enqueue(entry, phase, label);
  }

  /**
   * Post the next agent step of a registered turn: bumps the turn's counter
   * and emits `working` with a `Step {n} · {action}` label. `action` is
   * already a finished phrase (`Thinking…`, `Search skills…`).
   *
   * The counter can outrun the numbers the room actually sees — coalesced
   * frames are skipped, not renumbered — so the line always moves forward.
   * Unregistered requestIds are no-ops, same as `emit`.
   */
  step(requestId: string, action: string): void {
    const entry = this.turns.get(requestId);
    if (!entry) return;
    entry.steps += 1;
    this.enqueue(entry, 'working', `Step ${entry.steps} · ${action}`);
  }

  /**
   * Post a final phase (`done`/`superseded`) and unregister the turn. Later
   * emissions for this requestId — e.g. a tool of a superseded turn still
   * draining — become no-ops immediately.
   */
  finish(requestId: string, phase: WorkStatusPhase, label?: string): void {
    const entry = this.turns.get(requestId);
    if (!entry) return;
    this.turns.delete(requestId);
    this.enqueue(entry, phase, label);
  }

  /** Unregister a turn without posting (error paths, turns with no card). */
  endTurn(requestId: string): void {
    this.turns.delete(requestId);
  }

  /**
   * Stage a frame and make sure someone is posting. Anything already waiting
   * behind the in-flight post is stale by the time the homeserver would accept
   * it, so the newest frame replaces it — which is also why `finish`'s
   * terminal phase can never be dropped: it is always the newest frame.
   */
  private enqueue(
    entry: TurnEntry,
    phase: WorkStatusPhase,
    label?: string,
  ): void {
    entry.pending = { phase, label };
    if (entry.draining) return;
    entry.draining = true;
    void this.drain(entry);
  }

  /** Post staged frames one at a time until none is left. Never throws. */
  private async drain(entry: TurnEntry): Promise<void> {
    try {
      while (entry.pending) {
        const frame = entry.pending;
        entry.pending = undefined;
        await this.post(entry, frame);
      }
    } finally {
      // Cleared in the same tick as the loop's final `pending` check, so a
      // frame staged by a racing `emit` can never be stranded unposted.
      entry.draining = false;
    }
  }

  private async post(entry: TurnEntry, frame: StatusFrame): Promise<void> {
    const { phase, label } = frame;
    // Checked at post time, not enqueue time: a closing phase must not create
    // a card even if it was staged while an anchor post was still in flight.
    if (!entry.anchorEventId && !ANCHOR_PHASES.has(phase)) return;
    const resolvedLabel = label ?? DEFAULT_LABELS[phase];
    try {
      const content = buildOracleComponentContent({
        component: 'work_status',
        props: {
          forEventId: entry.forEventId,
          phase,
          label: resolvedLabel,
          updatedAt: this.clock().toISOString(),
        },
        body: `Status: ${resolvedLabel}`,
        sessionId: entry.sessionId,
        requestId: entry.requestId,
        ...(entry.anchorEventId
          ? { replacesEventId: entry.anchorEventId }
          : { threadId: entry.threadId }),
      });
      const eventId = await this.postEvent(
        entry.roomId,
        ORACLE_COMPONENT_EVENT_TYPE,
        content,
      );
      if (!entry.anchorEventId) entry.anchorEventId = eventId;
    } catch (error) {
      this.logger.warn(
        `work_status post failed (room=${entry.roomId}, phase=${phase}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Humanize a tool name into a short status label: `generate_tax_report` →
 * `Generate tax report…`.
 */
export function humanizeToolLabel(toolName: string): string {
  const words = toolName.replace(/[_-]+/g, ' ').trim();
  if (words.length === 0) return DEFAULT_LABELS.working;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}…`;
}

/**
 * Process-wide producer shared by the bridge (routing/delivering/done/
 * superseded) and the work-status middleware (per-step `working` beats) —
 * one anchor map per turn.
 */
export const workStatusProducer = new WorkStatusProducer();
