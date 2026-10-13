import { Authz } from '@ixo/oracles-chain-client/react';
import { queryOptions } from '@tanstack/react-query';
import type { IWalletProps } from '../providers/oracles-provider/types.js';

// The oracle's authz settings change rarely; remounting hosts (lists render
// one hook per oracle card) must not refetch them.
const AUTHZ_CONFIG_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * The oracle's authz config with the wallet as granter: one query shared by
 * every hook that needs it, keyed by the wallet so an account switch on the
 * same query client never reuses the previous user's config.
 */
export const authzConfigQueryOptions = (
  oracleDid: string,
  wallet: IWalletProps | null,
) =>
  queryOptions({
    queryKey: ['authz-config', oracleDid, wallet?.did, wallet?.address],
    queryFn: () =>
      Authz.getOracleAuthZConfig({
        oracleDid,
        granterAddress: wallet?.address ?? '',
        matrixAccessToken: wallet?.matrix.accessToken,
        matrixHomeServer: wallet?.matrix.homeServer,
      }),
    enabled: Boolean(wallet?.address && oracleDid),
    staleTime: AUTHZ_CONFIG_STALE_TIME_MS,
  });
