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
import {
  type IOraclesContextProps,
  type IOraclesProviderProps,
} from './types.js';

const OraclesContext = createContext<IOraclesContextProps | undefined>(
  undefined,
);

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
}: PropsWithChildren<IOraclesProviderProps>) => {
  if ((!initialWallet as unknown) || !transactSignX) {
    throw new Error('initialWallet and transactSignX are required');
  }

  // AG-UI action state management
  const [agActions, setAgActions] = useState<AgAction[]>([]);
  const [registeredAgActions, setRegisteredAgActions] = useState<AgAction[]>(
    [],
  );
  const agActionHandlers = useRef<
    Map<string, (args: unknown) => Promise<unknown> | unknown>
  >(new Map());
  const agActionRenders = useRef<
    Map<string, (props: Record<string, unknown>) => React.ReactElement | null>
  >(new Map());

  const getDelegation = useCallback(
    async (oracleDid: string): Promise<string | null> => {
      // Check cache first
      const cached = getCachedDelegation(initialWallet.did, oracleDid);
      if (cached) return cached;

      // No callback provided — skip delegation
      if (!createDelegation) return null;

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
    [initialWallet.did, createDelegation],
  );

  const getInvocation = useCallback(
    async (oracleDid: string): Promise<string | null> => {
      // Check cache first
      const cached = getCachedInvocation(initialWallet.did, oracleDid);
      if (cached) return cached;

      // No callback provided — skip invocation (migration-safe)
      if (!createInvocation) return null;

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
      setRegisteredAgActions((prev) => {
        const exists = prev.some((a) => a.name === action.name);
        if (exists) {
          return prev.map((a) => (a.name === action.name ? action : a));
        }
        return [...prev, action];
      });

      setAgActions((prev) => {
        if (action.exposeToAgent === false) {
          return prev.filter((a) => a.name !== action.name);
        }
        const exists = prev.some((a) => a.name === action.name);
        if (exists) {
          return prev.map((a) => (a.name === action.name ? action : a));
        }
        return [...prev, action];
      });

      agActionHandlers.current.set(action.name, handler);
      if (render) {
        agActionRenders.current.set(action.name, render);
      }
    },
    [],
  );

  const unregisterAgAction = useCallback((name: string) => {
    setAgActions((prev) => prev.filter((a) => a.name !== name));
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

  const queryClient = new QueryClient();
  return (
    <OraclesContext.Provider value={value}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </OraclesContext.Provider>
  );
};
