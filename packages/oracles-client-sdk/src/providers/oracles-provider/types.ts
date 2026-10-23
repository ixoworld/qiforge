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

export interface CreateInvocationOptions {
  /**
   * The SDK mints for a request the user did not start (a status poll).
   * The host must then mint without any user interaction — no PIN or
   * passkey prompt, and without extending the signer's idle timer — and
   * resolve `null` (or an empty `serialized`) when it cannot, e.g. while
   * the signer is locked. The request then fails as refused and is not
   * retried interactively. A host that ignores the argument keeps minting
   * as it always did, prompts included.
   */
  background?: boolean;
}

export type CreateInvocationFn = (
  oracleDid: string,
  options?: CreateInvocationOptions,
) => Promise<InvocationResult | null>;

export interface AuthedRequestOptions {
  /**
   * A request the user did not start (a status poll). It never mints a
   * delegation — minting one can open the wallet's PIN or passkey prompt —
   * and sends only a cached one. An invocation it needs (none cached, or
   * stage 1 of `renewOracleAuth` after a refusal) is minted with
   * `createInvocation(oracleDid, { background: true })`; when the host
   * mints nothing, the request fails with a 401 `RequestError`
   * (`BACKGROUND_INVOCATION_UNAVAILABLE`) and is never retried
   * interactively. Stage 2 (a fresh delegation) never runs: a request still
   * refused after stage 1 fails with that refusal.
   */
  background?: boolean;
}

export interface IOraclesContextProps {
  wallet: IWalletProps | null;
  transactSignX: TransactionFn;
  authedRequest: <T>(
    url: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    options?: RequestInit,
    oracleDid?: string,
    requestOptions?: AuthedRequestOptions,
  ) => Promise<T>;
  /**
   * The cached delegation to this oracle, or a newly minted one. `fresh`
   * drops the cached one and mints a replacement (callers that ask at the
   * same moment share one mint). Minting a delegation needs the user's key;
   * prefer `renewOracleAuth`, which mints one only as the last resort.
   * `background`: for a caller the user did not start (a background
   * socket) — the cached delegation only (unexpired, with the cache's own
   * margin), never minted: `null` when none is cached. With `fresh` as
   * well it resolves `null` and leaves the cache as it is.
   */
  getDelegation: (
    oracleDid: string,
    options?: { fresh?: boolean; background?: boolean },
  ) => Promise<string | null>;
  /**
   * The cached invocation for this oracle, or a newly minted one. `fresh`
   * skips the cache (the oracle refused the cached one). `background`
   * mints without user interaction (`CreateInvocationOptions`), or not at
   * all: `null` when the host could not.
   */
  getInvocation: (
    oracleDid: string,
    options?: { fresh?: boolean; background?: boolean },
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
   * already) — the caller gives up then. `background`: stage 1 mints the
   * invocation without user interaction, and stage 2 resolves `false`
   * without minting anything.
   */
  renewOracleAuth: (
    oracleDid: string,
    stage: AuthRenewalStage,
    refused?: RefusedCredentials,
    options?: { background?: boolean },
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
