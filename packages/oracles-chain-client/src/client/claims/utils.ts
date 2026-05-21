export async function getUserOraclesClaimCollection(
  userAddress: string,
): Promise<string | undefined> {
  if (process.env.NODE_ENV === 'production') {
    return undefined;
  }
  // eslint-disable-next-line no-console -- browser-reachable file; @ixo/logger uses node:util and breaks webpack frontend builds (see package CLAUDE.md)
  console.warn(
    '[Authz] getUserOraclesClaimCollection is not implemented',
    'getUserOraclesClaimCollection',
    'notImplemented',
    'userAddress',
    userAddress,
  );
  // eslint-disable-next-line no-console
  console.warn(
    '[Authz] getUserOraclesClaimCollection returning hardcoded value',
  );
  return process.env.USER_CLAIM_COLLECTION_ID ?? '138';
}
