/**
 * The socket.io endpoint of one user object — the Workers port of the Node
 * runtime's `WsGateway` + `WsService` + `callFrontendTool`.
 *
 * Lifecycle of one client (the client SDK's `use-websocket-events` hook):
 *
 *   GET /socket.io/?EIO=4&transport=websocket&sessionId=…&userDid=…
 *     → the shell routes the upgrade to this user's object (`?userDid`);
 *       the object accepts the socket (Hibernatable WebSockets API) and
 *       answers the engine.io OPEN handshake.
 *   40{"invocation":"…","ucanDelegation":"…"}
 *     → the CONNECT packet carries the same UCAN material the HTTP routes
 *       take in headers; it is validated with the shell's `authenticate`
 *       and the validated DID must be the routed one. Success: `40{sid}` +
 *       a `connected` event. Failure: `44{message}` and the socket closes.
 *   42["ping"] / 42["status"] / 42["list-events"]
 *     → Node's diagnostic events, same payloads.
 *   42["tool_result",{toolCallId,result,error?}] / 42["action_call_result",…]
 *     → settle the pending browser-tool / AG-UI call with that id.
 *
 * Outbound, every event the runtime emits for a session (`ctx.emit.*`,
 * `browser_tool_call`, `action_call`, …) is fanned out to the session's
 * authenticated sockets — the router's tap.
 *
 * Heartbeat: engine.io's server-initiated ping, driven by the OBJECT'S
 * ALARM rather than a timer. A timer would keep the object resident (and
 * billed) for as long as a browser tab is open; with the alarm the object
 * hibernates between pings and is woken for a few milliseconds every
 * `PING_INTERVAL_MS` to send `2` and close the sockets that missed
 * `PING_INTERVAL_MS + PING_TIMEOUT_MS`. Everything the round needs (last
 * ping, last pong) is persisted on the socket attachment, so a round on a
 * freshly woken object is exact. The client adopts the interval and timeout
 * the OPEN handshake declares, so no client change is needed. See "Object
 * lifetime and cost" in the README.
 */
import type { AuthOutcome } from '../shell/auth';
import type { EventSink, SessionEventRouter } from '../do/ambient';
import type {
  FrontendCallParams,
  FrontendCallSurface,
} from '../plugin-api/types';
import type { RawEventPayload } from '../core/runtime-context';
import {
  FrontendCallRegistry,
  type FrontendCallKind,
  type PendingFrontendCall,
} from './frontend-call-registry';
import { SessionSocketHub, type SocketAttachment } from './session-socket-hub';
import {
  decodeClientFrame,
  encodeAck,
  encodeConnectAck,
  encodeConnectError,
  encodeEvent,
  encodeOpen,
  ENGINE_PONG,
} from './socket-io-codec';

/**
 * Server ping cadence advertised in the OPEN handshake. Long on purpose:
 * every ping is an alarm wake of the (otherwise hibernated) object, and a
 * dead connection is noticed by the client after
 * `pingInterval + pingTimeout` either way — three to four minutes was the
 * agreed trade between wake cost and detection time.
 */
export const PING_INTERVAL_MS = 180_000;
export const PING_TIMEOUT_MS = 60_000;
export const MAX_PAYLOAD_BYTES = 1_000_000;
/** A socket that has not sent its CONNECT packet by then is closed. */
export const HANDSHAKE_DEADLINE_MS = 10_000;
export const BROWSER_TOOL_DEFAULT_TIMEOUT_MS = 15_000;
export const AG_ACTION_DEFAULT_TIMEOUT_MS = 10_000;

/** Header the shell sets on the forwarded upgrade: the DID it routed for. */
export const ROUTED_USER_HEADER = 'x-routed-user-did';

const CLIENT_EVENTS = [
  'ping',
  'status',
  'subscribe',
  'list-events',
  'tool_result',
  'action_call_result',
] as const;

const SERVER_EVENTS = [
  'connected',
  'pong',
  'status',
  'subscribed',
  'available-events',
  'render_component',
  'tool_call',
  'action_call',
  'browser_tool_call',
  'router_update',
  'message_cache_invalidation',
] as const;

