/**
 * @fileoverview Client helpers for creating UCAN invocations and delegations
 *
 * These helpers are used by front-ends to create invocations that can be
 * sent alongside regular API requests (e.g., in the mcpInvocations field).
 *
 * Supports any DID method for audience (did:key, did:ixo, did:web, etc.)
 */

import * as Client from '@ucanto/client';
import { ed25519 } from '@ucanto/principal';
import type {
  Signer,
  Delegation,
  Capability,
  Principal,
  Fact,
} from '@ucanto/interface';
import type { SupportedDID } from '../types.js';

/**
 * Create a principal from any DID string
 *
 * For did:key - parses the key from the DID (full verification support)
 * For other DIDs - creates a simple principal that just holds the DID
 *
 * This allows delegations and invocations to be addressed to any DID method.
 */
function createPrincipal(did: string): Principal {
  // did:key can be fully parsed (contains the public key)
  if (did.startsWith('did:key:')) {
    return ed25519.Verifier.parse(did);
  }

  // For other DID methods (did:ixo, did:web, etc.), create a simple principal
  // The audience doesn't need key material - they just need to be identified
  return {
    did: () => did as `did:${string}:${string}`,
  };
}

/**
 * Generate a new Ed25519 keypair
 *
 * @returns The generated signer with its DID and private key
 *
 * @example
 * ```typescript
 * const { signer, did, privateKey } = await generateKeypair();
 * console.log('New DID:', did);
 * // Store privateKey securely for future use
 * ```
 */
export async function generateKeypair(): Promise<{
  signer: Signer;
  did: string;
  privateKey: string;
}> {
  const signer = await ed25519.Signer.generate();
  return {
    signer,
    did: signer.did(),
    privateKey: ed25519.Signer.format(signer),
  };
}

/**
 * Parse a private key into a signer
 *
 * @param privateKey - The private key (multibase encoded)
 * @param did - The DID to use for the signer (optional) will override the did:key if provided
 * @returns The signer
 */
export function parseSigner(privateKey: string, did?: SupportedDID): Signer {
  const signer = ed25519.Signer.parse(privateKey);
  if (did) {
    return signer.withDID(did);
  }
  return signer;
}

/**
 * Create a signer from a BIP39 mnemonic
 *
 * Uses the same derivation as IXO verification methods:
 * SHA256(mnemonic) → first 32 bytes as Ed25519 seed
 *
 * This ensures the derived key matches the verification method on-chain.
 *
 * @param mnemonic - BIP39 mnemonic phrase (12-24 words)
 * @param did - The DID to use for the signer (optional) will override the did:key if provided
 * @returns The signer and formatted private key
 *
 * @example
 * ```typescript
 * const { signer, did, privateKey } = await signerFromMnemonic('word1 word2 ...');
 * console.log('DID:', did);
 * console.log('Private Key (for server config):', privateKey);
 * ```
 */
export async function signerFromMnemonic(
  mnemonic: string,
  did?: SupportedDID,
): Promise<{
  signer: Signer;
  did: string;
  privateKey: string;
}> {
  // Derive the Ed25519 keypair the same way as IXO verification methods:
  // SHA256(mnemonic UTF-8 bytes) → first 32 bytes as seed → Ed25519 keypair.
  //
  // Pure JS (WebCrypto + ucanto) so it runs everywhere ucanto runs — Node,
  // browsers, and Cloudflare Workers. (The previous implementation derived the
  // keypair via @cosmjs/crypto, whose libsodium WASM loader crashes on workerd.
  // The output is byte-identical — see the golden vectors in create-client.test.ts.)
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(mnemonic.trim()),
  );
  const seed = new Uint8Array(digest).slice(0, 32);

  const signer = await ed25519.derive(seed);
  // ed25519.format → 'M' + base64pad([0x80,0x26] + seed(32) + [0xed,0x01] + pubkey(32)),
  // i.e. exactly the 68-byte ucanto private key the old code assembled by hand.
  const multibasePrivateKey = ed25519.format(signer);
  const finalSigner = did ? signer.withDID(did) : signer;

  return {
    signer: finalSigner,
    did: finalSigner.did(),
    privateKey: multibasePrivateKey,
  };
}

/**
 * Create a delegation (grant capabilities to someone)
 *
 * Supports any DID method for the audience (did:key, did:ixo, did:web, etc.)
 *
 * @param options - Delegation options
 * @returns The delegation object
 *
 * @example
 * ```typescript
 * // Delegate to a did:key
 * const delegation = await createDelegation({
 *   issuer: mySigner,
 *   audience: 'did:key:z6Mk...',
 *   capabilities: [{ can: 'employees/read', with: 'myapp:server' }],
 * });
 *
 * // Delegate to a did:ixo
 * const delegation = await createDelegation({
 *   issuer: mySigner,
 *   audience: 'did:ixo:ixo1abc...',
 *   capabilities: [{ can: 'employees/read', with: 'myapp:server' }],
 * });
 * ```
 */
export async function createDelegation(options: {
  /** The issuer's signer (private key) */
  issuer: Signer;
  /** The audience's DID (who receives the capability) - any DID method supported */
  audience: string;
  /** The capabilities being delegated */
  capabilities: Capability[];
  /** Expiration timestamp (Unix seconds). Defaults to Infinity (never expires). */
  expiration?: number;
  /** Not before timestamp (Unix seconds) */
  notBefore?: number;
  /** Parent delegations (proof chain) */
  proofs?: Delegation[];
  /** Verifiable facts and proofs of knowledge (UCAN spec §3.2.4) */
  facts?: Fact[];
}): Promise<Delegation> {
  // Create principal from any DID (did:key, did:ixo, did:web, etc.)
  const audiencePrincipal = createPrincipal(options.audience);

  return Client.delegate({
    issuer: options.issuer,
    audience: audiencePrincipal,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ucanto delegate() expects a specific branded tuple type incompatible with Capability[]
    capabilities: options.capabilities as any,
    expiration: options.expiration ?? Infinity,
    proofs: options.proofs,
    notBefore: options.notBefore,
    facts: options.facts,
  });
}

