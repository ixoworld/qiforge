/**
 * The `chain_lookup` requests and the one Blocksync document they become.
 *
 * Every field name, argument and enum below is checked against the
 * ixo-blocksync-api schema (`public/graphql/schema.graphql`; see
 * docs/chain-tools.md for the commit). Ids are checked against their kind's
 * pattern and then written into the document as GraphQL literals, never
 * passed as variables. Every filter is on an indexed column; none is a
 * `Message.value` containment: on an account address those run into
 * Blocksync's 8 s statement timeout on mainnet even beside the `typeUrl`
 * clause that makes them an index lookup. Should one ever be added, it must
 * carry `typeUrl: { notEqualTo: "/ibc.core.client.v1.MsgUpdateClient" }`
 * beside it (the GIN index is partial).
 */
import { IxoAddressSchema } from '@ixo/ixo-transaction';
import { z } from 'zod';
import { ixoAddressOf, type UserIdentity } from '../../core/user-identity';
import type { AliasedField } from './blocksync';

const MAX_REQUESTS = 8;
const MAX_FIRST = 20;
const DEFAULT_FIRST = 10;
/**
 * Rows a document of several requests reads in all: each list request is
 * capped at `max(5, floor(40 / requests))`.
 */
const SHARED_ROWS = 40;
const MIN_SHARED_FIRST = 5;
/** Messages read per transaction in a list (the count of all is kept), and for one transaction. */
const LIST_TX_MESSAGES = 5;
const ONE_TX_MESSAGES = 50;
/** Signers read for one transaction. */
const TX_SIGNERS = 10;

const ENTITY_DID = /^did:ixo:entity:[0-9a-f]{32}$/;
const IXO_DID = /^did:ixo:[A-Za-z0-9:._-]{1,120}$/;
const CLAIM_ID = /^[a-z0-9]{20,100}$/i;
const COLLECTION_ID = /^\d{1,12}$/;
const TX_HASH = /^[A-F0-9]{64}$/i;
const CURSOR = /^[A-Za-z0-9+/=_-]{1,200}$/;
const ENTITY_TYPE = /^[A-Za-z0-9/_.:-]{1,64}$/;

// The account-field format and `first`'s meaning are stated once, in the
// tool description; each field here only names its role. Lengths are not
// capped here: every string is checked against its kind's bounded pattern
// before it reaches the document.
const first = z.number().int().min(1).max(MAX_FIRST).optional();
const account = (role: string) => z.string().optional().describe(role);

export const chainRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('claims'),
    agent: account('Claim submitter.'),
    collectionId: z.string().optional(),
    first,
    after: z.string().optional().describe('Previous page endCursor.'),
  }),
  z.strictObject({
    kind: z.literal('claim'),
    claimId: z.string().describe('The claim id (a CID, e.g. bafkrei…).'),
  }),
  z.strictObject({
    kind: z.literal('claim_collection'),
    id: z.string().describe('Collection id, e.g. "8250".'),
  }),
  z.strictObject({
    kind: z.literal('claim_collections'),
    entity: z.string().optional().describe('Its did:ixo:entity:… DID.'),
    admin: account('Collection admin.'),
    first,
  }),
  z.strictObject({
    kind: z.literal('entities'),
    owner: account('Entity owner.'),
    type: z.string().optional().describe('e.g. "dao".'),
    first,
  }),
  z.strictObject({
    kind: z.literal('entity'),
    id: z.string().describe('did:ixo:entity:…'),
  }),
  z.strictObject({
    kind: z.literal('did_document'),
    id: z
      .string()
      .optional()
      .describe("Any did:ixo:… DID; default: the user's."),
  }),
  z.strictObject({
    kind: z.literal('token_balances'),
    address: account('Token holder.'),
    first,
  }),
  z.strictObject({
    kind: z.literal('transactions'),
    address: account('Signer or recipient.'),
    direction: z
      .enum(['signed', 'received'])
      .optional()
      .describe('Default: signed.'),
    first,
  }),
  z.strictObject({
    kind: z.literal('transaction'),
    hash: z.string().describe('64-hex transaction hash.'),
  }),
]);