/** Close codes in the 4000–4999 application range. */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_HANDSHAKE_TIMEOUT = 4408;
const CLOSE_PROTOCOL = 4400;

export interface RealtimeEndpointDeps {
  /** `ctx.acceptWebSocket` / `ctx.getWebSockets` of the owning object. */
  ctx: {
    acceptWebSocket(ws: WebSocket, tags?: string[]): void;
    getWebSockets(tag?: string): WebSocket[];
  };
  /** Validates the CONNECT packet's UCAN material (the shell's `authenticate`). */
  authenticate: (auth: {
    invocation?: string;
    ucanDelegation?: string;
  }) => Promise<AuthOutcome>;
  /** Whether `sessionId` exists for this user (a socket to an unknown session is refused). */
  sessionExists: (userDid: string, sessionId: string) => Promise<boolean>;
  /** Event fan-out of the object; the endpoint taps it. */
  router: SessionEventRouter;
  logger: { log: (m: string) => void; warn: (m: string) => void };
  /**
   * The last authenticated socket subscribed to `sessionId` has gone (closed,
   * errored, or dropped by the heartbeat). The Node runtime indexes the
   * session's history into the memory engine at that moment
   * (`WsService.removeClientConnection`); the owning object wires the same.
   */
  onSessionDrained?: (sessionId: string, userDid: string) => void;
  /**
   * Ask the object to run `alarm()` no later than `at` (the object's own
   * `requestAlarm`): armed for the next heartbeat round whenever a socket is
   * accepted or re-adopted. The object calls `pingTick` from its alarm.
   */
  requestAlarm?: (at: number) => void;
  now?: () => number;
}

export interface RealtimeSocketStatus {
  sid: string;
  sessionId: string;
  authenticated: boolean;
  openedAt: number;
  lastPingAt: number | null;
  lastPongAt: number;
}

