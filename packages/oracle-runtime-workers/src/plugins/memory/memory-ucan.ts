import type { RuntimeContext } from '../../plugin-api/types';
import { MEMORY_CAPABILITY } from '../delegated-capabilities';
import { mintInvocationSafely, resolveServiceDidSafely } from '../ucan-failure';
import { MEMORY_ENTITY_HEADER } from './memory-entity';

/**
 * Build the headers needed to call the Memory Engine MCP server on behalf of
 * the current user.
 *
 *   1. Resolve the memory service DID via `runCtx.ucan.resolveServiceDid`
 *      (delegates the did:web lookup + cache to the UCAN service).
 *   2. Mint an `ixo:memory` invocation using the user's signing key.
 *   3. Layer the resulting Bearer token, the oracle's domain entity
 *      (`x-oracle-entity-did`, which keys every memory space on the engine)
 *      and the active `x-room-id`.
 *
 * `entityDid` is the configured `ORACLE_ENTITY_DID` (validated by the memory
 * plugin's `configSchema`), passed in because `RuntimeContext` carries no
 * oracle identity. It is never the core's `ORACLE_DID` fallback.
 *
 * UCAN-only — no Matrix-OpenID fallback. If resolution or minting fails for
 * any reason (no signing key, no cached delegation, did:web unresolved,
 * network error) the function returns `null` so callers degrade silently
 * rather than leak a half-built request to the upstream service. All failures
 * are contained by the shared UCAN helpers — nothing throws past this
 * boundary. The "no delegation present" case logs at `debug`; a genuine
 * resolve/mint failure logs at `warn`.
 */
export async function buildMemoryHeaders(
  runCtx: RuntimeContext,
  memoryMcpUrl: string,
  entityDid: string,
): Promise<Record<string, string> | null> {
  const memoryDid = await resolveServiceDidSafely(
    runCtx,
    memoryMcpUrl,
    'memory',
  );
  if (!memoryDid) return null;

  const invocation = await mintInvocationSafely(
    runCtx,
    { did: memoryDid, capability: MEMORY_CAPABILITY.resource },
    'memory',
    // Claim the ability the user's delegation actually grants. A `'*'` claim is
    // satisfiable only by a `'*'` grant — `'*'.startsWith('memory/')` is false.
    { can: MEMORY_CAPABILITY.action },
  );
  if (!invocation) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${invocation}`,
    'X-Auth-Type': 'ucan',
    'User-Agent': 'LangChain-MCP-Client/1.0',
    [MEMORY_ENTITY_HEADER]: entityDid,
  };
  if (runCtx.session.roomId) {
    headers['x-room-id'] = runCtx.session.roomId;
  }
  return headers;
}
