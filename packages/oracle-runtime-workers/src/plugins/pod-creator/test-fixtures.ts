/**
 * Shared fixtures for the pod-creator test suites. Not part of the public
 * surface (excluded from the published files).
 */
import { findMessageByTypeUrl, type ITrxMsg } from '@ixo/ixo-transaction';
import type { PluginTool } from '../../plugin-api/types';
import type { BlueprintStore } from './blueprint-store';
import type { BlueprintSection } from './blueprint-types';
import { DESIGN_POD_ROLES } from './design-pod-roles';

export const ISO = '2026-06-12T00:00:00.000Z';

/** The default thread of `makeRuntimeContext()`. */
export const THREAD = 'session-1';

/** The default user of `makeRuntimeContext()`. */
export const USER = 'did:ixo:user1';

export function byName(tools: readonly PluginTool[], name: string): PluginTool {
  const found = tools.find((t) => t.name === name);
  if (!found) {
    throw new Error(`tool ${name} not found`);
  }
  return found;
}

/**
 * Seed sections the way production does — through the specialists' write
 * path. Every listed role passes unless named in `failing`.
 */
export async function seedRoles(
  store: BlueprintStore,
  thread: string,
  roleIds: readonly string[],
  failing: readonly string[] = [],
): Promise<void> {
  for (const role of DESIGN_POD_ROLES) {
    if (!roleIds.includes(role.id)) {
      continue;
    }
    const section: BlueprintSection = {
      role: role.id,
      stage: role.stage,
      content: { ok: true },
      recordedAt: ISO,
      verdict: failing.includes(role.id) ? 'fail' : 'pass',
    };
    await store.putSection(thread, section);
  }
}

/** Every role id, in catalogue order. */
export const ALL_ROLE_IDS: readonly string[] = DESIGN_POD_ROLES.map(
  (role) => role.id,
);

const OWNER = 'ixo1qwertyuiopasdfghjklzxcvbnmqwerty12345';
const OWNER_DID = `did:ixo:${OWNER}`;
const ORACLE = 'ixo1zxcvbnmqwertyuiopasdfghjkl1234567890ab';
const ENTITY = 'did:ixo:entity:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * A POD creation batch as a chain gateway composes it, valid against the
 * `@ixo/ixo-transaction` catalog: the entity, its claim collection, a claims
 * authorization from the collection admin and an entity-account grant.
 */
export function podBatchMessages(): ITrxMsg[] {
  return [
    {
      typeUrl: '/ixo.entity.v1beta1.MsgCreateEntity',
      value: {
        entityType: 'pod',
        verification: [
          {
            relationships: ['authentication'],
            method: {
              id: `${OWNER_DID}#key-1`,
              type: 'EcdsaSecp256k1VerificationKey2019',
              controller: OWNER_DID,
              blockchainAccountID: OWNER,
            },
          },
        ],
        relayerNode: OWNER_DID,
        ownerDid: OWNER_DID,
        ownerAddress: OWNER,
      },
    },
    {
      typeUrl: '/ixo.claims.v1beta1.MsgCreateCollection',
      value: { entity: ENTITY, signer: OWNER, quota: '100' },
    },
    {
      typeUrl: '/ixo.claims.v1beta1.MsgCreateClaimAuthorization',
      value: {
        creatorAddress: OWNER,
        creatorDid: OWNER_DID,
        granteeAddress: ORACLE,
        adminAddress: OWNER,
        collectionId: '1',
        authType: 2,
        agentQuota: '10',
      },
    },
    {
      typeUrl: '/ixo.entity.v1beta1.MsgGrantEntityAccountAuthz',
      value: {
        id: ENTITY,
        name: 'admin',
        granteeAddress: ORACLE,
        grant: {
          authorization: {
            typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
            value: { msg: '/ixo.claims.v1beta1.MsgEvaluateClaim' },
          },
        },
        ownerAddress: OWNER,
      },
    },
  ];
}

/** Every risk of the batch, each once, in message order (from the catalog). */
export function podBatchRisks(
  messages: readonly ITrxMsg[] = podBatchMessages(),
): string[] {
  return [
    ...new Set(
      messages.flatMap(
        (message) => findMessageByTypeUrl(message.typeUrl)?.risks ?? [],
      ),
    ),
  ];
}

/** The user accepting every risk of the batch word for word. */
export function acceptPodRisks(): {
  confirmed: true;
  acceptedRisks: string[];
} {
  return { confirmed: true, acceptedRisks: podBatchRisks() };
}
