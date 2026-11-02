import {
  OUTCOME_SIGNATURE_HEADERS,
  OUTCOME_SIGNATURE_MAX_SKEW_SECONDS,
  outcomeAudience,
  publicKeyFromDidDocument,
  verifyOutcomeRequest,
} from '@ixo/action-protocol';
import { boundedBytes } from '../core/domain-context/transport';

/**
 * Signed Auth Hub outcome callbacks. The Hub signs every callback with the
 * `#key-0` Ed25519 key of its own did:web document; the key is resolved
 * from the configured `AUTH_HUB_URL` (never from the request), and the
 * signature covers this oracle's origin (the audience) so a callback
 * signed for another oracle never verifies here.
 */

/** How long a verified Hub key is trusted per isolate. */
export const HUB_DID_CACHE_MS = 60 * 60_000;
/**
 * The soonest the Hub's DID document is read again after any read, whether
 * it succeeded or failed (a Hub outage or a forged stream must not become a
 * stream of Hub reads).
 */
export const HUB_DID_REFRESH_MIN_MS = 60_000;
/** The largest DID document read. */
const HUB_DID_MAX_BYTES = 64 * 1024;

/** Keys from documents that passed the id and key checks, per document URL. */
const hubKeys = new Map<string, { publicKey: Uint8Array; at: number }>();
/** When each document URL was last read (success or failure): the negative cache. */
const lastAttemptAt = new Map<string, number>();
/** One read per document URL at a time. */
const inFlight = new Map<string, Promise<Uint8Array | null>>();

/** Tests only: forget every cached Hub key, attempt time and pending read. */
export function resetHubDidCache(): void {
  hubKeys.clear();
  lastAttemptAt.clear();
  inFlight.clear();
}

/** The did:web DID of the Hub at `hubUrl` (https only): its key id is `#key-0`. */
export function hubDidOf(hubUrl: string): string {
  const url = new URL(hubUrl);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new TypeError('Auth Hub URL must be https');
  return `did:web:${url.port ? `${url.hostname}%3A${url.port}` : url.hostname}`;
}

/**
 * The checks that need no key: the Hub's key id, a well-formed timestamp
 * within the allowed skew either way, and a signature that decodes to 64
 * bytes. A callback failing any of them never causes a Hub read.
 */
function plausibleSignatureHeaders(
  headers: Headers,
  keyId: string,
  nowSeconds: number,
): boolean {
  const timestamp = headers.get(OUTCOME_SIGNATURE_HEADERS.timestamp);
  const signature = headers.get(OUTCOME_SIGNATURE_HEADERS.signature);
  if (headers.get(OUTCOME_SIGNATURE_HEADERS.keyId) !== keyId) return false;
  if (!timestamp || !/^[1-9][0-9]{0,15}$/.test(timestamp)) return false;
  if (
    Math.abs(nowSeconds - Number(timestamp)) >
    OUTCOME_SIGNATURE_MAX_SKEW_SECONDS
  )
    return false;
  // 64 bytes in unpadded base64url is exactly 86 characters.
  if (!signature || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    const padded = signature.replace(/-/g, '+').replace(/_/g, '/');
    return atob(`${padded}==`).length === 64;
  } catch {
    return false;
  }
}

/**
 * Read the Hub's DID document and return its `#key-0` key, or null. Every
 * attempt is recorded first, so a read happens at most once per
 * `HUB_DID_REFRESH_MIN_MS` per URL whatever the outcome; concurrent callers
 * share one read; only a document that names exactly the Hub's DID and holds
 * the key is cached.
 */
