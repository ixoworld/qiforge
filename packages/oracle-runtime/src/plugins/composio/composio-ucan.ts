import type { RuntimeContext } from '../../plugin-api/types.js';
import {
  mintInvocationSafely,
  resolveServiceDidSafely,
} from '../ucan-failure.js';

/**
 * Mint a UCAN invocation token addressed to the composio-worker.
 *
 *   1. Resolves the composio-worker DID via `runCtx.ucan.resolveServiceDid`
 *      (delegates the did:web lookup + cache to the Tier-0 UCAN service).
 *   2. Mints an `ixo:sandbox` invocation using the user's signing key.
 *
 * Returns `null` when DID resolution fails, when minting throws, or when no
 * signing material is available. Every failure is contained inside the shared
 * UCAN helpers — nothing throws past this boundary. Callers degrade silently:
 * the composio client is simply not constructed and the plugin contributes no
 * tools. The "no delegation present" case logs at `debug`; a genuine
 * resolve/mint failure logs at `warn`.
 */
export async function mintComposioInvocation(
  runCtx: RuntimeContext,
  composioBaseUrl: string,
): Promise<string | null> {
  const composioDid = await resolveServiceDidSafely(
    runCtx,
    composioBaseUrl,
    'composio',
  );
  if (!composioDid) return null;

  // skipCache: the composio-worker enforces single-use replay protection
  // per invocation CID (see composio-worker `lib/validation.ts`
  // `createInvocationStore`, KV-backed, 120s default TTL). A cached
  // invocation would be replayed on the second request and rejected with
  // `401 REPLAY: Invocation has already been used`. Mint fresh every call.
  return mintInvocationSafely(
    runCtx,
    { did: composioDid, capability: 'ixo:sandbox' },
    'composio',
    // can: composio routes through the sandbox capability, and the user's
    // delegation grants `sandbox/*`. A `'*'` claim is satisfiable only by a
    // `'*'` grant — `'*'.startsWith('sandbox/')` is false.
    { skipCache: true, can: 'sandbox/*' },
  );
}
