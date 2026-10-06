// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IOraclesContextProps,
  IWalletProps,
} from '../providers/oracles-provider/types.js';
import { historyQueryOptions } from './use-chat/v2/history-query.js';
import { useMemoryEngine } from './use-memory-engine.js';
import { useOracleSessions } from './use-oracle-sessions/use-oracle-sessions.js';
import { useOraclesConfig } from './use-oracles-config.js';

const ORACLE = 'did:ixo:oracle';

const getOracleAuthZConfig = vi.fn();
vi.mock('@ixo/oracles-chain-client/react', () => ({
  Authz: {
    getOracleAuthZConfig: (input: { granterAddress: string }) =>
      getOracleAuthZConfig(input),
  },
  gqlClient: {
    GetEntityById: async () => ({
      entity: {
        service: [
          {
            id: '{id}#api',
            type: 'oracleService',
            serviceEndpoint: 'https://oracle.test',
          },
        ],
      },
    }),
  },
}));

let context: IOraclesContextProps;
vi.mock('../providers/oracles-provider/oracles-context.js', () => ({
  useOraclesContext: () => context,
}));

const walletA: IWalletProps = {
  did: 'did:ixo:user-a',
  address: 'ixo1usera',
  matrix: { accessToken: 'mx-a', homeServer: 'hs' },
};
const walletB: IWalletProps = {
  did: 'did:ixo:user-b',
  address: 'ixo1userb',
  matrix: { accessToken: 'mx-b', homeServer: 'hs' },
};

function makeContext(
  wallet: IWalletProps,
  authedRequest: IOraclesContextProps['authedRequest'],
): IOraclesContextProps {
  return {
    wallet,
    transactSignX: vi.fn(),
    authedRequest,
    getDelegation: vi.fn(async () => 'delegation'),
    getInvocation: vi.fn(async () => null),
    agActions: [],
    registeredAgActions: [],
    registerAgAction: vi.fn(),
    unregisterAgAction: vi.fn(),
    executeAgAction: vi.fn(),
    getAgActionRender: vi.fn(),
  };
}

/** One query client across the account switch, as the provider keeps it. */
function wrapperFor(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const providerLikeClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: false },
    },
  });

describe('per-user query caching', () => {
  beforeEach(() => {
    getOracleAuthZConfig.mockReset();
  });

  it("after an account switch the sessions list is the new user's, never the previous user's cache", async () => {
    const requestedBy = vi.fn();
    // A JSON round trip, as the real request function's body parse.
    const sessionsOf =
      (owner: string) =>
      async <T,>(): Promise<T> => {
        requestedBy(owner);
        return new Response(
          JSON.stringify({
            sessions: [{ sessionId: `${owner}-1`, title: `${owner}'s chat` }],
            total: 1,
          }),
        ).json();
      };
    context = makeContext(walletA, sessionsOf('a'));
    const { result, rerender } = renderHook(
      () => useOracleSessions(ORACLE, { baseUrl: 'https://oracle.test' }),
      { wrapper: wrapperFor(providerLikeClient()) },
    );
    await waitFor(() =>
      expect(result.current.sessions.map((s) => s.sessionId)).toEqual(['a-1']),
    );

    context = makeContext(walletB, sessionsOf('b'));
    rerender();
    await waitFor(() =>
      expect(result.current.sessions.map((s) => s.sessionId)).toEqual(['b-1']),
    );
    expect(requestedBy).toHaveBeenCalledWith('b');
  });

  it("after an account switch the oracle's authz config is fetched for the new granter", async () => {
    getOracleAuthZConfig.mockImplementation(
      async ({ granterAddress }: { granterAddress: string }) => ({
        granter: granterAddress,
      }),
    );
    context = makeContext(walletA, vi.fn());
    const { result, rerender } = renderHook(() => useOraclesConfig(ORACLE), {
      wrapper: wrapperFor(providerLikeClient()),
    });
    await waitFor(() =>
      expect(result.current.config.authConfig).toEqual({
        granter: 'ixo1usera',
      }),
    );

    context = makeContext(walletB, vi.fn());
    rerender();
    await waitFor(() =>
      expect(result.current.config.authConfig).toEqual({
        granter: 'ixo1userb',
      }),
    );
  });

  it('the oracle config and the memory engine share one authz config request', async () => {
    getOracleAuthZConfig.mockImplementation(
      async ({ granterAddress }: { granterAddress: string }) => ({
        granter: granterAddress,
      }),
    );
    context = makeContext(walletA, vi.fn());
    const { result } = renderHook(
      () => ({
        config: useOraclesConfig(ORACLE),
        memory: useMemoryEngine(ORACLE),
      }),
      { wrapper: wrapperFor(providerLikeClient()) },
    );
    await waitFor(() =>
      expect(result.current.config.config.authConfig).toEqual({
        granter: 'ixo1usera',
      }),
    );
    expect(getOracleAuthZConfig).toHaveBeenCalledTimes(1);
  });

  it("the history cache key names the user, so one user's transcript is never served to another", () => {
    const keyFor = (userDid: string) =>
      historyQueryOptions({
        userDid,
        oracleDid: ORACLE,
        sessionId: 's',
        apiUrl: 'https://oracle.test',
        pageSize: 2,
        request: vi.fn(),
      }).queryKey;
    expect(keyFor(walletA.did)).not.toEqual(keyFor(walletB.did));
    expect(keyFor(walletA.did)).toContain(walletA.did);
  });
});
