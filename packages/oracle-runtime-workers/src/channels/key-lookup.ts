/* eslint-disable no-console -- console IS the logger on Workers (Logs/observability). */
/**
 * The DID keys a channel turn is verified against: the oracle's own DID, the
 * channel gateway's DID and the person's did:ixo, looked up over the network
 * (Blocksync for did:ixo, the host's `/.well-known/did.json` for did:web) and
 * kept per isolate.
 *
 * - Keys younger than `CHANNEL_KEY_FRESH_MS` are used without a lookup.
 * - Older keys are looked up again. When that lookup fails, the last good
 *   keys stand in for it, but only while they are younger than
 *   `CHANNEL_KEY_STALE_MAX_MS` since they were last fetched; past that, or
 *   for a DID never resolved in this isolate, the lookup failure refuses the
 *   turn as before. A successful lookup always replaces the kept keys.
 * - The oracle's own DID, needed by every turn, is refreshed in the
 *   background once its keys pass `CHANNEL_KEY_FRESH_MS`: the turn uses the
 *   kept keys instead of waiting on the refresh.
 * - A lookup with nothing to fall back on (cold isolate, or keys past the
 *   bound) gets one immediate retry when its failure can be transient
 *   (timeout, network, HTTP 5xx, GraphQL error). A definitive answer (no
 *   document, no Ed25519 key, HTTP 4xx) is not asked again.
 * - Concurrent turns share one lookup per DID.
 *
 * Every failed lookup logs one `[channels] key lookup failed` line. Signatures
 * are always verified against keys from the DID document; nothing is
 * accepted without keys.
 */
import {
  createIxoDIDResolver,
  createWebDIDResolver,
  type DIDKeyResolver,
  type KeyDID,
} from '@ixo/ucan';
import { IXO_DID_RESOLUTION_CACHE_TTL_MS } from '../shell/auth';

type ResolutionResult = Awaited<ReturnType<DIDKeyResolver>>;
type ResolutionError = Extract<ResolutionResult, { error: unknown }>['error'];

export type ChannelKeyRole = 'oracle' | 'gateway' | 'person';
export type ChannelKeySource = 'blocksync' | 'did:web';

/** Keys younger than this are used without a lookup (as the shell's did:ixo cache). */
export const CHANNEL_KEY_FRESH_MS = IXO_DID_RESOLUTION_CACHE_TTL_MS;
/**
 * The longest the last good keys of a DID may stand in for lookups that
 * fail, counted from the moment they were last fetched successfully.
 *
 * Kept keys are only used while Blocksync (or the gateway's did:web host)
 * cannot be reached or answers with an error; whenever it answers, a key
 * change is seen within `CHANNEL_KEY_FRESH_MS` as before. These keys change
 * rarely and deliberately: an oracle or a person rotates a did:ixo key with a
 * chain transaction, and a gateway rotates its did:web key with an overlap
 * (`CHANNEL_SERVICE_DID` lists both). Ten minutes rides over a Blocksync
 * restart or a short outage, while a key removed from a DID document during
 * an outage is still trusted by this isolate for at most ten minutes (one
 * minute when lookups work), the same order as a user's channel grant
 * (at most five minutes).
 */
export const CHANNEL_KEY_STALE_MAX_MS = 10 * 60_000;
/** DIDs an isolate keeps keys for; the least recently fetched makes room. */
export const CHANNEL_KEY_CACHE_MAX_ENTRIES = 1_000;

interface KeptKeys {
  keys: KeyDID[];
  /** Epoch ms of the last successful lookup. */
  fetchedAt: number;
}

const keptKeys = new Map<string, KeptKeys>();
const lookups = new Map<string, Promise<ResolutionResult>>();

/** Forget every kept key and pending lookup (tests). */
export function clearChannelKeyCache(): void {
  keptKeys.clear();
  lookups.clear();
}

export interface ChannelKeyLookup {
  did: string;
  role: ChannelKeyRole;
  source: ChannelKeySource;
  /** Separates the same DID resolved through different Blocksync URLs. */
  cacheKey: string;
  /** One uncached lookup, bounded by the resolver's own timeout. */
  resolve: DIDKeyResolver;
  /** Keeps a shared or background lookup alive past the request that started it. */
  waitUntil?: (work: Promise<unknown>) => void;
}

/**
 * The keys for `lookup.did`, from the isolate's kept keys or a lookup; an
 * error when the lookup failed and no kept keys may stand in.
 */
export async function channelDidKeys(
  lookup: ChannelKeyLookup,
): Promise<ResolutionResult> {
  const kept = keptKeys.get(lookup.cacheKey);
  const age = kept ? Date.now() - kept.fetchedAt : Infinity;
  if (kept && age < CHANNEL_KEY_FRESH_MS) return { ok: [...kept.keys] };
  if (kept && lookup.role === 'oracle' && age < CHANNEL_KEY_STALE_MAX_MS) {
    void sharedLookup(lookup);
    return { ok: [...kept.keys] };
  }
  return sharedLookup(lookup);
}

function sharedLookup(lookup: ChannelKeyLookup): Promise<ResolutionResult> {
  const pending = lookups.get(lookup.cacheKey);
  if (pending) return pending.then(copyKeys);
  const started = lookupWithFallback(lookup).finally(() =>
    lookups.delete(lookup.cacheKey),
  );
  lookups.set(lookup.cacheKey, started);
  lookup.waitUntil?.(started);
  return started.then(copyKeys);
}

