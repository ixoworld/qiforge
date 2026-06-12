import type { ServicePodBlueprint } from './blueprint-types.js';

/** The unsigned transaction batch the user's wallet will sign. */
export interface PreparedPodBatch {
  /** Base64-encoded unsigned tx bytes (SignDoc / TxRaw) for the wallet. */
  unsignedTx: string;
  /** Human-readable summary of what the batch creates. */
  summary: string;
  /** Number of messages in the batch (entity + collection + grants). */
  messageCount: number;
  /** Estimated cost, when the gateway can compute it. */
  estimatedCost?: string;
}

/** The created POD, resolved from the broadcast transaction. */
export interface CreatedPod {
  podDid: string;
  summary: string;
}

/**
 * The chain-facing seam for the create path. Implementations build the UNSIGNED
 * POD-creation batch (`MsgCreateEntity` + the claim collection + authz grants)
 * and confirm a broadcast transaction. The oracle never signs creation — the
 * user's wallet does — so the gateway only ever prepares unsigned bytes and
 * reads results back.
 *
 * Injected so the create path is unit-testable without a live chain, and so the
 * real `@ixo/oracles-chain-client` encoding wires in without touching the tools.
 */
export interface ChainGateway {
  prepareUnsignedPodBatch(input: {
    blueprint: ServicePodBlueprint;
    userDid: string;
    network: string;
  }): Promise<PreparedPodBatch>;
  confirmPodCreation(input: {
    txHash: string;
    network: string;
  }): Promise<CreatedPod>;
}

const notConfigured = (): never => {
  throw new Error(
    'ChainGateway not configured: the POD create path needs a chain gateway ' +
      'wired to @ixo/oracles-chain-client before it can prepare or confirm ' +
      'transactions.',
  );
};

/** Default gateway that errors until a real one is wired. */
export const notConfiguredChainGateway: ChainGateway = {
  prepareUnsignedPodBatch: async () => notConfigured(),
  confirmPodCreation: async () => notConfigured(),
};
