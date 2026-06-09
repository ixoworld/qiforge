/**
 * UCAN delegation minting for integration tests.
 *
 * Wraps `@ixo/ucan`'s `signerFromMnemonic` + `createDelegation` +
 * `serializeDelegation` pipeline into one call. The result is a base64
 * CAR-encoded delegation string suitable for the `x-ucan-delegation`
 * request header — what the runtime's `AuthHeaderMiddleware` validates.
 *
 * Capability constants below match the strings the runtime / plugins
 * already expect. **Composio routes through the sandbox capability** —
 * there is no separate `composioCap` and tests that exercise composio
 * must include `sandboxCap` in their capability set.
 */
import {
  createDelegation,
  createInvocation,
  serializeDelegation,
  serializeInvocation,
  signerFromMnemonic,
  type Capability,
} from '@ixo/ucan';

/** Type predicate: tag a string as the `did:ixo:` brand `@ixo/ucan` accepts. */
function isIxoDid(did: string): did is `did:ixo:${string}` {
  return did.startsWith('did:ixo:');
}

/** Type predicate: tag a string as the `did:key:` brand `@ixo/ucan` accepts. */
function isKeyDid(did: string): did is `did:key:${string}` {
  return did.startsWith('did:key:');
}

/**
 * Narrow a string DID to one of the brands the UCAN library accepts. Returns
 * `undefined` for `undefined` input (so the caller can fall through to the
 * signer's auto-derived `did:key:` identity); throws for unsupported methods
 * so a typo in `.env.integration` fails loudly.
 */
function toSupportedDid(
  did: string | undefined,
): `did:ixo:${string}` | `did:key:${string}` | undefined {
  if (did === undefined) return undefined;
  if (isIxoDid(did)) return did;
  if (isKeyDid(did)) return did;
  const prefix = did.split(':').slice(0, 2).join(':');
  throw new Error(
    `[mintUserDelegation] Unsupported DID method '${prefix}' — ` +
      `only did:ixo: and did:key: are accepted. Got: ${did}`,
  );
}

/** One week in seconds — default TTL for a test delegation. */
const ONE_WEEK_SECONDS = 7 * 24 * 60 * 60;

/** Memory plugin capability — read/write user memories. */
export const memoryCap: Capability = {
  can: 'memory/*',
  with: 'ixo:memory',
};

/**
 * Sandbox capability — covers the sandbox plugin AND Composio (composio
 * routes through the sandbox infra). There is intentionally no
 * `composioCap`; tests that need composio access list `sandboxCap`.
 */
export const sandboxCap: Capability = {
  can: 'sandbox/*',
  with: 'ixo:sandbox',
};

/** Skills plugin capability — search/list/run skill capsules. */
export const skillsCap: Capability = {
  can: 'skills/*',
  with: 'ixo:skills',
};

/** Subscriptions read capability — covers the credits middleware lookup. */
export const subscriptionsReadCap: Capability = {
  can: 'subscriptions/read',
  with: 'ixo:subscriptions',
};

/** Convenience: the full capability bundle for "no-friction" tests. */
export const allCaps: Capability[] = [
  memoryCap,
  sandboxCap,
  skillsCap,
  subscriptionsReadCap,
];

/** Options accepted by `mintUserDelegation`. */
export interface MintUserDelegationOptions {
  /**
   * BIP39 mnemonic for the test user. Stored in `.env.integration` as
   * `TEST_USER_MNEMONIC`. Test files normally pass
   * `process.env.TEST_USER_MNEMONIC!`.
   */
  userMnemonic: string;
  /**
   * The oracle's DID — the delegation's audience. Tests normally pass
   * `process.env.ORACLE_DID!`. Matches the `serverDid` the runtime's
   * UCAN validator boots with.
   */
  oracleDid: string;
  /**
   * The test user's DID. Defaults to the DID derived from the mnemonic
   * by `signerFromMnemonic`. Pass `process.env.TEST_USER_DID!` when the
   * user has an on-chain Ed25519 verification method so the issuer string
   * matches what the chain-aware validator resolves.
   */
  userDid?: string;
  /**
   * Capabilities granted by the delegation. Tests that exercise UCAN
   * failure modes pass a narrower set (e.g. `[memoryCap]` to a sandbox
   * test to assert a clean auth error).
   */
  capabilities: Capability[];
  /**
   * Time-to-live, in **seconds** (not ms — `@ixo/ucan` uses Unix seconds
   * for expiration). Defaults to 7 days.
   */
  ttlSec?: number;
}