export interface RealtimeStatus {
  sockets: number;
  authenticated: number;
  sessions: number;
  pendingCalls: PendingFrontendCall[];
  pingIntervalMs: number;
  pingTimeoutMs: number;
  /** When the next heartbeat round is due (null with no sockets). */
  nextPingAt: number | null;
  socketDetails: RealtimeSocketStatus[];
  /**
   * Live JavaScript timers in the isolate (debug routes only): anything here
   * keeps the object resident instead of hibernating between messages.
   */
  pendingTimers?: Array<{
    id: number;
    kind: 'timeout' | 'interval';
    delayMs: number;
    ageMs: number;
    createdAt: string[];
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class RealtimeEndpoint {
  readonly hub: SessionSocketHub<WebSocket>;

  readonly calls = new FrontendCallRegistry();

  readonly frontend: FrontendCallSurface;

  private readonly handshakeTimers = new Map<
    WebSocket,
    ReturnType<typeof setTimeout>
  >();

  private readonly now: () => number;

  constructor(private readonly deps: RealtimeEndpointDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.hub = new SessionSocketHub<WebSocket>({ now: this.now });
    const tap: EventSink = {
      emit: (eventName, payload) => this.fanOut(eventName, payload),
    };
    deps.router.tap(tap);
    this.frontend = {
      callBrowserTool: (params) =>
        this.call(
          'browser',
          'browser_tool_call',
          params,
          BROWSER_TOOL_DEFAULT_TIMEOUT_MS,
        ),
      callAgAction: (params) =>
        this.call('agui', 'action_call', params, AG_ACTION_DEFAULT_TIMEOUT_MS),
      hasClient: (sessionId) => this.hub.hasSession(sessionId),
    };
    // Sockets that survived hibernation or a restart.
    const restored = this.hub.restore(deps.ctx.getWebSockets());
    if (restored > 0) {
      deps.logger.log(`[realtime] re-adopted ${restored} hibernated socket(s)`);
      this.scheduleHeartbeat();
    }
  }

  // ── HTTP upgrade ────────────────────────────────────────────────────────

  /** `GET /socket.io/?EIO=4&transport=websocket&sessionId=…` forwarded by the shell. */
  handleUpgrade(request: Request, url: URL): Response {
    const bad = (message: string, status = 400): Response =>
      Response.json({ code: 3, message }, { status });
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return bad(
        'Expected a WebSocket upgrade: this runtime serves socket.io over the websocket transport only (connect with transports: ["websocket"]).',
        426,
      );
    }
    if (url.searchParams.get('EIO') !== '4') {
      return bad(
        'Unsupported protocol version: engine.io v4 (EIO=4) is required.',
      );
    }
    if (url.searchParams.get('transport') !== 'websocket') {
      return bad('Transport unknown: only the websocket transport is served.');
    }
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) return bad('sessionId query parameter is required.');
    const routedUserDid = request.headers.get(ROUTED_USER_HEADER);
    if (!routedUserDid) return bad('userDid query parameter is required.');

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const sid = crypto.randomUUID();
    this.deps.ctx.acceptWebSocket(server, [`session:${sessionId}`]);
    const openedAt = this.now();
    this.hub.add(server, {
      sid,
      sessionId,
      routedUserDid,
      openedAt,
      lastPongAt: openedAt,
    });
    server.send(
      encodeOpen({
        sid,
        pingIntervalMs: PING_INTERVAL_MS,
        pingTimeoutMs: PING_TIMEOUT_MS,
        maxPayloadBytes: MAX_PAYLOAD_BYTES,
      }),
    );
    this.handshakeTimers.set(
      server,
      setTimeout(() => {
        this.handshakeTimers.delete(server);
        if (this.hub.get(server)?.userDid) return;
        this.drop(server, CLOSE_HANDSHAKE_TIMEOUT, 'handshake timeout');
      }, HANDSHAKE_DEADLINE_MS),
    );
    this.scheduleHeartbeat();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Hibernatable WebSocket handlers ─────────────────────────────────────

  async onMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = this.hub.get(ws);
    if (!meta) {
      this.drop(ws, CLOSE_PROTOCOL, 'unknown socket');
      return;
    }
    if (typeof message !== 'string') {
      this.drop(ws, CLOSE_PROTOCOL, 'binary frames are not supported');
      return;
    }
    const frame = decodeClientFrame(message);
    switch (frame.kind) {
      case 'pong':
        this.hub.notePong(ws);
        return;
      case 'ping':
        this.hub.send(ws, ENGINE_PONG);
        return;
      case 'close':
      case 'disconnect':
        this.drop(ws, 1000, 'client disconnect');
        return;
      case 'connect':
        await this.connect(ws, meta, frame.auth);
        return;
      case 'event':
        if (!meta.userDid) {
          this.hub.send(ws, encodeConnectError('Unauthorized'));
          this.drop(ws, CLOSE_UNAUTHORIZED, 'event before CONNECT');
          return;
        }
        this.handleEvent(ws, meta, frame.name, frame.args[0]);
        if (frame.ackId !== undefined)
          this.hub.send(ws, encodeAck(frame.ackId));
        return;
      case 'ack':
        // The server never requests acks; nothing to match.
        return;
      case 'unsupported':
        this.deps.logger.warn(
          `[realtime] unsupported frame from ${meta.sid}: ${frame.reason}`,
        );
        return;
      default:
        return;
    }
  }

  onClose(ws: WebSocket): void {
    this.forget(ws);
  }

  onError(ws: WebSocket, error: unknown): void {
    this.deps.logger.warn(
      `[realtime] socket error: ${error instanceof Error ? error.message : String(error)}`,
    );
    this.forget(ws);
  }

  status(): RealtimeStatus {
    return {
      sockets: this.hub.size,
      authenticated: this.hub.connectionCount(),
      sessions: this.hub.sessionCount(),
      pendingCalls: this.calls.list(),
      pingIntervalMs: PING_INTERVAL_MS,
      pingTimeoutMs: PING_TIMEOUT_MS,
      nextPingAt: this.nextPingAt(),
      socketDetails: this.hub.entries().map(({ attachment }) => ({
        sid: attachment.sid,
        sessionId: attachment.sessionId,
        authenticated: Boolean(attachment.userDid),
        openedAt: attachment.openedAt,
        lastPingAt: attachment.lastPingAt ?? null,
        lastPongAt: attachment.lastPongAt,
      })),
    };
  }

