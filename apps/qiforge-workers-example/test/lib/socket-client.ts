/**
 * A minimal socket.io v4 client over Node's global WebSocket — what the
 * client SDK's `use-websocket-events` hook does with `socket.io-client`
 * (`transports: ['websocket']`), reduced to the wire protocol so the e2e
 * can play the browser without pulling the SDK into the harness.
 *
 * Wire recap (engine.io v4 + socket.io v4, text frames):
 *   server `0{sid,…}` OPEN → client `40{auth}` CONNECT → server `40{sid}`
 *   events `42["name",payload]`, server ping `2` → client pong `3`.
 */

export interface SocketEvent {
  name: string;
  payload: unknown;
}

export interface SocketClientOptions {
  /** Oracle base URL (http/https); converted to ws/wss. */
  baseUrl: string;
  sessionId: string;
  userDid: string;
  /** CONNECT packet auth object (`{ invocation, ucanDelegation? }`). */
  auth: Record<string, unknown>;
  timeoutMs?: number;
}

export type ConnectOutcome =
  | { ok: true; sid: string }
  | { ok: false; error: string; closeCode?: number };

export class SocketIoClient {
  private ws: WebSocket | null = null;

  readonly events: SocketEvent[] = [];

  private readonly waiters: Array<{
    pick: (e: SocketEvent) => boolean;
    resolve: (e: SocketEvent) => void;
  }> = [];

  private closed: { code: number; reason: string } | null = null;

  private openSid: string | null = null;

  private constructor(private readonly opts: SocketClientOptions) {}

  static async connect(opts: SocketClientOptions): Promise<{
    client: SocketIoClient;
    outcome: ConnectOutcome;
  }> {
    const client = new SocketIoClient(opts);
    const outcome = await client.open();
    return { client, outcome };
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  get closeInfo(): { code: number; reason: string } | null {
    return this.closed;
  }

  private open(): Promise<ConnectOutcome> {
    const url = new URL(this.opts.baseUrl);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    url.pathname = '/socket.io/';
    url.search = new URLSearchParams({
      EIO: '4',
      transport: 'websocket',
      sessionId: this.opts.sessionId,
      userDid: this.opts.userDid,
    }).toString();
    const timeoutMs = this.opts.timeoutMs ?? 20_000;
    return new Promise<ConnectOutcome>((resolve) => {
      let settled = false;
      const done = (o: ConnectOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(o);
      };
      const timer = setTimeout(
        () =>
          done({ ok: false, error: `no CONNECT ack within ${timeoutMs}ms` }),
        timeoutMs,
      );
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener('error', () => {
        done({ ok: false, error: 'websocket error before connect' });
      });
      ws.addEventListener('close', (ev) => {
        this.closed = { code: ev.code, reason: ev.reason };
        done({
          ok: false,
          error: `closed ${ev.code} ${ev.reason}`,
          closeCode: ev.code,
        });
      });
      ws.addEventListener('message', (ev) => {
        const raw = typeof ev.data === 'string' ? ev.data : '';
        if (raw.startsWith('0')) {
          // OPEN handshake → send CONNECT with the auth object.
          const hs = JSON.parse(raw.slice(1)) as { sid: string };
          this.openSid = hs.sid;
          ws.send(`40${JSON.stringify(this.opts.auth)}`);
          return;
        }
        if (raw === '2') {
          ws.send('3');
          return;
        }
        if (raw.startsWith('40')) {
          const body = JSON.parse(raw.slice(2) || '{}') as { sid?: string };
          done({ ok: true, sid: body.sid ?? this.openSid ?? '' });
          return;
        }
        if (raw.startsWith('44')) {
          const body = JSON.parse(raw.slice(2) || '{}') as { message?: string };
          done({ ok: false, error: body.message ?? 'connect error' });
          return;
        }
        if (raw.startsWith('42')) {
          // Strip an optional ack id between "42" and the JSON array.
          const arrayStart = raw.indexOf('[');
          if (arrayStart === -1) return;
          const parsed = JSON.parse(raw.slice(arrayStart)) as unknown[];
          const event: SocketEvent = {
            name: String(parsed[0]),
            payload: parsed[1],
          };
          this.events.push(event);
          for (const w of [...this.waiters]) {
            if (w.pick(event)) {
              this.waiters.splice(this.waiters.indexOf(w), 1);
              w.resolve(event);
            }
          }
        }
      });
    });
  }

  emit(name: string, payload?: unknown): void {
    if (!this.ws) throw new Error('socket not open');
    this.ws.send(
      `42${JSON.stringify(payload === undefined ? [name] : [name, payload])}`,
    );
  }

  /** Resolve with the first event (already received or future) matching `pick`. */
  waitFor(
    pick: (e: SocketEvent) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<SocketEvent> {
    const seen = this.events.find(pick);
    if (seen) return Promise.resolve(seen);
    return new Promise<SocketEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === wrapped);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(
          new Error(
            `no ${label} event within ${timeoutMs}ms; events seen: ${
              this.events.map((e) => e.name).join(', ') || '(none)'
            }`,
          ),
        );
      }, timeoutMs);
      const wrapped = (e: SocketEvent) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiters.push({ pick, resolve: wrapped });
    });
  }

  /**
   * Answer every `browser_tool_call` / `action_call` with `handler`'s
   * result the way the SDK's `executeToolAndEmitResult` does. Returns an
   * unsubscribe function.
   */
  serveFrontendTools(
    handler: (call: {
      kind: 'browser' | 'agui';
      toolName: string;
      args: Record<string, unknown>;
    }) => Promise<unknown>,
  ): () => void {
    let active = true;
    const pump = async (): Promise<void> => {
      let cursor = 0;
      while (active && !this.isClosed) {
        while (cursor < this.events.length) {
          const e = this.events[cursor]!;
          cursor += 1;
          if (e.name !== 'browser_tool_call' && e.name !== 'action_call')
            continue;
          const kind = e.name === 'browser_tool_call' ? 'browser' : 'agui';
          const data = e.payload as {
            toolCallId: string;
            toolName: string;
            args?: Record<string, unknown>;
            sessionId?: string;
          };
          const replyEvent =
            kind === 'browser' ? 'tool_result' : 'action_call_result';
          try {
            const result = await handler({
              kind,
              toolName: data.toolName,
              args: data.args ?? {},
            });
            this.emit(replyEvent, {
              toolCallId: data.toolCallId,
              sessionId: data.sessionId,
              result,
            });
          } catch (err) {
            const message =
              err instanceof Error ? err.message : 'Unknown error';
            this.emit(replyEvent, {
              toolCallId: data.toolCallId,
              sessionId: data.sessionId,
              result:
                kind === 'agui' ? { success: false, error: message } : null,
              error: message,
            });
          }
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    void pump();
    return () => {
      active = false;
    };
  }

  close(): void {
    try {
      this.ws?.send('41');
      this.ws?.close(1000, 'done');
    } catch {
      // ignore
    }
  }
}