/**
 * Mint a real Ed25519-signed UCAN delegation string for the test user.
 *
 * Pipeline (verbatim per the integration-testing spec §6/§8 Phase 0.6):
 *
 *   `signerFromMnemonic(userMnemonic, userDid?)` → `createDelegation({
 *      issuer, audience: oracleDid, capabilities, expiration: now+ttl })` →
 *   `serializeDelegation()`
 *
 * `expiration` is Unix **seconds**, not milliseconds — a frequent footgun.
 */
export async function mintUserDelegation(
  opts: MintUserDelegationOptions,
): Promise<string> {
  const ttlSec = opts.ttlSec ?? ONE_WEEK_SECONDS;
  const expiration = Math.floor(Date.now() / 1000) + ttlSec;

  const { signer } = await signerFromMnemonic(
    opts.userMnemonic,
    toSupportedDid(opts.userDid),
  );

  const delegation = await createDelegation({
    issuer: signer,
    audience: opts.oracleDid,
    capabilities: opts.capabilities,
    expiration,
  });

  return serializeDelegation(delegation);
}

/**
 * The auth capability a root invocation carries. The ability is `*` (top) to
 * match the runtime's server-side capability parser (`defineCapability({ can:
 * '*' })`) — `@ixo/ucan` matches the `can` string literally, and the specific
 * action is irrelevant for auth since identity comes from the signature.
 */
const AUTH_CAPABILITY: Capability = {
  can: '*',
  with: 'ixo:oracle',
};

/** Default TTL (seconds) for a test auth invocation — short-lived, like prod. */
const AUTH_INVOCATION_TTL_SECONDS = 300;

/** Options accepted by `mintAuthInvocation`. */
export interface MintAuthInvocationOptions {
  /**
   * BIP39 mnemonic for the test user — the SAME signer used by
   * `mintUserDelegation`. Stored in `.env.integration` as
   * `TEST_USER_MNEMONIC`.
   */
  userMnemonic: string;
  /**
   * The oracle's DID — the invocation's audience. Matches the `serverDid`
   * the runtime's UCAN validator boots with.
   */
  oracleDid: string;
  /**
   * The test user's DID. Defaults to the DID derived from the mnemonic by
   * `signerFromMnemonic`. Pass `process.env.TEST_USER_DID!` when the user has
   * an on-chain Ed25519 verification method.
   */
  userDid?: string;
  /**
   * Time-to-live, in **seconds** (Unix seconds, not ms). Defaults to 300 —
   * a short-lived auth invocation, mirroring the production frontend.
   */
  ttlSec?: number;
}

/**
 * Mint a real Ed25519-signed UCAN **invocation** for the test user — the
 * primary auth artifact the runtime now expects.
 *
 * A root auth invocation: issuer = the test user's signer (the SAME identity
 * as the delegation), audience = the oracle DID, capability
 * `{ can: '*', with: 'ixo:oracle' }`, no proofs, short TTL.
 * Sent as `Authorization: Bearer <invocation>` + `X-Auth-Type: ucan`.
 *
 * Pipeline: `signerFromMnemonic(userMnemonic, userDid?)` →
 * `createInvocation({ issuer, audience: oracleDid, capability, proofs: [],
 *  expiration: now+ttl })` → `serializeInvocation()`.
 *
 * `expiration` is Unix **seconds**, not milliseconds.
 */
export async function mintAuthInvocation(
  opts: MintAuthInvocationOptions,
): Promise<string> {
  const ttlSec = opts.ttlSec ?? AUTH_INVOCATION_TTL_SECONDS;
  const expiration = Math.floor(Date.now() / 1000) + ttlSec;

  const { signer } = await signerFromMnemonic(
    opts.userMnemonic,
    toSupportedDid(opts.userDid),
  );

  const invocation = await createInvocation({
    issuer: signer,
    audience: opts.oracleDid,
    capability: AUTH_CAPABILITY,
    proofs: [],
    expiration,
  });

  return serializeInvocation(invocation);
}
