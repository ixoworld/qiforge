import type { RuntimeContext } from '../../plugin-api/types.js';

/**
 * Mint a UCAN invocation token addressed to the composio-worker.
 *
 *   1. Resolves the composio-worker DID via `runCtx.ucan.resolveServiceDid`
 *      (delegates the did:web lookup + cache to the Tier-0 UCAN service).
 *   2. Mints an `ixo:composio` invocation using the user's signing key.
 *
 * Returns `null` when DID resolution fails, when minting throws, or when no
 * signing material is available. Callers degrade silently — the composio
 * client is simply not constructed and the plugin contributes no tools.
 */
export async function mintComposioInvocation(
  runCtx: RuntimeContext,
  composioBaseUrl: string,
): Promise<string | null> {
  const composioDid = await runCtx.ucan.resolveServiceDid(composioBaseUrl);
  if (!composioDid) return null;

  try {
    const invocation = await runCtx.ucan.mintInvocation({
      did: composioDid,
      capability: 'ixo:composio',
    });
    return invocation && invocation.length > 0 ? invocation : null;
  } catch (error) {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    runCtx.logger.warn(
      `[composio] failed to mint UCAN invocation: ${detail}`,
    );
    return null;
  }
}
