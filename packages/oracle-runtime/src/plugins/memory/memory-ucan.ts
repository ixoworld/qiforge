import type { RuntimeContext } from '../../plugin-api/types.js';

/**
 * Build the headers needed to call the Memory Engine MCP server on behalf of
 * the current user.
 *
 *   1. Resolve the memory service DID via `runCtx.ucan.resolveServiceDid`
 *      (delegates the did:web lookup + cache to the Tier-0 UCAN service).
 *   2. Mint an `ixo:memory` invocation using the user's signing key.
 *   3. Layer the resulting Bearer token plus the active `x-room-id`.
 *
 * UCAN-only — no Matrix-OpenID fallback. If minting fails for any reason
 * (no signing key, no cached delegation, did:web unresolved) the function
 * returns `null` so callers can degrade silently rather than leak a
 * half-built request to the upstream service.
 */
export async function buildMemoryHeaders(
  runCtx: RuntimeContext,
  memoryMcpUrl: string,
): Promise<Record<string, string> | null> {
  const memoryDid = await runCtx.ucan.resolveServiceDid(memoryMcpUrl);
  if (!memoryDid) return null;

  try {
    const invocation = await runCtx.ucan.mintInvocation({
      did: memoryDid,
      capability: 'ixo:memory',
    });
    if (!invocation || invocation.length === 0) return null;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${invocation}`,
      'X-Auth-Type': 'ucan',
      'User-Agent': 'LangChain-MCP-Client/1.0',
    };
    if (runCtx.session.roomId) {
      headers['x-room-id'] = runCtx.session.roomId;
    }
    return headers;
  } catch (error) {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    runCtx.logger.warn(`[memory] failed to mint UCAN invocation: ${detail}`);
    return null;
  }
}
