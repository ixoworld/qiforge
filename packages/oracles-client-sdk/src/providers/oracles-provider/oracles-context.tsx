/* eslint-disable no-console */
'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { request } from '../../utils/request.js';
import {
  getCachedDelegation,
  setCachedDelegation,
} from '../../utils/delegation-cache.js';
import {
  getCachedInvocation,
  setCachedInvocation,
} from '../../utils/invocation-cache.js';
import type { AgAction } from '../../hooks/use-ag-action.js';
import { agentVisibleAgActions, upsertAgAction } from './ag-actions.js';
import {
  type IOraclesContextProps,
  type IOraclesProviderProps,
} from './types.js';

const OraclesContext = createContext<IOraclesContextProps | undefined>(
  undefined,
);

/** Join the mint in flight for `key`, or start one and register it until it settles. */
function shareMint(
  pending: Map<string, Promise<string | null>>,
  key: string,
  mint: () => Promise<string | null>,
): Promise<string | null> {
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const minting = mint().finally(() => {
    if (pending.get(key) === minting) pending.delete(key);
  });
  pending.set(key, minting);
  return minting;
}

export const useOraclesContext = () => {
  const context = useContext(OraclesContext);
  if (context === undefined) {
    throw new Error('useOraclesContext must be used within a OraclesProvider');
  }
  return context;
};

export const OraclesProvider = ({
  children,
  initialWallet,
  transactSignX,
  createDelegation,
  createInvocation,
  queryClient: externalQueryClient,
}: PropsWithChildren<IOraclesProviderProps>) => {
  if ((!initialWallet as unknown) || !transactSignX) {
    throw new Error('initialWallet and transactSignX are required');
  }

  // AG-UI action state management: every registered action is executable
  // over the socket; only the agent-visible ones are offered to the agent.
  const [registeredAgActions, setRegisteredAgActions] = useState<AgAction[]>(
    [],
  );
  const agActions = useMemo(
    () => agentVisibleAgActions(registeredAgActions),
    [registeredAgActions],
  );
  const agActionHandlers = useRef<
    Map<string, (args: unknown) => Promise<unknown> | unknown>
  >(new Map());
  const agActionRenders = useRef<
    Map<string, (props: Record<string, unknown>) => React.ReactElement | null>
  >(new Map());

  // Mints in flight, per user and oracle: callers that miss the cache at the
  // same moment (sessions, history, socket and run check all start together
  // on a cold cache) share one mint instead of each signing their own. An
  // entry is removed when its mint settles, so a failed mint can be retried.
  const pendingDelegations = useRef(new Map<string, Promise<string | null>>());
  const pendingInvocations = useRef(new Map<string, Promise<string | null>>());

  const getDelegation = useCallback(
    async (oracleDid: string): Promise<string | null> => {
      // Check cache first
      const cached = getCachedDelegation(initialWallet.did, oracleDid);
      if (cached) return cached;

      // No callback provided — skip delegation
      if (!createDelegation) return null;

      return shareMint(
        pendingDelegations.current,
        `${initialWallet.did}::${oracleDid}`,
        async () => {
          try {
            const result = await createDelegation(oracleDid);
            setCachedDelegation(
              initialWallet.did,
              oracleDid,
              result.serialized,
              result.expiresAt,
            );
            return result.serialized;
          } catch (error) {
            console.warn('Failed to create UCAN delegation:', error);
            return null;
          }
        },
      );
    },
    [initialWallet.did, createDelegation],
  );

  const getInvocation = useCallback(
    async (
      oracleDid: string,
      options?: { fresh?: boolean },
    ): Promise<string | null> => {
      // Check cache first
      if (!options?.fresh) {
        const cached = getCachedInvocation(initialWallet.did, oracleDid);
        if (cached) return cached;
      }

      // No callback provided — skip invocation (migration-safe)
      if (!createInvocation) return null;

      // A mint already in flight is as fresh as a new one.
      return shareMint(
        pendingInvocations.current,
        `${initialWallet.did}::${oracleDid}`,
        async () => {
          try {
            const result = await createInvocation(oracleDid);
            setCachedInvocation(
              initialWallet.did,
              oracleDid,
              result.serialized,
              result.expiresAt,
            );
            return result.serialized;
          } catch (error) {
            console.warn('Failed to create UCAN invocation:', error);
            return null;
          }
        },
      );
    },
    [initialWallet.did, createInvocation],
  );

  const authedRequest = useCallback(
    async (
      url: string,
      method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      options?: RequestInit,
      oracleDid?: string,
    ) => {
      const headers: Record<string, string> = {
        ...(options?.headers as Record<string, string>),
      };

      if (oracleDid) {
        const delegation = await getDelegation(oracleDid);
        if (delegation) {
          headers['x-ucan-delegation'] = delegation;
        }

        const invocation = await getInvocation(oracleDid);
        if (invocation) {
          headers['Authorization'] = `Bearer ${invocation}`;
          headers['X-Auth-Type'] = 'ucan';
        }
      }

      return request(url, method, {
        ...options,
        headers,
      });
    },
    [getDelegation, getInvocation],
  );

  // AG-UI action management functions
  const registerAgAction = useCallback(
    (
      action: AgAction,
      handler: (args: unknown) => Promise<unknown> | unknown,
      render?: (props: Record<string, unknown>) => React.ReactElement | null,
    ) => {
      setRegisteredAgActions((prev) => upsertAgAction(prev, action));

      agActionHandlers.current.set(action.name, handler);
      if (render) {
        agActionRenders.current.set(action.name, render);
      }
    },
    [],
  );

  const unregisterAgAction = useCallback((name: string) => {
    setRegisteredAgActions((prev) => prev.filter((a) => a.name !== name));
    agActionHandlers.current.delete(name);
    agActionRenders.current.delete(name);
  }, []);

  const executeAgAction = useCallback(async (name: string, args: unknown) => {
    const handler = agActionHandlers.current.get(name);
    if (!handler) {
      throw new Error(`AG-UI action '${name}' not found`);
    }
    return await handler(args);
  }, []);

  const getAgActionRender = useCallback((name: string) => {
    return agActionRenders.current.get(name);
  }, []);

  const value: IOraclesContextProps = useMemo(
    () => ({
      wallet: initialWallet,
      transactSignX,
      authedRequest: authedRequest as <T>(
        url: string,
        method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
        options?: RequestInit,
        oracleDid?: string,
      ) => Promise<T>,
      getDelegation,
      getInvocation,
      agActions,
      registeredAgActions,
      registerAgAction,
      unregisterAgAction,
      executeAgAction,
      getAgActionRender,
    }),
    [
      initialWallet,
      transactSignX,
      authedRequest,
      getDelegation,
      getInvocation,
      agActions,
      registeredAgActions,
      registerAgAction,
      unregisterAgAction,
      executeAgAction,
      getAgActionRender,
    ],
  );

  // Config-style queries barely change; without defaults every remount and
  // window focus refetches them all.
  const [ownQueryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  const queryClient = externalQueryClient ?? ownQueryClient;
  return (
    <OraclesContext.Provider value={value}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </OraclesContext.Provider>
  );
};
