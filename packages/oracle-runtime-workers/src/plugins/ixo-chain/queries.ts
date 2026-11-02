/**
 * The core `chain_lookup` kinds' arguments and the Blocksync root field
 * each request becomes.
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

const MAX_FIRST = 20;
const DEFAULT_FIRST = 10;
/**
 * Rows a call of several requests reads in all: each list request is
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

// These schemas are shown only through `describe_chain_kinds`, so each
// field says its format in full. Lengths are not capped here: every string
// is checked against its kind's bounded pattern before it reaches the
// document.
/** A list kind's `first` argument. */
export const firstArg = z
  .number()
  .int()
  .min(1)
  .max(MAX_FIRST)
  .optional()
  .describe(
    'Rows to read, 1–20 (default 10; fewer when a call has several requests).',
  );
/** An account argument (`role` names whose it is), the user's by default. */
export const accountArg = (role: string) =>
  z
    .string()
    .optional()
    .describe(
      `${role}: an ixo1… address or did:ixo:ixo1… DID. Default: the user.`,
    );

/** Each core kind's arguments (strict: an unknown key refuses the request). */
export const CORE_ARGS = {
  claims: z.strictObject({
    agent: accountArg('Claim submitter'),
    collectionId: z
      .string()
      .optional()
      .describe('Only claims in this collection, e.g. "8250".'),
    first: firstArg,
    after: z
      .string()
      .optional()
      .describe("The previous page's `endCursor`, for the next page."),
  }),
  claim: z.strictObject({
    claimId: z.string().describe('The claim id (a CID, e.g. bafkrei…).'),
  }),
  claim_collection: z.strictObject({
    id: z.string().describe('Collection id, e.g. "8250".'),
  }),
  claim_collections: z.strictObject({
    entity: z
      .string()
      .optional()
      .describe(
        "The collections' entity (did:ixo:entity:…); alone, every admin's.",
      ),
    admin: accountArg('Collection admin'),
    first: firstArg,
  }),
  entities: z.strictObject({
    owner: accountArg('Entity owner'),
    type: z.string().optional().describe('Entity type, e.g. "dao".'),
    first: firstArg,
  }),
  entity: z.strictObject({
    id: z.string().describe('The entity DID: did:ixo:entity:<32 hex>.'),
  }),
  did_document: z.strictObject({
    id: z
      .string()
      .optional()
      .describe("Any did:ixo:… DID. Default: the user's."),
  }),
  token_balances: z.strictObject({
    address: accountArg('Token holder'),
    first: firstArg,
  }),
  transactions: z.strictObject({
    address: accountArg('Signer or recipient'),
    direction: z
      .enum(['signed', 'received'])
      .optional()
      .describe('Signed by the address, or received by it. Default: signed.'),
    first: firstArg,
  }),
  transaction: z.strictObject({
    hash: z.string().describe('The 64-hex transaction hash.'),
  }),
};

type CoreArgs = typeof CORE_ARGS;
type ChainRequestKind = keyof CoreArgs;
/** A core kind's request: its name beside its parsed arguments. */
export type ChainRequest = {
  [K in ChainRequestKind]: { kind: K } & z.output<CoreArgs[K]>;
}[ChainRequestKind];
export type Subject = 'user' | 'other';

/**
 * One request as a root field of the lookup document (without its alias),
 * or why it cannot be asked. `subject` is known before the read for a
 * request by account; `first` is the rows a list request reads.
 */
export type FieldPlan =
  | { ok: true; field: string; subject?: Subject; first?: number }
  | { ok: false; detail: string };

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
 * The rows a list request reads: its `first` (1–20 by its kind's schema,
 * default 10), capped at `max(5, floor(40 / count))` when the call holds
 * `count > 1` requests.
 */
export function firstOf(requested: number | undefined, count: number): number {
  const cap =
    count > 1
      ? Math.max(MIN_SHARED_FIRST, Math.floor(SHARED_ROWS / count))
      : MAX_FIRST;
  return Math.min(requested ?? DEFAULT_FIRST, cap, MAX_FIRST);
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATOR = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
];
/** The checksum's length in characters. */
const BECH32_CHECKSUM = 6;

/** BIP-173 `bech32_polymod`. */
function polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    BECH32_GENERATOR.forEach((generator, bit) => {
      if ((top >>> bit) & 1) checksum ^= generator;
    });
  }
  return checksum;
}

/**
 * Whether `address` is a valid lower-case bech32 string (BIP-173, as Cosmos
 * SDK addresses are) with the prefix `prefix`: only bech32 characters after
 * `<prefix>1`, the checksum matching, and data that converts to whole
 * bytes (at most 4 padding bits, all zero). Its length is the caller's to
 * bound.
 */
export function isBech32(address: string, prefix: string): boolean {
  if (!address.startsWith(`${prefix}1`)) return false;
  const data = address.slice(prefix.length + 1);
  if (data.length <= BECH32_CHECKSUM) return false;
  const values: number[] = [];
  for (const char of data) {
    const value = BECH32_CHARSET.indexOf(char);
    if (value < 0) return false;
    values.push(value);
  }
  const codes = [...prefix].map((char) => char.charCodeAt(0));
  const expanded = [
    ...codes.map((code) => code >> 5),
    0,
    ...codes.map((code) => code & 31),
  ];
  if (polymod([...expanded, ...values]) !== 1) return false;
  const payload = values.length - BECH32_CHECKSUM;
  const padding = (payload * 5) % 8;
  const last = values[payload - 1] ?? 0;
  return padding < 5 && (last & ((1 << padding) - 1)) === 0;
}

