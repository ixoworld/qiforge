import type { TransactionFn } from '@ixo/oracles-chain-client/react';
import type { QueryClient } from '@tanstack/react-query';
import type { AgAction } from '../../hooks/use-ag-action.js';

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
  getDelegation: (oracleDid: string) => Promise<string | null>;
  getInvocation: (oracleDid: string) => Promise<string | null>;
  // AG-UI action management
  agActions: AgAction[];
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
   * Share the host app's react-query client instead of the SDK creating its
   * own. Without this, hosts that already mount a QueryClientProvider get a
   * second client (and second cache) shadowing theirs for the SDK subtree.
   */
  queryClient?: QueryClient;
}
