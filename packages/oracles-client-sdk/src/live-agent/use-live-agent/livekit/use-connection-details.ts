/* eslint-disable no-console */
import { decodeJwt } from 'jose';
import { type IOpenIDToken } from 'matrix-js-sdk';
import { useCallback, useState } from 'react';

export type ConnectionDetails = {
  url: string;
  jwt: string;
};
const ONE_MINUTE_IN_MILLISECONDS = 60 * 1000;

const network = process.env.NEXT_PUBLIC_CHAIN_NETWORK as
  | 'devnet'
  | 'testnet'
  | 'mainnet';
const JWT_SERVER = {
  devnet: 'https://livekit-jwt.devmx.ixo.earth/sfu/get',
  testnet: 'https://livekit-jwt.testmx.ixo.earth/sfu/get',
  mainnet: 'https://livekit-jwt.mx.ixo.earth/sfu/get',
};

export default function useConnectionDetails() {
  // The details are a JWT for one LiveKit room: kept with the room they
  // were issued for, and never handed out for another.
  const [current, setCurrent] = useState<{
    roomId: string;
    details: ConnectionDetails;
  } | null>(null);
  const connectionDetails = current?.details ?? null;

  const fetchConnectionDetails = useCallback(
    async (roomId: string, openIdToken: IOpenIDToken) => {
      setCurrent(null);
      const url = process.env.NEXT_PUBLIC_JWT_SERVER ?? JWT_SERVER[network];

      let data: ConnectionDetails;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            room: roomId,
            openid_token: {
              access_token: openIdToken?.access_token,
              expires_in: 3600,
              matrix_server_name: openIdToken?.matrix_server_name,
              token_type: 'Bearer',
            },
            device_id: 'PORTAL',
          }),
        });
        if (!res.ok) {
          throw new Error(`the JWT service answered ${res.status}`);
        }
        data = await res.json();
      } catch (error) {
        console.error('Error fetching connection details:', error);
        throw new Error('Error fetching connection details!', {
          cause: error,
        });
      }

      setCurrent({ roomId, details: data });
      return data;
    },
    [],
  );

  // useEffect(() => {
  //   fetchConnectionDetails();
  // }, [fetchConnectionDetails]);

  const isConnectionDetailsExpired = useCallback(() => {
    const token = current?.details.jwt;
    if (!token) {
      return true;
    }

    const jwtPayload = decodeJwt(token);
    if (!jwtPayload.exp) {
      return true;
    }
    // `exp` is in seconds; the details count as expired a minute early.
    return jwtPayload.exp * 1000 - ONE_MINUTE_IN_MILLISECONDS <= Date.now();
  }, [current?.details.jwt]);

  const existingOrRefreshConnectionDetails = useCallback(
    async (roomId: string, openIdToken: IOpenIDToken) => {
      if (
        !current ||
        current.roomId !== roomId ||
        isConnectionDetailsExpired()
      ) {
        return fetchConnectionDetails(roomId, openIdToken);
      }
      return current.details;
    },
    [current, fetchConnectionDetails, isConnectionDetailsExpired],
  );

  return {
    connectionDetails,
    refreshConnectionDetails: fetchConnectionDetails,
    existingOrRefreshConnectionDetails,
  };
}
