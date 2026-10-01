/**
 * @fileoverview Revocation checkers for UCAN delegations
 *
 * A UCAN revocation targets the canonical CID of one exact delegation, is
 * issued by a principal appearing as an issuer in that delegation's proof
 * chain, and is IRREVERSIBLE — revocations form a monotonically growing set.
 *
 * That monotonicity is what makes checking cheap: a "revoked" verdict is true
 * forever and can be cached permanently, so only "not revoked" verdicts need
 * re-checking, and only briefly.
 *
 * Two implementations are provided:
 * - `InMemoryRevocationStore` — a local set, for tests and single-process use.
 * - `createUcanStoreRevocationChecker` — queries an ixo-ucan-store worker.
 */

import type { RevocationChecker } from '../types.js';

/**
 * In-memory revocation store.
 *
 * Suitable for tests and for services that load a known revocation set at
 * startup. Not suitable as the authority for a distributed deployment — use
 * `createUcanStoreRevocationChecker` against a shared store for that.
 *
 * @example
 * ```typescript
 * const revocations = new InMemoryRevocationStore();
 * revocations.revoke('bafyreih...');
 *
 * const validator = await createUCANValidator({
 *   serverDid,
 *   rootIssuers: ['*'],
 *   revocationChecker: revocations,
 * });
 * ```
 */
export class InMemoryRevocationStore implements RevocationChecker {
  private readonly revoked = new Set<string>();

  constructor(revokedCids: Iterable<string> = []) {
    for (const cid of revokedCids) this.revoked.add(cid);
  }

  /** Mark a delegation CID as revoked. Irreversible by design — there is no un-revoke. */
  revoke(cid: string): void {
    this.revoked.add(cid);
  }

  async check(cids: string[]): Promise<string[]> {
    return cids.filter((cid) => this.revoked.has(cid));
  }

  get size(): number {
    return this.revoked.size;
  }
}

/**
 * Options for the ixo-ucan-store revocation checker
 */
export interface UcanStoreRevocationCheckerOptions {
  /**
   * Base URL of the ixo-ucan-store worker,
   * e.g. `https://store.ucan.ixo.earth` (mainnet).
   * A trailing slash is fine.
   */
  url: string;

  /** fetch implementation (defaults to the global fetch) */
  fetchImpl?: typeof globalThis.fetch;

  /** Per-request timeout in milliseconds (default: 1500) */
  timeoutMs?: number;

  /**
   * How long a "not revoked" verdict may be reused, in milliseconds
   * (default: 30_000). "Revoked" verdicts are cached permanently because
   * revocation is irreversible.
   */
  negativeCacheTtlMs?: number;

  /**
   * Maximum CIDs per request (default: 32, matching the store worker's cap).
   * Larger inputs are split into concurrent batches.
   */
  maxBatch?: number;

  /**
   * Soft cap on cached "not revoked" entries (default: 10_000). Exceeding it
   * clears the negative cache; the permanent revoked set is never dropped.
   */
  cacheMaxEntries?: number;
}

/**
 * Create a revocation checker backed by an ixo-ucan-store worker.
 *
 * Calls `POST {url}/api/revocations/check` with `{ cids }` and expects
 * `{ revoked: string[] }`. That endpoint is unauthenticated and does a single
 * primary-key lookup, so a check is a cheap round trip — and most checks never
 * reach the network at all thanks to the cache below.
 *
 * Caching exploits revocation monotonicity: a revoked CID stays revoked
 * forever (cached permanently, and short-circuits the request entirely), while
 * a clean CID is only trusted for `negativeCacheTtlMs`.
 *
 * Network/timeout/protocol failures THROW, so the validator applies its
 * configured `revocationFailure` policy (fail closed by default) rather than
 * silently authorizing.
 *
 * @example
 * ```typescript
 * const validator = await createUCANValidator({
 *   serverDid,
 *   rootIssuers: ['*'],
 *   revocationChecker: createUcanStoreRevocationChecker({
 *     url: 'https://store.ucan.ixo.earth',
 *   }),
 * });
 * ```
 */
export function createUcanStoreRevocationChecker(
  options: UcanStoreRevocationCheckerOptions,
): RevocationChecker {
  const endpoint = `${options.url.replace(/\/+$/, '')}/api/revocations/check`;
  const timeoutMs = options.timeoutMs ?? 1500;
  const negativeCacheTtlMs = options.negativeCacheTtlMs ?? 30_000;
  const maxBatch = Math.max(1, options.maxBatch ?? 32);
  const cacheMaxEntries = options.cacheMaxEntries ?? 10_000;

  /** Permanently revoked CIDs — safe to keep forever (revocation is irreversible). */
  const revoked = new Set<string>();
  /** CID -> timestamp until which a "not revoked" verdict may be reused. */
  const cleanUntil = new Map<string, number>();

  async function fetchRevoked(batch: string[]): Promise<string[]> {
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cids: batch }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Revocation check failed: ${response.status} ${response.statusText}`,
        );
      }

      const body: unknown = await response.json();
      if (
        typeof body !== 'object' ||
        body === null ||
        !('revoked' in body) ||
        !Array.isArray(body.revoked)
      ) {
        throw new Error(
          'Revocation check returned an unexpected response shape',
        );
      }

      return body.revoked.filter(
        (cid): cid is string => typeof cid === 'string',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async check(cids: string[]): Promise<string[]> {
      const unique = [...new Set(cids)];
      if (unique.length === 0) return [];

      // Any known-revoked CID is a permanent verdict — answer without any I/O.
      const knownRevoked = unique.filter((cid) => revoked.has(cid));
      if (knownRevoked.length > 0) return knownRevoked;

      const now = Date.now();
      const toQuery = unique.filter((cid) => {
        const until = cleanUntil.get(cid);
        if (until !== undefined && until > now) return false;
        if (until !== undefined) cleanUntil.delete(cid);
        return true;
      });
      if (toQuery.length === 0) return [];

      const batches: string[][] = [];
      for (let i = 0; i < toQuery.length; i += maxBatch) {
        batches.push(toQuery.slice(i, i + maxBatch));
      }

      const results = await Promise.all(batches.map(fetchRevoked));
      const hits = new Set(results.flat());

      for (const cid of hits) revoked.add(cid);

      if (cleanUntil.size > cacheMaxEntries) cleanUntil.clear();
      const cleanExpiry = Date.now() + negativeCacheTtlMs;
      for (const cid of toQuery) {
        if (!hits.has(cid)) cleanUntil.set(cid, cleanExpiry);
      }

      return unique.filter((cid) => hits.has(cid));
    },
  };
}