function readHubKey(
  hubUrl: string,
  hubDid: string,
  keyId: string,
  fetcher: { fetch(request: Request): Promise<Response> } | undefined,
  nowMs: number,
): Promise<Uint8Array | null> {
  const url = new URL('/.well-known/did.json', hubUrl);
  const pending = inFlight.get(url.href);
  if (pending) return pending;
  const last = lastAttemptAt.get(url.href);
  if (last !== undefined && nowMs - last < HUB_DID_REFRESH_MIN_MS)
    return Promise.resolve(null);
  lastAttemptAt.set(url.href, nowMs);
  const read = (async (): Promise<Uint8Array | null> => {
    try {
      const request = new Request(url, {
        headers: { accept: 'application/did+json, application/json' },
        // workerd has no `redirect: 'error'`; a redirect is not ok below.
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      });
      const response = await (fetcher
        ? fetcher.fetch(request)
        : fetch(request));
      if (!response.ok)
        throw new Error(`Hub DID document returned ${response.status}`);
      const document: unknown = JSON.parse(
        new TextDecoder().decode(
          await boundedBytes(response, HUB_DID_MAX_BYTES),
        ),
      );
      if (
        !document ||
        typeof document !== 'object' ||
        !('id' in document) ||
        document.id !== hubDid
      )
        throw new TypeError('Hub DID document is for another DID');
      const publicKey = publicKeyFromDidDocument(document, keyId);
      hubKeys.set(url.href, { publicKey, at: nowMs });
      return publicKey;
    } catch (error) {
      console.warn(
        `[hub-actions] Hub DID key unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  })();
  inFlight.set(url.href, read);
  void read.finally(() => {
    if (inFlight.get(url.href) === read) inFlight.delete(url.href);
  });
  return read;
}

async function verifiedWith(
  publicKey: Uint8Array,
  input: { rawBody: string; headers: Headers },
  keyId: string,
  audience: string,
  nowSeconds: number,
): Promise<boolean> {
  try {
    return await verifyOutcomeRequest({
      rawBody: input.rawBody,
      headers: input.headers,
      publicKey,
      expectedKeyId: keyId,
      expectedAudience: audience,
      now: nowSeconds,
    });
  } catch {
    // A key WebCrypto refuses to import is a failed check, not a 500.
    return false;
  }
}

/**
 * Whether `rawBody` with `headers` is a callback the configured Hub signed
 * for `audience` (this oracle's https origin) within the allowed clock skew.
 * The cheap header checks run first and need no key. The key comes from the
 * Hub's DID document, trusted for `HUB_DID_CACHE_MS`. A Hub key rotation
 * (same `#key-0` id, new key) is picked up by reading the document again
 * when the cached key does not verify, subject to the same once-a-minute
 * read limit. Anything that fails is false.
 */
export async function verifyHubOutcomeCallback(input: {
  hubUrl: string;
  rawBody: string;
  headers: Headers;
  audience: string;
  fetcher?: { fetch(request: Request): Promise<Response> };
  now?: number;
}): Promise<boolean> {
  const nowMs = input.now ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  let hubDid: string;
  let audience: string;
  try {
    hubDid = hubDidOf(input.hubUrl);
    audience = outcomeAudience(input.audience);
  } catch {
    return false;
  }
  const keyId = `${hubDid}#key-0`;
  if (!plausibleSignatureHeaders(input.headers, keyId, nowSeconds))
    return false;
  const href = new URL('/.well-known/did.json', input.hubUrl).href;
  const cached = hubKeys.get(href);
  if (cached && nowMs - cached.at < HUB_DID_CACHE_MS) {
    if (
      await verifiedWith(cached.publicKey, input, keyId, audience, nowSeconds)
    )
      return true;
    const fresh = await readHubKey(
      input.hubUrl,
      hubDid,
      keyId,
      input.fetcher,
      nowMs,
    );
    return (
      !!fresh &&
      !sameBytes(fresh, cached.publicKey) &&
      verifiedWith(fresh, input, keyId, audience, nowSeconds)
    );
  }
  const key = await readHubKey(
    input.hubUrl,
    hubDid,
    keyId,
    input.fetcher,
    nowMs,
  );
  return !!key && verifiedWith(key, input, keyId, audience, nowSeconds);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
