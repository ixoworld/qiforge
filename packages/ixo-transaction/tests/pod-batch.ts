import type { ITrxMsg } from '../src/schemas.js';
import {
  ADDRESS,
  ADDRESS_2,
  DID,
  ENTITY_DID,
  verification,
} from './fixtures.js';

/** The entity's admin account, as the chain derives it (any ixo1 address here). */
const ADMIN_ACCOUNT = 'ixo1adminaccountaddressqwertyuiopasdfghjkl';

/**
 * A POD creation batch as a chain gateway composes it: the entity, its claim
 * collection, a claims authorization from the collection admin and an
 * entity-account grant.
 */
export function podBatchMessages(): ITrxMsg[] {
  return [
    {
      typeUrl: '/ixo.entity.v1beta1.MsgCreateEntity',
      value: {
        entityType: 'pod',
        verification,
        relayerNode: DID,
        ownerDid: DID,
        ownerAddress: ADDRESS,
      },
    },
    {
      typeUrl: '/ixo.claims.v1beta1.MsgCreateCollection',
      value: {
        entity: ENTITY_DID,
        signer: ADDRESS,
        protocol: ENTITY_DID,
        quota: '100',
        state: 0,
      },
    },
    {
      typeUrl: '/ixo.claims.v1beta1.MsgCreateClaimAuthorization',
      value: {
        creatorAddress: ADDRESS,
        creatorDid: DID,
        granteeAddress: ADDRESS_2,
        adminAddress: ADMIN_ACCOUNT,
        collectionId: '1',
        authType: 1,
        agentQuota: '10',
      },
    },
    {
      typeUrl: '/ixo.entity.v1beta1.MsgGrantEntityAccountAuthz',
      value: {
        id: ENTITY_DID,
        name: 'admin',
        granteeAddress: ADDRESS_2,
        grant: {
          authorization: {
            typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
            value: { msg: '/ixo.claims.v1beta1.MsgEvaluateClaim' },
          },
        },
        ownerAddress: ADDRESS,
      },
    },
  ];
}
