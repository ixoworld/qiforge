/**
 * The per-turn `work_status` liveness card — the port of the Node runtime's
 * `matrix/work-status-producer.ts` + `matrix/oracle-component-event.ts`.
 *
 * A Matrix turn posts ONE `ixo.oracle.component` event (`component:
 * 'work_status'`) into the user's thread when it starts, then edits it in
 * place (`m.replace`) as the agent moves through phases:
 * routing → working (one "Step n · <action>" per model/tool call) →
 * delivering → done, or superseded when a newer message restarts the turn.
 * Clients that render oracle components show a live card; everything else
 * sees the plain `body` fallback ("Status: Working…").
 *
 * Frames are coalesced per turn: anything staged behind an in-flight post is
 * stale by the time the homeserver would accept it, so the newest frame
 * replaces it — which also guarantees a terminal phase is never dropped.
 * Fire-and-forget throughout: a failed post is logged, never thrown.
 */
import { retryTxnId } from './txn-id';

export const ORACLE_COMPONENT_EVENT_TYPE = 'ixo.oracle.component';

export type OracleComponentName =
  | 'list_services'
  | 'show_contract'
  | 'work_status'
  | 'work_delivered'
  | 'payment_update';

export interface OracleComponentThreadRelation {
  rel_type: 'm.thread';
  event_id: string;
}

export interface OracleComponentReplaceRelation {
  rel_type: 'm.replace';
  event_id: string;
}

export interface OracleComponentEnvelope {
  component: OracleComponentName;
  props: Record<string, unknown>;
  body: string;
  sessionId: string;
  requestId: string;
  toolCallId?: string;
}

export interface OracleComponentEventContent extends OracleComponentEnvelope {
  'm.new_content'?: OracleComponentEnvelope;
  'm.relates_to'?:
    | OracleComponentThreadRelation
    | OracleComponentReplaceRelation;
}

export interface OracleComponentInput {
  component: OracleComponentName;
  props: Record<string, unknown>;
  body: string;
  sessionId: string;
  requestId: string;
  toolCallId?: string;
  threadId?: string;
  replacesEventId?: string;
}

/** Byte-compatible with the Node runtime's `buildOracleComponentContent`. */
export function buildOracleComponentContent(
  input: OracleComponentInput,
): OracleComponentEventContent {
  const { threadId, replacesEventId, toolCallId, ...rest } = input;
  const envelope: OracleComponentEnvelope = {
    ...rest,
    ...(toolCallId !== undefined && { toolCallId }),
  };
  const relation: OracleComponentEventContent['m.relates_to'] | undefined =
    replacesEventId !== undefined
      ? { rel_type: 'm.replace', event_id: replacesEventId }
      : threadId !== undefined
        ? { rel_type: 'm.thread', event_id: threadId }
        : undefined;
  return {
    ...envelope,
    ...(replacesEventId !== undefined && { 'm.new_content': envelope }),
    ...(relation !== undefined && { 'm.relates_to': relation }),
  };
}

export type WorkStatusPhase =
  | 'routing'
  | 'working'
  | 'delivering'
  | 'done'
  | 'superseded';

const ANCHOR_RETRY_DELAY_MS = 1000;

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
  /** Thread the card is posted into (the user's message thread root). */
  threadId: string;
  sessionId: string;
  /** The user's message event the card reports on. */
  forEventId: string;
}

interface StatusFrame {
  phase: WorkStatusPhase;
  label?: string;
}

interface TurnEntry extends WorkStatusTurn {
  anchorEventId?: string;
  steps: number;
  pending?: StatusFrame;
  draining: boolean;
}

export interface WorkStatusProducerDeps {
  /**
   * Posts a room event and resolves its event id (the gateway's `sendEvent`).
   * `txnId` pins the transaction id so the anchor's single retry cannot post
   * a second card when only the response was lost.
   */
  postEvent: (
    roomId: string,
    eventType: string,
    content: object,
    opts?: { txnId?: string },
  ) => Promise<string>;
  clock?: () => Date;
  logger?: { warn: (message: string) => void };
  /** Delay before the single retry of a failed anchor post (tests: 0). */
  anchorRetryDelayMs?: number;
}

