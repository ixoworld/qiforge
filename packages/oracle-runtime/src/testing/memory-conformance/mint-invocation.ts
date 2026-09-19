/**
 * Mint the UCAN invocations a conformance run needs.
 *
 * The runtime does this through `runCtx.ucan.mintInvocation` with a
 * did:web-resolved audience (`plugins/memory/memory-ucan.ts`). A conformance
 * run has no `RuntimeContext`, so it builds the same artifact directly against
 * `@ixo/ucan`.
 *
 * Contract §3.1: capability `ixo:memory`, ability `memory/*`, audience = the
 * engine's own DID.
 */
import {
  createInvocation,
  serializeInvocation,
  signerFromMnemonic,
  type Capability,
} from '@ixo/ucan';

/** The capability the engine must see. Ability matching is literal (§3.1). */
const MEMORY_CAPABILITY: Capability = {
  can: 'memory/*',
  with: 'ixo:memory',
};

/** Default lifetime for a conformance invocation. */
const DEFAULT_TTL_SECONDS = 300;

export interface MintMemoryInvocationOptions {
  /** BIP39 mnemonic for the identity making the call. */
  userMnemonic: string;
  /**
   * The memory engine's DID — the invocation audience. Must match what the
   * engine publishes at its `did:web` document, or verification fails.
   */
  memoryServiceDid: string;
  /** Explicit user DID. Defaults to the one derived from the mnemonic. */
  userDid?: string;
  /**
   * Lifetime in Unix **seconds**. Pass a negative value to mint an
   * already-expired invocation for MEC-05.
   */
  ttlSec?: number;
}

function toSupportedDid(
  did: string | undefined,
): `did:ixo:${string}` | `did:key:${string}` | undefined {
  if (did === undefined) return undefined;
  if (did.startsWith('did:ixo:')) return did as `did:ixo:${string}`;
  if (did.startsWith('did:key:')) return did as `did:key:${string}`;
  throw new Error(
    `[mintMemoryInvocation] Unsupported DID method in "${did}" — only did:ixo: and did:key: are accepted.`,
  );
}

/**
 * Mint a serialized, Ed25519-signed invocation for the memory capability.
 *
 * Issued at the root (no proofs), mirroring `mintAuthInvocation` in the
 * integration harness. An engine whose `UCAN_ROOT_ISSUERS` does not include the
 * test identity will reject it — in that case supply a pre-minted invocation
 * from your own delegation chain instead of calling this.
 */
export async function mintMemoryInvocation(
  opts: MintMemoryInvocationOptions,
): Promise<string> {
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SECONDS;
  const expiration = Math.floor(Date.now() / 1000) + ttlSec;

  const { signer } = await signerFromMnemonic(
    opts.userMnemonic,
    toSupportedDid(opts.userDid),
  );

  const invocation = await createInvocation({
    issuer: signer,
    audience: opts.memoryServiceDid,
    capability: MEMORY_CAPABILITY,
    proofs: [],
    expiration,
  });

  return serializeInvocation(invocation);
}
