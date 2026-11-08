/**
 * The bundled chain gateway: creates a POD as ONE `MsgCreateEntity` the
 * user's own Portal wallet signs, the same message the Portal builds when a
 * user creates an entity there (ixo-portal `lib/entity/createEntity.ts`),
 * and reads the new POD back from the broadcast transaction.
 *
 * Why one message: the chain derives the entity DID while the transaction
 * runs (`did:ixo:entity:` + MD5 of `<nft contract>/<create sequence>`), so a
 * later message in the same transaction could only name it by predicting
 * that sequence and fails as a whole when another creation lands first. A
 * claim collection, entity accounts and grants are added afterwards, once
 * the DID is known.
 *
 * prepare (one time budget for every step):
 *   1. The owner is the user: `ctx.user.did` must be an IXO account DID
 *      (`did:ixo:ixo1…`), whose address is read off the DID.
 *   2. Their IID document must exist and list the account under
 *      `authentication` or `assertionMethod`, the check the chain's ante
 *      handler makes before it runs a `MsgCreateEntity` (ixo-blockchain
 *      `x/iid/ante/iidtx.go`, `IidDocument.HasRelationship`).
 *   3. Their secp256k1 public key, for the entity's verification methods: a
 *      secp key in that IID document that belongs to the address, else the
 *      account's `pub_key` from chain REST when it belongs to the address.
 *   4. The profile (name, description) as JSON-LD, reserved on the oracle's
 *      homeserver (`matrix-media.ts`) and uploaded unencrypted only once the
 *      user approved the batch; the linked resource names its public
 *      download URL and the SHA-256 of the exact bytes.
 *   5. The message, in proto-JSON as `@ixo/ixo-transaction` validates it.
 *
 * confirm: the Portal wallet answers with the hash, code and height (no
 * events), so the transaction is looked up on chain REST, again while it is
 * not indexed yet or the node is briefly unavailable, within a bounded time.
 * It must carry the `MsgCreateEntity` the conversation sent (the same
 * profile proof, owned by the user) and create exactly one POD: one entity
 * event and one ownership mint to the user's address, agreeing with the
 * message response.
 *
 * Every chain read is bounded (time, size, retries) through the ixo-chain
 * plugin's `restJson`, and shares the user's chain read permits with it.
 * Expected failures are answered as results; only the turn's abort throws.
 */
import { sha256 } from '@noble/hashes/sha2';
import { ripemd160 } from '@noble/hashes/legacy';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { ITrxMsg, Network } from '@ixo/ixo-transaction';
import { TxMsgData } from '@ixo/impactxclient-sdk/module/codegen/cosmos/base/abci/v1beta1/abci.js';
import { MsgCreateEntityResponse } from '@ixo/impactxclient-sdk/module/codegen/ixo/entity/v1beta1/tx.js';
import { base58btc } from 'multiformats/bases/base58';
import { z } from 'zod';
import { fetchWithoutRedirects } from '../../core/domain-context/transport';
import { ixoAddressOf } from '../../core/user-identity';
import type { RuntimeContext } from '../../plugin-api/types';
import {
  MIN_ATTEMPT_MS,
  TOOL_BUDGET_MS,
  sleep,
  throwIfAborted,
  type ChainCall,
  type Failure,
} from '../ixo-chain/http';
import { chainRestUrlFor } from '../ixo-chain/ixo-chain.plugin';
import { bech32Bytes } from '../ixo-chain/queries';
import { restJson } from '../ixo-chain/rest';
import type {
  ChainGateway,
  GatewayRefusal,
  GatewayResult,
  PodConfirmation,
  PodProfile,
  SentPodBatch,
} from './chain-gateway';
import { domainIndexerUrlFor, relayerNodeDidFor } from './config';
import { podDomainCardDocument } from './domain-card';
import {
  documentProof,
  publishPendingDocuments,
  reservePublicDocument,
  type MatrixMediaDeps,
} from './matrix-media';

