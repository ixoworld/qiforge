import { type AllEvents } from '@ixo/oracles-events';
import { EventEmitter } from 'node:events';
import type { EventEnvelope } from '../../events/event-envelope.js';

export const WS_SERVICE_EVENT_NAME = 'wsService';

/**
 * Cross-module event channel: graph nodes call `wsEmitter.emit(sessionId, event)`,
 * the WS service listens for `WS_SERVICE_EVENT_NAME` and fans out to sockets.
 *
 * Accepts both `@ixo/oracles-events` class instances and plain
 * `EventEnvelope`s — the two shapes are identical on the wire
 * (`{ eventName, payload: { sessionId, requestId, ... } }`).
 */
export class Emitter extends EventEmitter {
  override emit(_sessionId: string, event: AllEvents | EventEnvelope): boolean {
    return super.emit(WS_SERVICE_EVENT_NAME, event);
  }
}

export const wsEmitter = new Emitter();
