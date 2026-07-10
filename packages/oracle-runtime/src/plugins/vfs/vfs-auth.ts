import type { RuntimeContext } from '../../plugin-api/types.js';
import type { VfsAbility, VfsAuthErrorKind } from './vfs-errors.js';
import type { VfsConfig } from './vfs.plugin.js';

/** Personal-namespace resource the user delegates over. */
const VFS_RESOURCE = 'ixo:filesystem';

/** Invocations are single-use per call, so a short TTL suffices. */
const INVOCATION_TTL_SECONDS = 60;

export type VfsBearerResult =
  | { bearer: string }
  | { error: VfsAuthErrorKind; detail?: string };

/**
 * Resolve a fresh, single-use VFS bearer for one operation via the two-hop
 * UCAN flow:
 *
 *   1. Fetch the user's delegation for this oracle from the store worker
 *      (`getServiceDelegation`) over `ixo:filesystem`, requiring an ability
 *      that covers `ability`.
 *   2. Mint an invocation proved by that delegation, attenuated to
 *      `{ can: ability, with: <granted resource> }`.
 *
 * Non-throwing: every failure is returned as `{ error, detail? }` so the
 * client can surface an agent-actionable message instead of a stack.
 */
export async function vfsBearer(
  rtCtx: RuntimeContext,
  cfg: VfsConfig,
  ability: VfsAbility,
  targetResource?: string,
): Promise<VfsBearerResult> {
  const delegation = await rtCtx.ucan.getServiceDelegation(rtCtx.user.did, {
    storeUrl: cfg.UCAN_STORE_URL,
    resource: VFS_RESOURCE,
    requiredAbility: ability,
  });
  if ('error' in delegation) {
    // `{ error: 'no-delegation' | 'store-error', detail? }` widens cleanly to
    // `VfsBearerResult` (both kinds are in `VfsAuthErrorKind`).
    return delegation;
  }

  const minted = await rtCtx.ucan.createInvocationFromDelegation(
    delegation.token,
    cfg.VFS_BASE_URL,
    { can: ability, with: targetResource ?? delegation.with },
    { maxTtlSeconds: INVOCATION_TTL_SECONDS },
  );
  if ('error' in minted) {
    return { error: 'mint-failed', detail: minted.error };
  }

  return { bearer: minted.invocation };
}
