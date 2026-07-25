import {
  Authz,
  Payments,
  getMatrixUrlsForDid,
  getOracleAgentCard,
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

// Oracle entity settings (authz config, agent card, room ids) change rarely;
// keep them fresh for a while so remounting hosts (lists render one hook per
// oracle card) don't refetch the same documents.
const ORACLE_CONFIG_STALE_TIME_MS = 5 * 60 * 1000;

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
    enabled: Boolean(wallet?.address && params.oracleDid),
    staleTime: ORACLE_CONFIG_STALE_TIME_MS,
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
    staleTime: ORACLE_CONFIG_STALE_TIME_MS,
  });

  // The oracle's Agent Card — the services it offers and what each costs. This
  // supersedes the `#fee` pricing list below, and the two resolve independently
  // because an oracle may publish either or both while the migration runs:
  // whichever one this oracle has must be enough to drive the contracting UI.
  // `null` means "no card published", which is a normal state, not a failure.
  const { data: agentCard, isLoading: isLoadingAgentCard } = useQuery({
    queryKey: ['agent-card', params.oracleDid],
    queryFn: () =>
      getOracleAgentCard(
        params.oracleDid,
        wallet?.matrix.accessToken,
        wallet?.matrix.homeServer,
      ),
    enabled: Boolean(params.oracleDid),
    staleTime: ORACLE_CONFIG_STALE_TIME_MS,
  });

  /** @deprecated Superseded by `agentCard`. Kept for oracles still on `#fee`. */
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
    enabled: Boolean(params.oracleDid),
    staleTime: ORACLE_CONFIG_STALE_TIME_MS,
    // A card-only oracle has no `#fee` resource at all, so this throws every
    // time and retrying only keeps `isLoadingPricingList` true through three
    // backoffs while callers wait on it. The absence is an answer, not a blip.
    retry: false,
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

        // The per-claim spend cap: the caller's explicit `maxAmount` first (the
        // agent-card lane derives it from the selected services' prices), then
        // the legacy pricing list. With neither there is no cap to grant — and
        // granting a zero cap would authorize an oracle that can never be paid,
        // so this fails loudly instead of quietly signing something useless.
        const maxAmount = params.maxAmount
          ? [
              {
                amount: params.maxAmount.amount.toString(),
                denom: params.maxAmount.denom,
              },
            ]
          : pricingList?.[0]
            ? [
                {
                  amount: pricingList[0].amount,
                  denom: pricingList[0].denom,
                },
              ]
            : undefined;

        if (useAuthz && !maxAmount) {
          throw new Error(
            `Cannot contract ${params.oracleDid}: no spend cap available. Pass \`maxAmount\` (for an oracle with an agent card, derive it from the selected services' prices), or publish a pricing list on the oracle entity.`,
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
              maxAmount,
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
    agentCard,
    isLoadingAgentCard,
    /** @deprecated Superseded by `agentCard`. */
    isLoadingPricingList,
    /** @deprecated Superseded by `agentCard`. */
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
