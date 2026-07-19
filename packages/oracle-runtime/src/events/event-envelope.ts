import { EVENT_NAMES } from './scoped-emitter.js';

/** Canonical wire names of the runtime's session-scoped events. */
export type RuntimeEventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

/**
 * Payload half of the wire envelope. Every session-scoped event carries the
 * session and request identifiers — the WS fan-out routes by
 * `payload.sessionId`, and the client SDK's `isWebSocketEvent` guard rejects
 * anything missing either field.
 */
export interface EventEnvelopePayload extends Record<string, unknown> {
  sessionId: string;
  requestId: string;
}

/**
 * The single wire shape for session-scoped events:
 * `{ eventName, payload: { sessionId, requestId, ... } }`.
 *
 * This is the same discriminated shape `@ixo/oracles-events` `BaseEvent`
 * instances serialize to and the shape the client SDK accepts, so events
 * built by plugins through `ctx.emit` and events built from the event
 * classes are indistinguishable on the wire.
 */
export interface EventEnvelope {
  eventName: string;
  payload: EventEnvelopePayload;
}

/**
 * Build a wire envelope from a raw scoped-emitter payload. Returns `null`
 * when the payload is missing `sessionId` or `requestId` — the caller logs
 * and drops, because an unroutable or guard-rejected event is dead weight
 * on the wire either way.
 */
export function toEventEnvelope(
  eventName: string,
  payload: Record<string, unknown>,
): EventEnvelope | null {
  const { sessionId, requestId } = payload;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  return { eventName, payload: { ...payload, sessionId, requestId } };
}
