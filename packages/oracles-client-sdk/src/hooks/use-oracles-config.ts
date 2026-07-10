/* eslint-disable no-console */
import { useOraclesContext } from '../providers/oracles-provider/oracles-context.js';

import { Authz, gqlClient } from '@ixo/oracles-chain-client/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

type Service = {
  type: string;
  serviceEndpoint: string;
  id: string;
};

// Oracle entity documents change rarely; a generous staleTime keeps remounting
// consumers from refetching the same config.
const ORACLES_CONFIG_STALE_TIME_MS = 5 * 60 * 1000;

export const useOraclesConfig = (
  oracleId: string,
  overrides?: {
    baseUrl?: string;
  },
) => {
  const { wallet } = useOraclesContext();

  const { data, isLoading } = useQuery({
    queryKey: ['oracles-config', oracleId],
    queryFn: async () => {
      const res = await gqlClient.GetEntityById({ id: oracleId });
      return res.entity;
    },
    enabled: Boolean(oracleId),
    staleTime: ORACLES_CONFIG_STALE_TIME_MS,
  });

  const { data: authConfig, isLoading: isLoadingAuthConfig } = useQuery({
    queryKey: ['oracles-config', oracleId, 'authConfig'],
    queryFn: () =>
      Authz.getOracleAuthZConfig({
        oracleDid: oracleId,
        granterAddress: wallet?.address ?? '',
        matrixAccessToken: wallet?.matrix.accessToken,
        matrixHomeServer: wallet?.matrix.homeServer,
      }),
    enabled: Boolean(wallet?.address && oracleId),
    staleTime: ORACLES_CONFIG_STALE_TIME_MS,
  });

  const apiUrl = useMemo(() => {
    if (!data?.service) return null;
    if (Array.isArray(data.service)) {
      const url = data.service.find(
        (service: Service) =>
          service.type === 'oracleService' || service.id === '{id}#api',
      ) as Service | undefined;
      if (!url) {
        if (overrides?.baseUrl) {
          return overrides.baseUrl;
        }
        return null;
      }
      // validate url
      try {
        const urlObj = new URL(url.serviceEndpoint);
        return urlObj.origin;
      } catch (error) {
        console.error(error, url);
        throw new Error(`Invalid url: ${url.serviceEndpoint}`, {
          cause: error,
        });
      }
    }
    return null;
  }, [data?.service]);

  const socketUrl = useMemo(() => {
    if (!data?.service) return null;
    if (Array.isArray(data.service)) {
      const service = data.service.find(
        (s: Service) => s.type === 'wsService' || s.id === '{id}#ws',
      ) as Service | undefined;
      if (!service) return null;
      try {
        const urlObj = new URL(service.serviceEndpoint);
        return urlObj.origin;
      } catch (error) {
        console.error(error, service);
        return null;
      }
    }
  }, [data?.service]);

  // Config is ready when we have an API URL AND queries are not loading
  const isReady = useMemo(() => {
    const hasUrl = Boolean(overrides?.baseUrl || apiUrl);
    const notLoading = !isLoading && !isLoadingAuthConfig;
    return hasUrl && notLoading;
  }, [overrides?.baseUrl, apiUrl, isLoading, isLoadingAuthConfig]);

  return {
    config: {
      authConfig,
      apiUrl,
      socketUrl,
    },
    isLoading: isLoading || isLoadingAuthConfig,
    isReady,
  };
};