  // ── heartbeat (alarm-driven) ────────────────────────────────────────────

  /** When the object should next run `pingTick` (null: no sockets). */
  nextPingAt(): number | null {
    return this.hub.nextPingAt(PING_INTERVAL_MS);
  }

  /**
   * One heartbeat round, called from the object's alarm: pings every socket
   * and closes the ones that missed the timeout. Returns when the next round
   * is due, or null once no socket is left. Cheap enough to run on a woken
   * object without opening the user's database.
   */
  pingTick(): number | null {
    const closed = this.hub.heartbeat(PING_INTERVAL_MS, PING_TIMEOUT_MS);
    if (closed.length > 0) {
      this.deps.logger.log(
        `[realtime] closed ${closed.length} socket(s): ping timeout`,
      );
    }
    return this.nextPingAt();
  }

  // ── handshake ───────────────────────────────────────────────────────────

  private async connect(
    ws: WebSocket,
    meta: SocketAttachment,
    auth: unknown,
  ): Promise<void> {
    if (meta.userDid) {
      // A second CONNECT on an authenticated socket: acknowledge again.
      this.hub.send(ws, encodeConnectAck(meta.sid));
      return;
    }
    const record = isRecord(auth) ? auth : {};
    const invocation = readString(record, 'invocation');
    const ucanDelegation = readString(record, 'ucanDelegation');
    if (!invocation && !ucanDelegation) {
      this.refuse(
        ws,
        'Unauthorized: missing UCAN auth (invocation or ucanDelegation)',
      );
      return;
    }
    let outcome: AuthOutcome;
    try {
      outcome = await this.deps.authenticate({
        ...(invocation ? { invocation } : {}),
        ...(ucanDelegation ? { ucanDelegation } : {}),
      });
    } catch (err) {
      this.deps.logger.warn(
        `[realtime] auth check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.refuse(ws, 'Unauthorized: auth check failed');
      return;
    }
    if (!outcome.ok) {
      this.refuse(ws, `Unauthorized: ${outcome.error}`);
      return;
    }
    if (outcome.auth.userDid !== meta.routedUserDid) {
      // The shell routed on an unauthenticated query parameter; the token
      // decides. A mismatch is someone pointing their token at another
      // user's object.
      this.refuse(ws, 'Unauthorized: token does not belong to the routed user');
      return;
    }
    if (
      !(await this.deps.sessionExists(outcome.auth.userDid, meta.sessionId))
    ) {
      this.refuse(ws, `Session ${meta.sessionId} not found`);
      return;
    }
    // The socket may have gone while we validated.
    if (!this.hub.get(ws)) return;
    const timer = this.handshakeTimers.get(ws);
    if (timer) {
      clearTimeout(timer);
      this.handshakeTimers.delete(ws);
    }
    this.hub.update(ws, { userDid: outcome.auth.userDid });
    this.hub.send(ws, encodeConnectAck(meta.sid));
    this.hub.send(
      ws,
      encodeEvent('connected', {
        message: 'Connected successfully',
        sessionId: meta.sessionId,
        timestamp: new Date(this.now()).toISOString(),
      }),
    );
    this.deps.logger.log(
      `[realtime] ${outcome.auth.userDid} connected to session ${meta.sessionId} (${meta.sid})`,
    );
  }

  private refuse(ws: WebSocket, message: string): void {
    this.hub.send(ws, encodeConnectError(message));
    this.drop(ws, CLOSE_UNAUTHORIZED, message.slice(0, 120));
  }

  // ── inbound events ──────────────────────────────────────────────────────

  private handleEvent(
    ws: WebSocket,
    meta: SocketAttachment,
    name: string,
    data: unknown,
  ): void {
    const timestamp = new Date(this.now()).toISOString();
    switch (name) {
      case 'ping':
        this.hub.send(
          ws,
          encodeEvent('pong', { timestamp, sessionId: meta.sessionId }),
        );
        return;
      case 'status':
        this.hub.send(
          ws,
          encodeEvent('status', {
            connected: true,
            sessionId: meta.sessionId,
            activeSessions: this.hub.sessionCount(),
            totalConnections: this.hub.connectionCount(),
            timestamp,
          }),
        );
        return;
      case 'subscribe':
        // Node keeps this for compatibility: the socket already joined the
        // session named at connect time.
        this.hub.send(
          ws,
          encodeEvent('subscribed', { sessionId: meta.sessionId, timestamp }),
        );
        return;
      case 'list-events':
        this.hub.send(
          ws,
          encodeEvent('available-events', {
            clientEvents: [...CLIENT_EVENTS],
            serverEvents: [...SERVER_EVENTS],
            sessionId: meta.sessionId,
            timestamp,
          }),
        );
        return;
      case 'tool_result':
        this.settle('browser', meta, data);
        return;
      case 'action_call_result':
        this.settle('agui', meta, data);
        return;
      default:
        this.deps.logger.warn(
          `[realtime] ignoring unknown event ${name} from ${meta.sid}`,
        );
    }
  }

  private settle(
    kind: FrontendCallKind,
    meta: SocketAttachment,
    data: unknown,
  ): void {
    const record = isRecord(data) ? data : {};
    const toolCallId = readString(record, 'toolCallId');
    if (!toolCallId) {
      this.deps.logger.warn(
        `[realtime] ${kind} result without toolCallId from ${meta.sid}`,
      );
      return;
    }
    const error = readString(record, 'error');
    const settled = this.calls.settle(kind, {
      toolCallId,
      result: record.result,
      ...(error ? { error } : {}),
    });
    if (!settled) {
      this.deps.logger.warn(
        `[realtime] ${kind} result for ${toolCallId} had no pending call (late or duplicate)`,
      );
    }
  }

  // ── outbound ────────────────────────────────────────────────────────────

  private fanOut(eventName: string, payload: RawEventPayload): void {
    const sessionId =
      typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
    if (!sessionId) return;
    this.hub.emitToSession(sessionId, eventName, payload);
  }

  private call(
    kind: FrontendCallKind,
    eventName: 'browser_tool_call' | 'action_call',
    params: FrontendCallParams,
    defaultTimeoutMs: number,
  ): Promise<unknown> {
    const timeoutMs = params.timeoutMs ?? defaultTimeoutMs;
    // Register BEFORE emitting so a synchronous answer cannot be missed.
    const pending = this.calls.wait(
      {
        kind,
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        sessionId: params.sessionId,
      },
      { timeoutMs },
    );
    const payload: RawEventPayload = {
      sessionId: params.sessionId,
      requestId: params.toolCallId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      args: params.args,
      ...(kind === 'agui' ? { status: 'isRunning' } : {}),
    };
    // Through the router: the session's SSE stream sees it too (Node emits
    // it on the root emitter, which feeds both channels).
    this.deps.router.emit(eventName, payload);
    return pending;
  }

  // ── housekeeping ────────────────────────────────────────────────────────

  private drop(ws: WebSocket, code: number, reason: string): void {
    this.forget(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  private forget(ws: WebSocket): void {
    const timer = this.handshakeTimers.get(ws);
    if (timer) {
      clearTimeout(timer);
      this.handshakeTimers.delete(ws);
    }
    const attachment = this.hub.get(ws);
    this.hub.remove(ws);
    // Only an authenticated socket ever counted for its session; a socket
    // that never passed CONNECT leaves nothing to drain.
    if (attachment?.userDid && !this.hub.hasSession(attachment.sessionId)) {
      this.deps.onSessionDrained?.(attachment.sessionId, attachment.userDid);
    }
  }

  /** Make sure an alarm is set for the next heartbeat round. */
  private scheduleHeartbeat(): void {
    const at = this.nextPingAt();
    if (at !== null) this.deps.requestAlarm?.(at);
  }
}
