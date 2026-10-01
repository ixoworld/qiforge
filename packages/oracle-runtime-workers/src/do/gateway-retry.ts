/**
 * Retry a gateway RPC across a gateway restart.
 *
 * The Matrix gateway object is replaced on every deploy and can be evicted;
 * an RPC issued in that window fails with a transport error ("Network
 * connection lost", "Durable Object reset", …) rather than a Matrix error.
 * Waited sends that must not be replayed blindly (the session marker: its
 * event id becomes the session id) instead retry the SAME transaction id a
 * few times over ~10 s, so the homeserver deduplicates a send whose response
 * was lost and a restart never produces a second marker.
 */

export const GATEWAY_RETRY_DELAYS_MS: readonly number[] = [
  // Must outlast a gateway restart or idle recycle: the SDK's stop, alarm
  // re-arm and boot take a few seconds normally, longer on a cold start.
  500, 1000, 2000, 4000, 8000, 8000, 8000,
];

const TRANSIENT_PATTERNS = [
  /network connection lost/i,
  /durable object (reset|storage operation exceeded|has been)/i,
  /object (was|has been) (reset|evicted)/i,
  /internal error in durable object/i,
  /not (yet )?started/i,
  /client is not running/i,
  /matrix client.*(stopped|not ready|not started)/i,
  /timed out waiting for the matrix client/i,
  /failed to fetch/i,
  /econnreset|econnrefused|socket hang up/i,
  // `ctx.abort(reason)` surfaces the reason to in-flight RPC callers.
  /gateway reset/i,
  /planned recycle/i,
  /\babort(ed)?\b/i,
  // matrix-js-sdk's wording while the bot stops or recycles.
  /shutting down/i,
  /OutgoingRequestsManager was stopped/i,
  /null pointer passed to rust/i,
  // A retry that raced the stopping client's pending list (see startedClient).
  /known txnId/i,
];

export function isTransientGatewayError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

export interface RetryGatewayOptions {
  delaysMs?: readonly number[];
  isTransient?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Run `fn`, retrying transient gateway failures with the given delays. */
export async function retryGateway<T>(
  fn: () => Promise<T>,
  opts: RetryGatewayOptions = {},
): Promise<T> {
  const delays = opts.delaysMs ?? GATEWAY_RETRY_DELAYS_MS;
  const isTransient = opts.isTransient ?? isTransientGatewayError;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const delay = delays[attempt];
      if (delay === undefined || !isTransient(err)) throw err;
      opts.onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
    }
  }
}
