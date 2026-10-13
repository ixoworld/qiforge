import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import MatrixClient from '../matrix/matrix-client.js';
import { useOraclesContext } from '../providers/oracles-provider/oracles-context.js';
import { authzConfigQueryOptions } from './authz-config-query.js';

export const useMemoryEngine = (oracleDid: string) => {
  const { wallet } = useOraclesContext();
  const matrixClientRef = useMemo(
    () =>
      new MatrixClient({
        userAccessToken: wallet?.matrix.accessToken ?? '',
      }),
    [wallet?.matrix.accessToken],
  );

  const { data: authzConfig } = useQuery(
    authzConfigQueryOptions(oracleDid, wallet),
  );

  const { data: oracleRoomId, isLoading: isLoadingOracleRoomId } = useQuery({
    queryKey: ['oracle-room-id', authzConfig?.granteeAddress, wallet?.did],
    queryFn: async () => {
      const roomId = await matrixClientRef.getOracleRoomIdWithDid({
        userDid: wallet?.did ?? '',
        oracleEntityDid: oracleDid,
      });
      return roomId;
    },
    enabled: Boolean(
      wallet?.did &&
      authzConfig?.granteeAddress &&
      wallet.matrix.accessToken &&
      oracleDid,
    ),
  });

  // list members in a room
  const {
    data: members,
    isLoading: isLoadingMembers,
    refetch: refetchMembers,
  } = useQuery({
    queryKey: ['members', authzConfig?.granteeAddress, wallet?.did],
    queryFn: async () => {
      if (!oracleRoomId || !wallet?.did) {
        return [];
      }
      const m = await matrixClientRef.listRoomMembersWithDid(
        oracleRoomId,
        wallet.did,
      );
      return m;
    },
    enabled: Boolean(oracleRoomId && wallet?.did),
  });

  const inviteUserFn = useCallback(
    async (userId: string) => {
      const roomId =
        oracleRoomId ??
        (await matrixClientRef.getOracleRoomIdWithDid({
          userDid: wallet?.did ?? '',
          oracleEntityDid: oracleDid,
        }));
      if (!roomId) {
        throw new Error('Oracle room id not found');
      }
      await matrixClientRef.inviteUserWithDid(
        roomId,
        userId,
        wallet?.did ?? '',
      );
      await refetchMembers();
    },
    [oracleRoomId, authzConfig?.granteeAddress, wallet?.did, oracleDid],
  );

  const { mutateAsync: inviteUser, isPending: isInvitingUser } = useMutation({
    mutationFn: inviteUserFn,
  });

  const enableMemoryEngineFn = useCallback(
    async (memoryEngineUserId: string) => {
      const roomId =
        oracleRoomId ??
        (await matrixClientRef.getOracleRoomIdWithDid({
          userDid: wallet?.did ?? '',
          oracleEntityDid: oracleDid,
        }));
      if (!roomId) {
        throw new Error('Oracle room id not found');
      }
      await matrixClientRef.inviteUserWithDid(
        roomId,
        memoryEngineUserId,
        wallet?.did ?? '',
      );
      await matrixClientRef.setPowerLevelWithDid(
        roomId,
        memoryEngineUserId,
        50,
        wallet?.did ?? '',
      );
      await refetchMembers();
    },
    [oracleRoomId, authzConfig?.granteeAddress, wallet?.did, oracleDid],
  );

  const { mutateAsync: enableMemoryEngine, isPending: isLoadingMemoryEngine } =
    useMutation({
      mutationFn: enableMemoryEngineFn,
    });

  return {
    inviteUser,
    isInvitingUser,
    isLoadingOracleRoomId,
    oracleRoomId,
    isLoadingMembers,
    members,
    enableMemoryEngine,
    isLoadingMemoryEngine,
  };
};
