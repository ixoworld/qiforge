/**
 * Deadlines for the gateway's media downloads. A homeserver that stops
 * sending mid-body would otherwise keep the reading side — a user object
 * assembling an attachment for a turn — waiting for as long as the
 * connection stays open.
 *
 * The bound covers the whole transfer: opening the download and every byte
 * of the body. When it passes (or the caller's own signal aborts), the
 * source is cancelled and the stream handed out errors with the reason.
 */

export interface BoundedSignal {
  signal: AbortSignal;
  /** Stop the timer (the transfer finished or failed on its own). */
  clear(): void;
}

/** Error a download fails with when its deadline passes. */
export class MediaDownloadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`media download timed out after ${timeoutMs} ms`);
    this.name = 'MediaDownloadTimeoutError';
  }
}

/**
 * A signal that aborts after `timeoutMs`, or as soon as `signal` does. The
 * timer is a plain timeout so it can be cleared the moment the transfer ends
 * (a pending timer keeps a Durable Object resident).
 */
export function boundedSignal(
  timeoutMs: number,
  signal?: AbortSignal,
): BoundedSignal {
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort(signal?.reason);
  const timer = setTimeout(
    () => controller.abort(new MediaDownloadTimeoutError(timeoutMs)),
    timeoutMs,
  );
  const clear = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  };
  if (signal?.aborted) {
    clear();
    controller.abort(signal.reason);
  } else signal?.addEventListener('abort', onCallerAbort, { once: true });
  controller.signal.addEventListener('abort', clear, { once: true });
  return { signal: controller.signal, clear };
}

/** The signal's reason as an Error (a `DOMException` reason already is one). */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Settle with `work`, or reject with the signal's reason when it aborts
 * first. A result that arrives after the abort is handed to `discard` so a
 * stream opened too late is still released.
 */
export function raceSignal<T>(
  work: Promise<T>,
  signal: AbortSignal,
  discard: (late: T) => void,
): Promise<T> {
  if (signal.aborted) {
    void work.then(discard, () => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void work.then(discard, () => undefined);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) discard(value);
        else resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * `source` behind the deadline: the returned stream carries the same bytes,
 * and errors with the signal's reason (the source cancelled) when the bound
 * passes before the last byte. The timer is cleared once the transfer ends
 * either way, including when the reader cancels.
 */
export function streamWithDeadline(
  source: ReadableStream<Uint8Array>,
  bound: BoundedSignal,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const reader = source.getReader();
  const stop = (reason: unknown): void => {
    void writer.abort(reason).catch(() => undefined);
    void reader.cancel(reason).catch(() => undefined);
  };
  const onAbort = (): void => stop(bound.signal.reason);
  if (bound.signal.aborted) onAbort();
  else bound.signal.addEventListener('abort', onAbort, { once: true });
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || bound.signal.aborted) break;
        await writer.write(value);
      }
      if (!bound.signal.aborted) await writer.close();
    } catch (err) {
      // The reader went away (cancelled) or the source failed: end both.
      stop(err);
    } finally {
      bound.signal.removeEventListener('abort', onAbort);
      bound.clear();
    }
  })();
  return readable;
}
