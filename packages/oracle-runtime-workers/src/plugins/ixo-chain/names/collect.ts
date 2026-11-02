/**
 * The identifiers a tool result carries, for its `names` map, and the
 * upkeep of that map while the result is cut to size.
 *
 * An identifier is a whole string value in a form the IXO Names worker
 * names: an `ixo1…` address of an account (42 characters) or a contract
 * (62), its bech32 checksum valid; a `did:ixo:ixo1…` or `did:ixo:wasm:ixo1…`
 * DID of such an address; an entity DID (`did:ixo:entity:<32 hex>`); an
 * `ixovaloper1…` address; or a claim collection id (sent as
 * `collection:<id>`) in a field named `collectionId`, or the `id` of a
 * `claim_collection` result or of a `claim_collections` result's items.
 * A field named `collection` is not read as one: a token's `collection` is
 * text its minter chose. An address inside a memo or an excerpt is text,
 * not an identifier. Denoms are not collected: balances already name their
 * tokens. Who raised a dispute (`disputer`, `disputerDid`) is never named.
 * A `names` map already on the result is never read as part of it.
 */
import type { UserIdentity } from '../../../core/user-identity';
import { isBech32 } from '../queries';
import { isRecord } from '../summaries';
import type { NameMap } from './types';

/** The most identifiers one tool result asks names for, the best placed first. */
export const MAX_IDENTIFIERS = 40;
/** An account address, and a contract address. */
const ADDRESS_LENGTHS: ReadonlySet<number> = new Set([42, 62]);
/** BIP-173's longest bech32 string. */
const BECH32_MAX = 90;
const ACCOUNT_DID_PREFIX = 'did:ixo:';
const CONTRACT_DID_PREFIX = 'did:ixo:wasm:';
const ENTITY_DID = /^did:ixo:entity:[0-9a-f]{32}$/;
const COLLECTION_ID = /^\d{1,12}$/;
/** Fields whose identifiers are never named: a dispute's filer (the `disputes` kind). */
const UNNAMED_FIELDS: ReadonlySet<string> = new Set([
  'disputer',
  'disputerDid',
]);

/**
 * The rows of a `chain_lookup` result whose own `id` is a claim collection
 * id: the `data` of an answered `claim_collection` request, the
 * `data.items` of an answered `claim_collections` request.
 */
function collectionRowsOf(node: Record<string, unknown>): unknown[] {
  if (node.ok !== true || !isRecord(node.data)) return [];
  if (node.kind === 'claim_collection') return [node.data];
  if (node.kind === 'claim_collections' && Array.isArray(node.data.items))
    return node.data.items;
  return [];
}

/**
 * `value` (under the key `field`) as an identifier the Names worker names, or
 * null; `inCollectionRow` when `field` is a key of a collection row (see
 * {@link collectionRowsOf}).
 */
function identifierOf(
  value: string,
  field: string | undefined,
  inCollectionRow: boolean,
): string | null {
  if (
    (field === 'collectionId' || (inCollectionRow && field === 'id')) &&
    COLLECTION_ID.test(value)
  )
    return `collection:${value}`;
  if (ENTITY_DID.test(value)) return value;
  const address = value.startsWith(`${CONTRACT_DID_PREFIX}ixo1`)
    ? value.slice(CONTRACT_DID_PREFIX.length)
    : value.startsWith(`${ACCOUNT_DID_PREFIX}ixo1`)
      ? value.slice(ACCOUNT_DID_PREFIX.length)
      : value;
  if (ADDRESS_LENGTHS.has(address.length) && isBech32(address, 'ixo'))
    return value;
  return address === value &&
    value.length <= BECH32_MAX &&
    isBech32(value, 'ixovaloper')
    ? value
    : null;
}

/** One walk over a tool result: where it reports, and the collection rows it has met. */
interface Walk {
  found: (identifier: string, rank: number) => void;
  collectionRows: WeakSet<object>;
}

/**
 * Calls `walk.found` for every identifier in `node` with its rank: the
 * highest list index on its path, so an identifier in the first rows of
 * every list ranks before one further down any of them. `inCollectionRow`:
 * `node` is a value directly under a collection row.
 */
function visit(
  node: unknown,
  rank: number,
  field: string | undefined,
  inCollectionRow: boolean,
  walk: Walk,
): void {
  if (field !== undefined && UNNAMED_FIELDS.has(field)) return;
  if (typeof node === 'string') {
    const identifier = identifierOf(node, field, inCollectionRow);
    if (identifier) walk.found(identifier, rank);
  } else if (Array.isArray(node))
    node.forEach((item, index) =>
      visit(item, Math.max(rank, index), field, false, walk),
    );
  else if (isRecord(node)) {
    for (const row of collectionRowsOf(node))
      if (isRecord(row)) walk.collectionRows.add(row);
    const isCollectionRow = walk.collectionRows.has(node);
    for (const [key, inner] of Object.entries(node))
      visit(inner, rank, key, isCollectionRow, walk);
  }
}

/** {@link visit} over a tool result, leaving out its `names` map. */
function eachIdentifier(
  result: unknown,
  found: (identifier: string, rank: number) => void,
): void {
  const walk: Walk = { found, collectionRows: new WeakSet() };
  if (!isRecord(result)) {
    visit(result, 0, undefined, false, walk);
    return;
  }
  for (const [key, inner] of Object.entries(result))
    if (key !== 'names') visit(inner, 0, key, false, walk);
}

/**
 * The identifiers to name in `result`, without the user's own address and
 * DID (the model already knows the user): each once, those in the top rows
 * of lists first (then in the order they appear), at most
 * {@link MAX_IDENTIFIERS}.
 */
export function collectIdentifiers(
  result: unknown,
  identity: UserIdentity,
): string[] {
  const own = new Set([identity.did]);
  if (identity.address) {
    own.add(identity.address);
    own.add(`${ACCOUNT_DID_PREFIX}${identity.address}`);
  }
  // Insertion order is the order of first appearance; the sort is stable.
  const best = new Map<string, number>();
  eachIdentifier(result, (identifier, rank) => {
    if (own.has(identifier)) return;
    const known = best.get(identifier);
    if (known === undefined || rank < known) best.set(identifier, rank);
  });
  return [...best]
    .sort((a, b) => a[1] - b[1])
    .slice(0, MAX_IDENTIFIERS)
    .map(([identifier]) => identifier);
}

/** Leaves out the entries of `answer.names` whose identifier is no longer in `answer`. */
export function pruneNames(answer: { names?: NameMap }): void {
  const { names } = answer;
  if (!names) return;
  const present = new Set<string>();
  eachIdentifier(answer, (identifier) => present.add(identifier));
  answer.names = Object.fromEntries(
    Object.entries(names).filter(([identifier]) => present.has(identifier)),
  );
}

/**
 * Leaves out the last entry of `answer.names` (the map lists the best
 * placed identifiers first); false when there is none to leave out.
 */
export function dropLastName(answer: { names?: NameMap }): boolean {
  const entries = Object.entries(answer.names ?? {});
  if (!entries.length) return false;
  answer.names = Object.fromEntries(entries.slice(0, -1));
  return true;
}
