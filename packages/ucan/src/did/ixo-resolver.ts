/* eslint-disable no-console */
/**
 * @fileoverview did:ixo resolver for UCAN validation
 *
 * This module provides a DID resolver that can resolve did:ixo identifiers
 * to their associated did:key identifiers by querying the IXO blockchain
 * indexer for the DID document.
 */

import type { DID } from '@ucanto/interface';
import type { DIDKeyResolver, KeyDID } from '../types.js';
import {
  base58Encode,
  hexDecode,
  base58Decode,
  ed25519MultibaseToDidKey,
} from './utils.js';
import {
  boundedResolution,
  DEFAULT_RESOLUTION_CACHE_MAX_ENTRIES,
  DEFAULT_RESOLUTION_TIMEOUT_MS,
  type ResolutionResult,
} from './bounded-resolution.js';

/**
 * Configuration for the IXO DID resolver
 */
export interface IxoDIDResolverConfig {
  /**
   * URL of the IXO GraphQL indexer
   * @example 'https://blocksync.ixo.earth/graphql'
   */
  indexerUrl: string;

  /**
   * Optional fetch implementation (for testing or custom environments)
   */
  fetch?: typeof globalThis.fetch;

  /**
   * Upper bound for one resolution (request and response body), in
   * milliseconds. The request is aborted with `AbortSignal.timeout()` and
   * the resolution fails with a `DIDKeyResolutionError` once it elapses,
   * also when a custom `fetch` ignores the signal.
   * @default 3000
   */
  timeoutMs?: number;

  /**
   * Cache successful resolutions for this many milliseconds (0 = no cache).
   * Failures are never cached. Concurrent resolutions of one DID share a
   * single request while the cache is on. A key that is rotated out of or
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

/** Default upper bound for one did:ixo resolution. */
export const DEFAULT_IXO_RESOLVER_TIMEOUT_MS = DEFAULT_RESOLUTION_TIMEOUT_MS;

/** Default size bound of the did:ixo resolution cache. */
export const DEFAULT_IXO_RESOLVER_CACHE_MAX_ENTRIES =
  DEFAULT_RESOLUTION_CACHE_MAX_ENTRIES;

/**
 * GraphQL query to fetch DID document from IXO indexer
 */
const DID_DOCUMENT_QUERY = `
  query GetDIDDocument($id: String!) {
    iids(filter: { id: { equalTo: $id } }) {
      nodes {
        id
        verificationMethod
      }
    }
  }
`;

/**
 * Verification method from IXO DID document
 */
interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase?: string;
  publicKeyHex?: string;
  publicKeyBase58?: string;
}

/**
 * IXO DID document structure (partial)
 */
interface IxoDIDDocument {
  id: string;
  verificationMethod: VerificationMethod[];
}

// =============================================================================
// did:key Conversion
// =============================================================================

/**
 * Ed25519 multicodec prefix (0xed)
 * When creating a did:key, we prepend this to the raw public key
 */
const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

/**
 * Convert raw Ed25519 public key bytes to did:key format
 *
 * did:key format for Ed25519:
 * - Prefix with multicodec 0xed01
 * - Encode with base58btc (multibase 'z' prefix)
 * - Result: did:key:z6Mk...
 */
function rawPublicKeyToDidKey(publicKeyBytes: Uint8Array): KeyDID | null {
  // Ed25519 public keys should be 32 bytes
  if (publicKeyBytes.length !== 32) {
    console.warn(
      `[IxoDIDResolver] Expected 32-byte Ed25519 key, got ${publicKeyBytes.length} bytes`,
    );
    return null;
  }

  // Prepend the Ed25519 multicodec prefix
  const prefixedKey = new Uint8Array(
    ED25519_MULTICODEC_PREFIX.length + publicKeyBytes.length,
  );
  prefixedKey.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixedKey.set(publicKeyBytes, ED25519_MULTICODEC_PREFIX.length);

  // Encode with base58btc and add 'z' multibase prefix
  const multibaseEncoded = 'z' + base58Encode(prefixedKey);

  return `did:key:${multibaseEncoded}`;
}

/**
 * Convert a public key to did:key format
 * Supports Ed25519 keys in multibase, hex, or base58 format
 */
