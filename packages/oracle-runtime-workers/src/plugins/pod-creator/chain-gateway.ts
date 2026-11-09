import type { BatchMessageRoute, ITrxMsg, Network } from '@ixo/ixo-transaction';
import type { RuntimeContext } from '../../plugin-api/types';
import type {
  DaoGroupLookup,
  DaoGroupSpec,
} from '../ixo-transaction/dao-group';
import type { ServicePodBlueprint } from './blueprint-types';

/**
 * The POD creation batch the user's wallet will sign as ONE transaction:
 * proto-JSON messages the Portal can show and re-validate against the
 * `@ixo/ixo-transaction` catalog — never encoded bytes.
 */
export interface PreparedPodBatch {
  /**
   * The messages, in execution order: `MsgCreateEntity` first, then only
   * `POD_BATCH_TYPE_URLS` (the bundled gateway sends `MsgCreateEntity`
   * alone). Each is `{ typeUrl, value }` in proto-JSON (camelCase fields,
   * integer amounts as strings, bytes as base64, timestamps as RFC 3339
   * strings) with exactly its catalog fields.
   */
  messages: ITrxMsg[];
  /** Human-readable summary of what the batch creates (at most 1000 characters). */
  summary: string;
  /** Estimated cost, when the gateway can compute it. */
  estimatedCost?: string;
  /**
   * Public documents the messages name (by URL and SHA-256 proof) that are
   * not published yet: `publishDocuments` publishes them once the user
   * approved, before the wallet is asked to sign. Empty when every document
   * the messages name is already public.
   */
  documents: PendingDocument[];
}

/**
 * A public document a batch names (the POD's profile, its domain card),
 * reserved on the oracle's homeserver when the batch is prepared and
 * uploaded only after the user approved it.
 */
export interface PendingDocument {
  /** The reserved media it is uploaded as: `mxc://<server>/<media id>`. */
  mxc: string;
  /** Its media type, e.g. `application/ld+json`. */
  contentType: string;
  /** The file name the homeserver records. */
  filename: string;
  /** The exact text: the message carries the SHA-256 of these bytes as its proof. */
  text: string;
}

/**
 * An expected refusal (a missing identity, a homeserver that is down), which
 * the tools report to the model as a result instead of throwing.
 */
export interface GatewayRefusal {
  ok: false;
  message: string;
  /** Whether the same call can succeed later unchanged (something was down). */
  retryable: boolean;
}

/** A gateway answer: the value, or why there is none. */
export type GatewayResult<T extends object> =
  | ({ ok: true } & T)
  | GatewayRefusal;

/**
 * What a broadcast transaction says about the POD. `pending`: not on chain
 * (or not indexed) within the lookup's time, ask again later with the same
 * hash; `failed`: it failed, or it is not the POD this conversation sent, so
 * asking again cannot help; `unavailable`: the chain could not be read.
 */
export type PodConfirmation =
  | { status: 'created'; podDid: string; summary: string }
  | {
      status: 'pending' | 'failed' | 'unavailable';
      message: string;
      retryable: boolean;
    };

/**
 * The governance group a POD's `create_pod_group` asked the wallet to
 * create: a DAO DAO group as the IXO Transaction plugin's `create_dao_group`
 * creates one (`ixo-transaction/dao-group.ts`).
 */
export type PodGroupSpec = DaoGroupSpec;

/**
 * What a group creation transaction says (`findDaoGroup`). `found`: it
 * created the group the conversation sent, at `coreAddress`; `pending`: not
 * on chain (or not indexed) within the lookup's time; `failed`: it failed,
 * or it is not that group; `unavailable`: the chain could not be read.
 */
export type PodGroupLookup = DaoGroupLookup;

/** What the user's wallet was asked to sign, as the create session records it. */
export interface SentPodBatch {
  /** The messages exactly as sent (proto-JSON, catalog-validated). */
  messages: ITrxMsg[];
  /** The profile the POD was prepared with (for its domain card). */
  profile: PodProfile;
}

