/**
 * Test support: an in-memory Matrix homeserver behind a real `matrix-js-sdk`
 * client. The client's `fetchFn` is routed here, so matrix-crdt and the
 * provider run their real code paths — join, backwards history walk, the
 * `/events` long-poll, document-update sends — against rooms these tests
 * control, and every request is counted. Not a `*.test.ts` file.
 *
 * Only the endpoints the document provider uses are implemented:
 *   POST /join/{room}                       → joins (always succeeds)
 *   GET  /rooms/{room}/messages             → the stored events, newest first
 *   GET  /events                            → held open until aborted
 *   PUT  /rooms/{room}/send/{type}/{txn}    → stored, or the scripted failure
 *   GET  /rooms/{room}/state/…              → 404 M_NOT_FOUND
 * Anything else answers 404 `M_UNRECOGNIZED` and is recorded.
 */
import { createClient, type MatrixClient } from 'matrix-js-sdk';
import * as Y from 'yjs';

export const TEST_HOMESERVER_URL = 'https://hs.test.example';
export const TEST_ORACLE_USER = '@oracle:test.example';

export interface StoredEvent {
  event_id: string;
  type: string;
  room_id: string;
  sender: string;
  user_id: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
}

/**
 * A scripted homeserver answer: `ok` stores the event; `network` fails the
 * request with no HTTP answer; `hang` never answers (until aborted); else an
 * error body.
 */
export type SendOutcome =
  | 'ok'
  | 'network'
  | 'hang'
  | {
      status: number;
      errcode: string;
      error?: string;
      retry_after_ms?: number;
    };

export interface RecordedRequest {
  method: string;
  path: string;
  at: number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function encodeUpdate(update: Uint8Array): string {
  let binary = '';
  for (const byte of update) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class TestHomeserver {
  readonly requests: RecordedRequest[] = [];
  /** Events per room, oldest first. */
  readonly rooms = new Map<string, StoredEvent[]>();
  /** Answers for document-update sends, consumed in order; then `ok`. */
  sendScript: SendOutcome[] = [];
  /** When set, `/messages` answers this instead of the stored events. */
  messagesFailure: { status: number; errcode: string } | undefined;
  /** When set, `POST /join` answers this error. */
  joinFailure: { status: number; errcode: string } | undefined;
  /** One-off `/messages` failures, consumed in order before `messagesFailure`. */
  messagesScript: Array<{ status: number; errcode: string }> = [];
  /** `/events` long-polls currently held open. */
  openPolls = 0;
  /** Delays (ms) for successive `/messages` answers, consumed in order. */
  messagesDelays: number[] = [];

  private nextEventId = 1;

  /** A fresh client bound to this homeserver. */
  client(): MatrixClient {
    return createClient({
      baseUrl: TEST_HOMESERVER_URL,
      accessToken: 'test-token',
      userId: TEST_ORACLE_USER,
      fetchFn: (input, init) => this.handle(input, init),
    });
  }

  /** Store a Y.Doc's full state as one document-update event in `roomId`. */
  seedDoc(roomId: string, doc: Y.Doc): void {
    this.append(roomId, 'matrix-crdt.doc_update', {
      update: encodeUpdate(Y.encodeStateAsUpdate(doc)),
    });
  }

  /** Rebuild the room's document from its stored update events. */
  docOf(roomId: string): Y.Doc {
    const doc = new Y.Doc();
    for (const event of this.rooms.get(roomId) ?? []) {
      const update = event.content.update;
      if (typeof update !== 'string') continue;
      const bytes = Uint8Array.from(atob(update), (c) => c.charCodeAt(0));
      Y.applyUpdate(doc, bytes);
    }
    return doc;
  }

  count(method: string, pathPart: string): number {
    return this.requests.filter(
      (r) => r.method === method && r.path.includes(pathPart),
    ).length;
  }

  private append(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
  ): StoredEvent {
    const event: StoredEvent = {
      event_id: `$e${this.nextEventId++}`,
      type,
      room_id: roomId,
      sender: TEST_ORACLE_USER,
      user_id: TEST_ORACLE_USER,
      origin_server_ts: Date.now(),
      content,
    };
    const events = this.rooms.get(roomId) ?? [];
    events.push(event);
    this.rooms.set(roomId, events);
    return event;
  }

  private async handle(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const path = decodeURIComponent(
      url.pathname.replace(/^\/_matrix\/client\/v3/, ''),
    );
    this.requests.push({ method, path, at: Date.now() });

    const join = /^\/join\/(.+)$/.exec(path);
    if (method === 'POST' && join)
      return this.joinFailure
        ? json(this.joinFailure.status, {
            errcode: this.joinFailure.errcode,
            error: 'scripted failure',
          })
        : json(200, { room_id: join[1] });

    const messages = /^\/rooms\/([^/]+)\/messages$/.exec(path);
    if (method === 'GET' && messages) {
      const delay = this.messagesDelays.shift();
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const failure = this.messagesScript.shift() ?? this.messagesFailure;
      if (failure)
        return json(failure.status, {
          errcode: failure.errcode,
          error: 'scripted failure',
        });
      const chunk = [...(this.rooms.get(messages[1] ?? '') ?? [])].reverse();
      return json(200, { chunk, start: 't0' });
    }

    if (method === 'GET' && path === '/events') {
      const signal = init?.signal;
      this.openPolls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const finish = () => {
          this.openPolls -= 1;
          const reason: unknown = signal?.reason;
          reject(reason instanceof Error ? reason : new Error('aborted'));
        };
        if (signal?.aborted) finish();
        else signal?.addEventListener('abort', finish, { once: true });
      });
    }

    const send = /^\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/.exec(path);
    if (method === 'PUT' && send) {
      const [, roomId = '', type = ''] = send;
      const outcome =
        type === 'matrix-crdt.doc_update' ? this.sendScript.shift() : 'ok';
      if (outcome === 'network') throw new TypeError('Network connection lost');
      if (outcome === 'hang')
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      if (outcome && outcome !== 'ok')
        return json(outcome.status, {
          errcode: outcome.errcode,
          error: outcome.error ?? 'scripted failure',
          ...(outcome.retry_after_ms !== undefined
            ? { retry_after_ms: outcome.retry_after_ms }
            : {}),
        });
      const body: unknown = JSON.parse(String(init?.body ?? '{}'));
      const content = body && typeof body === 'object' ? { ...body } : {};
      return json(200, {
        event_id: this.append(roomId, type, content).event_id,
      });
    }

    if (method === 'GET' && /^\/rooms\/[^/]+\/state\//.test(path))
      return json(404, { errcode: 'M_NOT_FOUND', error: 'not found' });

    return json(404, { errcode: 'M_UNRECOGNIZED', error: `no route ${path}` });
  }
}

/**
 * Record every unhandled promise rejection until `stop()` is called. Uses the
 * global `unhandledrejection` event, which workerd dispatches.
 */
export function watchUnhandledRejections(): {
  reasons: unknown[];
  stop: () => void;
} {
  const reasons: unknown[] = [];
  const listener = (event: PromiseRejectionEvent) => {
    reasons.push(event.reason);
  };
  globalThis.addEventListener('unhandledrejection', listener);
  return {
    reasons,
    stop: () => globalThis.removeEventListener('unhandledrejection', listener),
  };
}