const CREATE_ENTITY = '/ixo.entity.v1beta1.MsgCreateEntity';
const CREATE_ENTITY_RESPONSE = '/ixo.entity.v1beta1.MsgCreateEntityResponse';
const ADD_LINKED_RESOURCE = '/ixo.iid.v1beta1.MsgAddLinkedResource';
const ENTITY_CREATED_EVENT = 'ixo.entity.v1beta1.EntityCreatedEvent';
const POD_ENTITY_TYPE = 'pod';
const SECP_KEY_TYPE = 'EcdsaSecp256k1VerificationKey2019';
const SECP_PUBKEY_TYPE = '/cosmos.crypto.secp256k1.PubKey';
const ENTITY_DID = /^did:ixo:entity:[0-9a-f]{32}$/;
/** The relationships the chain accepts a signer under (`iidtx.go` constraints). */
const SIGNER_RELATIONSHIPS = ['authentication', 'assertionMethod'] as const;
/** The linked resource id of an entity's profile, which the chain fills in. */
const PROFILE_RESOURCE_ID = '{id}#pro';

/** How long the entity is valid: the Portal's "forever" (100 years of 365 days). */
const ENTITY_LIFETIME_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/** Total time of one prepare: the chain reads and the homeserver reservation. */
export const PREPARE_BUDGET_MS = TOOL_BUDGET_MS;
/** Total time of publishing a batch's documents. */
export const PUBLISH_BUDGET_MS = TOOL_BUDGET_MS;
/** Upper bound on one homeserver request. */
export const HOMESERVER_TIMEOUT_MS = 10_000;
/** Upper bound on getting the oracle's Matrix device credentials. */
export const CREDENTIALS_TIMEOUT_MS = 10_000;
/** How long `confirmPodCreation` looks for the transaction before giving up. */
export const CONFIRM_BUDGET_MS = TOOL_BUDGET_MS;
/** The wait between two lookups of a transaction not on chain (or not readable) yet. */
export const CONFIRM_POLL_MS = 2_000;
/** Upper bound on the domain indexer's answer. */
export const INDEXER_TIMEOUT_MS = 10_000;

