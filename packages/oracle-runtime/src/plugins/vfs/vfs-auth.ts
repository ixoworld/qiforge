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

/** The two UCAN operations the two-hop flow needs — satisfied by `rtCtx.ucan` and by `UcanService` itself. */
export type VfsDelegationMinter = Pick<
  RuntimeContext['ucan'],
  'getServiceDelegation' | 'createInvocationFromDelegation'
>;

export interface VfsAuthUrls {
  VFS_BASE_URL: string;
  UCAN_STORE_URL: string;
}

/**
 * Resolve a fresh, single-use VFS bearer for one operation via the two-hop
 * UCAN flow, for any caller that holds the UCAN operations directly — the
 * request path (through `vfsBearer`) and background jobs alike:
 *
 *   1. Fetch the user's delegation for this oracle from the store worker
 *      (`getServiceDelegation`) over `ixo:filesystem`, requiring an ability
 *      that covers `ability`.
 *   2. Mint an invocation proved by that delegation, attenuated to
 *      `{ can: ability, with: <granted resource> }`.
 *
 * Non-throwing: every failure is returned as `{ error, detail? }`.
 */
export async function mintVfsBearerFor(
  minter: VfsDelegationMinter,
  userDid: string,
  urls: VfsAuthUrls,
  ability: VfsAbility,
  targetResource?: string,
): Promise<VfsBearerResult> {
  const delegation = await minter.getServiceDelegation(userDid, {
    storeUrl: urls.UCAN_STORE_URL,
    resource: VFS_RESOURCE,
    requiredAbility: ability,
  });
  if ('error' in delegation) {
    return delegation;
  }

  const minted = await minter.createInvocationFromDelegation(
    delegation.token,
    urls.VFS_BASE_URL,
    { can: ability, with: targetResource ?? delegation.with },
    { maxTtlSeconds: INVOCATION_TTL_SECONDS },
  );
  if ('error' in minted) {
    return { error: 'mint-failed', detail: minted.error };
  }

  return { bearer: minted.invocation };
}

/** Request-path convenience: the same flow using the runtime context's user + UCAN adapter. */
export function vfsBearer(
  rtCtx: RuntimeContext,
  cfg: VfsConfig,
  ability: VfsAbility,
  targetResource?: string,
): Promise<VfsBearerResult> {
  return mintVfsBearerFor(
    rtCtx.ucan,
    rtCtx.user.did,
    cfg,
    ability,
    targetResource,
  );
}
