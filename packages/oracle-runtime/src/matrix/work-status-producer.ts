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

interface TurnEntry extends WorkStatusTurn {
  anchorEventId?: string;
  /** Serializes posts so the anchor always lands before its replacements. */
  queue: Promise<void>;
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
 * Matrix commerce turns. One anchor event per user message (`forEventId`);
 * every later phase posts an `m.replace` update carrying the full new content,
 * so clients collapse to the latest state.
 *
 * Turns are registered by the Matrix listener bridge (only when the commerce
 * router is active), keyed by the turn's requestId. Emissions for an
 * unregistered requestId are no-ops — which is what silently disables the
 * card on HTTP turns and on oracles without the oracle-payments plugin.
 * Posting failures are logged and never thrown.
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
    this.turns.set(turn.requestId, { ...turn, queue: Promise.resolve() });
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

  private enqueue(
    entry: TurnEntry,
    phase: WorkStatusPhase,
    label?: string,
  ): void {
    entry.queue = entry.queue
      .then(async () => {
        if (!entry.anchorEventId && !ANCHOR_PHASES.has(phase)) return;
        const resolvedLabel = label ?? DEFAULT_LABELS[phase];
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
      })
      .catch((error) => {
        this.logger.warn(
          `work_status post failed (room=${entry.roomId}, phase=${phase}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
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
 * Process-wide producer shared by the bridge (routing/done/superseded), the
 * router (routing) and the tool wrapper (working) — one anchor map per turn.
 */
export const workStatusProducer = new WorkStatusProducer();
