// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OraclesProvider } from '../../providers/oracles-provider/oracles-context.js';
import { type RoomsBotAuthFn } from '../../providers/oracles-provider/types.js';
import { useContractOracle } from './index.js';

const TOKEN = 'user-matrix-token';
const ROOMS_BOT = 'https://rooms.bot.mx.ixo.earth';
const SESSION_HOST = 'matrix.supamoto.global';

vi.hoisted(() => {
  process.env.BLOCKSYNC_GRAPHQL_URL = 'http://localhost/graphql';
  process.env.RPC_URL = 'http://localhost/rpc';
});

vi.mock('@ixo/oracles-chain-client/react', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMatrixUrlsForDid: vi.fn(async () => ({
    homeServer: 'https://mx.ixo.earth',
    homeServerCropped: 'mx.ixo.earth',
    roomsBot: ROOMS_BOT,
  })),
  getOracleAgentCard: vi.fn(async () => null),
  Authz: Object.assign(vi.fn(), {
    getOracleAuthZConfig: vi.fn(async () => ({
      granteeAddress: 'ixo1oracle',
      oracleName: 'Oracle',
    })),
  }),
}));

type Call = { url: string; authorization: string | null };

function renderContract(getRoomsBotAuth?: RoomsBotAuthFn) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <OraclesProvider
      initialWallet={{
        address: 'ixo1user',
        did: 'did:ixo:ixo1user',
        matrix: { accessToken: TOKEN, homeServer: SESSION_HOST },
      }}
      transactSignX={vi.fn()}
      createDelegation={vi.fn()}
      getRoomsBotAuth={getRoomsBotAuth}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </OraclesProvider>
  );
  return renderHook(
    () =>
      useContractOracle({
        params: {
          oracleDid: 'did:ixo:entity:oracle',
          adminAddress: 'ixo1admin',
          claimCollectionId: '1',
          userClaimCollectionId: '1',
        } as never,
      }),
    { wrapper },
  );
}

describe('useContractOracle', () => {
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          url,
          authorization: new Headers(init?.headers).get('authorization'),
        });
        if (url.endsWith('/spaces/source')) {
          return new Response(
            JSON.stringify({
              space_id: '!space:mx.ixo.earth',
              subspaces: { a: { space_id: '!sub:mx.ixo.earth' } },
            }),
          );
        }
        return new Response(
          JSON.stringify({
            roomId: '!room:mx.ixo.earth',
            room_id: '!room:mx.ixo.earth',
            chunk: [],
          }),
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('contracts on the session homeserver, with a UCAN for the rooms bot', async () => {
    const getRoomsBotAuth = vi.fn(async () => ({
      Authorization: 'Bearer ucan',
      'X-Auth-Type': 'ucan',
    }));
    const { result } = renderContract(getRoomsBotAuth);

    await act(async () => {
      await result.current.contractOracle({ useAuthz: false });
    });

    await waitFor(() =>
      expect(getRoomsBotAuth).toHaveBeenCalledWith(ROOMS_BOT),
    );
    const carrying = calls.filter(
      (call) => call.authorization === `Bearer ${TOKEN}`,
    );
    expect(carrying.length).toBeGreaterThan(0);
    expect(
      carrying.filter((call) => new URL(call.url).host !== SESSION_HOST),
    ).toEqual([]);
    expect(
      calls.find((call) => call.url.endsWith('/spaces/oracle/create'))
        ?.authorization,
    ).toBe('Bearer ucan');
  });

  it('refuses to start without getRoomsBotAuth', async () => {
    const { result } = renderContract();
    calls.length = 0;

    await expect(
      act(() => result.current.contractOracle({ useAuthz: false })),
    ).rejects.toThrow('getRoomsBotAuth');

    expect(
      calls.filter(
        (call) =>
          call.url.includes('/join/') || call.url.includes('/spaces/source'),
      ),
    ).toEqual([]);
  });
});