export type ChainRequest = z.infer<typeof chainRequestSchema>;
export type ChainRequestKind = ChainRequest['kind'];
export type Subject = 'user' | 'other';

export const chainLookupSchema = z.strictObject({
  requests: z.array(chainRequestSchema).min(1).max(MAX_REQUESTS),
});

/**
 * One request as a document field, or why it cannot be asked. `subject` is
 * known before the read for a request by account; `first` is the rows a
 * list request reads.
 */
export type FieldPlan =
  | ({
      ok: true;
      request: ChainRequest;
      kind: ChainRequestKind;
      subject?: Subject;
      first?: number;
    } & AliasedField)
  | {
      ok: false;
      request: ChainRequest;
      kind: ChainRequestKind;
      detail: string;
    };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A JSON value as a GraphQL input literal: keys bare, strings quoted as JSON quotes them. */
export function literal(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (value && typeof value === 'object')
    return `{ ${Object.entries(value)
      .map(([key, inner]) => {
        if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(key))
          throw new Error(`not a GraphQL name: ${key}`);
        return `${key}: ${literal(inner)}`;
      })
      .join(', ')} }`;
  return JSON.stringify(value);
}

/**
 * The rows a list request reads: its `first` (1–20 by the schema, default
 * 10), capped at `max(5, floor(40 / count))` when the document holds
 * `count > 1` requests.
 */
export function firstOf(requested: number | undefined, count: number): number {
  const cap =
    count > 1
      ? Math.max(MIN_SHARED_FIRST, Math.floor(SHARED_ROWS / count))
      : MAX_FIRST;
  return Math.min(requested ?? DEFAULT_FIRST, cap, MAX_FIRST);
}

/**
 * The account an account field names: the user's own address when the
 * field is omitted, else an `ixo1…` address or the address a
 * `did:ixo:ixo1…` DID names.
 */
export function accountOf(
  input: string | undefined,
  identity: UserIdentity,
  role: string,
):
  | { ok: true; address: string; subject: Subject }
  | { ok: false; detail: string } {
  if (input === undefined)
    return identity.address
      ? { ok: true, address: identity.address, subject: 'user' }
      : { ok: false, detail: 'The user has no IXO account address; give one.' };
  const address = IxoAddressSchema.safeParse(input).success
    ? input
    : ixoAddressOf(input);
  if (!address)
    return {
      ok: false,
      detail: `${role} must be an ixo1… address or a did:ixo:ixo1… DID.`,
    };
  return {
    ok: true,
    address,
    subject: address === identity.address ? 'user' : 'other',
  };
}

const CLAIM_FIELDS =
  'claimId collectionId agentDid agentAddress submissionDate paymentsStatus schemaType useIntent amount currentEvaluationId';
const COLLECTION_FIELDS =
  'id entity admin protocol startDate endDate quota count evaluated approved rejected disputed state';
const MESSAGE_FIELDS = 'typeUrl index value';
const TRANSACTION_FIELDS = 'hash height time code memo';

const messagesOf = (n: number) =>
  `messagesByTransactionHash(first: ${n}, orderBy: INDEX_ASC) { totalCount nodes { ${MESSAGE_FIELDS} } }`;

/** `filter: { a: { equalTo: x }, … }` for the given scalar equalities. */
function equalities(pairs: [string, string | undefined][]): string {
  return literal(
    Object.fromEntries(
      pairs.flatMap(([key, value]) =>
        value === undefined ? [] : [[key, { equalTo: value }]],
      ),
    ),
  );
}

/**
 * One request as an aliased field of the lookup document; `count` is the
 * number of requests the document holds.
 */