function copyKeys(result: ResolutionResult): ResolutionResult {
  return 'ok' in result ? { ok: [...result.ok] } : result;
}

/** Kept keys still young enough to stand in for a failed lookup. */
function fallbackKeys(cacheKey: string, now: number): KeptKeys | undefined {
  const kept = keptKeys.get(cacheKey);
  return kept && now - kept.fetchedAt < CHANNEL_KEY_STALE_MAX_MS
    ? kept
    : undefined;
}

async function lookupWithFallback(
  lookup: ChannelKeyLookup,
): Promise<ResolutionResult> {
  const started = Date.now();
  let attempts = 1;
  let result = await attempt(lookup);
  const firstFailure = 'error' in result ? failureKind(result.error) : null;
  if (
    firstFailure &&
    retryable(firstFailure) &&
    !fallbackKeys(lookup.cacheKey, Date.now())
  ) {
    attempts = 2;
    result = await attempt(lookup);
  }
  const now = Date.now();
  if ('ok' in result) {
    keptKeys.delete(lookup.cacheKey);
    if (keptKeys.size >= CHANNEL_KEY_CACHE_MAX_ENTRIES) {
      const oldest = keptKeys.keys().next();
      if (!oldest.done) keptKeys.delete(oldest.value);
    }
    keptKeys.set(lookup.cacheKey, { keys: result.ok, fetchedAt: now });
    if (firstFailure)
      logFailure(lookup, {
        failure: firstFailure,
        attempts,
        elapsedMs: now - started,
        recovered: true,
      });
    return result;
  }
  const fallback = fallbackKeys(lookup.cacheKey, now);
  logFailure(lookup, {
    failure: failureKind(result.error),
    attempts,
    elapsedMs: now - started,
    recovered: false,
    ...(fallback ? { staleAgeMs: now - fallback.fetchedAt } : {}),
  });
  return fallback ? { ok: fallback.keys } : result;
}

/** One lookup; an empty key list counts as a failure. */
async function attempt(lookup: ChannelKeyLookup): Promise<ResolutionResult> {
  const result = await lookup.resolve(lookup.did as `did:${string}:${string}`);
  if ('ok' in result && result.ok.length === 0)
    return {
      error: {
        name: 'DIDKeyResolutionError',
        did: lookup.did,
        message: `No valid Ed25519 verification methods found in DID document for ${lookup.did}`,
      },
    };
  return result;
}

/**
 * The failure's kind, read from the resolver's error text (`@ixo/ucan`
 * reports every failure as a `DIDKeyResolutionError` message).
 */
export function failureKind(error: ResolutionError): string {
  const status = /HTTP (\d{3})/.exec(error.message)?.[1];
  if (status) return `http_${status}`;
  if (/timeout|timed out/i.test(error.message)) return 'timeout';
  if (/No (valid|usable) Ed25519/i.test(error.message)) return 'no_keys';
  if (/not found/i.test(error.message)) return 'not_found';
  if (/GraphQL error/.test(error.message)) return 'graphql';
  if (/not a did:/.test(error.message)) return 'unsupported';
  return 'network';
}

/** A failure another attempt may not repeat. */
function retryable(kind: string): boolean {
  if (kind === 'no_keys' || kind === 'not_found' || kind === 'unsupported')
    return false;
  if (kind.startsWith('http_')) return kind.startsWith('http_5');
  return true;
}

/** `did:ixo:ixo1abcdef…wxyz`: enough to tell DIDs apart in a log. */
export function shortDid(did: string): string {
  return did.length <= 28 ? did : `${did.slice(0, 18)}…${did.slice(-6)}`;
}

function logFailure(
  lookup: ChannelKeyLookup,
  outcome: {
    failure: string;
    attempts: number;
    elapsedMs: number;
    recovered: boolean;
    staleAgeMs?: number;
  },
): void {
  const stale = !outcome.recovered && outcome.staleAgeMs !== undefined;
  console.warn(
    `[channels] key lookup failed ${JSON.stringify({
      role: lookup.role,
      did: shortDid(lookup.did),
      source: lookup.source,
      failure: outcome.failure,
      attempts: outcome.attempts,
      elapsedMs: outcome.elapsedMs,
      recoveredOnRetry: outcome.recovered,
      staleKeysUsed: stale,
      ...(stale ? { staleAgeMs: outcome.staleAgeMs } : {}),
      turnRefused: !outcome.recovered && !stale,
    })}`,
  );
}

/** Uncached resolvers: `channelDidKeys` keeps the keys. */
const webResolver = createWebDIDResolver();
const ixoResolvers = new Map<string, DIDKeyResolver>();

/** The uncached lookup and cache key for one DID. */
export function channelKeySource(
  did: string,
  blocksyncUrl: string,
): Pick<ChannelKeyLookup, 'source' | 'cacheKey' | 'resolve'> {
  if (did.startsWith('did:web:'))
    return { source: 'did:web', cacheKey: did, resolve: webResolver };
  let resolve = ixoResolvers.get(blocksyncUrl);
  if (!resolve) {
    // A deployment uses one Blocksync URL; tests may use several.
    if (ixoResolvers.size >= 8) ixoResolvers.clear();
    resolve = createIxoDIDResolver({ indexerUrl: blocksyncUrl });
    ixoResolvers.set(blocksyncUrl, resolve);
  }
  return {
    source: 'blocksync',
    cacheKey: `${blocksyncUrl} ${did}`,
    resolve,
  };
}
