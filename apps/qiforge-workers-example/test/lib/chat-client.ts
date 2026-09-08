import { fetchWithRetry } from './harness';
/**
 * Minimal HTTP/SSE client for the oracle — the same wire protocol the
 * Portal / `@ixo/oracles-client-sdk` speak (mirrors the Node runtime's
 * integration `ChatClient`).
 */
export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface StreamResult {
  events: SSEEvent[];
  text: string;
  durationMs: number;
  requestId: string | null;
  status: number;
}

export class ChatClient {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: { invocation: string; delegation?: string },
    private readonly timezone = 'UTC',
  ) {}

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.auth.invocation}`,
      'x-auth-type': 'ucan',
      ...(this.auth.delegation && {
        'x-ucan-delegation': this.auth.delegation,
      }),
      ...extra,
    };
  }

  async createSession(): Promise<string> {
    const res = await fetchWithRetry(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: this.headers(),
    });
    const body = (await res.json()) as { sessionId?: string; message?: string };
    if (!res.ok || !body.sessionId)
      throw new Error(`createSession ${res.status}: ${JSON.stringify(body)}`);
    return body.sessionId;
  }

  async listSessions(): Promise<unknown> {
    const res = await fetchWithRetry(`${this.baseUrl}/sessions`, {
      headers: this.headers(),
    });
    return res.json();
  }

  async listMessages(sessionId: string): Promise<{
    messages: Array<{ type: string; content: string; toolCalls?: unknown[] }>;
  }> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/messages/${encodeURIComponent(sessionId)}`,
      { headers: this.headers() },
    );
    if (!res.ok)
      throw new Error(`listMessages ${res.status}: ${await res.text()}`);
    return (await res.json()) as {
      messages: Array<{ type: string; content: string; toolCalls?: unknown[] }>;
    };
  }

  async send(
    sessionId: string,
    message: string,
  ): Promise<{
    status: number;
    body: Record<string, unknown>;
    durationMs: number;
  }> {
    const start = Date.now();
    const res = await fetchWithRetry(
      `${this.baseUrl}/messages/${encodeURIComponent(sessionId)}`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          message,
          stream: false,
          timezone: this.timezone,
          returnAllMessages: true,
        }),
      },
    );
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body, durationMs: Date.now() - start };
  }

  async stream(
    sessionId: string,
    message: string,
    opts: {
      signal?: AbortSignal;
      onEvent?: (e: SSEEvent) => void;
      /** Extra turn-body fields (e.g. `model`, `attachments`). */
      body?: Record<string, unknown>;
    } = {},
  ): Promise<StreamResult> {
    const start = Date.now();
    const res = await fetchWithRetry(
      `${this.baseUrl}/messages/${encodeURIComponent(sessionId)}`,
      {
        method: 'POST',
        headers: this.headers({ accept: 'text/event-stream' }),
        body: JSON.stringify({
          message,
          stream: true,
          timezone: this.timezone,
          ...opts.body,
        }),
        signal: opts.signal,
      },
    );
    const requestId = res.headers.get('x-request-id');
    const events: SSEEvent[] = [];
    let text = '';
    if (!res.ok || !res.body) {
      return {
        events,
        text: await res.text(),
        durationMs: Date.now() - start,
        requestId,
        status: res.status,
      };
    }
    for await (const evt of parseSSE(res.body)) {
      events.push(evt);
      opts.onEvent?.(evt);
      if (evt.event === 'message' && typeof evt.data.content === 'string')
        text += evt.data.content;
    }
    return {
      events,
      text,
      durationMs: Date.now() - start,
      requestId,
      status: res.status,
    };
  }

  async abort(sessionId: string): Promise<unknown> {
    const res = await fetchWithRetry(`${this.baseUrl}/messages/abort`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ sessionId }),
    });
    return res.json();
  }
}

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data = '';
  const flush = (): SSEEvent | null => {
    if (!event || !data) {
      event = '';
      data = '';
      return null;
    }
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const out = { event, data: parsed };
      event = '';
      data = '';
      return out;
    } catch {
      event = '';
      data = '';
      return null;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (line === '' || line.startsWith(':')) {
        const evt = flush();
        if (evt) yield evt;
        continue;
      }
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data = line.slice(5).trim();
    }
  }
  const last = flush();
  if (last) yield last;
}