export function requestField(
  alias: string,
  request: ChainRequest,
  identity: UserIdentity,
  count = 1,
): FieldPlan {
  const plan = fieldOf(alias, request, identity, count);
  return 'detail' in plan
    ? { ok: false, request, kind: request.kind, detail: plan.detail }
    : { ok: true, request, kind: request.kind, alias, ...plan };
}

const invalid = (detail: string) => ({ detail });

function fieldOf(
  alias: string,
  request: ChainRequest,
  identity: UserIdentity,
  count: number,
): { field: string; subject?: Subject; first?: number } | { detail: string } {
  switch (request.kind) {
    case 'claims': {
      const agent = accountOf(request.agent, identity, 'agent');
      if (!agent.ok) return invalid(agent.detail);
      if (
        request.collectionId !== undefined &&
        !COLLECTION_ID.test(request.collectionId)
      )
        return invalid('collectionId must be a number such as "8250".');
      if (request.after !== undefined && !CURSOR.test(request.after))
        return invalid('after must be an endCursor from an earlier page.');
      // Claim."agentAddress" is indexed and "agentDid" is not: a did:ixo
      // account's claims are read by the address its DID names.
      const filter = equalities([
        ['agentAddress', agent.address],
        ['collectionId', request.collectionId],
      ]);
      const after = request.after ? `, after: ${literal(request.after)}` : '';
      const n = firstOf(request.first, count);
      return {
        subject: agent.subject,
        first: n,
        field: `${alias}: claims(filter: ${filter}, first: ${n}${after}, orderBy: SUBMISSION_DATE_DESC) { totalCount pageInfo { hasNextPage endCursor } nodes { ${CLAIM_FIELDS} evaluation { status evaluationDate } } }`,
      };
    }
    case 'claim':
      if (!CLAIM_ID.test(request.claimId))
        return invalid(
          'claimId must be a claim id (a CID such as "bafkrei…").',
        );
      return {
        field: `${alias}: claim(claimId: ${literal(request.claimId)}) { ${CLAIM_FIELDS} evaluation { status evaluationDate oracle agentDid agentAddress reason amount } }`,
      };
    case 'claim_collection':
      if (!COLLECTION_ID.test(request.id))
        return invalid('id must be a collection number such as "8250".');
      return {
        field: `${alias}: claimCollection(id: ${literal(request.id)}) { ${COLLECTION_FIELDS} payments }`,
      };
    case 'claim_collections': {
      if (request.entity !== undefined && !ENTITY_DID.test(request.entity))
        return invalid('entity must be a did:ixo:entity:… DID.');
      // With only an entity named, every collection of that entity;
      // otherwise the admin (the user by default).
      const admin =
        request.entity !== undefined && request.admin === undefined
          ? undefined
          : accountOf(request.admin, identity, 'admin');
      if (admin && !admin.ok) return invalid(admin.detail);
      const filter = equalities([
        ['entity', request.entity],
        ['admin', admin?.address],
      ]);
      const n = firstOf(request.first, count);
      // Newest start date first (the id is text: "9" sorts above "10"). A
      // collection without a start date sorts first, as PostgreSQL puts
      // NULLs first in a descending order; x/claims reads the start date on
      // every claim submission, so a collection that takes claims has one.
      return {
        ...(admin ? { subject: admin.subject } : {}),
        first: n,
        field: `${alias}: claimCollections(filter: ${filter}, first: ${n}, orderBy: START_DATE_DESC) { totalCount nodes { ${COLLECTION_FIELDS} } }`,
      };
    }
    case 'entities': {
      const owner = accountOf(request.owner, identity, 'owner');
      if (!owner.ok) return invalid(owner.detail);
      if (request.type !== undefined && !ENTITY_TYPE.test(request.type))
        return invalid('type must be an entity type such as "dao".');
      const filter = equalities([
        ['owner', owner.address],
        ['type', request.type],
      ]);
      const n = firstOf(request.first, count);
      return {
        subject: owner.subject,
        first: n,
        field: `${alias}: entities(filter: ${filter}, first: ${n}, orderBy: ID_DESC) { totalCount nodes { id type status owner metadata } }`,
      };
    }
    case 'entity':
      if (!ENTITY_DID.test(request.id))
        return invalid('id must be a did:ixo:entity:… DID.');
      return {
        field: `${alias}: entity(id: ${literal(request.id)}) { id type status owner accounts settings linkedResource linkedEntity controller service }`,
      };
    case 'did_document': {
      const id = request.id ?? identity.did;
      if (!IXO_DID.test(id))
        return invalid(
          request.id === undefined
            ? "The user's DID is not a did:ixo DID; give one."
            : 'id must be a did:ixo:… DID.',
        );
      return {
        subject: id === identity.did ? 'user' : 'other',
        field: `${alias}: iid(id: ${literal(id)}) { id controller verificationMethod linkedResource alsoKnownAs }`,
      };
    }
    case 'token_balances': {
      const holder = accountOf(request.address, identity, 'address');
      if (!holder.ok) return invalid(holder.detail);
      const n = firstOf(request.first, count);
      return {
        subject: holder.subject,
        first: n,
        field: `${alias}: tokenBalances(filter: ${equalities([['address', holder.address]])}, first: ${n}, orderBy: AMOUNT_DESC) { totalCount nodes { tokenId amount retired token { name collection tokenClassByName { contractAddress class } } } }`,
      };
    }
    case 'transactions': {
      const holder = accountOf(request.address, identity, 'address');
      if (!holder.ok) return invalid(holder.detail);
      const n = firstOf(request.first, count);
      if (request.direction === 'received')
        // `Message.to` (indexed) is the recipient field of the message, or
        // of its first inner message for an authz MsgExec: toAddress,
        // receiver, recipient, recipientAddress or recipientDid. The same
        // filter the Portal's wallet history polls with.
        return {
          subject: holder.subject,
          first: n,
          field: `${alias}: messages(filter: ${equalities([['to', holder.address]])}, first: ${n}, orderBy: ID_DESC) { totalCount nodes { ${MESSAGE_FIELDS} transactionHash transactionByTransactionHash { ${TRANSACTION_FIELDS} } } }`,
        };
      return {
        subject: holder.subject,
        first: n,
        field: `${alias}: transactionSigners(filter: ${equalities([['signerAddress', holder.address]])}, first: ${n}, orderBy: TRANSACTION_ID_DESC) { totalCount nodes { transactionHash transaction { ${TRANSACTION_FIELDS} ${messagesOf(LIST_TX_MESSAGES)} } } }`,
      };
    }
    case 'transaction':
      if (!TX_HASH.test(request.hash))
        return invalid('hash must be a 64-character hex transaction hash.');
      return {
        field: `${alias}: transactions(filter: ${equalities([['hash', request.hash.toUpperCase()]])}, first: 1) { nodes { ${TRANSACTION_FIELDS} fee transactionSignersByTransactionId(first: ${TX_SIGNERS}) { nodes { signerAddress } } ${messagesOf(ONE_TX_MESSAGES)} } }`,
      };
  }
}

/** The alias of the request at `index`. */
const aliasOf = (index: number) => `r${index}`;

/**
 * Every askable request as an aliased document field (aliases `r0…r7`, by
 * position) and each request's plan. `fields` is empty when no request can
 * be asked.
 */
export function buildDocument(
  requests: readonly ChainRequest[],
  identity: UserIdentity,
): { fields: AliasedField[]; plans: FieldPlan[] } {
  const plans = requests.map((request, index) =>
    requestField(aliasOf(index), request, identity, requests.length),
  );
  return {
    fields: plans.flatMap((plan) =>
      plan.ok ? [{ alias: plan.alias, field: plan.field }] : [],
    ),
    plans,
  };
}
