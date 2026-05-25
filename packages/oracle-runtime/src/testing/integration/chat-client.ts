/**
 * `ChatClient` — HTTP/SSE client for talking to a booted oracle from
 * an integration test. Mirrors the production frontend pattern from
 * `packages/oracles-client-sdk/src/hooks/use-chat/v2/use-send-message.ts`:
 *
 *  - `POST /messages/:sessionId` with `x-ucan-delegation` header
 *  - `timezone` sent in the request BODY (not the header)
 *  - SSE parsed via the typed `parseSSEStream` (mirror of the SDK's parser)
 *  - `X-Request-Id` header captured from the response — required for stream
 *
 * Streams yield the same typed `SSEEvent` discriminated union the SDK uses,
 * so test assertions reason about the exact event payloads the frontend
 * consumes. No bespoke parser, no `unknown`-typed events.
 */
import { type SendMessageResponse } from '../../modules/messages/dto/send-message.dto.js';
import { parseSSEStream, type SSEEvent } from './sse-parser.js';

export type { SSEEvent } from './sse-parser.js';
export type { SendMessageResponse } from '../../modules/messages/dto/send-message.dto.js';

/** Options used to construct a `ChatClient`. */
export interface ChatClientOptions {
  /** Base64 UCAN delegation, forwarded as `x-ucan-delegation`. */
  delegation?: string;
  /** IANA timezone string — sent in the request BODY (matches SDK). */
  timezone?: string;
  /** Per-request timeout (ms). Default 60_000. */
  timeoutMs?: number;
  /** Override the `fetch` impl. */
  fetch?: typeof globalThis.fetch;
}

/** Per-call options accepted by `ChatClient.send` and `ChatClient.stream`. */
export interface SendOptions {
  /** Cancel the request mid-flight. */
  signal?: AbortSignal;
  /** Per-call override of the constructor's `timezone`. */
  timezone?: string;
  /** Per-call override of the constructor's `delegation`. */
  delegation?: string;
  /** Optional metadata forwarded to the server (matches SDK). */
  metadata?: Record<string, unknown>;
  /** Optional attachments — same shape the SDK sends. */
  attachments?: Array<{
    mxcUri?: string;
    eventId?: string;
    filename: string;
    mimetype: string;
    size?: number;
  }>;
  /** Optional declared browser tools. */
  tools?: Array<{
    name: string;
    description: string;
    schema: Record<string, unknown>;
  }>;
  /** Optional declared AG-UI actions. */
  agActions?: Array<{
    name: string;
    description: string;
    schema: Record<string, unknown>;
    hasRender?: boolean;
  }>;
  /**
   * Per-call override — defaults to `true` in `ChatClient` so tests always
   * receive the full transcript. Pass `false` to mirror the production
   * payload (only the last assistant message).
   */
  returnAllMessages?: boolean;
}

/**
 * Non-stream `send()` body — guaranteed to include the full transcript
 * since `ChatClient` defaults `returnAllMessages: true`. The `message`
 * field is the last assistant message (the older response shape, kept for
 * backward-compatible test assertions).
 */
export interface SendMessageWithTranscriptResponse extends SendMessageResponse {
  messages: NonNullable<SendMessageResponse['messages']>;
}

/** Result of an HTTP request issued by `ChatClient`. */
export interface SendResult<TBody = unknown> {
  body: TBody;
  durationMs: number;
  status: number;
  requestId?: string;
}

export type StreamOptions = SendOptions;

/** Result yielded by `ChatClient.stream()` once iteration completes. */
export interface StreamFinal {
  events: SSEEvent[];
  /** Concatenated text from every `message` event in arrival order. */
  text: string;
  durationMs: number;
  /** `X-Request-Id` — always present for stream responses (matches SDK). */
  requestId: string;
}

