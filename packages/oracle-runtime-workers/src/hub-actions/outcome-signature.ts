import {
  OUTCOME_SIGNATURE_HEADERS,
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

/** How long the Hub's DID document is trusted per isolate. */
export const HUB_DID_CACHE_MS = 60 * 60_000;
/** The soonest a failed signature reads the Hub's DID document again. */
export const HUB_DID_REFRESH_MIN_MS = 60_000;
/** The largest DID document read. */
const HUB_DID_MAX_BYTES = 64 * 1024;

const didDocuments = new Map<string, { document: unknown; at: number }>();
/** Tests only: forget every cached Hub DID document. */
export function resetHubDidCache(): void {
  didDocuments.clear();
}

/** The did:web DID of the Hub at `hubUrl` (https only): its key id is `#key-0`. */
export function hubDidOf(hubUrl: string): string {
  const url = new URL(hubUrl);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new TypeError('Auth Hub URL must be https');
  return `did:web:${url.port ? `${url.hostname}%3A${url.port}` : url.hostname}`;
}

async function hubDidDocument(
  hubUrl: string,
  fetcher: { fetch(request: Request): Promise<Response> } | undefined,
  now: number,
  fresh: boolean,
): Promise<{ document: unknown; at: number }> {
  const url = new URL('/.well-known/did.json', hubUrl);
  const cached = didDocuments.get(url.href);
  if (!fresh && cached && now - cached.at < HUB_DID_CACHE_MS) return cached;
  const request = new Request(url, {
    headers: { accept: 'application/did+json, application/json' },
    // workerd has no `redirect: 'error'`; a redirect is not ok below.
    redirect: 'manual',
    signal: AbortSignal.timeout(5_000),
  });
  const response = await (fetcher ? fetcher.fetch(request) : fetch(request));
  if (!response.ok)
    throw new Error(`Hub DID document returned ${response.status}`);
  const document: unknown = JSON.parse(
    new TextDecoder().decode(await boundedBytes(response, HUB_DID_MAX_BYTES)),
  );
  const entry = { document, at: now };
  didDocuments.set(url.href, entry);
  return entry;
}

/**
 * Whether `rawBody` with `headers` is a callback the configured Hub signed
 * for `audience` (this oracle's https origin) within the allowed clock skew.
 * The key comes from the Hub's DID document, cached for an hour. A Hub key
 * rotation (same `#key-0` id, new key) is picked up by reading the document
 * again when the cached key does not verify a callback that names the Hub's
 * key id, at most once per `HUB_DID_REFRESH_MIN_MS` (a stream of forged
 * callbacks cannot turn into a stream of Hub reads). Anything that fails is
 * false.
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
  let hubDid: string;
  let audience: string;
  try {
    hubDid = hubDidOf(input.hubUrl);
    audience = outcomeAudience(input.audience);
  } catch {
    return false;
  }
  const keyId = `${hubDid}#key-0`;
  if (input.headers.get(OUTCOME_SIGNATURE_HEADERS.keyId) !== keyId)
    return false;
  for (const fresh of [false, true]) {
    let entry: { document: unknown; at: number };
    let publicKey: Uint8Array;
    try {
      entry = await hubDidDocument(input.hubUrl, input.fetcher, nowMs, fresh);
      const document = entry.document;
      if (
        !document ||
        typeof document !== 'object' ||
        !('id' in document) ||
        document.id !== hubDid
      )
        throw new TypeError('Hub DID document is for another DID');
      publicKey = publicKeyFromDidDocument(document, keyId);
    } catch (error) {
      if (fresh) {
        console.warn(
          `[hub-actions] Hub DID key unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
      continue;
    }
    let verified: boolean;
    try {
      verified = await verifyOutcomeRequest({
        rawBody: input.rawBody,
        headers: input.headers,
        publicKey,
        expectedKeyId: keyId,
        expectedAudience: audience,
        now: Math.floor(nowMs / 1000),
      });
    } catch {
      // A key WebCrypto refuses to import is a failed check, not a 500.
      verified = false;
    }
    if (verified || fresh || nowMs - entry.at < HUB_DID_REFRESH_MIN_MS)
      return verified;
  }
  return false;
}
