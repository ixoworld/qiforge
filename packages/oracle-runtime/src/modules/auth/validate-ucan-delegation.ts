import {
  createIxoDIDResolver,
  createUCANValidator,
  defineCapability,
  parseDelegation,
  type ValidateResult,
} from '@ixo/ucan';

function resourceProtocol(resource: string): `${string}:` | null {
  const separator = resource.indexOf(':');
  return separator > 0
    ? (resource.slice(0, separator + 1) as `${string}:`)
    : null;
}

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
 * authenticate identically. User DIDs are intentional roots for these grants;
 * the first capability consumed by the Node runtime is still required to
 * derive from every parent proof by action and resource.
 */
export async function validateUcanDelegation(
  ucanHeader: string,
  opts: ValidateUcanDelegationOptions,
): Promise<ValidateUcanDelegationOutcome> {
  const validator = await createUCANValidator({
    serverDid: opts.oracleDid,
    rootIssuers: ['*'],
    didResolver: createIxoDIDResolver({ indexerUrl: opts.blocksyncUri }),
  });

  const verification = await validator.verifyDelegation(ucanHeader);

  if (!verification.ok) {
    return {
      ok: false,
      error: `[${verification.error?.code}] ${verification.error?.message}`,
    };
  }

  if (!verification.invoker) {
    return { ok: false, error: 'Delegation validated without an invoker DID' };
  }

  let capability: ValidateResult['capability'];
  try {
    const delegation = await parseDelegation(ucanHeader);
    const claim = delegation.capabilities[0];
    if (claim) {
      const protocol = resourceProtocol(String(claim.with));
      if (!protocol) {
        return {
          ok: false,
          error: `Delegation capability has an invalid resource: ${String(claim.with)}`,
        };
      }
      const authorization = await validator.validateDelegation(
        ucanHeader,
        defineCapability({ can: String(claim.can), protocol }),
        String(claim.with),
      );
      if (!authorization.ok) {
        return {
          ok: false,
          error: `[${authorization.error?.code}] ${authorization.error?.message}`,
        };
      }
      capability = authorization.capability;
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Invalid delegation',
    };
  }

  return {
    ok: true,
    result: {
      userDid: verification.invoker,
      delegation: {
        issuer: verification.invoker,
        audience: opts.oracleDid,
        capabilities: capability ? [capability] : [],
        expiration: verification.expiration,
      },
    },
  };
}