export class WorkStatusProducer {
  private readonly turns = new Map<string, TurnEntry>();

  private readonly postEvent: WorkStatusProducerDeps['postEvent'];

  private readonly clock: () => Date;

  private readonly logger: { warn: (message: string) => void };

  private readonly anchorRetryDelayMs: number;

  constructor(deps: WorkStatusProducerDeps) {
    this.postEvent = deps.postEvent;
    this.clock = deps.clock ?? (() => new Date());
    this.logger = deps.logger ?? { warn: () => undefined };
    this.anchorRetryDelayMs = deps.anchorRetryDelayMs ?? ANCHOR_RETRY_DELAY_MS;
  }

  /** Register a turn so later `emit`/`step`/`finish` calls have a card to drive. */
  beginTurn(turn: WorkStatusTurn): void {
    this.turns.set(turn.requestId, { ...turn, steps: 0, draining: false });
  }

  /**
   * Post a status phase for a registered turn. The first anchor-capable phase
   * (`routing`/`working`) creates the card; every later phase updates it via
   * `m.replace`. Unregistered requestIds — and closing phases with no card to
   * close — are no-ops.
   */
  emit(requestId: string, phase: WorkStatusPhase, label?: string): void {
    const entry = this.turns.get(requestId);
    if (!entry) return;
    this.enqueue(entry, phase, label);
  }

  /**
   * Post the next agent step: bumps the turn's counter and emits `working`
   * with a `Step n · <action>` label. The counter can outrun the numbers the
   * room actually sees (coalesced frames are skipped, not renumbered) so the
   * line always moves forward.
   */
  step(requestId: string, action: string): void {
    const entry = this.turns.get(requestId);
    if (!entry) return;
    entry.steps += 1;
    this.enqueue(entry, 'working', `Step ${entry.steps} · ${action}`);
  }

  /**
   * Post a final phase (`done`/`superseded`) and unregister the turn. Later
   * emissions for this requestId become no-ops immediately.
   */
  finish(requestId: string, phase: WorkStatusPhase, label?: string): void {
    const entry = this.turns.get(requestId);
    if (!entry) return;
    this.turns.delete(requestId);
    this.enqueue(entry, phase, label);
  }

  private async postWithRetry(
    roomId: string,
    content: object,
    retryOnce: boolean,
  ): Promise<string> {
    const opts = { txnId: retryTxnId('work-status') };
    try {
      return await this.postEvent(
        roomId,
        ORACLE_COMPONENT_EVENT_TYPE,
        content,
        opts,
      );
    } catch (error) {
      if (!retryOnce) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, this.anchorRetryDelayMs),
      );
      return this.postEvent(roomId, ORACLE_COMPONENT_EVENT_TYPE, content, opts);
    }
  }

  /** Unregister a turn without posting (error paths, turns with no card). */
  endTurn(requestId: string): void {
    this.turns.delete(requestId);
  }

  /** Whether a turn is registered (tests + the ingest supersede path). */
  has(requestId: string): boolean {
    return this.turns.has(requestId);
  }

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

  private async drain(entry: TurnEntry): Promise<void> {
    try {
      while (entry.pending) {
        const frame = entry.pending;
        entry.pending = undefined;
        await this.post(entry, frame);
      }
    } finally {
      entry.draining = false;
    }
  }

  private async post(entry: TurnEntry, frame: StatusFrame): Promise<void> {
    const { phase, label } = frame;
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
      const eventId = await this.postWithRetry(
        entry.roomId,
        content,
        // The anchor decides whether the turn gets a card at all: retry it.
        !entry.anchorEventId,
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

/** `generate_tax_report` → `Generate tax report…`. */
export function humanizeToolLabel(toolName: string): string {
  const words = toolName.replace(/[_-]+/g, ' ').trim();
  if (words.length === 0) return DEFAULT_LABELS.working;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}…`;
}
