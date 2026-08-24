import { type AllEvents } from '@ixo/oracles-events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { type Response } from 'express';
import {
  redactOperatorFault,
  type ClassifiedLlmError,
} from '../../llm/provider-error.js';

interface SSEContext {
  res: Response;
  abortController?: AbortController;
  /** Request identity, stamped onto raw events emitted from nested code. */
  ids?: { sessionId?: string; requestId?: string };
}

const sseContextStorage = new AsyncLocalStorage<SSEContext>();

const THINKING_PHRASES = [
  'Thinking...',
  'Working...',
  'Analyzing...',
  'Processing...',
  'Computing...',
  'Crunching...',
  'Deliberating...',
  'Reasoning...',
  'Calculating...',
  'Evaluating...',
  'Pondering...',
  'Reading...',
  'Synthesizing...',
  'Formulating...',
  'Considering...',
  'Exploring ideas...',
  'Investigating...',
  'Brainstorming...',
  'Solving...',
  'Reviewing...',
  'Reflecting...',
];

/** Random instant-ack phrase for the moment the SSE connection opens. */
export function pickThinkingPhrase(): string {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]!;
}

/** SSE event format: `event: <name>\ndata: <jsonPayload>\n\n` */
export function formatSSEEvent(event: AllEvents): string {
  return `event: ${event.eventName}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

/** Format a raw event/data pair without going through the event class system. */
export function formatSSE(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE heartbeat (comment line) — keeps proxies/load balancers from timing out. */
export function sendSSEHeartbeat(res: Response): void {
  if (!res.writableEnded) {
    res.write(': heartbeat\n\n');
  }
}

/** Start a 15s heartbeat interval. Caller clears the returned timer. */
export function startSSEHeartbeat(res: Response): NodeJS.Timeout {
  return setInterval(() => sendSSEHeartbeat(res), 15000);
}

/** Set SSE response headers, optionally including a request id. */
export function setSSEHeaders(res: Response, requestId?: string): void {
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };

  if (requestId) {
    headers['X-Request-Id'] = requestId;
    headers['Access-Control-Expose-Headers'] = 'X-Request-Id';
  }

  res.set(headers);
}

/** Signal stream completion. */
export function sendSSEDone(res: Response): void {
  if (!res.writableEnded) {
    res.write(formatSSE('done', {}));
  }
}

/**
 * Send an error event. With `classified` set, the payload carries the
 * structured classification (kind/source/provider/status/retryable) next to
 * the human-readable `error` message so clients can render provider-aware
 * feedback instead of the raw SDK text; without it, the legacy
 * `{error, timestamp}` shape goes out unchanged.
 *
 * Every classification passes through `redactOperatorFault` here rather than
 * at the call sites: this is the one place an LLM failure becomes bytes on a
 * client's wire, so redacting here means a new caller cannot forget to.
 */
export function sendSSEError(
  res: Response,
  error: Error | string,
  classified?: ClassifiedLlmError,
  ids?: { sessionId?: string; requestId?: string },
): void {
  const safe = classified ? redactOperatorFault(classified) : undefined;
  if (!res.writableEnded) {
    res.write(
      formatSSE('error', {
        error: safe
          ? safe.message
          : error instanceof Error
            ? error.message
            : error,
        ...(safe && {
          kind: safe.kind,
          source: safe.source,
          ...(safe.provider && { provider: safe.provider }),
          ...(safe.providerLabel && {
            providerLabel: safe.providerLabel,
          }),
          ...(safe.status !== undefined && {
            status: safe.status,
          }),
          retryable: safe.retryable,
          detail: safe.detail,
        }),
        ...(ids?.sessionId && { sessionId: ids.sessionId }),
        ...(ids?.requestId && { requestId: ids.requestId }),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

/**
 * Run a callback with an SSE context bound to AsyncLocalStorage so deeply
 * nested code can call `emitSSEEvent()` without threading the Response
 * through every function signature.
 */
export function runWithSSEContext<T>(
  res: Response,
  callback: () => Promise<T>,
  abortController?: AbortController,
  ids?: { sessionId?: string; requestId?: string },
): Promise<T> {
  return sseContextStorage.run({ res, abortController, ids }, callback);
}

/** Emit an SSE event from anywhere within the active SSE context. */
export function emitSSEEvent(event: AllEvents): void {
  const context = sseContextStorage.getStore();
  if (context?.res && !context.res.writableEnded) {
    context.res.write(formatSSEEvent(event));
  }
}

/**
 * Emit a raw event/payload pair from within the active SSE context, for
 * one-off notices that have no event class (e.g. the BYO-fallback warning).
 * Object payloads are stamped with the context's sessionId/requestId so
 * clients can attribute the event. No-op outside an SSE request (batch
 * path, Matrix path).
 */
export function emitSSERawEvent(eventName: string, data: unknown): void {
  const context = sseContextStorage.getStore();
  if (context?.res && !context.res.writableEnded) {
    const payload =
      data && typeof data === 'object' && !Array.isArray(data)
        ? { ...context.ids, ...(data as Record<string, unknown>) }
        : data;
    context.res.write(formatSSE(eventName, payload));
  }
}

export function getSSEContext(): Response | undefined {
  return sseContextStorage.getStore()?.res;
}

export function getSSEabortController(): AbortController | undefined {
  return sseContextStorage.getStore()?.abortController;
}

export function hasSSEContext(): boolean {
  return sseContextStorage.getStore() !== undefined;
}

export function isSSEAborted(): boolean {
  const context = sseContextStorage.getStore();
  return context?.abortController?.signal.aborted ?? false;
}