/**
 * The account an account field names: the user's own address when the
 * field is omitted, else an `ixo1…` address or the address a
 * `did:ixo:ixo1…` DID names, its bech32 checksum verified (a mistyped
 * address is refused, never read).
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
  if (!isBech32(address, 'ixo'))
    return {
      ok: false,
      detail: `${role} is not a valid ixo1… address: its checksum does not match. Check it for a typo.`,
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

const invalid = (detail: string): FieldPlan => ({ ok: false, detail });

/**
 * One request as a root field of the lookup document. `rows` is the rows a
 * list request reads: its `first` as {@link firstOf} scales it for the call.
 */
export function requestField(
  request: ChainRequest,
  identity: UserIdentity,
  rows: number,
): FieldPlan {
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
      return {
        ok: true,
        subject: agent.subject,
        first: rows,
        field: `claims(filter: ${filter}, first: ${rows}${after}, orderBy: SUBMISSION_DATE_DESC) { totalCount pageInfo { hasNextPage endCursor } nodes { ${CLAIM_FIELDS} evaluation { status evaluationDate } } }`,
      };
    }
    case 'claim':
      if (!CLAIM_ID.test(request.claimId))
        return invalid(
          'claimId must be a claim id (a CID such as "bafkrei…").',
        );
      return {
        ok: true,
        field: `claim(claimId: ${literal(request.claimId)}) { ${CLAIM_FIELDS} evaluation { status evaluationDate oracle agentDid agentAddress reason amount } }`,
      };
    case 'claim_collection':
      if (!COLLECTION_ID.test(request.id))
        return invalid('id must be a collection number such as "8250".');
      return {
        ok: true,
        field: `claimCollection(id: ${literal(request.id)}) { ${COLLECTION_FIELDS} payments }`,
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
      // Newest start date first (the id is text: "9" sorts above "10"). A
      // collection without a start date sorts first, as PostgreSQL puts
      // NULLs first in a descending order; x/claims reads the start date on
      // every claim submission, so a collection that takes claims has one.
      return {
        ok: true,
        ...(admin ? { subject: admin.subject } : {}),
        first: rows,
        field: `claimCollections(filter: ${filter}, first: ${rows}, orderBy: START_DATE_DESC) { totalCount nodes { ${COLLECTION_FIELDS} } }`,
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
      return {
        ok: true,
        subject: owner.subject,
        first: rows,
        field: `entities(filter: ${filter}, first: ${rows}, orderBy: ID_DESC) { totalCount nodes { id type status owner metadata } }`,
      };
    }
    case 'entity':
      if (!ENTITY_DID.test(request.id))
        return invalid('id must be a did:ixo:entity:… DID.');
      return {
        ok: true,
        field: `entity(id: ${literal(request.id)}) { id type status owner accounts settings linkedResource linkedEntity controller service }`,
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
        ok: true,
        subject: id === identity.did ? 'user' : 'other',
        field: `iid(id: ${literal(id)}) { id controller verificationMethod linkedResource alsoKnownAs }`,
      };
    }
    case 'token_balances': {
      const holder = accountOf(request.address, identity, 'address');
      if (!holder.ok) return invalid(holder.detail);
      return {
        ok: true,
        subject: holder.subject,
        first: rows,
        field: `tokenBalances(filter: ${equalities([['address', holder.address]])}, first: ${rows}, orderBy: AMOUNT_DESC) { totalCount nodes { tokenId amount retired token { name collection tokenClassByName { contractAddress class } } } }`,
      };
    }
    case 'transactions': {
      const holder = accountOf(request.address, identity, 'address');
      if (!holder.ok) return invalid(holder.detail);
      if (request.direction === 'received')
        // `Message.to` (indexed) is the recipient field of the message, or
        // of its first inner message for an authz MsgExec: toAddress,
        // receiver, recipient, recipientAddress or recipientDid. The same
        // filter the Portal's wallet history polls with.
        return {
          ok: true,
          subject: holder.subject,
          first: rows,
          field: `messages(filter: ${equalities([['to', holder.address]])}, first: ${rows}, orderBy: ID_DESC) { totalCount nodes { ${MESSAGE_FIELDS} transactionHash transactionByTransactionHash { ${TRANSACTION_FIELDS} } } }`,
        };
      return {
        ok: true,
        subject: holder.subject,
        first: rows,
        field: `transactionSigners(filter: ${equalities([['signerAddress', holder.address]])}, first: ${rows}, orderBy: TRANSACTION_ID_DESC) { totalCount nodes { transactionHash transaction { ${TRANSACTION_FIELDS} ${messagesOf(LIST_TX_MESSAGES)} } } }`,
      };
    }
    case 'transaction':
      if (!TX_HASH.test(request.hash))
        return invalid('hash must be a 64-character hex transaction hash.');
      return {
        ok: true,
        field: `transactions(filter: ${equalities([['hash', request.hash.toUpperCase()]])}, first: 1) { nodes { ${TRANSACTION_FIELDS} fee transactionSignersByTransactionId(first: ${TX_SIGNERS}) { nodes { signerAddress } } ${messagesOf(ONE_TX_MESSAGES)} } }`,
      };
  }
}