function publicKeyToDidKey(vm: VerificationMethod): KeyDID | null {
  // Handle multibase format (preferred). Only an Ed25519 multicodec key
  // (base58btc 'z' + 0xed01 + 32 bytes) is already in did:key form.
  if (vm.publicKeyMultibase) {
    const didKey = ed25519MultibaseToDidKey(vm.publicKeyMultibase);
    if (!didKey) {
      console.warn(
        `[IxoDIDResolver] Skipping ${vm.id}: publicKeyMultibase is not an Ed25519 multicodec key`,
      );
    }
    return didKey;
  }

  // Handle hex format
  if (vm.publicKeyHex) {
    try {
      const publicKeyBytes = hexDecode(vm.publicKeyHex);
      const didKey = rawPublicKeyToDidKey(publicKeyBytes);
      return didKey;
    } catch (error) {
      console.warn(
        `[IxoDIDResolver] Failed to decode publicKeyHex for ${vm.id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
  }

  // Handle base58 format
  if (vm.publicKeyBase58) {
    try {
      const publicKeyBytes = base58Decode(vm.publicKeyBase58);
      const didKey = rawPublicKeyToDidKey(publicKeyBytes);
      return didKey;
    } catch (error) {
      console.warn(
        `[IxoDIDResolver] Failed to decode publicKeyBase58 for ${vm.id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
  }

  return null;
}

/**
 * Creates a DID resolver for did:ixo identifiers
 *
 * This resolver queries the IXO blockchain indexer to fetch DID documents
 * and extracts the verification methods that can be used to verify signatures.
 *
 * @param config - Configuration for the resolver
 * @returns A DIDKeyResolver function compatible with ucanto
 *
 * @example
 * ```typescript
 * const resolver = createIxoDIDResolver({
 *   indexerUrl: 'https://blocksync.ixo.earth/graphql'
 * });
 *
 * const result = await resolver('did:ixo:abc123');
 * if (result.ok) {
 *   console.log('Keys:', result.ok); // ['did:key:z6Mk...']
 * }
 * ```
 */
export function createIxoDIDResolver(
  config: IxoDIDResolverConfig,
): DIDKeyResolver {
  const resolve = boundedResolution(
    {
      timeoutMs: config.timeoutMs ?? DEFAULT_IXO_RESOLVER_TIMEOUT_MS,
      cacheTtlMs: config.cacheTtlMs ?? 0,
      cacheMaxEntries:
        config.cacheMaxEntries ?? DEFAULT_IXO_RESOLVER_CACHE_MAX_ENTRIES,
    },
    // The global fetch is read per lookup, so a resolver built at module
    // load uses whatever fetch the environment provides when it runs.
    (did, signal) =>
      queryDidDocument(
        config.fetch ?? globalThis.fetch,
        config.indexerUrl,
        did,
        signal,
      ),
  );

  return async (did: DID): Promise<ResolutionResult> => {
    // Only handle did:ixo
    if (!did.startsWith('did:ixo:')) {
      return {
        error: {
          name: 'DIDKeyResolutionError',
          did,
          message: `Cannot resolve ${did}: not a did:ixo identifier`,
        },
      };
    }
    return resolve(did);
  };
}

/**
 * Fetch a did:ixo document from the indexer and extract its Ed25519 keys.
 */
async function queryDidDocument(
  fetchFn: typeof globalThis.fetch,
  indexerUrl: string,
  did: DID,
  signal: AbortSignal,
): Promise<ResolutionResult> {
  // Query the IXO indexer
  const response = await fetchFn(indexerUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: DID_DOCUMENT_QUERY,
      variables: { id: did },
    }),
    signal,
  });

  if (!response.ok) {
    return {
      error: {
        name: 'DIDKeyResolutionError',
        did,
        message: `Failed to fetch DID document: HTTP ${response.status}`,
      },
    };
  }

  const data = (await response.json()) as {
    data?: { iids?: { nodes?: IxoDIDDocument[] } };
    errors?: Array<{ message: string }>;
  };

  if (data.errors && data.errors.length > 0) {
    return {
      error: {
        name: 'DIDKeyResolutionError',
        did,
        message: `GraphQL error: ${data.errors[0]?.message ?? 'Unknown error'}`,
      },
    };
  }

  const didDoc = data.data?.iids?.nodes?.[0];
  if (!didDoc) {
    return {
      error: {
        name: 'DIDKeyResolutionError',
        did,
        message: `DID document not found for ${did}`,
      },
    };
  }

  // Extract verification methods and convert to did:key
  const keys: KeyDID[] = [];

  for (const vm of didDoc.verificationMethod || []) {
    // Look for Ed25519 verification methods
    // Common types: Ed25519VerificationKey2018, Ed25519VerificationKey2020, JsonWebKey2020
    if (
      vm.type.includes('Ed25519') ||
      vm.type === 'JsonWebKey2020' ||
      vm.id.includes('signing')
    ) {
      const keyDid = publicKeyToDidKey(vm);
      if (keyDid) {
        keys.push(keyDid);
      }
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

/**
 * Creates a composite DID resolver that tries multiple resolvers in order
 *
 * @param resolvers - Array of DID resolvers to try
 * @returns A DIDKeyResolver that tries each resolver until one succeeds
 */
export function createCompositeDIDResolver(
  resolvers: DIDKeyResolver[],
): DIDKeyResolver {
  return async (did: DID) => {
    for (const resolver of resolvers) {
      const result = await resolver(did);
      if ('ok' in result) {
        return result;
      }
      // If this resolver doesn't handle this DID method, try the next one
      if (result.error.message.includes('not a did:')) {
        continue;
      }
      // If it's a different error, return it
      return result;
    }

    return {
      error: {
        name: 'DIDKeyResolutionError',
        did,
        message: `No resolver could handle ${did}`,
      },
    };
  };
}

// TODO: Add support for resolving from local DID document store
