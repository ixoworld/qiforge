// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type PropsWithChildren, StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { IOraclesContextProps } from '../../../providers/oracles-provider/types.js';
import { type HistoryData, historyQueryOptions } from './history-query.js';
import type { IMessage } from './types.js';
import { useChat } from './use-chat.js';

const API = 'https://oracle.test';
const ORACLE = 'did:ixo:oracle';
const USER = 'did:ixo:user-a';

// Every JSON GET the chat makes on mount: the running-turn check finds none.
const noRunningTurn = async <T,>(): Promise<T> =>
  new Response(JSON.stringify({ run: null })).json();
const context: IOraclesContextProps = {
  wallet: {
    did: USER,
    address: 'ixo1usera',
    matrix: { accessToken: 'mx', homeServer: 'hs' },
  },
  transactSignX: vi.fn(),
  authedRequest: noRunningTurn,
  getDelegation: vi.fn(async () => 'delegation'),
  getInvocation: vi.fn(async () => null),
  agActions: [],
  registeredAgActions: [],
  registerAgAction: vi.fn(),
  unregisterAgAction: vi.fn(),
  executeAgAction: vi.fn(),
  getAgActionRender: vi.fn(),
};
vi.mock('../../../providers/oracles-provider/oracles-context.js', () => ({
  useOraclesContext: () => context,
}));
vi.mock('../../use-oracles-config.js', () => ({
  useOraclesConfig: () => ({ config: { apiUrl: API }, isReady: true }),
}));
vi.mock('../../use-oracle-sessions/use-oracle-sessions.js', () => ({
  useOracleSessions: () => ({ refetch: vi.fn(async () => undefined) }),
}));
vi.mock('../../use-websocket-events/use-websocket-events.js', () => ({
  useWebSocketEvents: () => ({ isConnected: false }),
}));

const history: IMessage[] = [
  { id: 'h1', type: 'human', content: 'hello' },
  { id: 'a1', type: 'ai', content: 'hi there' },
];

describe('useChat', () => {
  it('under StrictMode a session whose history is already cached shows it', async () => {
    // The provider's defaults: cached history is fresh for a minute, so the
    // remount does not refetch it.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 60_000, refetchOnWindowFocus: false },
      },
    });
    const key = historyQueryOptions({
      userDid: USER,
      oracleDid: ORACLE,
      sessionId: 'sess',
      apiUrl: API,
      pageSize: 20,
      request: noRunningTurn,
    }).queryKey;
    queryClient.setQueryData<HistoryData>(key, {
      pages: [
        {
          messages: history,
          prevCursor: null,
          nextCursor: 'a1',
          hasOlder: false,
          hasNewer: false,
        },
      ],
      pageParams: [null],
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </StrictMode>
    );

    const { result } = renderHook(
      () =>
        useChat({
          oracleDid: ORACLE,
          sessionId: 'sess',
          onPaymentRequiredError: () => undefined,
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.messages.map((m) => m.id)).toEqual(['h1', 'a1']),
    );
    // Still there once every pending update has landed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current.messages.map((m) => m.id)).toEqual(['h1', 'a1']);
  });
});
