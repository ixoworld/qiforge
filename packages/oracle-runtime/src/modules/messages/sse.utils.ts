import { type AllEvents } from '@ixo/oracles-events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { type Response } from 'express';

interface SSEContext {
  res: Response;
  abortController?: AbortController;
}

const sseContextStorage = new AsyncLocalStorage<SSEContext>();

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

/** Send an error event. */
export function sendSSEError(res: Response, error: Error | string): void {
  if (!res.writableEnded) {
    res.write(
      formatSSE('error', {
        error: error instanceof Error ? error.message : error,
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
): Promise<T> {
  return sseContextStorage.run({ res, abortController }, callback);
}

/** Emit an SSE event from anywhere within the active SSE context. */
export function emitSSEEvent(event: AllEvents): void {
  const context = sseContextStorage.getStore();
  if (context?.res && !context.res.writableEnded) {
    context.res.write(formatSSEEvent(event));
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
