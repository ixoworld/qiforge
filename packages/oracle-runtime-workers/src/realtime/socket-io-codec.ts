/**
 * Wire codec for the socket.io v4 protocol over a raw WebSocket — the
 * server half only, enough to speak to `socket.io-client` (the client SDK's
 * `use-websocket-events` hook connects with `transports: ['websocket']`).
 *
 * Two layers, both text frames:
 *
 *   engine.io v4 — one leading digit: `0` open, `1` close, `2` ping,
 *     `3` pong, `4` message, `5` upgrade, `6` noop. The server initiates
 *     pings; the client answers with `3`.
 *   socket.io v4 (inside a `4` message) — type digit, optional binary
 *     attachment count (`n-`), optional namespace (`/nsp,`), optional ack id
 *     (digits), then a JSON payload. Only the default namespace is served.
 *
 * Examples on the wire:
 *   server → `0{"sid":"…","upgrades":[],"pingInterval":25000,…}`
 *   client → `40{"invocation":"…"}`            CONNECT with the auth object
 *   server → `40{"sid":"…"}`                   CONNECT acknowledged
 *   server → `44{"message":"Unauthorized"}`   CONNECT_ERROR
 *   either → `42["tool_result",{…}]`          EVENT
 *   client → `4212["ev",{}]` / server → `4312[]`   EVENT with ack id 12 / ACK
 *
 * Binary events (types 5/6) are not supported: nothing this runtime emits is
 * binary, and the client SDK never sends any.
 */

export const ENGINE_OPEN = '0';
export const ENGINE_CLOSE = '1';
export const ENGINE_PING = '2';
export const ENGINE_PONG = '3';
export const ENGINE_MESSAGE = '4';

const SIO_CONNECT = 0;
const SIO_DISCONNECT = 1;
const SIO_EVENT = 2;
const SIO_ACK = 3;
const SIO_CONNECT_ERROR = 4;

export interface OpenHandshake {
  sid: string;
  pingIntervalMs: number;
  pingTimeoutMs: number;
  maxPayloadBytes: number;
}

export type ClientFrame =
  | { kind: 'ping' }
  | { kind: 'pong' }
  | { kind: 'close' }
  | { kind: 'connect'; auth: unknown }
  | { kind: 'disconnect' }
  | { kind: 'event'; name: string; args: unknown[]; ackId?: number }
  | { kind: 'ack'; id: number; args: unknown[] }
  | { kind: 'unsupported'; reason: string; raw: string };

export function encodeOpen(handshake: OpenHandshake): string {
  return (
    ENGINE_OPEN +
    JSON.stringify({
      sid: handshake.sid,
      upgrades: [],
      pingInterval: handshake.pingIntervalMs,
      pingTimeout: handshake.pingTimeoutMs,
      maxPayload: handshake.maxPayloadBytes,
    })
  );
}

export function encodeConnectAck(sid: string): string {
  return `${ENGINE_MESSAGE}${SIO_CONNECT}${JSON.stringify({ sid })}`;
}

export function encodeConnectError(message: string, data?: unknown): string {
  return `${ENGINE_MESSAGE}${SIO_CONNECT_ERROR}${JSON.stringify(
    data === undefined ? { message } : { message, data },
  )}`;
}

export function encodeEvent(name: string, ...args: unknown[]): string {
  return `${ENGINE_MESSAGE}${SIO_EVENT}${JSON.stringify([name, ...args])}`;
}

export function encodeAck(id: number, args: unknown[] = []): string {
  return `${ENGINE_MESSAGE}${SIO_ACK}${id}${JSON.stringify(args)}`;
}

export function encodeDisconnect(): string {
  return `${ENGINE_MESSAGE}${SIO_DISCONNECT}`;
}

function unsupported(reason: string, raw: string): ClientFrame {
  return { kind: 'unsupported', reason, raw };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Decode one text frame from the client. Never throws: anything outside the
 * supported protocol subset comes back as `unsupported` with a reason, so
 * the caller can log it and decide whether to close.
 */
export function decodeClientFrame(raw: string): ClientFrame {
  if (raw.length === 0) return unsupported('empty frame', raw);
  const engineType = raw.charAt(0);
  switch (engineType) {
    case ENGINE_PING:
      return { kind: 'ping' };
    case ENGINE_PONG:
      return { kind: 'pong' };
    case ENGINE_CLOSE:
      return { kind: 'close' };
    case ENGINE_MESSAGE:
      return decodeSocketIoPacket(raw.slice(1), raw);
    default:
      return unsupported(`engine.io packet type ${engineType}`, raw);
  }
}

function decodeSocketIoPacket(packet: string, raw: string): ClientFrame {
  if (packet.length === 0) return unsupported('empty socket.io packet', raw);
  const type = Number(packet.charAt(0));
  if (!Number.isInteger(type) || type < 0 || type > 6) {
    return unsupported(`socket.io packet type ${packet.charAt(0)}`, raw);
  }
  if (type === 5 || type === 6) {
    return unsupported('binary socket.io packets are not supported', raw);
  }
  let i = 1;
  // Namespace: only the default one is served.
  if (packet.charAt(i) === '/') {
    const end = packet.indexOf(',', i);
    const nsp = end === -1 ? packet.slice(i) : packet.slice(i, end);
    if (nsp !== '/') return unsupported(`namespace ${nsp} is not served`, raw);
    i = end === -1 ? packet.length : end + 1;
  }
  // Optional ack id: consecutive digits before the payload.
  let idText = '';
  while (
    i < packet.length &&
    packet.charAt(i) >= '0' &&
    packet.charAt(i) <= '9'
  ) {
    idText += packet.charAt(i);
    i += 1;
  }
  const ackId = idText.length > 0 ? Number(idText) : undefined;
  const payload = parseJson(packet.slice(i));
  if (!payload.ok) return unsupported('malformed JSON payload', raw);

  switch (type) {
    case SIO_CONNECT:
      return { kind: 'connect', auth: payload.value };
    case SIO_DISCONNECT:
      return { kind: 'disconnect' };
    case SIO_EVENT: {
      const value = payload.value;
      if (!Array.isArray(value) || typeof value[0] !== 'string') {
        return unsupported('event payload must be [name, ...args]', raw);
      }
      return {
        kind: 'event',
        name: value[0],
        args: value.slice(1),
        ...(ackId !== undefined ? { ackId } : {}),
      };
    }
    case SIO_ACK: {
      if (ackId === undefined) return unsupported('ack without id', raw);
      const value = payload.value;
      return {
        kind: 'ack',
        id: ackId,
        args: Array.isArray(value) ? value : [],
      };
    }
    default:
      // CONNECT_ERROR is server → client only.
      return unsupported(`unexpected socket.io packet type ${type}`, raw);
  }
}
