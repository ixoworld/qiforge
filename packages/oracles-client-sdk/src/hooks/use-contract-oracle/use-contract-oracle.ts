import {
  Authz,
  Payments,
  getMatrixUrlsForDid,
} from '@ixo/oracles-chain-client/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import MatrixClient from '../../matrix/matrix-client.js';
import { useOraclesContext } from '../../providers/oracles-provider/oracles-context.js';

const payments = new Payments();

interface IUseContractOracleProps {
  params: {
    oracleDid: string;
    userClaimCollectionId: string;
    adminAddress: string;
    claimId: string;
    agentQuota?: number;
    maxAmount?: {
      amount: number;
      denom: string;
    };
  };
}

const useContractOracle = ({ params }: IUseContractOracleProps) => {
  const { wallet, transactSignX } = useOraclesContext();
  const matrixClientRef = useMemo(
    () =>
      new MatrixClient({
        userAccessToken: wallet?.matrix.accessToken ?? '',
      }),
    [wallet?.matrix.accessToken],
  );

  const { data: authzConfig, isLoading: isLoadingAuthzConfig } = useQuery({
    queryKey: ['authz-config', params.oracleDid],
    queryFn: async () => {
      const config = await Authz.getOracleAuthZConfig({
        oracleDid: params.oracleDid,
        granterAddress: wallet?.address ?? '',
        matrixAccessToken: wallet?.matrix.accessToken,
        matrixHomeServer: wallet?.matrix.homeServer,
      });
      return config;
    },
    enabled: Boolean(wallet?.address),
  });

  const { data: oracleRoomId, isLoading: _isLoadingOracleRoomId } = useQuery({
    queryKey: ['oracle-room-id', params.oracleDid, wallet?.did],
    queryFn: async () => {
      // Use DID-based resolution for decoupled Matrix infrastructure
      const roomId = await matrixClientRef.getOracleRoomIdWithDid({
        userDid: wallet?.did ?? '',
        oracleEntityDid: params.oracleDid,
      });
      return roomId;
    },
    enabled: Boolean(wallet?.did && params.oracleDid),
  });

  // Get pricing list
  const { data: pricingList, isLoading: isLoadingPricingList } = useQuery({
    queryKey: ['pricing-list', params.oracleDid],
    queryFn: async () => {
      const list = await payments.getOraclePricingList(
        params.oracleDid,
        wallet?.matrix.accessToken,
        wallet?.matrix.homeServer,
      );
      return list;
    },
  });

  const { mutateAsync: contractOracle, isPending: isContractingOracle } =
    useMutation({
      mutationFn: async ({ useAuthz = true }: { useAuthz?: boolean }) => {
        const config =
          authzConfig ??
          (await Authz.getOracleAuthZConfig({
            oracleDid: params.oracleDid,
            granterAddress: wallet?.address ?? '',
            matrixAccessToken: wallet?.matrix.accessToken,
            matrixHomeServer: wallet?.matrix.homeServer,
          }));

        if (pricingList?.length === 0 && !params.maxAmount) {
          throw new Error(
            'No pricing list found please provide a max amount or add a pricing list to the oracle',
          );
        }

        const authz = new Authz(config);

        if (!wallet?.did || !wallet.matrix.accessToken) {
          throw new Error('Wallet or matrix access token not found');
        }

        // Use DID-based resolution for decoupled Matrix infrastructure
        const mainSpaceId = await matrixClientRef.sourceMainSpaceWithDid({
          userDid: wallet.did,
        });

        await matrixClientRef.joinSpaceOrRoomWithDid({
          roomId: mainSpaceId.mainSpaceId,
          userDid: wallet.did,
        });

        await Promise.all(
          mainSpaceId.subSpaces.map(async (subSpaceId) => {
            await matrixClientRef.joinSpaceOrRoomWithDid({
              roomId: subSpaceId,
              userDid: wallet.did,
            });
          }),
        );

        await matrixClientRef.createAndJoinOracleRoomWithDid({
          oracleEntityDid: params.oracleDid,
          userDid: wallet.did,
        });
        void refetchOracleInRoom();
        if (useAuthz) {
          return authz.contractOracle(
            {
              adminAddress: params.adminAddress,
              claimCollectionId: params.userClaimCollectionId,
              oracleAddress: config.granteeAddress,
              oracleName: config.oracleName,
              accountAddress: wallet.address,
              agentQuota: params.agentQuota ?? 1,
              maxAmount: params.maxAmount
                ? [
                    {
                      amount: params.maxAmount.amount.toString(),
                      denom: params.maxAmount.denom,
                    },
                  ]
                : [
                    {
                      amount: pricingList?.[0]?.amount ?? '0',
                      denom: pricingList?.[0]?.denom ?? 'uixo',
                    },
                  ],
            },
            transactSignX,
          );
        }
      },
    });

  const { mutateAsync: payClaim, isPending: isPayingClaim } = useMutation({
    mutationFn: async () => {
      if (!wallet?.address) {
        throw new Error('Wallet not found');
      }
      await payments.payClaim({
        userAddress: wallet.address,
        claimId: params.claimId,
        adminAddress: params.adminAddress,
        claimCollectionId: params.userClaimCollectionId,
        sign: transactSignX,
      });
    },
  });

  // check if the oracle is in the room with the user
  // The oracle's Matrix user ID uses the oracle's homeserver (from oracle entity DID)
  const {
    data: isOracleInRoom,
    isLoading: isLoadingOracleInRoom,
    refetch: refetchOracleInRoom,
  } = useQuery({
    queryKey: [
      'oracle-in-room',
      params.oracleDid,
      params.userClaimCollectionId,
    ],
    queryFn: async () => {
      if (!oracleRoomId) {
        return false;
      }
      if (!authzConfig?.granteeAddress) {
        return false;
      }
      // Resolve oracle's homeserver from oracle entity DID
      const oracleMatrixUrls = await getMatrixUrlsForDid(params.oracleDid);
      const oracleMatrixUserId = `@did-ixo-${authzConfig.granteeAddress}:${oracleMatrixUrls.homeServerCropped}`;

      const members = await matrixClientRef.listRoomMembersWithDid(
        oracleRoomId,
        wallet?.did ?? '',
      );
      return members.includes(oracleMatrixUserId);
    },
    enabled: Boolean(
      wallet?.did &&
      params.oracleDid &&
      oracleRoomId &&
      authzConfig?.granteeAddress,
    ),
  });

  const { mutateAsync: inviteOracle, isPending: isInvitingOracle } =
    useMutation({
      mutationFn: async () => {
        if (!oracleRoomId || !authzConfig?.granteeAddress || !wallet?.did) {
          throw new Error('Oracle room id not found');
        }
        // Resolve oracle's homeserver from oracle entity DID
        const oracleMatrixUrls = await getMatrixUrlsForDid(params.oracleDid);
        const oracleMatrixUserId = `@did-ixo-${authzConfig.granteeAddress}:${oracleMatrixUrls.homeServerCropped}`;

        await matrixClientRef.inviteUserWithDid(
          oracleRoomId,
          oracleMatrixUserId,
          wallet.did,
        );
        await refetchOracleInRoom();
      },
    });

  return {
    contractOracle,
    isContractingOracle,
    payClaim,
    isPayingClaim,
    isLoadingPricingList,
    pricingList,
    isLoadingAuthzConfig,
    authzConfig,
    isOracleInRoom,
    isLoadingOracleInRoom,
    inviteOracle,
    isInvitingOracle,
  };
};

export default useContractOracle;
