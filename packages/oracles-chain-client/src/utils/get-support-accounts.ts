import { z } from 'zod';
import { graphqlClient } from '../gql/index.js';

/**
 * Support accounts are declared on the entity's DID document as
 * `linkedEntity` entries of the shape:
 *
 *   { type: '...', id: '<support user DID>', relationship: 'support', service: 'matrix' }
 *
 * The DID document is the source of truth: the oracle's concierge escalation
 * and the rooms-bot `/spaces/source` scaffold both resolve support accounts
 * through this function.
 */
export interface SupportAccount {
  /** The support user's DID (`linkedEntity.id`). */
  did: string;
  relationship: string;
  service: string;
}

const SUPPORT_RELATIONSHIP = 'support';
const SUPPORT_SERVICE = 'matrix';

/** On-chain iid `LinkedEntity` shape, parsed tolerantly from the JSON scalar. */
const linkedEntitySchema = z.object({
  id: z.string().min(1),
  relationship: z.string(),
  service: z.string(),
});

/**
 * Pure filter over a DID document's `linkedEntity` value (an untyped JSON
 * scalar from blocksync). Malformed entries are skipped, never thrown on —
 * one bad entry must not disable support escalation for the whole entity.
 */
export function parseSupportAccounts(linkedEntity: unknown): SupportAccount[] {
  if (!Array.isArray(linkedEntity)) return [];
  const accounts: SupportAccount[] = [];
  for (const entry of linkedEntity) {
    const parsed = linkedEntitySchema.safeParse(entry);
    if (!parsed.success) continue;
    const { id, relationship, service } = parsed.data;
    if (relationship !== SUPPORT_RELATIONSHIP) continue;
    if (service !== SUPPORT_SERVICE) continue;
    if (!id.startsWith('did:')) continue;
    accounts.push({ did: id, relationship, service });
  }
  return accounts;
}

// Support lookups happen per escalation and during room scaffolding; dedupe
// in-flight and briefly cache instead of hitting blocksync every time
// (mirrors the settings-resource entity cache). Failures are evicted so the
// next call retries.
const CACHE_TTL_MS = 60_000;
const linkedEntityCache = new Map<
  string,
  { promise: Promise<unknown>; at: number }
>();

// Scoped raw query instead of extending the generated `GetEntityById`
// selection: regenerating the SDK snapshots the whole live schema, which has
// drifted far beyond this change. The `linkedEntity` field already exists on
// the schema (`GetEntityByType` selects it).
const LINKED_ENTITY_QUERY = /* GraphQL */ `
  query GetEntityLinkedEntities($id: String!) {
    entity(id: $id) {
      linkedEntity
    }
  }
`;

function fetchLinkedEntityCached(entityDid: string): Promise<unknown> {
  const cached = linkedEntityCache.get(entityDid);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.promise;
  }

  const promise = graphqlClient
    .request<{
      entity: { linkedEntity: unknown } | null;
    }>(LINKED_ENTITY_QUERY, { id: entityDid })
    .then((result) => result.entity?.linkedEntity);
  linkedEntityCache.set(entityDid, { promise, at: Date.now() });
  promise.catch(() => {
    if (linkedEntityCache.get(entityDid)?.promise === promise) {
      linkedEntityCache.delete(entityDid);
    }
  });
  return promise;
}

/**
 * Resolve the designated human support accounts for an entity from its DID
 * document (`linkedEntity` entries with `relationship: "support"`,
 * `service: "matrix"`). Returns `[]` when the entity doesn't exist or
 * declares no support accounts; throws only on query failure.
 */
export async function getSupportAccounts(
  entityDid: string,
): Promise<SupportAccount[]> {
  const linkedEntity = await fetchLinkedEntityCached(entityDid);
  return parseSupportAccounts(linkedEntity);
}

/**
 * The entity's Support room alias localpart+server, following the room
 * scaffold convention: hyphenated entity DID + `-sup`, under the Community
 * subspace. E.g. `did:ixo:entity:abc` on `mx.ixo.earth` →
 * `#did-ixo-entity-abc-sup:mx.ixo.earth`.
 */
export function getSupportRoomAlias(
  entityDid: string,
  homeserverName: string,
): string {
  return `#${entityDid.replace(/:/g, '-')}-sup:${homeserverName}`;
}
