/**
 * @fileoverview did:web resolver for UCAN validation
 *
 * Resolves did:web identifiers by fetching the DID document from
 * the well-known endpoint as defined in the did:web specification.
 *
 * @see https://w3c-ccg.github.io/did-method-web/
 */

import type { DID } from '@ucanto/interface';
import type { DIDKeyResolver, KeyDID } from '../types.js';
import { ed25519MultibaseToDidKey } from './utils.js';
import {
  boundedResolution,
  DEFAULT_RESOLUTION_CACHE_MAX_ENTRIES,
  DEFAULT_RESOLUTION_TIMEOUT_MS,
  type ResolutionResult,
} from './bounded-resolution.js';

export interface WebDIDResolverConfig {
  fetch?: typeof globalThis.fetch;
  /** If true, retry with http:// when https:// fetch fails. Default: false. */
  fallbackToHttp?: boolean;
  /**
   * Upper bound for one resolution (every request it makes and the response
   * body), in milliseconds. The requests are aborted and the resolution
   * fails with a `DIDKeyResolutionError` once it elapses, also when a custom
   * `fetch` ignores the signal.
   * @default 3000
   */
  timeoutMs?: number;
  /**
   * Cache successful resolutions for this many milliseconds (0 = no cache).
   * Failures are never cached. Concurrent resolutions of one DID share a
   * single lookup while the cache is on. A key that is rotated out of or
   * removed from the DID document stays trusted for up to this long.
   * @default 0
   */
  cacheTtlMs?: number;
  /**
   * Maximum number of DIDs kept in the cache; the oldest entry is dropped
   * when a new one would exceed it.
   * @default 1000
   */
  cacheMaxEntries?: number;
}

interface VerificationMethod {
  id: string;
  type: string;
  publicKeyMultibase?: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * True when the decoded did:web domain is exactly `localhost`, `127.0.0.1`
 * or `[::1]`, optionally followed by `:<port>`.
 */
function isLoopbackHost(domain: string): boolean {
  let host = domain;
  let port = '';
  if (domain.startsWith('[')) {
    const close = domain.indexOf(']');
    if (close === -1) return false;
    host = domain.slice(0, close + 1);
    const rest = domain.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(':')) return false;
      port = rest.slice(1);
      if (!port) return false;
    }
  } else {
    const colon = domain.indexOf(':');
    if (colon !== -1) {
      host = domain.slice(0, colon);
      port = domain.slice(colon + 1);
      if (!port) return false;
    }
  }
  if (port && !/^\d{1,5}$/.test(port)) return false;
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Creates a DID resolver for did:web identifiers
 *
 * Fetches the DID document from `https://{domain}/.well-known/did.json`
 * (or `https://{domain}/{path}/did.json` for path-based did:web DIDs)
 * and extracts Ed25519 verification methods as did:key identifiers.
 *
 * @example
 * ```typescript
 * const resolver = createWebDIDResolver();
 * const result = await resolver('did:web:sandbox.ixo.world');
 * if ('ok' in result) {
 *   console.log('Keys:', result.ok); // ['did:key:z6Mk...']
 * }
 * ```
 */
export function createWebDIDResolver(
  config?: WebDIDResolverConfig,
): DIDKeyResolver {
  const resolve = boundedResolution(
    {
      timeoutMs: config?.timeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS,
      cacheTtlMs: config?.cacheTtlMs ?? 0,
      cacheMaxEntries:
        config?.cacheMaxEntries ?? DEFAULT_RESOLUTION_CACHE_MAX_ENTRIES,
    },
    // The global fetch is read per lookup, so a resolver built at module
    // load uses whatever fetch the environment provides when it runs.
    (did, signal) =>
      fetchDidWebKeys(config?.fetch ?? globalThis.fetch, config, did, signal),
  );

  return async (did: DID): Promise<ResolutionResult> => {
    if (!did.startsWith('did:web:')) {
      return {
        error: {
          name: 'DIDKeyResolutionError',
          did,
          message: `Cannot resolve ${did}: not a did:web identifier`,
        },
      };
    }
    return resolve(did);
  };
}

/**
 * Fetch a did:web document and extract its Ed25519 keys. Network and parse
 * failures throw; the caller turns them into a `DIDKeyResolutionError`.
 */
async function fetchDidWebKeys(
  fetchFn: typeof globalThis.fetch,
  config: WebDIDResolverConfig | undefined,
  did: DID,
  signal: AbortSignal,
): Promise<ResolutionResult> {
  // did:web:example.com → https://example.com/.well-known/did.json
  // did:web:example.com:path:to → https://example.com/path/to/did.json
  const parts = did.slice('did:web:'.length).split(':');
  const domain = decodeURIComponent(parts[0]!);
  const pathSegments = parts.slice(1).map(decodeURIComponent);

  const path =
    pathSegments.length > 0
      ? `/${pathSegments.join('/')}/did.json`
      : '/.well-known/did.json';

  // Use HTTP directly for a loopback host (no TLS available, avoids ~15s
  // connection timeout). Every other host, including look-alikes such as
  // `localhost.example.com`, is fetched over HTTPS.
  const isLocalhost = isLoopbackHost(domain);
  const httpsUrl = `https://${domain}${path}`;
  const httpUrl = `http://${domain}${path}`;

  let response: Response | null = null;
  let fetchUrl = isLocalhost ? httpUrl : httpsUrl;

  try {
    response = await fetchFn(fetchUrl, { signal });
  } catch (fetchError) {
    if (!isLocalhost && config?.fallbackToHttp) {
      fetchUrl = httpUrl;
      response = await fetchFn(fetchUrl, { signal });
    } else {
      throw fetchError;
    }
  }

  if (
    !response.ok &&
    !isLocalhost &&
    config?.fallbackToHttp &&
    fetchUrl === httpsUrl
  ) {
    // HTTPS returned a non-ok status, try HTTP
    fetchUrl = httpUrl;
    response = await fetchFn(fetchUrl, { signal });
  }

  if (!response.ok) {
    return {
      error: {
        name: 'DIDKeyResolutionError',
        did,
        message: `Failed to fetch DID document from ${fetchUrl}: HTTP ${response.status}`,
      },
    };
  }

  const doc = (await response.json()) as {
    verificationMethod?: VerificationMethod[];
  };

  const keys: KeyDID[] = [];
  for (const vm of doc.verificationMethod ?? []) {
    if (vm.type.includes('Ed25519') && vm.publicKeyMultibase) {
      const didKey = ed25519MultibaseToDidKey(vm.publicKeyMultibase);
      if (didKey) keys.push(didKey);
    }
  }

  if (keys.length === 0) {
    return {
      error: {
        name: 'DIDKeyResolutionError',
        did,
        message: `No valid Ed25519 verification methods found in DID document for ${did}`,
      },
    };
  }

  return { ok: keys };
}