/** What the gateway is built with; every member has a production default. */
export interface IxoChainGatewayDeps {
  /** Every request (chain REST, the homeserver, the indexer) goes through it. */
  fetch?: typeof fetch;
  /** The clock the entity's start and end dates (and a card's `validFrom`) are read from. */
  now?: () => Date;
  /** Total time `confirmPodCreation` looks for the transaction. */
  confirmBudgetMs?: number;
  /** The wait between two lookups of the transaction. */
  pollIntervalMs?: number;
  /** Total time of one prepare. */
  prepareBudgetMs?: number;
  /** Upper bound on one homeserver request. */
  homeserverTimeoutMs?: number;
  /** Upper bound on getting the oracle's Matrix device credentials. */
  credentialsTimeoutMs?: number;
  /** Every wait (the poll's and a read's retry); tests inject a clock. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The profile document, in the shape the Portal uploads for an entity it creates. */
export function podProfileDocument(profile: {
  name: string;
  description?: string;
}): Record<string, unknown> {
  return {
    '@context': {
      ixo: 'https://w3id.org/ixo/ns/protocol/',
      '@id': '@type',
      type: '@type',
      '@protected': false,
    },
    id: 'ixo:entity#profile',
    type: 'profile',
    orgName: profile.name,
    name: profile.name,
    image: '',
    logo: '',
    brand: profile.name,
    location: '',
    description: profile.description ?? '',
  };
}

/**
 * The entity's verification methods for an owner's secp256k1 key, as the
 * Portal's `customMessages.iid.createIidVerificationMethods({ did, pubkey,
 * address, controller: did, type: 'secp' })` makes them, in proto-JSON.
 */
export function ownerVerifications(owner: {
  did: string;
  address: string;
  publicKey: Uint8Array;
}): Record<string, unknown>[] {
  const { did, address } = owner;
  const hex = bytesToHex(owner.publicKey);
  const base58 = base58btc.baseEncode(owner.publicKey);
  const secp = (id: string, material: Record<string, string>) => ({
    relationships: ['authentication'],
    method: { id, type: SECP_KEY_TYPE, controller: did, ...material },
  });
  return [
    secp(did, { publicKeyBase58: base58 }),
    secp(`${did}#${hex}`, { publicKeyMultibase: `F${hex}` }),
    secp(`${did}#${base58}`, { publicKeyBase58: base58 }),
    {
      relationships: ['authentication'],
      method: {
        id: `${did}#${address}`,
        type: 'CosmosAccountAddress',
        controller: did,
        blockchainAccountID: address,
      },
    },
  ];
}

/* ── chain reads ──────────────────────────────────────────────────────── */

function chainCall(
  ctx: RuntimeContext,
  network: Network,
  io: { fetch: typeof fetch; sleep: ChainCall['sleep'] },
  deadline: number,
): ChainCall {
  return {
    network,
    restUrl: chainRestUrlFor(network, ctx.config),
    blocksyncUrl: '',
    user: ctx.user.did,
    deadline,
    signal: ctx.abortSignal,
    fetch: io.fetch,
    ...(io.sleep ? { sleep: io.sleep } : {}),
  };
}

const refuse = (message: string, retryable: boolean): GatewayRefusal => ({
  ok: false,
  message,
  retryable,
});

/** A failed chain read as a refusal the model can act on. */
const readRefusal = (what: string, failure: Failure): GatewayRefusal =>
  refuse(
    `Could not read ${what} from the chain: ${failure.detail}`,
    failure.retryable,
  );

const pubKeySchema = z.object({
  '@type': z.string(),
  key: z.string().optional(),
});
const baseAccountSchema = z.object({ pub_key: pubKeySchema.nullish() });
const accountSchema = z.object({
  account: z.looseObject({ '@type': z.string() }),
});

/** Where each account type keeps its public key; other types never sign. */
const ACCOUNT_KEY_HOLDER: Record<
  string,
  z.ZodType<z.infer<typeof baseAccountSchema>>
> = {
  '/cosmos.auth.v1beta1.BaseAccount': baseAccountSchema,
  ...Object.fromEntries(
    [
      '/cosmos.vesting.v1beta1.ContinuousVestingAccount',
      '/cosmos.vesting.v1beta1.DelayedVestingAccount',
      '/cosmos.vesting.v1beta1.PeriodicVestingAccount',
      '/cosmos.vesting.v1beta1.PermanentLockedAccount',
    ].map((type) => [
      type,
      z
        .object({
          base_vesting_account: z.object({ base_account: baseAccountSchema }),
        })
        .transform((account) => account.base_vesting_account.base_account),
    ]),
  ),
};

const verificationMethodSchema = z.object({
  id: z.string(),
  type: z.string(),
  blockchainAccountID: z.string().optional(),
  publicKeyHex: z.string().optional(),
  publicKeyMultibase: z.string().optional(),
  publicKeyBase58: z.string().optional(),
});

type VerificationMethod = z.infer<typeof verificationMethodSchema>;

const iidSchema = z.object({
  iidDocument: z.object({
    verificationMethod: z.array(verificationMethodSchema).default([]),
    authentication: z.array(z.string()).default([]),
    assertionMethod: z.array(z.string()).default([]),
  }),
});

type IidDocument = z.infer<typeof iidSchema>['iidDocument'];

function base64Bytes(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function hexBytes(text: string): Uint8Array | null {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(text)) return null;
  return hexToBytes(text.toLowerCase());
}

function base58Bytes(text: string): Uint8Array | null {
  try {
    return base58btc.baseDecode(text);
  } catch {
    return null;
  }
}

/**
 * A verification method's key bytes, read the way the chain reads them when
 * it checks a signer (`IidDocument.HasRelationship`): `publicKeyMultibase`
 * as hex after its one-character prefix (the Portal writes `F` + hex),
 * `publicKeyHex` as hex, `publicKeyBase58` as base58.
 */
function methodKey(method: VerificationMethod): Uint8Array | null {
  if (method.publicKeyMultibase !== undefined)
    return hexBytes(method.publicKeyMultibase.slice(1));
  if (method.publicKeyHex !== undefined) return hexBytes(method.publicKeyHex);
  if (method.publicKeyBase58 !== undefined)
    return base58Bytes(method.publicKeyBase58);
  return null;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * The account a 33-byte key stands for: RIPEMD-160 of its SHA-256, as the
 * chain derives a secp256k1 key's address. Null for any other length.
 */
function keyAccount(key: Uint8Array): Uint8Array | null {
  return key.length === 33 ? ripemd160(sha256(key)) : null;
}

/** Whether the chain counts `method` as the account `address` (`HasRelationship`'s material match). */
function methodIsAccount(
  method: VerificationMethod,
  address: string,
  accountBytes: Uint8Array,
): boolean {
  if (method.blockchainAccountID !== undefined)
    return method.blockchainAccountID === address;
  const key = methodKey(method);
  const account = key ? keyAccount(key) : null;
  return account !== null && sameBytes(account, accountBytes);
}

/**
 * Whether the IID document lets `address` act for its DID the way the
 * chain's ante handler checks a signer: a verification method of that
 * account named under `authentication` or `assertionMethod`.
 */
function listsSigner(
  doc: IidDocument,
  address: string,
  accountBytes: Uint8Array,
): boolean {
  const named = new Set(
    SIGNER_RELATIONSHIPS.flatMap((relationship) => doc[relationship]),
  );
  return doc.verificationMethod.some(
    (method) =>
      named.has(method.id) && methodIsAccount(method, address, accountBytes),
  );
}

/** Whether `key` is a compressed secp256k1 public key of the account `accountBytes`. */
function isAccountSecpKey(key: Uint8Array, accountBytes: Uint8Array): boolean {
  if (key[0] !== 2 && key[0] !== 3) return false;
  const account = keyAccount(key);
  return account !== null && sameBytes(account, accountBytes);
}

const POD_TAG = '[pod-creator]';

/**
 * The owner's secp256k1 public key for the entity's verification methods,
 * after checking that the chain will accept the owner at all: their IID
 * document must exist and list the account as a signer. The key is the IID
 * document's secp key of this account, else the account's own `pub_key`
 * (the chain learns it from the account's first signed transaction).
 */
async function ownerPublicKey(
  call: ChainCall,
  owner: { did: string; address: string },
): Promise<GatewayResult<{ publicKey: Uint8Array }>> {
  const accountBytes = bech32Bytes(owner.address, 'ixo');
  if (!accountBytes)
    return refuse(
      `Your account address ${owner.address} is not a valid ixo address.`,
      false,
    );
  const iid = await restJson(call, `/ixo/did/dids/${owner.did}`, iidSchema, {
    label: 'owner identity',
    tag: POD_TAG,
    noneOn: [404],
  });
  if (!iid.ok) return readRefusal('your identity', iid.failure);
  if ('absent' in iid)
    return refuse(
      `Your identity ${owner.did} is not on chain yet, and the chain refuses to create an entity whose owner has no identity document. ` +
        'Sign in to the Portal with this wallet once (it creates your identity), then prepare the POD again.',
      false,
    );
  const doc = iid.value.iidDocument;
  if (!listsSigner(doc, owner.address, accountBytes))
    return refuse(
      `Your identity document does not list your account ${owner.address} under authentication or assertionMethod, so the chain would refuse the POD: ` +
        "it accepts a message for an owner only from an account the owner's identity lists. Add the account to your identity, then prepare the POD again.",
      false,
    );
  for (const method of doc.verificationMethod) {
    if (method.type !== SECP_KEY_TYPE) continue;
    const key = methodKey(method);
    if (key && isAccountSecpKey(key, accountBytes))
      return { ok: true, publicKey: key };
  }
  const account = await restJson(
    call,
    `/cosmos/auth/v1beta1/accounts/${owner.address}`,
    accountSchema,
    { label: 'owner account', tag: POD_TAG, noneOn: [404] },
  );
  if (!account.ok) return readRefusal('your account', account.failure);
  if (!('absent' in account)) {
    const holder = ACCOUNT_KEY_HOLDER[account.value.account['@type']];
    const parsed = holder?.safeParse(account.value.account);
    const pubKey = parsed?.success ? parsed.data.pub_key : undefined;
    if (pubKey?.['@type'] === SECP_PUBKEY_TYPE && pubKey.key !== undefined) {
      const key = base64Bytes(pubKey.key);
      if (key && isAccountSecpKey(key, accountBytes))
        return { ok: true, publicKey: key };
    }
  }
  return refuse(
    `There is no public key on chain yet for your account ${owner.address}, so the POD cannot name your key as its owner. ` +
      'The chain learns it from your first signed transaction: make any transaction from this wallet (or set up your identity in the Portal), then prepare the POD again.',
    false,
  );
}

/* ── the transaction lookup ───────────────────────────────────────────── */

const txSchema = z.object({
  tx: z.object({
    body: z.object({
      messages: z.array(z.looseObject({ '@type': z.string() })).default([]),
    }),
  }),
  tx_response: z.object({
    txhash: z.string(),
    height: z.string(),
    code: z.number().int(),
    codespace: z.string().default(''),
    raw_log: z.string().default(''),
    data: z.string().default(''),
    events: z
      .array(
        z.object({
          type: z.string(),
          attributes: z
            .array(z.object({ key: z.string(), value: z.string().default('') }))
            .default([]),
        }),
      )
      .default([]),
  }),
});

type Tx = z.infer<typeof txSchema>;
type TxEvent = Tx['tx_response']['events'][number];

function attribute(event: TxEvent, key: string): string | undefined {
  return event.attributes.find((attr) => attr.key === key)?.value;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A `MsgCreateEntity` as chain REST shows it in a transaction body. */
const createEntityBodySchema = z.object({
  owner_did: z.string(),
  linked_resource: z
    .array(z.object({ id: z.string(), proof: z.string().default('') }))
    .default([]),
});

/** The same message as the conversation sent it (proto-JSON). */
const createEntitySentSchema = z.object({
  linkedResource: z.array(
    z.object({ id: z.string(), proof: z.string().optional() }),
  ),
});

/** The profile proof of the `MsgCreateEntity` sent for signing. */
function sentProfileProof(sent: SentPodBatch): string | undefined {
  const parsed = createEntitySentSchema.safeParse(
    sent.messages.find((message) => message.typeUrl === CREATE_ENTITY)?.value,
  );
  return parsed.success
    ? parsed.data.linkedResource.find(
        (resource) => resource.id === PROFILE_RESOURCE_ID,
      )?.proof
    : undefined;
}

const entityEventSchema = z.object({ id: z.string(), type: z.string() });

const failed = (message: string): PodConfirmation => ({
  status: 'failed',
  message,
  retryable: false,
});

/** The DIDs and types the message responses in the result data name. */
function createdResponses(
  data: string,
): { entityId: string; entityType: string }[] | null {
  if (data === '') return [];
  const bytes = hexBytes(data);
  if (!bytes) return null;
  try {
    return TxMsgData.decode(bytes)
      .msgResponses.filter(
        (response) => response.typeUrl === CREATE_ENTITY_RESPONSE,
      )
      .map((response) => MsgCreateEntityResponse.decode(response.value));
  } catch {
    return null;
  }
}

/**
 * What `tx` says about the POD the conversation sent: created when it
 * carries that `MsgCreateEntity` (the sent profile proof, owned by the user)
 * and created exactly one POD (one entity event, one ownership mint to the
 * user's address, the message response agreeing); else why it is not.
 */
function podOfTransaction(
  tx: Tx,
  owner: { did: string; address: string | null },
  sent: SentPodBatch,
  network: Network,
): PodConfirmation {
  const result = tx.tx_response;
  if (result.code !== 0)
    return failed(
      `That transaction failed on chain (code ${result.code}${result.codespace ? ` in ${result.codespace}` : ''}), so no POD was created: ${result.raw_log.slice(0, 300)}`,
    );
  const creates = tx.tx.body.messages.filter(
    (message) => message['@type'] === CREATE_ENTITY,
  );
  const body =
    creates.length === 1 ? createEntityBodySchema.safeParse(creates[0]) : null;
  const proof = sentProfileProof(sent);
  if (
    !body?.success ||
    proof === undefined ||
    body.data.linked_resource.find(
      (resource) => resource.id === PROFILE_RESOURCE_ID,
    )?.proof !== proof
  )
    return failed(
      'That transaction is not the POD batch this conversation sent for signing (it carries another entity creation, or none). Check the transaction hash.',
    );
  if (body.data.owner_did !== owner.did)
    return failed(
      `The entity that transaction created is owned by ${body.data.owner_did.slice(0, 120)}, not by you.`,
    );
  const entityEvents = result.events.filter(
    (event) => event.type === ENTITY_CREATED_EVENT,
  );
  const mints = result.events.filter(
    (event) =>
      event.type === 'wasm' &&
      attribute(event, 'action') === 'mint' &&
      ENTITY_DID.test(attribute(event, 'token_id') ?? ''),
  );
  const [entityEvent] = entityEvents;
  const [mint] = mints;
  if (entityEvents.length !== 1 || mints.length !== 1 || !entityEvent || !mint)
    return failed(
      'That transaction did not create exactly one entity (one entity event and one ownership token), so it is not a POD creation.',
    );
  const entity = entityEventSchema.safeParse(
    parseJson(attribute(entityEvent, 'entity')),
  );
  if (!entity.success)
    return failed(
      'The transaction has an entity event the gateway cannot read.',
    );
  const mintOwner = attribute(mint, 'owner') ?? '';
  // The mint's owner is the account that holds the entity: the binding owner.
  if (mintOwner !== owner.address)
    return failed(
      `The entity that transaction created is owned by ${mintOwner.slice(0, 80) || 'no account'} (the ownership token), not by you.`,
    );
  const signer = z
    .string()
    .safeParse(parseJson(attribute(entityEvent, 'signer')));
  if (signer.success && signer.data !== owner.did)
    return failed(
      `The entity that transaction created is owned by ${signer.data.slice(0, 120)} (the entity event), not by you.`,
    );
  const responses = createdResponses(result.data);
  if (responses === null)
    return failed(
      'The transaction result data is not what the chain writes; the gateway cannot read it.',
    );
  const did = entity.data.id;
  const dids = new Set([
    did,
    attribute(mint, 'token_id'),
    ...responses.map((response) => response.entityId),
  ]);
  if (dids.size !== 1 || !ENTITY_DID.test(did))
    return failed(
      'That transaction names more than one entity, so it is not a POD creation (which creates exactly one).',
    );
  const type = [entity.data.type, ...responses.map((r) => r.entityType)].find(
    (entityType) => entityType !== POD_ENTITY_TYPE,
  );
  if (type !== undefined)
    return failed(
      `That transaction created a "${type.slice(0, 40)}" entity, not a POD.`,
    );
  return {
    status: 'created',
    podDid: did,
    summary: `Your POD ${did} was created on ${network} in block ${result.height}.`,
  };
}

/* ── the domain indexer ───────────────────────────────────────────────── */

/**
 * Ask the domain indexer to index `podDid` now (`POST {indexer}/index`, no
 * credentials: only a forced re-index needs the indexer's admin key). Its
 * own chain poller indexes the card later anyway, so a failure is logged.
 */
async function requestIndexing(
  ctx: RuntimeContext,
  url: string,
  podDid: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INDEXER_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
  try {
    const answer = await fetchWithoutRedirects(
      fetchImpl,
      `${url}/index`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ did: podDid }),
        signal: controller.signal,
      },
      'indexer-redirected',
    );
    await answer.body?.cancel().catch(() => undefined);
    if (answer.ok)
      ctx.logger.log(`${POD_TAG} indexer asked to index ${podDid}`);
    else
      ctx.logger.warn(
        `${POD_TAG} indexer refused to index ${podDid} (HTTP ${answer.status}); its chain poller indexes it later`,
      );
  } catch (error) {
    ctx.logger.warn(
      `${POD_TAG} indexer request for ${podDid} failed (${error instanceof Error ? error.name : 'unknown'}); its chain poller indexes it later`,
    );
  } finally {
    clearTimeout(timer);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

/* ── the gateway ──────────────────────────────────────────────────────── */

/** What the user approves: what the POD is, with its exact public name and description. */
function podSummary(
  network: Network,
  address: string,
  profile: PodProfile,
): string {
  return `Create the POD on ${network}, owned by you (${address}). Its public profile: name "${profile.name}"; description ${profile.description ? `"${profile.description}"` : '(none)'}.`;
}

/**
 * The bundled `ChainGateway`: a POD created as one `MsgCreateEntity` signed
 * by the user's wallet, then its domain card (see the module comment).
 * `deps` exists for tests.
 */
export function createIxoChainGateway(
  deps: IxoChainGatewayDeps = {},
): ChainGateway {
  // Looked up per call: workerd rejects `fetch` invoked with a foreign
  // `this`, and a test may stub the global after the gateway is built.
  const fetchImpl: typeof fetch =
    deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? (() => new Date());
  const wait = deps.sleep ?? sleep;
  const io = { fetch: fetchImpl, sleep: deps.sleep };
  const confirmBudgetMs = deps.confirmBudgetMs ?? CONFIRM_BUDGET_MS;
  const pollMs = deps.pollIntervalMs ?? CONFIRM_POLL_MS;
  const prepareBudgetMs = deps.prepareBudgetMs ?? PREPARE_BUDGET_MS;
  const media: MatrixMediaDeps = {
    fetch: fetchImpl,
    requestTimeoutMs: deps.homeserverTimeoutMs ?? HOMESERVER_TIMEOUT_MS,
    credentialsTimeoutMs: deps.credentialsTimeoutMs ?? CREDENTIALS_TIMEOUT_MS,
  };
  const notAnAccount = refuse(
    'Your identity is not an IXO account (did:ixo:ixo1…), so a POD cannot be created in your name.',
    false,
  );

  return {
    async preparePodBatch({ network, profile }, ctx) {
      const did = ctx.user.did;
      const address = ixoAddressOf(did);
      if (!address) return notAnAccount;
      const deadline = Date.now() + prepareBudgetMs;
      const owner = await ownerPublicKey(
        chainCall(ctx, network, io, deadline),
        { did, address },
      );
      if (!owner.ok) return owner;
      // Reserved and hashed as these exact bytes: the proof is what a reader
      // checks the downloaded profile against.
      const profileText = JSON.stringify(podProfileDocument(profile));
      const reserved = await reservePublicDocument(
        ctx,
        {
          text: profileText,
          filename: 'profile.json',
          contentType: 'application/ld+json',
        },
        media,
        deadline,
      );
      if (!reserved.ok) return reserved;
      const start = now();
      const message: ITrxMsg = {
        typeUrl: CREATE_ENTITY,
        value: {
          entityType: POD_ENTITY_TYPE,
          entityStatus: 0,
          controller: [did],
          context: [],
          verification: ownerVerifications({
            did,
            address,
            publicKey: owner.publicKey,
          }),
          service: [],
          accordedRight: [],
          linkedResource: [
            {
              id: PROFILE_RESOURCE_ID,
              type: 'Settings',
              description: 'Profile',
              mediaType: 'application/json',
              serviceEndpoint: reserved.url,
              proof: documentProof(profileText),
              encrypted: 'false',
              right: '',
            },
          ],
          linkedEntity: [],
          linkedClaim: [],
          startDate: start.toISOString(),
          endDate: new Date(start.getTime() + ENTITY_LIFETIME_MS).toISOString(),
          relayerNode: relayerNodeDidFor(ctx, network),
          ownerDid: did,
          ownerAddress: address,
        },
      };
      return {
        ok: true,
        messages: [message],
        summary: podSummary(network, address, profile),
        documents: reserved.pending ? [reserved.pending] : [],
      };
    },

    publishDocuments({ documents }, ctx) {
      return publishPendingDocuments(
        ctx,
        documents,
        media,
        Date.now() + PUBLISH_BUDGET_MS,
      );
    },

    async confirmPodCreation({ txHash, network, sent }, ctx) {
      const started = Date.now();
      const call = chainCall(ctx, network, io, started + confirmBudgetMs);
      const owner = { did: ctx.user.did, address: ixoAddressOf(ctx.user.did) };
      let lastFailure: Failure | null = null;
      while (true) {
        const read = await restJson(
          call,
          `/cosmos/tx/v1beta1/txs/${txHash}`,
          txSchema,
          { label: 'POD transaction', tag: POD_TAG, noneOn: [404] },
        );
        if (read.ok && !('absent' in read)) {
          if (
            read.value.tx_response.txhash.toUpperCase() !== txHash.toUpperCase()
          )
            return {
              status: 'unavailable',
              retryable: false,
              message:
                'The chain answered with a different transaction than the one asked for.',
            };
          return podOfTransaction(read.value, owner, sent, network);
        }
        if (!read.ok && !read.failure.retryable)
          return {
            status: 'unavailable',
            retryable: false,
            message: `Could not read the transaction from the chain: ${read.failure.detail}`,
          };
        // Not indexed yet, or the node is briefly unavailable: ask again
        // while the budget leaves room for a wait and one more read.
        lastFailure = read.ok ? null : read.failure;
        if (call.deadline - Date.now() < pollMs + MIN_ATTEMPT_MS) break;
        await wait(pollMs, ctx.abortSignal);
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      return lastFailure === null
        ? {
            status: 'pending',
            retryable: true,
            message: `The chain has no transaction ${txHash} after ${seconds} s: it may not be in a block yet. Call confirm_pod_creation again in a moment with the same hash.`,
          }
        : {
            status: 'unavailable',
            retryable: true,
            message: `The chain could not be read for ${seconds} s (${lastFailure.detail}). Call confirm_pod_creation again in a moment with the same hash.`,
          };
    },

    async prepareDomainCard({ network, podDid, profile }, ctx) {
      const address = ixoAddressOf(ctx.user.did);
      if (!address) return notAnAccount;
      const cardText = JSON.stringify(
        podDomainCardDocument({
          podDid,
          ownerDid: ctx.user.did,
          profile,
          validFrom: now().toISOString(),
        }),
      );
      const reserved = await reservePublicDocument(
        ctx,
        {
          text: cardText,
          filename: 'domainCard.json',
          contentType: 'application/ld+json',
        },
        media,
        Date.now() + prepareBudgetMs,
      );
      if (!reserved.ok) return reserved;
      return {
        ok: true,
        messages: [
          {
            typeUrl: ADD_LINKED_RESOURCE,
            value: {
              id: podDid,
              linkedResource: {
                id: '{id}#dmn',
                type: 'domainCard',
                description: 'Domain Card',
                mediaType: 'application/json',
                serviceEndpoint: reserved.url,
                proof: documentProof(cardText),
                encrypted: 'false',
                right: '',
              },
              signer: address,
            },
          },
        ],
        summary: `Add the public domain card of your POD ${podDid} on ${network}, so the Portal lists it and search finds it: name "${profile.name}"; description ${profile.description ? `"${profile.description}"` : '(none)'}.`,
        documents: reserved.pending ? [reserved.pending] : [],
      };
    },

    async requestIndexing({ network, podDid }, ctx) {
      throwIfAborted(ctx.abortSignal);
      await requestIndexing(
        ctx,
        domainIndexerUrlFor(ctx, network),
        podDid,
        fetchImpl,
      );
    },
  };
}
