import { type AllEvents } from '@ixo/oracles-events';
import { EventEmitter } from 'node:events';

export const WS_SERVICE_EVENT_NAME = 'wsService';

/**
 * Cross-module event channel: graph nodes call `wsEmitter.emit(sessionId, event)`,
 * the WS service listens for `WS_SERVICE_EVENT_NAME` and fans out to sockets.
 */
export class Emitter extends EventEmitter {
  override emit(_sessionId: string, event: AllEvents): boolean {
    return super.emit(WS_SERVICE_EVENT_NAME, event);
  }
}

export const wsEmitter = new Emitter();
