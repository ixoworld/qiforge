/**
 * Deadlines for the gateway's media event lookups (`eventMediaInfo`). A
 * homeserver that never answers would otherwise keep the asking side — a
 * user object assembling an attachment for a turn — waiting for as long as
 * the connection stays open. When the bound passes (or the caller's own
 * signal aborts), the lookup rejects with the reason.
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
