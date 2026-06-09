import {
  createIxoDIDResolver,
  createUCANValidator,
  defineCapability,
} from '@ixo/ucan';

/**
 * Default upper bound on how long an auth invocation may live. The middleware
 * and WS gateway read `UCAN_AUTH_MAX_TTL_SECONDS` from config and fall back to
 * this when it isn't set.
 */
export const DEFAULT_UCAN_AUTH_MAX_TTL_SECONDS = 900; // 15 minutes

/**
 * The capability the oracle accepts for *authentication* invocations. The
 * client invokes `{ can: '*', with: 'ixo:oracle' }`; the
 * server accepts any action (`can: '*'`) on the `ixo:` protocol and pins the
 * resource to `ixo:oracle`. The invocation carries no delegation proofs — the
 * user signs it as the root issuer, so it proves *who* is calling and nothing
 * more. Authorization (what the oracle may do downstream) stays with the
 * separate user→oracle delegation.
 */
const ORACLE_AUTH_RESOURCE = 'ixo:oracle';
const OracleAuthCapability = defineCapability({ can: '*', protocol: 'ixo:' });

/** The validated identity extracted from an auth invocation. */
export interface ValidatedUcanInvocation {
  userDid: string;
  /** Effective expiry (unix seconds). Always present — auth tokens must expire. */
  expiration: number;
}

export interface ValidateUcanInvocationOptions {
  /** The oracle's DID — the expected invocation audience (serverDid). */
  oracleDid: string;
  /** Blocksync GraphQL endpoint used to resolve `did:ixo` verification keys. */
  blocksyncUri: string;
  /**
   * Reject invocations whose effective expiry is further than this many seconds
   * in the future. Bounds the replay window server-side regardless of the TTL
   * the client declares.
   */
  maxTtlSeconds: number;
}

export type ValidateUcanInvocationOutcome =
  | { ok: true; result: ValidatedUcanInvocation }
  | { ok: false; error: string };

/**
 * Validate a user-signed UCAN auth invocation against this oracle. Shared by
 * the HTTP `AuthHeaderMiddleware` and the WebSocket gateway so both transports
 * authenticate identically — the returned `userDid` is the validated invoker
 * (the invocation's signer), never a value the client claimed for itself.
 *
 * Unlike a delegation, an invocation is a single, short-lived assertion of
 * "this user is calling now" — the replay window is its TTL, which we clamp.
 */
export async function validateUcanInvocation(
  invocation: string,
  opts: ValidateUcanInvocationOptions,
): Promise<ValidateUcanInvocationOutcome> {
  const validator = await createUCANValidator({
    serverDid: opts.oracleDid,
    // A user authenticates by self-signing a root invocation (no proofs), so
    // any DID must be accepted as a root issuer. Authorization is enforced
    // separately via the delegation chain on downstream services.
    rootIssuers: ['*'],
    didResolver: createIxoDIDResolver({ indexerUrl: opts.blocksyncUri }),
  });

  const result = await validator.validate(
    invocation,
    OracleAuthCapability,
    ORACLE_AUTH_RESOURCE,
  );

  if (!result.ok) {
    return {
      ok: false,
      error: `[${result.error?.code}] ${result.error?.message}`,
    };
  }

  if (!result.invoker) {
    return { ok: false, error: 'Invocation validated without an invoker DID' };
  }

  // Auth tokens must expire, and must not outlive the configured replay window.
  if (typeof result.expiration !== 'number' || !isFinite(result.expiration)) {
    return { ok: false, error: 'Auth invocation must declare an expiration' };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (result.expiration > nowSeconds + opts.maxTtlSeconds) {
    return {
      ok: false,
      error: `Auth invocation TTL exceeds maximum of ${opts.maxTtlSeconds}s`,
    };
  }

  return {
    ok: true,
    result: { userDid: result.invoker, expiration: result.expiration },
  };
}
