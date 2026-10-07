import type { TransactionFn } from '@ixo/oracles-chain-client/react';
import type { QueryClient } from '@tanstack/react-query';
import type { AgAction } from '../../hooks/use-ag-action.js';
import type {
  AuthRenewalStage,
  RefusedCredentials,
} from '../../utils/auth-renewal.js';

export type { AuthRenewalStage, RefusedCredentials };

export interface IMatrixLoginProps {
  accessToken: string;
  homeServer: string;
}

export interface IWalletProps {
  address: string;
  did: string;
  matrix: IMatrixLoginProps;
}

export interface DelegationResult {
  serialized: string;
  expiresAt: number;
}

export type CreateDelegationFn = (
  oracleDid: string,
) => Promise<DelegationResult>;

export interface InvocationResult {
  serialized: string;
  expiresAt: number;
}

export type CreateInvocationFn = (
  oracleDid: string,
) => Promise<InvocationResult>;

export interface IOraclesContextProps {
  wallet: IWalletProps | null;
  transactSignX: TransactionFn;
  authedRequest: <T>(
    url: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    options?: RequestInit,
    oracleDid?: string,
  ) => Promise<T>;
  /**
   * The cached delegation to this oracle, or a newly minted one. `fresh`
   * drops the cached one and mints a replacement (callers that ask at the
   * same moment share one mint). Minting a delegation needs the user's key;
   * prefer `renewOracleAuth`, which mints one only as the last resort.
   */
  getDelegation: (
    oracleDid: string,
    options?: { fresh?: boolean },
  ) => Promise<string | null>;
  /**
   * The cached invocation for this oracle, or a newly minted one. `fresh`
   * skips the cache (the oracle refused the cached one).
   */
  getInvocation: (
    oracleDid: string,
    options?: { fresh?: boolean },
  ) => Promise<string | null>;
  /**
   * Renew this oracle's credentials after it refused a request for them,
   * then repeat the request. Stage 1 mints a fresh invocation; stage 2 —
   * only after a request repeated after stage 1 was refused too — mints a
   * fresh delegation, then a fresh invocation. Pass the credentials the
   * refused request carried: when another caller renewed them meanwhile,
   * nothing is minted and the current ones are used. Callers refused at
   * the same moment share one renewal. Resolves `false` when there is
   * nothing to repeat with (no mint callback, the mint failed, or a stage 2
   * would replace a delegation stage 2 minted minutes ago that is refused
   * already) — the caller gives up then.
   */
  renewOracleAuth: (
    oracleDid: string,
    stage: AuthRenewalStage,
    refused?: RefusedCredentials,
  ) => Promise<boolean>;
  // AG-UI action management
  /** Actions offered to the agent with each turn (`exposeToAgent` not false). */
  agActions: AgAction[];
  /** Every registered action, hidden ones included: what the socket can execute. */
  registeredAgActions: AgAction[];
  registerAgAction: (
    action: AgAction,
    handler: (args: unknown) => Promise<unknown> | unknown,
    render?: (props: Record<string, unknown>) => React.ReactElement | null,
  ) => void;
  unregisterAgAction: (name: string) => void;
  executeAgAction: (name: string, args: unknown) => Promise<unknown>;
  getAgActionRender: (
    name: string,
  ) =>
    | ((props: Record<string, unknown>) => React.ReactElement | null)
    | undefined;
}

export interface IOraclesProviderProps {
  initialWallet: IWalletProps;
  transactSignX: TransactionFn;
  createDelegation: CreateDelegationFn;
  createInvocation?: CreateInvocationFn;
  /**
   * A delegation was minted to replace one the oracle refused (stage 2 of
   * `renewOracleAuth`). The oracle adopts it from the next request that
   * carries it; a host that also deposits the delegation for header-less
   * turns (`POST /delegation`, which Matrix ingress falls back to) deposits
   * the new one here. Called without being awaited; a failure is logged.
   */
  onDelegationRenewed?: (
    oracleDid: string,
    delegation: string,
  ) => void | Promise<void>;
  /**
   * Share the host app's react-query client instead of the SDK creating its
   * own. Without this, hosts that already mount a QueryClientProvider get a
   * second client (and second cache) shadowing theirs for the SDK subtree.
   */
  queryClient?: QueryClient;
}
