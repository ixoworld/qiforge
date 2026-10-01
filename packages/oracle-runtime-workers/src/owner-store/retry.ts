/**
 * Bounded retry with fixed backoff for owner-store requests. A flush that
 * still fails after these attempts is left for the next alarm tick — the
 * working copy stays dirty, nothing is lost.
 */

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 5_000, 15_000,
];

export interface RetryOptions {
  /** Delay before retry n (length = number of retries). */
  delaysMs?: readonly number[];
  isRetryable: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(
  op: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await op(attempt);
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !options.isRetryable(error)) throw error;
      options.onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
    }
  }
}

/** Network-level failures (`fetch` rejections, aborts) are always retryable. */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  // workerd/undici surface connection failures as TypeError('fetch failed' | 'Network connection lost' | ...).
  return error.name === 'TypeError';
}
