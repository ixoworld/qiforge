/**
 * @fileoverview Timeout and success-only cache shared by the network DID
 * resolvers (did:ixo, did:web).
 */

import type { DID } from '@ucanto/interface';
import type { KeyDID } from '../types.js';

export type ResolutionResult =
  | { ok: KeyDID[] }
  | { error: { name: string; did: string; message: string } };

export interface ResolutionBounds {
  /** Upper bound for one resolution, in milliseconds. */
  timeoutMs: number;
  /** Cache successful resolutions this long (0 = no cache). */
  cacheTtlMs: number;
  /** Maximum number of cached DIDs. */
  cacheMaxEntries: number;
}

/** Default upper bound for one network DID resolution. */
export const DEFAULT_RESOLUTION_TIMEOUT_MS = 3_000;

/** Default size bound of a resolution cache. */
export const DEFAULT_RESOLUTION_CACHE_MAX_ENTRIES = 1_000;

/**
 * Throws a RangeError when a bound is out of range: `timeoutMs` must be a
 * positive finite number, `cacheTtlMs` a finite number >= 0 and
 * `cacheMaxEntries` a positive integer.
 */
function assertBounds(bounds: ResolutionBounds): void {
  if (!Number.isFinite(bounds.timeoutMs) || bounds.timeoutMs <= 0) {
    throw new RangeError(
      `timeoutMs must be a positive finite number, got ${String(bounds.timeoutMs)}`,
    );
  }
  if (!Number.isFinite(bounds.cacheTtlMs) || bounds.cacheTtlMs < 0) {
    throw new RangeError(
      `cacheTtlMs must be a finite number >= 0, got ${String(bounds.cacheTtlMs)}`,
    );
  }
  if (!Number.isInteger(bounds.cacheMaxEntries) || bounds.cacheMaxEntries < 1) {
    throw new RangeError(
      `cacheMaxEntries must be a positive integer, got ${String(bounds.cacheMaxEntries)}`,
    );
  }
}

/**
 * Wrap a key lookup with a timeout and an optional cache.
 *
 * `lookup` receives an AbortSignal that fires after `timeoutMs`; the
 * resolution also fails at that moment when `lookup` ignores the signal.
 * With `cacheTtlMs > 0`, successful results are cached per DID for that long
 * (bounded by `cacheMaxEntries`, oldest dropped first) and concurrent
 * resolutions of one DID share one lookup. Failures are never cached. Every
 * caller gets its own copy of the key list.
 */
export function boundedResolution(
  bounds: ResolutionBounds,
  lookup: (did: DID, signal: AbortSignal) => Promise<ResolutionResult>,
): (did: DID) => Promise<ResolutionResult> {
  assertBounds(bounds);
  const { timeoutMs, cacheTtlMs, cacheMaxEntries } = bounds;
  const cache = new Map<string, { keys: KeyDID[]; expiresAt: number }>();
  const inFlight = new Map<string, Promise<ResolutionResult>>();

  const resolveOnce = async (did: DID): Promise<ResolutionResult> => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      // The race settles the resolution on timeout even when a custom
      // fetch implementation ignores the signal.
      return await Promise.race([
        lookup(did, signal),
        new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            const reason: unknown = signal.reason;
            reject(
              reason instanceof Error ? reason : new Error(String(reason)),
            );
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } catch (error) {
      return {
        error: {
          name: 'DIDKeyResolutionError',
          did,
          message: `Failed to resolve ${did}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      };
    }
  };

  return async (did: DID): Promise<ResolutionResult> => {
    if (cacheTtlMs === 0) return resolveOnce(did);

    const cached = cache.get(did);
    if (cached) {
      if (cached.expiresAt > Date.now()) return { ok: [...cached.keys] };
      cache.delete(did);
    }

    let pending = inFlight.get(did);
    if (!pending) {
      pending = resolveOnce(did).then((result) => {
        inFlight.delete(did);
        if ('ok' in result) {
          cache.delete(did);
          // Map iteration follows insertion order: the first key is the
          // oldest entry.
          for (const oldest of cache.keys()) {
            if (cache.size < cacheMaxEntries) break;
            cache.delete(oldest);
          }
          cache.set(did, {
            keys: [...result.ok],
            expiresAt: Date.now() + cacheTtlMs,
          });
        }
        return result;
      });
      inFlight.set(did, pending);
    }
    const result = await pending;
    return 'ok' in result ? { ok: [...result.ok] } : result;
  };
}