/**
 * Create an invocation (request to use a capability)
 *
 * Supports any DID method for the audience (did:key, did:ixo, did:web, etc.)
 *
 * @param options - Invocation options
 * @returns The invocation object
 *
 * @example
 * ```typescript
 * // Invoke on a did:key server
 * const invocation = await createInvocation({
 *   issuer: mySigner,
 *   audience: 'did:key:z6Mk...',
 *   capability: { can: 'employees/read', with: 'myapp:server' },
 *   proofs: [myDelegation],
 * });
 *
 * // Invoke on a did:ixo server
 * const invocation = await createInvocation({
 *   issuer: mySigner,
 *   audience: 'did:ixo:ixo1oracle...',
 *   capability: { can: 'mcp/call', with: 'ixo:oracle:...' },
 *   proofs: [myDelegation],
 * });
 * ```
 */
export async function createInvocation(options: {
  /** The invoker's signer (private key) */
  issuer: Signer;
  /** The service's DID (audience) - any DID method supported */
  audience: string;
  /** The capability being invoked */
  capability: Capability;
  /** Delegation proofs */
  proofs?: Delegation[];
  /** Expiration timestamp (Unix seconds). Defaults to Infinity (never expires). */
  expiration?: number;
  /** Verifiable facts and proofs of knowledge (UCAN spec §3.2.4) */
  facts?: Fact[];
}) {
  // Create principal from any DID (did:key, did:ixo, did:web, etc.)
  const audiencePrincipal = createPrincipal(options.audience);

  return Client.invoke({
    issuer: options.issuer,
    audience: audiencePrincipal,
    capability: options.capability,
    proofs: options.proofs ?? [],
    expiration: options.expiration ?? Infinity,
    facts: options.facts,
  });
}

/**
 * Serialize an invocation to CAR format base64 (for sending in request body)
 *
 * @param invocation - The invocation to serialize
 * @returns Base64-encoded CAR data
 */
export async function serializeInvocation(
  invocation: Awaited<ReturnType<typeof createInvocation>>,
): Promise<string> {
  // Build the invocation into an IPLD view
  const built = await invocation.buildIPLDView();

  // Archive the invocation
  const archive = await built.archive();
  // Check for error
  if (archive.error) {
    throw new Error(
      `Failed to archive invocation: ${archive.error?.message ?? 'unknown'}`,
    );
  }
  // Get the bytes
  if (!archive.ok) {
    throw new Error('Failed to archive invocation: no data returned');
  }

  // Convert to base64
  return Buffer.from(archive.ok).toString('base64');
}

/**
 * Serialize a delegation to CAR format base64 (for storage/transport)
 *
 * @param delegation - The delegation to serialize
 * @returns Base64-encoded CAR data
 */
export async function serializeDelegation(
  delegation: Delegation,
): Promise<string> {
  // Archive the delegation (returns Result type)
  const archive = await delegation.archive();

  // Check for error (archive returns { ok: bytes } or { error: Error })
  if (archive.error) {
    throw new Error(`Failed to archive delegation: ${archive.error.message}`);
  }
  // Get the bytes
  if (!archive.ok) {
    throw new Error('Failed to archive delegation: no data returned');
  }

  // Convert to base64
  return Buffer.from(archive.ok).toString('base64');
}

/**
 * Get the canonical CID of a delegation — the identifier a UCAN revocation
 * targets.
 *
 * A delegation's CID is `CIDv1(dag-cbor, sha2-256)` over its DAG-CBOR encoding,
 * computed by ucanto when the delegation is created. This helper accepts either
 * a live Delegation or a serialized base64 CAR (as returned by
 * `serializeDelegation`, or as stored/transported), and always returns the
 * canonical base32 string form, so CIDs compare exactly across services.
 *
 * @param delegation - A Delegation object or a base64-encoded CAR
 * @returns The canonical CID string (e.g. `bafyrei...`)
 *
 * @example
 * ```typescript
 * const delegation = await createDelegation({ issuer, audience, capabilities });
 * const cid = await getDelegationCid(delegation);
 * // later: revoke that exact delegation by this cid
 * ```
 */
export async function getDelegationCid(
  delegation: Delegation | string,
): Promise<string> {
  const resolved =
    typeof delegation === 'string'
      ? await parseDelegation(delegation)
      : delegation;
  return resolved.cid.toString();
}

/**
 * Parse a serialized delegation from CAR format
 *
 * @param serialized - Base64-encoded CAR data
 * @returns The parsed delegation
 */
export async function parseDelegation(serialized: string): Promise<Delegation> {
  const { extract } = await import('@ucanto/core/delegation');
  const bytes = new Uint8Array(Buffer.from(serialized, 'base64'));

  const result = await extract(bytes);
  if (result.error) {
    throw new Error(
      `Failed to parse delegation: ${result.error?.message ?? 'unknown error'}`,
    );
  }

  if (!result.ok) {
    throw new Error('Failed to parse delegation: no data returned');
  }

  return result.ok;
}

// Re-export useful types
export type { Signer, Delegation, Capability, Fact };
