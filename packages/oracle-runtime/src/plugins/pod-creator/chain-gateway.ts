import type { RuntimeContext } from '../../plugin-api/types.js';
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
 * The chain-facing seam for the create path. The planned concrete implementation
 * calls the IXO MCP server (hosted on Cloudflare) to build the UNSIGNED
 * POD-creation batch (`MsgCreateEntity` + the claim collection + authz grants)
 * and to read a broadcast transaction back. The oracle never signs creation —
 * the user's wallet does — so the gateway only ever returns unsigned bytes and
 * resolves results.
 *
 * Both methods receive the request `RuntimeContext` because reaching the IXO MCP
 * server follows the runtime's remote-MCP pattern (see the sandbox plugin):
 * resolve the server DID via did:web and mint a per-user `ixo:*` UCAN invocation
 * through `ctx.ucan` for the `Authorization` header, with the MCP URL read from
 * `ctx.config`. The seam is injected so the create path stays unit-testable
 * without a live server or chain.
 */
export interface ChainGateway {
  prepareUnsignedPodBatch(
    input: { blueprint: ServicePodBlueprint; network: string },
    ctx: RuntimeContext,
  ): Promise<PreparedPodBatch>;
  confirmPodCreation(
    input: { txHash: string; network: string },
    ctx: RuntimeContext,
  ): Promise<CreatedPod>;
}

const notConfigured = (): never => {
  throw new Error(
    'ChainGateway not configured: the POD create path needs a chain gateway ' +
      'wired to the IXO MCP server before it can prepare or confirm ' +
      'transactions.',
  );
};

/** Default gateway that errors until a real one is wired. */
export const notConfiguredChainGateway: ChainGateway = {
  prepareUnsignedPodBatch: async () => notConfigured(),
  confirmPodCreation: async () => notConfigured(),
};
