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
import { request, RequestError } from '../../utils/request.js';
import {
  isCredentialRefusal,
  withAuthRenewal,
  type AuthRenewalStage,
  type RefusedCredentials,
} from '../../utils/auth-renewal.js';
import {
  getCachedDelegation,
  removeCachedDelegation,
  setCachedDelegation,
} from '../../utils/delegation-cache.js';
import {
  getCachedInvocation,
  removeCachedInvocation,
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

/** Start `run` and register it under `key` until it settles (replacing any entry). */
function startShared<T>(
  pending: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const running = run().finally(() => {
    if (pending.get(key) === running) pending.delete(key);
  });
  pending.set(key, running);
  return running;
}

/** Join the work in flight for `key`, or start it and register it until it settles. */
function shareInFlight<T>(
  pending: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  return pending.get(key) ?? startShared(pending, key, run);
}

/**
 * A stage-2 renewal does not replace a delegation that stage 2 itself
 * minted less than this long ago: one refused that soon is refused for a
 * reason a new mint does not change, and every mint asks the user for their
 * key again.
 */
const DELEGATION_RENEWAL_COOLDOWN_MS = 10 * 60 * 1000;

/** A request body that cannot be sent a second time. */
const isOneShotBody = (body: RequestInit['body']): boolean =>
  typeof ReadableStream !== 'undefined' && body instanceof ReadableStream;

type RequestOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** The caller's headers as a plain record (a `Headers` or entry list too). */
function headersRecord(init: HeadersInit | undefined): Record<string, string> {
  if (!init) return {};
  if (init instanceof Headers || Array.isArray(init))
    return Object.fromEntries(new Headers(init));
  return { ...init };
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
  onDelegationRenewed,
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
  // Renewals in flight, per user, oracle and stage: requests, the socket and
  // a re-join refused at the same moment share one renewal.
  const pendingRenewals = useRef(new Map<string, Promise<boolean>>());
  // The delegation the last stage-2 renewal minted, per user and oracle.
  const renewedDelegations = useRef(
    new Map<string, { delegation: string; at: number }>(),
  );

  const mintDelegation = useCallback(
    async (oracleDid: string): Promise<string | null> => {
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

  const mintInvocation = useCallback(
    async (oracleDid: string): Promise<string | null> => {
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

  const getDelegation = useCallback(
    async (
      oracleDid: string,
      options?: { fresh?: boolean },
    ): Promise<string | null> => {
      if (options?.fresh) {
        // Dropped before the mint starts, so a reader that comes along
        // meanwhile joins the mint instead of taking the stale one.
        removeCachedDelegation(initialWallet.did, oracleDid);
      } else {
        const cached = getCachedDelegation(initialWallet.did, oracleDid);
        if (cached) return cached;
      }

      // No callback provided — skip delegation
      if (!createDelegation) return null;

      // A mint already in flight started after the cached one was dropped
      // (or there was none): it is as fresh as a new one.
      return shareInFlight(
        pendingDelegations.current,
        `${initialWallet.did}::${oracleDid}`,
        () => mintDelegation(oracleDid),
      );
    },
    [initialWallet.did, createDelegation, mintDelegation],
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
      return shareInFlight(
        pendingInvocations.current,
        `${initialWallet.did}::${oracleDid}`,
        () => mintInvocation(oracleDid),
      );
    },
    [initialWallet.did, createInvocation, mintInvocation],
  );

  const renewOracleAuth = useCallback(
    (
      oracleDid: string,
      stage: AuthRenewalStage,
      refused?: RefusedCredentials,
    ): Promise<boolean> => {
      const userDid = initialWallet.did;
      const key = `${userDid}::${oracleDid}`;
      return shareInFlight(
        pendingRenewals.current,
        `${key}::${stage}`,
        async () => {
          if (stage === 1) {
            if (!createInvocation) return false;
            // Another caller renewed it since the refused request was sent.
            const current = getCachedInvocation(userDid, oracleDid);
            if (
              refused?.invocation !== undefined &&
              current &&
              current !== refused.invocation
            )
              return true;
            return (await getInvocation(oracleDid, { fresh: true })) !== null;
          }

          if (!createDelegation) return false;
          const current = getCachedDelegation(userDid, oracleDid);
          if (
            refused?.delegation !== undefined &&
            current &&
            current !== refused.delegation
          )
            return true;
          const last = renewedDelegations.current.get(key);
          if (
            last &&
            Date.now() - last.at < DELEGATION_RENEWAL_COOLDOWN_MS &&
            (refused?.delegation === undefined ||
              refused.delegation === last.delegation)
          ) {
            console.warn(
              `[oracles-client-sdk] ${oracleDid} refused a delegation minted ${Math.round((Date.now() - last.at) / 1000)}s ago; not asking for another one yet`,
            );
            return false;
          }

          // The cached invocation may be proved by the refused delegation.
          removeCachedInvocation(userDid, oracleDid);
          const delegation = await getDelegation(oracleDid, { fresh: true });
          if (!delegation) return false;
          renewedDelegations.current.set(key, { delegation, at: Date.now() });
          if (onDelegationRenewed) {
            void Promise.resolve()
              .then(() => onDelegationRenewed(oracleDid, delegation))
              .catch((error: unknown) => {
                console.warn('onDelegationRenewed failed:', error);
              });
          }
          if (!createInvocation) return true;
          // Not joined to an invocation mint in flight: that one may have
          // started before the new delegation existed.
          const invocation = await startShared(
            pendingInvocations.current,
            key,
            () => mintInvocation(oracleDid),
          );
          return invocation !== null;
        },
      );
    },
    [
      initialWallet.did,
      createDelegation,
      createInvocation,
      onDelegationRenewed,
      getDelegation,
      getInvocation,
      mintInvocation,
    ],
  );

  const authedRequest = useCallback(
    async <T,>(
      url: string,
      method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      options?: RequestInit,
      oracleDid?: string,
    ): Promise<T> => {
      let sent: RefusedCredentials = {};
      const attempt = async (): Promise<RequestOutcome<T>> => {
        const headers = headersRecord(options?.headers);
        if (oracleDid) {
          const delegation = await getDelegation(oracleDid);
          if (delegation) headers['x-ucan-delegation'] = delegation;
          const invocation = await getInvocation(oracleDid);
          if (invocation) {
            headers['Authorization'] = `Bearer ${invocation}`;
            headers['X-Auth-Type'] = 'ucan';
          }
          sent = { delegation, invocation };
        }
        try {
          return {
            ok: true,
            value: await request<T>(url, method, { ...options, headers }),
          };
        } catch (error) {
          return { ok: false, error };
        }
      };
      const { outcome } = await withAuthRenewal({
        attempt,
        isRefused: (result) =>
          !result.ok &&
          RequestError.isRequestError(result.error) &&
          isCredentialRefusal(result.error.status, result.error.code),
        renew:
          oracleDid && !isOneShotBody(options?.body)
            ? (stage) => renewOracleAuth(oracleDid, stage, sent)
            : undefined,
        signal: options?.signal ?? undefined,
      });
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
    [getDelegation, getInvocation, renewOracleAuth],
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
      authedRequest,
      getDelegation,
      getInvocation,
      renewOracleAuth,
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
      renewOracleAuth,
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
