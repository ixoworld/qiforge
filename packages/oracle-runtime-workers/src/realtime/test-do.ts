/**
 * Test-only Durable Object driving `RealtimeEndpoint` inside workerd: real
 * Hibernatable WebSockets (`acceptWebSocket`, `webSocketMessage`, …), the
 * real `SessionEventRouter` fan-out, and a scripted authenticator. Bound as
 * `REALTIME_TEST` by `test/wrangler.test.jsonc`. Not part of the runtime.
 */
import { DurableObject } from 'cloudflare:workers';
import { SessionEventRouter } from '../do/ambient';
import type { FrontendCallParams } from '../plugin-api/types';
import type { AuthOutcome } from '../shell/auth';
import { RealtimeEndpoint, type RealtimeStatus } from './realtime-endpoint';

export const TEST_GOOD_TOKEN = 'good-token';
export const TEST_USER_DID = 'did:ixo:realtimeuser';
export const TEST_MISSING_SESSION = 'missing-session';

export type CallOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

async function outcomeOf(call: Promise<unknown>): Promise<CallOutcome> {
  try {
    return { ok: true, value: await call };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export class RealtimeTestDO extends DurableObject {
  private endpoint: RealtimeEndpoint | null = null;

  private readonly router = new SessionEventRouter();

  private readonly requestedAlarms: number[] = [];

  private readonly drained: Array<{ sessionId: string; userDid: string }> = [];

  private get realtime(): RealtimeEndpoint {
    this.endpoint ??= new RealtimeEndpoint({
      ctx: this.ctx,
      requestAlarm: (at) => {
        this.requestedAlarms.push(at);
      },
      onSessionDrained: (sessionId, userDid) => {
        this.drained.push({ sessionId, userDid });
      },
      authenticate: (auth): Promise<AuthOutcome> =>
        Promise.resolve(
          auth.invocation === TEST_GOOD_TOKEN
            ? { ok: true, auth: { userDid: TEST_USER_DID, via: 'invocation' } }
            : {
                ok: false,
                status: 401,
                error: 'Invalid UCAN invocation: nope',
              },
        ),
      sessionExists: (_userDid, sessionId) =>
        Promise.resolve(sessionId !== TEST_MISSING_SESSION),
      router: this.router,
      logger: { log: () => undefined, warn: () => undefined },
    });
    return this.endpoint;
  }

  override fetch(request: Request): Promise<Response> {
    return Promise.resolve(
      this.realtime.handleUpgrade(request, new URL(request.url)),
    );
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.realtime.onMessage(ws, message);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.realtime.onClose(ws);
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.realtime.onError(ws, error);
  }

  // ── test surface ─────────────────────────────────────────────────────────

  /** Emit a runtime event the way `ctx.emit.*` does (through the router). */
  async emitForSession(
    sessionId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.router.emit(eventName, { ...payload, sessionId });
  }

  /**
   * Outcome objects rather than rejections: a promise rejected inside the
   * object is reported by the test pool as an unhandled error even when the
   * test awaits it.
   */
  async callBrowserTool(params: FrontendCallParams): Promise<CallOutcome> {
    return outcomeOf(this.realtime.frontend.callBrowserTool(params));
  }

  async callAgAction(params: FrontendCallParams): Promise<CallOutcome> {
    return outcomeOf(this.realtime.frontend.callAgAction(params));
  }

  async hasClient(sessionId: string): Promise<boolean> {
    return this.realtime.frontend.hasClient(sessionId);
  }

  async status(): Promise<RealtimeStatus> {
    return this.realtime.status();
  }

  /** One alarm-driven heartbeat round; returns when the next one is due. */
  async pingTick(): Promise<number | null> {
    return this.realtime.pingTick();
  }

  /**
   * Simulate the object waking from hibernation: the endpoint instance is
   * gone, the next use rebuilds it from `ctx.getWebSockets()` and the
   * attachments — exactly what a real wake does.
   */
  async simulateWake(): Promise<number> {
    this.endpoint = null;
    return this.realtime.status().sockets;
  }

  /**
   * Age every socket's heartbeat bookkeeping by `ms` (rewrites the
   * attachment), so a tick sees it as if that much time had passed.
   */
  async ageSockets(ms: number): Promise<void> {
    for (const { socket, attachment } of this.realtime.hub.entries()) {
      this.realtime.hub.update(socket, {
        lastPongAt: attachment.lastPongAt - ms,
        ...(attachment.lastPingAt !== undefined
          ? { lastPingAt: attachment.lastPingAt - ms }
          : {}),
      });
    }
  }

  /** The alarm requests the endpoint made (next heartbeat deadlines). */
  async alarmRequests(): Promise<number[]> {
    return [...this.requestedAlarms];
  }

  /** Sessions whose last authenticated socket went away, in order. */
  async drainedSessions(): Promise<
    Array<{ sessionId: string; userDid: string }>
  > {
    return [...this.drained];
  }
}
