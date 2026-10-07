import type { BatchMessageRoute, ITrxMsg, Network } from '@ixo/ixo-transaction';
import type { RuntimeContext } from '../../plugin-api/types';
import type { ServicePodBlueprint } from './blueprint-types';

/**
 * The POD creation batch the user's wallet will sign as ONE transaction:
 * proto-JSON messages the Portal can show and re-validate against the
 * `@ixo/ixo-transaction` catalog — never encoded bytes.
 */
export interface PreparedPodBatch {
  /**
   * The messages, in execution order: `MsgCreateEntity` first, then the
   * claim collection(s), entity accounts and grants (`POD_BATCH_TYPE_URLS`).
   * Each is `{ typeUrl, value }` in proto-JSON (camelCase fields, integer
   * amounts as strings, bytes as base64) with exactly its catalog fields.
   */
  messages: ITrxMsg[];
  /** Human-readable summary of what the batch creates (at most 1000 characters). */
  summary: string;
  /** Estimated cost, when the gateway can compute it. */
  estimatedCost?: string;
}

/**
 * The message types a POD creation batch may carry. The chain runs the
 * messages of one transaction in order, all or nothing, so a later message
 * can name what an earlier one creates — the entity DID, its admin account,
 * the collection id — as long as the gateway predicts those values right
 * (otherwise the whole transaction fails and nothing is created).
 */
export const POD_BATCH_TYPE_URLS = [
  '/ixo.entity.v1beta1.MsgCreateEntity',
  // A collection's payment accounts must be accounts of the entity.
  '/ixo.entity.v1beta1.MsgCreateEntityAccount',
  '/ixo.claims.v1beta1.MsgCreateCollection',
  // Submit / evaluate authorizations from the collection admin account.
  '/ixo.claims.v1beta1.MsgCreateClaimAuthorization',
  // Generic or bank-send grants from an entity account.
  '/ixo.entity.v1beta1.MsgGrantEntityAccountAuthz',
] as const;

const CREATE_ENTITY = POD_BATCH_TYPE_URLS[0];

/**
 * Why a validated batch is not a POD creation batch, or null when it is:
 * exactly one `MsgCreateEntity`, first, and only `POD_BATCH_TYPE_URLS`.
 */
export function podBatchProblem(
  routes: readonly BatchMessageRoute[],
): string | null {
  const allowed: readonly string[] = POD_BATCH_TYPE_URLS;
  const foreign = routes.filter((route) => !allowed.includes(route.typeUrl));
  if (foreign.length > 0) {
    return `A POD creation batch carries only ${POD_BATCH_TYPE_URLS.join(', ')}; it had ${foreign
      .map((route) => route.typeUrl)
      .join(', ')}`;
  }
  const entities = routes.filter((route) => route.typeUrl === CREATE_ENTITY);
  if (entities.length !== 1 || routes[0]?.typeUrl !== CREATE_ENTITY) {
    return `A POD creation batch creates exactly one entity, with ${CREATE_ENTITY} as its first message`;
  }
  return null;
}

/** The created POD, resolved from the broadcast transaction. */
export interface CreatedPod {
  podDid: string;
  summary: string;
}

/**
 * The chain-facing seam for the create path. The planned concrete implementation
 * calls the IXO MCP server (hosted on Cloudflare) to compose the POD-creation
 * batch (`MsgCreateEntity` + the claim collection + authz grants) and to read a
 * broadcast transaction back. The oracle never signs creation — the user's
 * wallet does — so the gateway only ever returns proto-JSON messages, which
 * the plugin validates against the `@ixo/ixo-transaction` catalog before
 * storing them, and resolves results.
 *
 * Both methods receive the request `RuntimeContext` because reaching the IXO MCP
 * server follows the runtime's remote-MCP pattern (see the sandbox plugin):
 * resolve the server DID via did:web and mint a per-user `ixo:*` UCAN invocation
 * through `ctx.ucan` for the `Authorization` header, with the MCP URL read from
 * `ctx.config`. The seam is injected so the create path stays unit-testable
 * without a live server or chain.
 */
export interface ChainGateway {
  preparePodBatch(
    input: { blueprint: ServicePodBlueprint; network: Network },
    ctx: RuntimeContext,
  ): Promise<PreparedPodBatch>;
  confirmPodCreation(
    input: { txHash: string; network: Network },
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
  preparePodBatch: async () => notConfigured(),
  confirmPodCreation: async () => notConfigured(),
};