export class ChatClient {
  private readonly baseUrl: string;
  private readonly delegation: string | undefined;
  private readonly timezone: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(baseUrl: string, opts: ChatClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.delegation = opts.delegation;
    this.timezone = opts.timezone ?? 'UTC';
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Headers shared by every request. `timezone` is NOT here — it's in the body. */
  private authHeaders(extra: Record<string, string> = {}): HeadersInit {
    const out: Record<string, string> = {
      'content-type': 'application/json',
      ...extra,
    };
    if (this.delegation && this.delegation.length > 0) {
      out['x-ucan-delegation'] = this.delegation;
    }
    return out;
  }

  /**
   * Compose the JSON body the SDK sends — keys match
   * `apps/qiforge-example` → SDK → controller exactly.
   */
  private composeBody(
    message: string,
    stream: boolean,
    opts: SendOptions,
  ): string {
    return JSON.stringify({
      message,
      stream,
      timezone: opts.timezone ?? this.timezone,
      // ChatClient defaults `returnAllMessages` to true — tests get the full
      // transcript by default and can opt out with `returnAllMessages: false`.
      // Stream requests ignore the flag server-side, so only send it when
      // non-stream.
      ...(!stream && {
        returnAllMessages: opts.returnAllMessages ?? true,
      }),
      ...(opts.metadata && { metadata: opts.metadata }),
      ...(opts.attachments?.length && { attachments: opts.attachments }),
      ...(opts.tools?.length && { tools: opts.tools }),
      ...(opts.agActions?.length && { agActions: opts.agActions }),
    });
  }

  /** Raw `fetch` against the oracle's base URL — for plugin HTTP routes. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const mergedHeaders = this.authHeaders(
      Object.fromEntries(new Headers(init.headers).entries()),
    );
    return this.fetchImpl(url, { ...init, headers: mergedHeaders });
  }

  /**
   * `POST /messages/:sessionId` with `stream: false`.
   *
   * `ChatClient` defaults `returnAllMessages: true`, so `body.messages`
   * holds the full session transcript and `body.message` is the last
   * assistant message (same shape the production payload returns). The
   * caller can opt out via `opts.returnAllMessages = false` — in that case
   * `body.messages` will be `undefined` at runtime but the type stays
   * non-optional for the default case; narrow manually if you opt out.
   */
  async send(
    sessionId: string,
    message: string,
    opts: SendOptions = {},
  ): Promise<SendResult<SendMessageWithTranscriptResponse>> {
    const start = Date.now();
    const headers = this.authHeaders(
      opts.delegation ? { 'x-ucan-delegation': opts.delegation } : {},
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = opts.signal
      ? mergeSignals(controller.signal, opts.signal)
      : controller.signal;

    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/messages/${encodeURIComponent(sessionId)}`,
        {
          method: 'POST',
          headers,
          body: this.composeBody(message, false, opts),
          signal,
        },
      );
      const requestId = res.headers.get('x-request-id') ?? undefined;
      const text = await res.text();
      const body = JSON.parse(text) as SendMessageWithTranscriptResponse;
      return {
        body,
        status: res.status,
        durationMs: Date.now() - start,
        requestId,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * `POST /messages/:sessionId` with `stream: true`. Returns an async
   * iterable of typed SSE events plus a `final()` method resolving to the
   * complete event list + accumulated text.
   */
  stream(
    sessionId: string,
    message: string,
    opts: StreamOptions = {},
  ): AsyncIterable<SSEEvent> & { final(): Promise<StreamFinal> } {
    const headers = this.authHeaders({
      accept: 'text/event-stream',
      ...(opts.delegation ? { 'x-ucan-delegation': opts.delegation } : {}),
    });

    const start = Date.now();
    const events: SSEEvent[] = [];
    let text = '';
    let requestId: string | undefined;
    let doneResolve: (v: StreamFinal) => void;
    let doneReject: (e: Error) => void;
    const donePromise = new Promise<StreamFinal>((res, rej) => {
      doneResolve = res;
      doneReject = rej;
    });

    const generator = async function* (
      this: ChatClient,
    ): AsyncGenerator<SSEEvent> {
      const res = await this.fetchImpl(
        `${this.baseUrl}/messages/${encodeURIComponent(sessionId)}`,
        {
          method: 'POST',
          headers,
          body: this.composeBody(message, true, opts),
          signal: opts.signal,
        },
      );
      requestId = res.headers.get('x-request-id') ?? undefined;
      if (!requestId) {
        // Mirror the SDK invariant — stream responses MUST carry x-request-id.
        const err = new Error(
          `Stream response missing x-request-id header (status ${res.status})`,
        );
        doneReject(err);
        throw err;
      }
      if (!res.body) {
        doneResolve({
          events,
          text,
          durationMs: Date.now() - start,
          requestId,
        });
        return;
      }

      const reader = res.body.getReader();
      try {
        for await (const evt of parseSSEStream(reader)) {
          events.push(evt);
          if (evt.event === 'message') {
            text += evt.data.content;
          }
          yield evt;
        }
        doneResolve({
          events,
          text,
          durationMs: Date.now() - start,
          requestId,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        doneReject(error);
        throw error;
      }
    }.call(this);

    const iterable = generator as AsyncGenerator<SSEEvent> & {
      final(): Promise<StreamFinal>;
    };
    iterable.final = () => donePromise;
    return iterable;
  }

  /**
   * `POST /sessions` — create a new chat session and return its id.
   *
   * Required before `send`/`stream` against a sessionId — `MessagesService`
   * throws 404 if the session doesn't already exist. Tests call this in
   * `beforeAll` and reuse the returned id, matching the SDK's
   * `useSessionManager` flow on the frontend.
   */
  async createSession(): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(
        `createSession failed: ${res.status} ${JSON.stringify(await res.json().catch(() => ''))}`,
      );
    }
    const body = (await res.json()) as { sessionId?: string };
    if (!body.sessionId) {
      throw new Error(
        `createSession response missing sessionId: ${JSON.stringify(body)}`,
      );
    }
    return body.sessionId;
  }

  /** `GET /messages/:sessionId` — list messages in a session. */
  async list(sessionId: string): Promise<SendResult> {
    const start = Date.now();
    const res = await this.fetchImpl(
      `${this.baseUrl}/messages/${encodeURIComponent(sessionId)}`,
      { method: 'GET', headers: this.authHeaders() },
    );
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON
    }
    return {
      body,
      status: res.status,
      durationMs: Date.now() - start,
      requestId: res.headers.get('x-request-id') ?? undefined,
    };
  }

  /** `POST /messages/abort` — cancel an ongoing stream by session id. */
  async abort(sessionId: string): Promise<SendResult> {
    const start = Date.now();
    const res = await this.fetchImpl(`${this.baseUrl}/messages/abort`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ sessionId }),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON
    }
    return {
      body,
      status: res.status,
      durationMs: Date.now() - start,
      requestId: res.headers.get('x-request-id') ?? undefined,
    };
  }
}

/** Merge a timeout signal with a caller-supplied one. */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