/**
 * The message types a POD creation batch may carry. The chain runs the
 * messages of one transaction in order, all or nothing, so a later message
 * can name what an earlier one creates — the entity DID, its admin account,
 * the collection id — only by predicting those values (otherwise the whole
 * transaction fails and nothing is created). The bundled gateway does not
 * predict: it sends `MsgCreateEntity` alone.
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

/** What the user agreed to call the POD, for its on-chain profile. */
export interface PodProfile {
  /** The POD's name: plain text, 1 to 100 characters. */
  name: string;
  /** What the POD does, in plain text (at most 600 characters). */
  description?: string;
}

/**
 * The chain-facing seam for the create path. The oracle never signs
 * creation — the user's wallet does — so a gateway only ever returns
 * proto-JSON messages, which the plugin validates against the
 * `@ixo/ixo-transaction` catalog before storing them, and resolves the
 * broadcast transaction afterwards.
 *
 * The bundled implementation is `createIxoChainGateway()`
 * (`ixo-chain-gateway.ts`): one `MsgCreateEntity` owned by the user, its
 * profile reserved on the oracle's homeserver and published after approval,
 * read back from chain REST; then the POD's domain card, and the address of
 * the governance group the user created for it. Every method
 * receives the request `RuntimeContext` (the user, the config, the turn's
 * abort signal, the oracle's Matrix device) and answers an expected refusal
 * as a result; a throw is a programming error. The seam is injected so the
 * create path stays unit-testable without a live homeserver or chain, and
 * so a fork can compose a different batch.
 */
export interface ChainGateway {
  preparePodBatch(
    input: {
      blueprint: ServicePodBlueprint;
      network: Network;
      profile: PodProfile;
    },
    ctx: RuntimeContext,
  ): Promise<GatewayResult<PreparedPodBatch>>;
  /** Publish a prepared batch's pending documents; publishing one twice is a success. */
  publishDocuments(
    input: { documents: readonly PendingDocument[] },
    ctx: RuntimeContext,
  ): Promise<GatewayResult<object>>;
  /** Read the transaction back and check it is the POD `sent` describes. */
  confirmPodCreation(
    input: { txHash: string; network: Network; sent: SentPodBatch },
    ctx: RuntimeContext,
  ): Promise<PodConfirmation>;
  /** The batch that adds a confirmed POD's public domain card (one message). */
  prepareDomainCard(
    input: { network: Network; podDid: string; profile: PodProfile },
    ctx: RuntimeContext,
  ): Promise<GatewayResult<PreparedPodBatch>>;
  /** Ask the domain indexer to index the POD now; best effort, never throws. */
  requestIndexing(
    input: { network: Network; podDid: string },
    ctx: RuntimeContext,
  ): Promise<void>;
  /**
   * Read a group creation transaction back: that the user's account
   * created exactly `group` (a DAO DAO `dao_core` of the network), and the
   * address of its core contract.
   */
  findPodGroup(
    input: { txHash: string; network: Network; group: PodGroupSpec },
    ctx: RuntimeContext,
  ): Promise<PodGroupLookup>;
}

const notConfigured = (): never => {
  throw new Error(
    'ChainGateway not configured: this oracle was built without a chain ' +
      'gateway, so it cannot prepare or confirm POD creation transactions.',
  );
};

/**
 * A gateway that refuses every call, for a fork that wants the design
 * pipeline without on-chain creation: the create tools report creation as
 * unavailable without calling it.
 */
export const notConfiguredChainGateway: ChainGateway = {
  preparePodBatch: async () => notConfigured(),
  publishDocuments: async () => notConfigured(),
  confirmPodCreation: async () => notConfigured(),
  prepareDomainCard: async () => notConfigured(),
  requestIndexing: async () => notConfigured(),
  findPodGroup: async () => notConfigured(),
};
