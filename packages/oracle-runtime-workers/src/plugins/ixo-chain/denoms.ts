/**
 * How a bank denom is shown. DenomMetadata is trusted for any denom: on
 * the IXO chain it is written only by chain code (liquidstake pools, which
 * governance creates; the IBC transfer module; genesis and upgrades), never
 * by a token's issuer (the chain has no tokenfactory module). This is
 * broader than the Auth Hub's rule (ixo-auth-worker
 * `src/lib/actions/denom-display.ts`), which reads metadata only for
 * `ibc/…`, so the Hub may still show a native token such as `upay` as
 * unverified.
 *
 * - `uixo`: always IXO with 6 decimals, verified, no lookup.
 * - any other denom with metadata whose `display` unit is listed in
 *   `denom_units` with an exponent of 0–18: verified, those decimals, the
 *   metadata `symbol` (or, when that is empty, the display unit
 *   upper-cased: `uatom` → `ATOM`) if it is plain ASCII.
 * - anything else (no metadata, a display unit not listed — the shape IBC
 *   transfers register — or a malformed denom, which is never looked up):
 *   unverified, base units (0 decimals), the full denom as its symbol.
 *
 * A denom whose metadata could not be read (a transport failure, or no
 * budget left to ask) is shown the same way with `metadataUnavailable`:
 * it may still be verified.
 */
import { z } from 'zod';
import { MIN_ATTEMPT_MS, throwIfAborted, type ChainCall } from './http';
import { restJson } from './rest';

export type DenomMetadataView = { symbol: string; decimals: number } | null;
export type TokenDisplay = {
  symbol: string;
  decimals: number;
  verified: boolean;
  metadataUnavailable?: true;
};

/** Symbols an unverified denom may never use (compared case-insensitively). */
const RESERVED_SYMBOLS = ['IXO', 'USDC', 'USDT', 'ATOM', 'OSMO'] as const;
/** The Cosmos SDK bank denom pattern: only such a denom is looked up. */
const DENOM = /^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/;
// Plain ASCII only: no spaces or look-alike Unicode letters ("UЅDC").
const SAFE_SYMBOL = /^[A-Za-z0-9._-]{1,32}$/;

export function trustedDenomDisplay(
  denom: string,
  metadata: DenomMetadataView,
): TokenDisplay {
  if (denom === 'uixo') return { symbol: 'IXO', decimals: 6, verified: true };
  const symbol =
    metadata && SAFE_SYMBOL.test(metadata.symbol) ? metadata.symbol : null;
  if (
    metadata &&
    symbol &&
    DENOM.test(denom) &&
    Number.isInteger(metadata.decimals) &&
    metadata.decimals >= 0 &&
    metadata.decimals <= 18
  )
    return { symbol, decimals: metadata.decimals, verified: true };
  const reserved =
    symbol !== null &&
    (RESERVED_SYMBOLS as readonly string[]).includes(symbol.toUpperCase());
  return {
    symbol: symbol && !reserved ? symbol : denom,
    decimals: 0,
    verified: false,
  };
}

/** Base units as a decimal string: `("9000000", 6)` → `"9"`, `("1234567", 6)` → `"1.234567"`. */
export function formatUnits(amount: string, decimals: number): string {
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Per isolate: found metadata is reused for 10 min, a definite miss (404,
 * or no display unit) for 60 s, a failed read for 10 s — a failure is
 * never kept as a miss, so it cannot leave a real token unverified.
 */
export const METADATA_TTL_MS = 600_000;
export const METADATA_NOT_FOUND_TTL_MS = 60_000;
export const METADATA_FAILED_TTL_MS = 10_000;
const CACHE_LIMIT = 256;

/** A metadata read: its view (null for a miss), or why there is none. */
type Lookup = { metadata: DenomMetadataView } | 'failed' | 'aborted';

const metadataCache = new Map<string, { lookup: Lookup; expiresAt: number }>();
/** Reads in flight, shared by every call of the isolate that needs the same denom. */
const inflight = new Map<string, Promise<Lookup>>();

/** Tests only: forget every cached metadata answer. */
export function resetDenomMetadataCache(): void {
  metadataCache.clear();
  inflight.clear();
}

const metadataResponse = z.object({
  metadata: z.object({
    denom_units: z.array(
      z.object({ denom: z.string(), exponent: z.number().int() }),
    ),
    display: z.string(),
    symbol: z.string(),
  }),
});

/**
 * One DenomMetadata read. The by-query-string route is used because the
 * path route cannot carry the slash in `ibc/…` (the gateway answers 501).
 * A 404 is a miss; any other failure is `failed`; the launching turn's
 * abort is `aborted` (never cached), so a call sharing the read is not
 * failed by another turn's abort.
 */
async function readMetadata(call: ChainCall, denom: string): Promise<Lookup> {
  let read;
  try {
    read = await restJson(
      call,
      `/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=${encodeURIComponent(denom)}`,
      metadataResponse,
      { label: 'denom metadata', maxBytes: 64 * 1024, notFoundOn404: true },
    );
  } catch (error) {
    if (call.signal.aborted) return 'aborted';
    throw error;
  }
  if (!read.ok)
    return read.failure.reason === 'not_found' ? { metadata: null } : 'failed';
  const { metadata } = read.value;
  const unit = metadata.denom_units.find((u) => u.denom === metadata.display);
  return {
    metadata:
      unit && unit.exponent >= 0 && unit.exponent <= 18
        ? {
            symbol: metadata.symbol || metadata.display.toUpperCase(),
            decimals: unit.exponent,
          }
        : null,
  };
}

function remember(key: string, lookup: Lookup): void {
  if (lookup === 'aborted') return;
  const ttl =
    lookup === 'failed'
      ? METADATA_FAILED_TTL_MS
      : lookup.metadata
        ? METADATA_TTL_MS
        : METADATA_NOT_FOUND_TTL_MS;
  if (metadataCache.size > CACHE_LIMIT) metadataCache.clear();
  metadataCache.set(key, { lookup, expiresAt: Date.now() + ttl });
}

/** The cached lookup, the read in flight, or a new read; `failed` without a read once the budget is spent. */
function lookupOf(call: ChainCall, denom: string): Promise<Lookup> {
  const key = `${call.restUrl}|${denom}`;
  const hit = metadataCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.lookup);
  const running = inflight.get(key);
  if (running) return running;
  if (call.deadline - Date.now() < MIN_ATTEMPT_MS)
    return Promise.resolve('failed');
  const read = readMetadata(call, denom)
    .then((lookup) => {
      remember(key, lookup);
      return lookup;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, read);
  return read;
}

/** The display of `denom`, reading its DenomMetadata for every denom but `uixo`. */
export async function denomDisplay(
  call: ChainCall,
  denom: string,
): Promise<TokenDisplay> {
  if (denom === 'uixo' || !DENOM.test(denom))
    return trustedDenomDisplay(denom, null);
  const lookup = await lookupOf(call, denom);
  throwIfAborted(call.signal);
  return lookup === 'failed' || lookup === 'aborted'
    ? { ...trustedDenomDisplay(denom, null), metadataUnavailable: true }
    : trustedDenomDisplay(denom, lookup.metadata);
}
