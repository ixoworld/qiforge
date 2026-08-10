import type { MatrixAdapter } from '../runtime-context/ambient.js';

/**
 * Timeline event type for interactive oracle UI components. The portal
 * renders `content.component` with a dedicated card; clients without a
 * renderer (e.g. Element) fall back to the plain-text `content.body`.
 */
export const ORACLE_COMPONENT_EVENT_TYPE = 'ixo.oracle.component';

/**
 * Timeline event type posted BY THE PORTAL into the room after a user
 * contracts the oracle. Untrusted cache-buster only — the oracle re-queries
 * its contract source on receipt, never persists this event as a record.
 */
export const ORACLE_CONTRACTED_EVENT_TYPE = 'ixo.oracle.contracted';

/** Component names the portal knows how to render. */
export type OracleComponentName =
  | 'list_services'
  | 'show_contract'
  | 'work_status'
  | 'work_delivered'
  | 'payment_update';

/** Matrix thread relation attached when the turn is threaded. */
export interface OracleComponentThreadRelation {
  rel_type: 'm.thread';
  event_id: string;
}

/**
 * Matrix edit relation used by updating components (e.g. `work_status`): a
 * later event replaces an earlier anchor, carrying the full new content.
 */
export interface OracleComponentReplaceRelation {
  rel_type: 'm.replace';
  event_id: string;
}

/**
 * The component payload of an `ixo.oracle.component` event, carrying no Matrix
 * relation. It appears twice on an edit: once at the top level as the fallback
 * body, and once under `m.new_content` as the replacement content.
 */
export interface OracleComponentEnvelope {
  component: OracleComponentName;
  /** Per-component payload consumed by the matching portal card. */
  props: Record<string, unknown>;
  /** Plain-text fallback shown by clients without a component renderer. */
  body: string;
  sessionId: string;
  requestId: string;
  toolCallId?: string;
}

/** The `content` of an `ixo.oracle.component` timeline event. */
export interface OracleComponentEventContent extends OracleComponentEnvelope {
  /**
   * Replacement content for an `m.replace` edit. Matrix clients resolve an
   * edited event's content from here, so it must repeat the full envelope —
   * and must not nest a relation of its own.
   */
  'm.new_content'?: OracleComponentEnvelope;
  'm.relates_to'?:
    | OracleComponentThreadRelation
    | OracleComponentReplaceRelation;
}

/**
 * Builder input — `threadId` (the thread root event id) sets the thread
 * relation; `replacesEventId` (an earlier anchor event) sets an `m.replace`
 * edit relation instead. An event carries at most one relation, so
 * `replacesEventId` wins when both are provided — only the anchor event of a
 * live-updating card sits in the thread; its updates relate to the anchor.
 */
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

/**
 * Build the event content for an `ixo.oracle.component` timeline event.
 * The `m.relates_to` relation is attached only when a `threadId` or
 * `replacesEventId` is provided — a top-level (unthreaded) one-shot event
 * posts without a relation. An `m.replace` edit additionally repeats the
 * envelope under `m.new_content`, which is where edit-aware clients read the
 * replacement content from.
 */
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

/**
 * Build and post an `ixo.oracle.component` event in one call. Accepts any
 * adapter with `postEvent` — the ambient `MatrixAdapter` and the
 * per-request `ctx.matrix` both qualify. Returns the new event id.
 */
export async function postOracleComponent(
  matrix: Pick<MatrixAdapter, 'postEvent'>,
  roomId: string,
  input: OracleComponentInput,
): Promise<string> {
  return matrix.postEvent(
    roomId,
    ORACLE_COMPONENT_EVENT_TYPE,
    buildOracleComponentContent(input),
  );
}
