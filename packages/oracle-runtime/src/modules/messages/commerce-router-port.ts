import type {
  CommerceEngagement,
  CommerceGateFailureReason,
  CommerceInProgressEngagement,
} from '../../plugin-api/types.js';

/**
 * One contractable service, reduced to what the router's classifier and gate
 * need. Sourced from the oracle's Agent Card by the registering plugin.
 */
export interface CommerceRoutedService {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  priceUsd: number;
}

/** The data an engagement starts from once the contract gate passes. */
export interface CommerceEngagementStart {
  serviceId: string;
  serviceName: string;
  priceUsd: number;
  collectionId: string;
  adminAddress: string;
  /**
   * How long the contract's authorization keeps an escrowed intent alive, in
   * nanoseconds, as the AuthZ snapshot reports it. Carried on the gate result
   * so the start lane can stamp the engagement's deadline without a second
   * lookup. Absent when the snapshot omits it.
   */
  intentDurationNs?: string | number;
}

/** Outcome of the contract gate for (sender, service). */
export type CommerceGateResult =
  | { ok: true; start: CommerceEngagementStart }
  | {
      ok: false;
      reason: CommerceGateFailureReason;
      /** The blocking job, when the reason is `engagement_in_progress`. */
      inProgress?: CommerceInProgressEngagement;
    };

/**
 * Outcome of starting an engagement. Starting can fail on its own terms even
 * after the gate passed — reserving the payment on-chain is a chain write —
 * so the failure carries a reason the router surfaces exactly like a gate
 * failure.
 */
export type CommerceEngagementStartResult =
  | { ok: true; engagement: CommerceEngagement }
  | { ok: false; reason: CommerceGateFailureReason };

/**
 * Commerce knowledge the message router consults, registered by the
 * oracle-payments plugin's Nest module at `onModuleInit`. The router (core)
 * never imports the plugin — with no port registered it is inert and Matrix
 * turns behave exactly as they do today.
 */
export interface CommerceRouterPort {
  /**
   * Classifier model override (`ORACLE_PAYMENTS_ROUTER_MODEL`, validated
   * plugin config). Undefined → the provider's `routing` role default.
   */
  routerModel?: string;

  /** The oracle's published services, or `null` when no agent card resolves. */
  getServices(): Promise<CommerceRoutedService[] | null>;

  /** The thread's active engagement, or `null`. */
  getActiveEngagement(
    roomId: string,
    threadId: string,
  ): Promise<CommerceEngagement | null>;

  /**
   * Contract + AuthZ gate for a work-classified turn, plus the one-job-at-a-time
   * check (`threadId` is the requesting thread, excluded from it). Never throws
   * — lookup failures degrade to a gate failure.
   */
  checkContractGate(params: {
    roomId: string;
    threadId: string;
    senderDid: string;
    service: CommerceRoutedService;
  }): Promise<CommerceGateResult>;

  /**
   * Reserve payment for the job and persist a new active engagement for the
   * thread (gate already passed). The router only ever STARTS engagements —
   * ending one is an agent decision made through the plugin's `cancel_work` /
   * `deliver_work` tools, never at the transport layer.
   */
  startEngagement(
    roomId: string,
    threadId: string,
    start: CommerceEngagementStart,
  ): Promise<CommerceEngagementStartResult>;
}

let registeredPort: CommerceRouterPort | null = null;

/**
 * Single-slot registration, mirroring the bridge's `setDeliverHandler` /
 * `setRoomSessionResolver` precedent — exactly one commerce plugin can own
 * routing in a process.
 */
export function setCommerceRouterPort(port: CommerceRouterPort): void {
  registeredPort = port;
}

export function clearCommerceRouterPort(): void {
  registeredPort = null;
}

export function getCommerceRouterPort(): CommerceRouterPort | null {
  return registeredPort;
}
