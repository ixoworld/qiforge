import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import MatrixClient from '../../matrix/matrix-client.js';
import { useOraclesContext } from '../../providers/oracles-provider/oracles-context.js';

export const useGetOpenIdToken = () => {
  const { wallet } = useOraclesContext();
  const matrixClientRef = useMemo(
    () =>
      new MatrixClient({
        userAccessToken: wallet?.matrix.accessToken ?? '',
        homeserverUrl: wallet?.matrix.homeServer,
      }),
    [wallet?.matrix.accessToken, wallet?.matrix.homeServer],
  );
  const {
    data: openIdToken,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['openIdToken', wallet?.did],
    queryFn: async () => {
      if (!wallet?.did || !wallet?.address || !wallet?.matrix.homeServer) {
        return;
      }
      const matrixUserId = `@did-ixo-${wallet.address}:${wallet.matrix.homeServer}`;
      return matrixClientRef.getOpenIdTokenWithDid(matrixUserId, wallet.did);
    },
    enabled:
      !!wallet?.did &&
      !!wallet?.matrix.accessToken &&
      !!wallet?.matrix.homeServer,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 5,
  });

  const refetchOpenIdToken = useCallback(async () => {
    const token = await refetch();
    return token.data;
  }, [refetch]);

  return { openIdToken, isLoading, error, refetch: refetchOpenIdToken };
};
