import { z } from 'zod';
import type { Coin } from '../../chain';

/**
 * Read-only chain lookups for the contract gate — plain `fetch` against the
 * Cosmos REST (LCD) and Blocksync GraphQL, so no protobuf loads on the
 * request path.
 */

const CoinSchema = z.object({ denom: z.string(), amount: z.string() });

const SubmitConstraintSchema = z.object({
  collection_id: z.string(),
  agent_quota: z.string(),
  max_amount: z.array(CoinSchema).default([]),
  intent_duration_ns: z.string().default('0s'),
});

const GrantSchema = z.object({
  granter: z.string(),
  authorization: z.looseObject({ '@type': z.string() }),
});

const GrantsPageSchema = z.object({
  grants: z.array(GrantSchema),
  pagination: z
    .object({ next_key: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

const SubmitAuthorizationSchema = z.object({
  '@type': z.literal('/ixo.claims.v1beta1.SubmitClaimAuthorization'),
  admin: z.string(),
  constraints: z.array(SubmitConstraintSchema),
});

/** One collection the oracle may submit claims to, from its AuthZ grants. */
export interface SubmitGrant {
  /** The collection's admin account — the granter, and the claim's `adminAddress`. */
  admin: string;
  collectionId: string;
  agentQuota: number;
  maxAmount: Coin[];
  /** 0 when the grant sets no intent window. */
  intentDurationSeconds: number;
}

function seconds(duration: string): number {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(duration);
  return m?.[1] ? Number(m[1]) : 0;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${url} answered ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Every `SubmitClaimAuthorization` constraint granted to `grantee`, one entry
 * per constraint (a grant may carry several collections). Several
 * constraints for the same collection are kept apart: the chain uses the
 * first one with quota left, so the gate does too.
 */
export async function listSubmitGrants(
  restUrl: string,
  grantee: string,
): Promise<SubmitGrant[]> {
  const out: SubmitGrant[] = [];
  let nextKey: string | null | undefined;
  do {
    const qs = new URLSearchParams({ 'pagination.limit': '200' });
    if (nextKey) qs.set('pagination.key', nextKey);
    const page = GrantsPageSchema.parse(
      await getJson(
        `${restUrl}/cosmos/authz/v1beta1/grants/grantee/${grantee}?${qs}`,
      ),
    );
    for (const grant of page.grants) {
      const auth = SubmitAuthorizationSchema.safeParse(grant.authorization);
      if (!auth.success) continue;
      for (const c of auth.data.constraints) {
        out.push({
          admin: auth.data.admin,
          collectionId: c.collection_id,
          agentQuota: Number(c.agent_quota),
          maxAmount: c.max_amount,
          intentDurationSeconds: seconds(c.intent_duration_ns),
        });
      }
    }
    nextKey = page.pagination?.next_key;
  } while (nextKey);
  return out;
}

const ServiceSchema = z.object({
  type: z.string().optional(),
  serviceEndpoint: z.string().optional(),
});

const CollectionEntitySchema = z.object({
  data: z.object({
    claimCollection: z
      .object({
        id: z.string(),
        admin: z.string(),
        entity: z.string(),
        protocol: z.string().nullable(),
        intents: z.number().nullable(),
      })
      .nullable(),
  }),
});

const EntitySchema = z.object({
  data: z.object({
    entity: z
      .object({
        id: z.string(),
        owner: z.string().nullable(),
        linkedEntity: z
          .array(
            z.object({
              id: z.string(),
              type: z.string().optional(),
              relationship: z.string().optional(),
            }),
          )
          .nullable(),
        service: z.array(ServiceSchema).nullable(),
      })
      .nullable(),
  }),
});

export interface CollectionInfo {
  id: string;
  admin: string;
  /** The deed the collection belongs to. */
  entityDid: string;
  protocol: string | null;
  /** `intents` option: 0 allow, 1 deny, 2 required. */
  intents: number | null;
  /** The deed's owner address (a buyer-owned collection's buyer). */
  owner: string | null;
  /** `ixo1…` addresses the deed links as a `user` (a subscription's subscriber). */
  linkedUsers: string[];
  /** The deed's `MatrixHomeServer` endpoint — decides its claim bot. */
  homeServer: string | null;
}

async function gql(
  url: string,
  query: string,
  variables: object,
): Promise<unknown> {
  return getJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
}

/** A collection plus the deed facts the gate needs, or null when not indexed. */
export async function getCollectionInfo(
  blocksyncUrl: string,
  collectionId: string,
): Promise<CollectionInfo | null> {
  const col = CollectionEntitySchema.parse(
    await gql(
      blocksyncUrl,
      'query ($id: String!) { claimCollection(id: $id) { id admin entity protocol intents } }',
      { id: collectionId },
    ),
  ).data.claimCollection;
  if (!col) return null;
  const entity = EntitySchema.parse(
    await gql(
      blocksyncUrl,
      'query ($id: String!) { entity(id: $id) { id owner linkedEntity service } }',
      { id: col.entity },
    ),
  ).data.entity;
  const linkedUsers = (entity?.linkedEntity ?? [])
    .filter((l) => l.type === 'user')
    .map((l) => l.id.replace(/^\{id\}#/, ''))
    .filter((id) => id.startsWith('ixo1'));
  const homeServer =
    entity?.service?.find((s) => s.type === 'MatrixHomeServer')
      ?.serviceEndpoint ?? null;
  return {
    id: col.id,
    admin: col.admin,
    entityDid: col.entity,
    protocol: col.protocol,
    intents: col.intents,
    owner: entity?.owner ?? null,
    linkedUsers,
    homeServer,
  };
}
