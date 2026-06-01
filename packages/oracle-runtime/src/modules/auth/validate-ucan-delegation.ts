import { createIxoDIDResolver, createUCANValidator } from '@ixo/ucan';

/** The validated identity + delegation metadata extracted from a UCAN header. */
export interface ValidatedUcanDelegation {
  userDid: string;
  delegation: {
    issuer: string;
    audience: string;
    capabilities: unknown[];
    expiration?: number;
  };
}

export interface ValidateUcanDelegationOptions {
  /** The oracle's DID — used as the expected delegation audience (serverDid). */
  oracleDid: string;
  /** Blocksync GraphQL endpoint used to resolve `did:ixo` verification keys. */
  blocksyncUri: string;
}

export type ValidateUcanDelegationOutcome =
  | { ok: true; result: ValidatedUcanDelegation }
  | { ok: false; error: string };

/**
 * Validate a raw UCAN delegation header against this oracle. Shared by the
 * HTTP `AuthHeaderMiddleware` and the WebSocket gateway so both transports
 * authenticate identically — the returned `userDid` is the validated invoker,
 * never a value the client claimed for itself.
 */
export async function validateUcanDelegation(
  ucanHeader: string,
  opts: ValidateUcanDelegationOptions,
): Promise<ValidateUcanDelegationOutcome> {
  const validator = await createUCANValidator({
    serverDid: opts.oracleDid,
    rootIssuers: [],
    didResolver: createIxoDIDResolver({ indexerUrl: opts.blocksyncUri }),
  });

  const result = await validator.validateDelegation(ucanHeader);

  if (!result.ok) {
    return {
      ok: false,
      error: `[${result.error?.code}] ${result.error?.message}`,
    };
  }

  if (!result.invoker) {
    return { ok: false, error: 'Delegation validated without an invoker DID' };
  }

  return {
    ok: true,
    result: {
      userDid: result.invoker,
      delegation: {
        issuer: result.invoker,
        audience: opts.oracleDid,
        capabilities: result.capability ? [result.capability] : [],
        expiration: result.expiration,
      },
    },
  };
}
