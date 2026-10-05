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
 *     → settle the browser-tool / AG-UI invocation with that id, when this
 *       is the socket it was sent to (see "Frontend calls" below).
 *
 * Outbound, every event the runtime emits for a session (`ctx.emit.*`,
 * `tool_call`, `render_component`, …) is fanned out to the session's
 * authenticated sockets — the router's tap.
 *
 * Frontend calls (`ctx.frontend.callBrowserTool` / `callAgAction`) are not
 * fanned out: each invocation gets its own id, is sent to ONE socket of its
 * session (the one most recently active), and only that socket's answer
 * settles it. When the
 * answer cannot come — deadline, or that socket went — the call resolves
 * with `FRONTEND_OUTCOME_UNKNOWN` and is never re-sent. See
 * docs/frontend-bridge.md.
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
import { frontendInvocationId } from '@ixo/common/ai/frontend-bridge';
import {
  FRONTEND_CALL_LABEL,
  FrontendCallRegistry,
  type FrontendCallKind,
  type FrontendResultRejection,
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

/** Socket event every runtime event travels under, carrying `{ eventName, payload }` (Node's wire). */
const ENVELOPE_EVENT = 'event';
/**
 * Frontend calls: the client SDK listens for them by name with the raw
 * payload and EXECUTES them, so they reach a socket only as a dispatched
 * invocation (`call`), never through the fan-out.
 */
const FRONTEND_CALL_EVENTS: ReadonlySet<string> = new Set([
  'browser_tool_call',
  'action_call',
]);

/** Warning text per rejected result (identifiers only, never the payload). */
const REJECTION_TEXT: Record<FrontendResultRejection, string> = {
  'not-issued': 'no such invocation was issued (or its record expired)',
  'already-settled': 'the invocation already settled (duplicate or late)',
  'wrong-socket': 'this is not the socket it was sent to',
  'wrong-kind': 'the invocation is of the other kind',
};

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
  /** Finished invocations remembered to reject replays (bounded). */
  completedCalls: number;
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

  readonly calls: FrontendCallRegistry;

  readonly frontend: FrontendCallSurface;

  private readonly handshakeTimers = new Map<
    WebSocket,
    ReturnType<typeof setTimeout>
  >();

  private readonly now: () => number;

  constructor(private readonly deps: RealtimeEndpointDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.calls = new FrontendCallRegistry({ now: this.now });
    this.hub = new SessionSocketHub<WebSocket>({
      now: this.now,
      onDropped: (attachment) => this.executorGone(attachment.sid),
    });
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
        // Client activity picks the tab frontend calls run on.
        this.hub.noteActivity(ws);
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
      completedCalls: this.calls.completedCount,
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
    if (outcome.auth.via === 'delegation')
      // The shell logs the same line per HTTP request: operators find the
      // clients that still need UCAN_ALLOW_BARE_DELEGATION_AUTH by it.
      this.deps.logger.warn(
        `[auth] socket CONNECT ${meta.sessionId}: ${outcome.auth.userDid} authenticated with a bare delegation (UCAN_ALLOW_BARE_DELEGATION_AUTH); the client must send a UCAN invocation before the fallback is turned off`,
      );
    let owned: boolean;
    try {
      owned = await this.deps.sessionExists(
        outcome.auth.userDid,
        meta.sessionId,
      );
    } catch (err) {
      // Ownership that cannot be checked is not granted.
      this.deps.logger.warn(
        `[realtime] session check for ${meta.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.refuse(ws, 'Unauthorized: session check failed');
      return;
    }
    if (!owned) {
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
    const userDid = meta.userDid;
    if (!toolCallId || !userDid) {
      this.deps.logger.warn(
        `[realtime] ${kind} result without toolCallId from ${meta.sid}`,
      );
      return;
    }
    // Routing comes from the socket alone. A client that names another
    // session is making a claim it cannot make; the result is dropped and
    // the call keeps waiting for its own socket's answer.
    const claimed = record.sessionId;
    if (claimed !== undefined && claimed !== meta.sessionId) {
      this.deps.logger.warn(
        `[realtime] ${kind} result for ${toolCallId} rejected: socket ${meta.sid} of session ${meta.sessionId} names session ${typeof claimed === 'string' ? claimed : typeof claimed}`,
      );
      return;
    }
    const error = readString(record, 'error');
    const outcome = this.calls.settle(kind, {
      toolCallId,
      from: { sid: meta.sid, sessionId: meta.sessionId, userDid },
      result: record.result,
      ...(error ? { error } : {}),
    });
    if (!outcome.settled) {
      this.deps.logger.warn(
        `[realtime] ${kind} result for ${toolCallId} from socket ${meta.sid} (session ${meta.sessionId}) rejected: ${REJECTION_TEXT[outcome.reason]}`,
      );
    }
  }

  // ── outbound ────────────────────────────────────────────────────────────

  /**
   * Mirror a runtime event to the sockets of the session it belongs to, on
   * the Node runtime's wire: the socket event is `event` and its argument is
   * the `@ixo/oracles-events` envelope `{ eventName, payload }`. The client
   * SDK's catch-all listener validates exactly that (`payload.sessionId` and
   * `payload.requestId`) and drops a bare payload, while its named
   * `tool_call` / `render_component` listeners crash on one. The two calls
   * the SDK EXECUTES (`browser_tool_call`, `action_call`) never travel this
   * way: a frame of theirs here is the SSE stream's mirror of a sub-agent
   * tool call or a plugin's one-way emit — not an invocation — and a browser
   * that ran it would act again. Invocations go out through `call`.
   */
  private fanOut(eventName: string, payload: RawEventPayload): void {
    const sessionId =
      typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
    if (!sessionId || FRONTEND_CALL_EVENTS.has(eventName)) return;
    this.hub.emitToSession(sessionId, ENVELOPE_EVENT, { eventName, payload });
  }

  /**
   * One frontend invocation: a fresh id, registered before it is sent (an
   * immediate answer cannot be missed), sent to the most recently active
   * authenticated socket of the session (`executorForSession`) and bound to
   * it. A call that reaches no socket is
   * a definite failure; one whose answer never comes is an unknown outcome.
   */
  private call(
    kind: FrontendCallKind,
    eventName: 'browser_tool_call' | 'action_call',
    params: FrontendCallParams,
    defaultTimeoutMs: number,
  ): Promise<unknown> {
    const toolCallId = frontendInvocationId(params.toolCallId);
    const label = FRONTEND_CALL_LABEL[kind];
    let pending: Promise<unknown>;
    try {
      pending = this.calls.open(
        {
          kind,
          toolCallId,
          toolName: params.toolName,
          sessionId: params.sessionId,
        },
        {
          timeoutMs: params.timeoutMs ?? defaultTimeoutMs,
          ...(params.signal ? { signal: params.signal } : {}),
        },
      );
    } catch (err) {
      return Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    // A turn already aborted rejected the call as not sent: send nothing.
    if (!this.calls.isPending(toolCallId)) return pending;
    params.onInvocation?.(toolCallId);
    const payload: RawEventPayload = {
      sessionId: params.sessionId,
      requestId: params.toolCallId,
      toolCallId,
      toolName: params.toolName,
      args: params.args,
      ...(kind === 'agui' ? { status: 'isRunning' } : {}),
    };
    const target = this.hub.executorForSession(params.sessionId);
    const userDid = target?.attachment.userDid;
    if (
      !target ||
      !userDid ||
      !this.hub.send(target.socket, encodeEvent(eventName, payload))
    ) {
      this.calls.fail(
        toolCallId,
        new Error(
          `${label} ${params.toolName} was not sent: no browser is connected to session ${params.sessionId}`,
        ),
      );
      return pending;
    }
    this.calls.dispatched(toolCallId, {
      sid: target.attachment.sid,
      sessionId: params.sessionId,
      userDid,
    });
    // A browser tool call is shown on the session's SSE stream too (session
    // sinks; the socket tap skips frontend calls, see `fanOut`). An AG-UI
    // invocation is not: the SSE stream already reports the action as an
    // `action_call` under the model's call id and closes it when the tool
    // ends, and a second frame under the invocation id would never be
    // closed — the client would show a card spinning forever.
    if (kind === 'browser') this.deps.router.emit(eventName, payload);
    return pending;
  }

  /** The socket `sid` is gone: its invocations end as unknown, never re-sent. */
  private executorGone(sid: string): void {
    const ended = this.calls.executorGone(sid);
    if (ended > 0)
      this.deps.logger.warn(
        `[realtime] socket ${sid} went with ${ended} frontend call(s) in flight; reported as unknown outcome, not re-sent`,
      );
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
    if (attachment) this.executorGone(attachment.sid);
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
