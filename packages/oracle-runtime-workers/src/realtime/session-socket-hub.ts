/**
 * The realtime clients of one user object: every accepted WebSocket, the
 * session it subscribed to, and its handshake state. This is the Workers
 * counterpart of the Node runtime's `WsService` (`sessionConnections`) plus
 * the socket.io room `server.to(sessionId)` that `BaseEvent` fans out to.
 *
 * Sockets are Hibernatable WebSockets: everything the hub knows about a
 * socket — identity, handshake state AND the heartbeat bookkeeping (last
 * ping sent, last pong seen) — lives in the per-socket attachment
 * (`serializeAttachment`), so the set is rebuilt losslessly from
 * `ctx.getWebSockets()` whenever the object wakes from hibernation or
 * restarts. Nothing here is kept only in memory.
 */
import { ENGINE_PING, encodeEvent } from './socket-io-codec';

export interface SocketAttachment {
  /** engine.io session id (the `sid` from the OPEN handshake). */
  sid: string;
  /** Oracle session the socket subscribed to (`?sessionId=`). */
  sessionId: string;
  /** User DID the shell routed the socket for (`?userDid=`). */
  routedUserDid: string;
  /** Set once the CONNECT packet's UCAN auth validated. */
  userDid?: string;
  openedAt: number;
  /** Last engine.io pong (`3`) seen — at open, "now". */
  lastPongAt: number;
  /** Last engine.io ping (`2`) sent; unset until the first heartbeat round. */
  lastPingAt?: number;
}

/** The subset of the Workers `WebSocket` the hub needs (tests use fakes). */
export interface HubSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface SessionSocketHubOptions {
  logger?: { warn: (message: string) => void };
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAttachment(value: unknown): value is SocketAttachment {
  if (!isRecord(value)) return false;
  const record = value;
  return (
    typeof record.sid === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.routedUserDid === 'string' &&
    typeof record.openedAt === 'number'
  );
}

/** Attachments written before the heartbeat fields existed get them on restore. */
function withHeartbeat(
  attachment: SocketAttachment,
  now: number,
): SocketAttachment {
  return typeof attachment.lastPongAt === 'number'
    ? attachment
    : { ...attachment, lastPongAt: now };
}

export class SessionSocketHub<S extends HubSocket = HubSocket> {
  private readonly sockets = new Map<S, SocketAttachment>();

  private readonly logger: { warn: (message: string) => void };

  private readonly now: () => number;

  constructor(options: SessionSocketHubOptions = {}) {
    this.logger = options.logger ?? { warn: () => undefined };
    this.now = options.now ?? (() => Date.now());
  }

  /** Register a freshly accepted socket and persist its identity on it. */
  add(socket: S, attachment: SocketAttachment): void {
    socket.serializeAttachment(attachment);
    this.sockets.set(socket, attachment);
  }

  /**
   * Rebuild the set from the hibernated sockets (object wake or restart).
   * The heartbeat bookkeeping comes back from the attachment untouched, so a
   * socket that stopped answering before the object slept is still caught.
   */
  restore(sockets: readonly S[]): number {
    let restored = 0;
    const now = this.now();
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment();
      if (!isAttachment(attachment)) {
        // Not one of ours (or a pre-handshake socket whose attachment was
        // never written): nothing to route to, close it.
        socket.close(1011, 'unknown socket');
        continue;
      }
      this.sockets.set(socket, withHeartbeat(attachment, now));
      restored += 1;
    }
    return restored;
  }

  get(socket: S): SocketAttachment | undefined {
    return this.sockets.get(socket);
  }

  /** Update the persisted attachment (e.g. after the CONNECT auth validated). */
  update(
    socket: S,
    patch: Partial<SocketAttachment>,
  ): SocketAttachment | undefined {
    const current = this.sockets.get(socket);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    socket.serializeAttachment(next);
    this.sockets.set(socket, next);
    return next;
  }

  remove(socket: S): void {
    this.sockets.delete(socket);
  }

  /** A pong arrived: persist the time (the object may sleep right after). */
  notePong(socket: S): void {
    if (this.sockets.has(socket))
      this.update(socket, { lastPongAt: this.now() });
  }

  /** Every socket with its heartbeat bookkeeping (diagnostics). */
  entries(): Array<{ socket: S; attachment: SocketAttachment }> {
    return [...this.sockets].map(([socket, attachment]) => ({
      socket,
      attachment,
    }));
  }

  /** Authenticated sockets subscribed to `sessionId`. */
  forSession(sessionId: string): S[] {
    const out: S[] = [];
    for (const [socket, meta] of this.sockets) {
      if (meta.userDid && meta.sessionId === sessionId) out.push(socket);
    }
    return out;
  }

  hasSession(sessionId: string): boolean {
    return this.forSession(sessionId).length > 0;
  }

  /** Fan an event out to every authenticated socket of the session. */
  emitToSession(
    sessionId: string,
    eventName: string,
    payload: unknown,
  ): number {
    const frame = encodeEvent(eventName, payload);
    let sent = 0;
    for (const socket of this.forSession(sessionId)) {
      if (this.trySend(socket, frame)) sent += 1;
    }
    return sent;
  }

  send(socket: S, frame: string): boolean {
    return this.trySend(socket, frame);
  }

  /**
   * One heartbeat round (run from the object's alarm, never from a timer):
   * close every socket whose last pong is older than
   * `pingIntervalMs + pingTimeoutMs` — the same rule the client applies in
   * the other direction — and ping the rest, recording the ping time on the
   * socket. Returns the sockets closed.
   */
  heartbeat(pingIntervalMs: number, pingTimeoutMs: number): S[] {
    const now = this.now();
    const closed: S[] = [];
    for (const [socket, meta] of [...this.sockets]) {
      if (now - meta.lastPongAt > pingIntervalMs + pingTimeoutMs) {
        this.remove(socket);
        try {
          socket.close(4408, 'ping timeout');
        } catch {
          // already gone
        }
        closed.push(socket);
        continue;
      }
      if (this.trySend(socket, ENGINE_PING))
        this.update(socket, { lastPingAt: now });
    }
    return closed;
  }

  /**
   * When the next heartbeat round is due: `pingIntervalMs` after the most
   * overdue socket's last ping (its open time before the first round), or
   * null with no sockets attached.
   */
  nextPingAt(pingIntervalMs: number): number | null {
    let next: number | null = null;
    for (const meta of this.sockets.values()) {
      const due = (meta.lastPingAt ?? meta.openedAt) + pingIntervalMs;
      if (next === null || due < next) next = due;
    }
    return next;
  }

  get size(): number {
    return this.sockets.size;
  }

  /** Distinct sessions with at least one authenticated socket. */
  sessionCount(): number {
    const ids = new Set<string>();
    for (const meta of this.sockets.values()) {
      if (meta.userDid) ids.add(meta.sessionId);
    }
    return ids.size;
  }

  /** Authenticated socket count (Node's `totalConnections`). */
  connectionCount(): number {
    let n = 0;
    for (const meta of this.sockets.values()) if (meta.userDid) n += 1;
    return n;
  }

  private trySend(socket: S, frame: string): boolean {
    try {
      socket.send(frame);
      return true;
    } catch (err) {
      this.logger.warn(
        `socket send failed, dropping socket: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.remove(socket);
      return false;
    }
  }
}
