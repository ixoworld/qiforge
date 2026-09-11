import type { FieldKind } from './schemas.js';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type FieldSpec = {
  name: string;
  kind: FieldKind;
  required?: boolean;
};

export type MessageSpec = {
  module: string;
  action: string;
  messageName: string;
  typeUrl: string;
  fields: FieldSpec[];
  risks: string[];
  riskLevel: RiskLevel;
};

const opt = (name: string, kind: FieldKind): FieldSpec => ({ name, kind });
const req = (name: string, kind: FieldKind): FieldSpec => ({
  name,
  kind,
  required: true,
});

/**
 * Modules whose `Msg`s are query-only or out of v1 scope. Surfaced to the agent
 * so it can explain why a route is unavailable instead of guessing.
 */
export const QUERY_ONLY_MODULES = ['epochs', 'mint'] as const;
export const DEFERRED_MODULES = ['bonds', 'liquidstake', 'names'] as const;

type Entry = [
  action: string,
  messageName: string,
  fields: FieldSpec[],
  riskLevel: RiskLevel,
  risks: string[],
];

function buildModule(
  module: string,
  version: string,
  entries: Entry[],
): MessageSpec[] {
  return entries.map(([action, messageName, fields, riskLevel, risks]) => ({
    module,
    action,
    messageName,
    typeUrl: `/ixo.${version}.${messageName}`,
    fields,
    risks,
    riskLevel,
  }));
}

const SIGNER = req('signer', 'address');

/**
 * Canonical catalog of v1-supported IXO transaction messages. Field names and
 * shapes are verified against `@ixo/impactxclient-sdk` protobuf definitions.
 * `names`, `bonds`, `liquidstake`, and generic Cosmos authz are intentionally
 * out of v1 (see `DEFERRED_MODULES`).
 */
export const MESSAGE_CATALOG: readonly MessageSpec[] = [
  ...buildModule('entity', 'entity.v1beta1', [
    [
      'create',
      'MsgCreateEntity',
      [
        req('entityType', 'string'),
        opt('entityStatus', 'int'),
        opt('controller', 'didArray'),
        opt('context', 'contextArray'),
        req('verification', 'verificationArray'),
        opt('service', 'serviceArray'),
        opt('accordedRight', 'accordedRightArray'),
        opt('linkedResource', 'linkedResourceArray'),
        opt('linkedEntity', 'linkedEntityArray'),
        opt('linkedClaim', 'linkedClaimArray'),
        opt('startDate', 'timestamp'),
        opt('endDate', 'timestamp'),
        req('relayerNode', 'did'),
        opt('credentials', 'stringArray'),
        req('ownerDid', 'did'),
        req('ownerAddress', 'address'),
        opt('data', 'bytes'),
        opt('alsoKnownAs', 'string'),
      ],
      'high',
      [
        'Creates a new entity, admin account, DID document, and ownership NFT. The entity DID is chain-derived and cannot be chosen.',
      ],
    ],
    [
      'update',
      'MsgUpdateEntity',
      [
        req('id', 'did'),
        opt('entityStatus', 'int'),
        opt('startDate', 'timestamp'),
        opt('endDate', 'timestamp'),
        opt('credentials', 'stringArray'),
        req('controllerDid', 'did'),
        req('controllerAddress', 'address'),
      ],
      'high',
      [
        'Overwrites mutable entity fields. Omitted fields can reset to chain zero values if a partial update was intended.',
      ],
    ],
    [
      'update-verified',
      'MsgUpdateEntityVerified',
      [
        req('id', 'did'),
        req('entityVerified', 'bool'),
        req('relayerNodeDid', 'did'),
        req('relayerNodeAddress', 'address'),
      ],
      'critical',
      [
        'Changes entity verification status. Only the stored relayer node can perform this transaction.',
      ],
    ],
    [
      'transfer',
      'MsgTransferEntity',
      [
        req('id', 'did'),
        req('ownerDid', 'did'),
        req('ownerAddress', 'address'),
        req('recipientDid', 'did'),
      ],
      'critical',
      [
        'Transfers the entity ownership NFT and rewrites controllers to the recipient. Irreversible without the recipient transferring back.',
      ],
    ],
    [
      'create-account',
      'MsgCreateEntityAccount',
      [req('id', 'did'), req('name', 'string'), req('ownerAddress', 'address')],
      'medium',
      ['Creates a deterministic module account controlled by the entity.'],
    ],
    [
      'grant-account-authz',
      'MsgGrantEntityAccountAuthz',
      [
        req('id', 'did'),
        req('name', 'string'),
        req('granteeAddress', 'address'),
        req('grant', 'authzGrant'),
        req('ownerAddress', 'address'),
      ],
      'critical',
      [
        'Grants another address authority from an entity account. Scope, expiration, and message type must be reviewed.',
      ],
    ],
    [
      'revoke-account-authz',
      'MsgRevokeEntityAccountAuthz',
      [
        req('id', 'did'),
        req('name', 'string'),
        req('granteeAddress', 'address'),
        req('msgTypeUrl', 'string'),
        req('ownerAddress', 'address'),
      ],
      'high',
      [
        'Revokes entity-account authority and may interrupt dependent automation.',
      ],
    ],
  ]),

  ...buildModule('iid', 'iid.v1beta1', [
    [
      'create',
      'MsgCreateIidDocument',
      [
        req('id', 'did'),
        opt('controllers', 'didArray'),
        opt('context', 'contextArray'),
        opt('verifications', 'verificationArray'),
        opt('services', 'serviceArray'),
        opt('accordedRight', 'accordedRightArray'),
        opt('linkedResource', 'linkedResourceArray'),
        opt('linkedEntity', 'linkedEntityArray'),
        opt('linkedClaim', 'linkedClaimArray'),
        opt('alsoKnownAs', 'string'),
        SIGNER,
      ],
      'critical',
      [
        'Creates a new IID/DID document. Confirm controllers and signer authority.',
      ],
    ],
    [
      'update',
      'MsgUpdateIidDocument',
      [
        req('id', 'did'),
        opt('controllers', 'didArray'),
        opt('context', 'contextArray'),
        opt('verifications', 'verificationArray'),
        opt('services', 'serviceArray'),
        opt('accordedRight', 'accordedRightArray'),
        opt('linkedResource', 'linkedResourceArray'),
        opt('linkedEntity', 'linkedEntityArray'),
        opt('linkedClaim', 'linkedClaimArray'),
        opt('alsoKnownAs', 'string'),
        SIGNER,
      ],
      'high',
      ['Overwrites the IID document. Omitted fields may reset to zero values.'],
    ],
    [
      'add-verification',
      'MsgAddVerification',
      [req('id', 'did'), req('verification', 'verification'), SIGNER],
      'high',
      [
        'Adds a verification method/key. Wrong keys can grant unwanted control.',
      ],
    ],
    [
      'revoke-verification',
      'MsgRevokeVerification',
      [req('id', 'did'), req('methodId', 'string'), SIGNER],
      'high',
      [
        'Revokes a verification method. Can lock out a controller if mis-targeted.',
      ],
    ],
    [
      'set-verification-relationships',
      'MsgSetVerificationRelationships',
      [
        req('id', 'did'),
        req('methodId', 'string'),
        req('relationships', 'stringArray'),
        SIGNER,
      ],
      'high',
      ['Changes which relationships a verification method authorizes.'],
    ],
    [
      'add-service',
      'MsgAddService',
      [req('id', 'did'), req('serviceData', 'service'), SIGNER],
      'medium',
      ['Adds a service endpoint to the IID document.'],
    ],
    [
      'delete-service',
      'MsgDeleteService',
      [req('id', 'did'), req('serviceId', 'string'), SIGNER],
      'medium',
      ['Removes a service endpoint from the IID document.'],
    ],
    [
      'add-controller',
      'MsgAddController',
      [req('id', 'did'), req('controllerDid', 'did'), SIGNER],
      'critical',
      ['Adds a controller DID — grants full control over the identity.'],
    ],
    [
      'delete-controller',
      'MsgDeleteController',
      [req('id', 'did'), req('controllerDid', 'did'), SIGNER],
      'critical',
      ['Removes a controller DID. Can lock users out of the identity.'],
    ],
    [
      'add-linked-resource',
      'MsgAddLinkedResource',
      [req('id', 'did'), req('linkedResource', 'linkedResource'), SIGNER],
      'medium',
      ['Attaches a linked resource to the IID document.'],
    ],
    [
      'delete-linked-resource',
      'MsgDeleteLinkedResource',
      [req('id', 'did'), req('resourceId', 'string'), SIGNER],
      'medium',
      ['Removes a linked resource from the IID document.'],
    ],
    [
      'add-linked-claim',
      'MsgAddLinkedClaim',
      [req('id', 'did'), req('linkedClaim', 'linkedClaim'), SIGNER],
      'medium',
      ['Attaches a linked claim to the IID document.'],
    ],
    [
      'delete-linked-claim',
      'MsgDeleteLinkedClaim',
      [req('id', 'did'), req('claimId', 'string'), SIGNER],
      'medium',
      ['Removes a linked claim from the IID document.'],
    ],
    [
      'add-linked-entity',
      'MsgAddLinkedEntity',
      [req('id', 'did'), req('linkedEntity', 'linkedEntity'), SIGNER],
      'medium',
      ['Attaches a linked entity relationship to the IID document.'],
    ],
    [
      'delete-linked-entity',
      'MsgDeleteLinkedEntity',
      [req('id', 'did'), req('entityId', 'string'), SIGNER],
      'medium',
      ['Removes a linked entity relationship from the IID document.'],
    ],
    [
      'add-accorded-right',
      'MsgAddAccordedRight',
      [req('id', 'did'), req('accordedRight', 'accordedRight'), SIGNER],
      'medium',
      ['Adds an accorded right to the IID document.'],
    ],
    [
      'delete-accorded-right',
      'MsgDeleteAccordedRight',
      [req('id', 'did'), req('rightId', 'string'), SIGNER],
      'medium',
      ['Removes an accorded right from the IID document.'],
    ],
    [
      'add-context',
      'MsgAddIidContext',
      [req('id', 'did'), req('context', 'context'), SIGNER],
      'medium',
      ['Adds a context entry to the IID document.'],
    ],
    [
      'delete-context',
      'MsgDeleteIidContext',
      [req('id', 'did'), req('contextKey', 'string'), SIGNER],
      'medium',
      ['Removes a context entry from the IID document.'],
    ],
    [
      'deactivate',
      'MsgDeactivateIID',
      [req('id', 'did'), req('state', 'bool'), SIGNER],
      'critical',
      ['Deactivates (or reactivates) the IID document.'],
    ],
  ]),

  ...buildModule('claims', 'claims.v1beta1', [
    [
      'create-collection',
      'MsgCreateCollection',
      [
        req('entity', 'did'),
        SIGNER,
        opt('protocol', 'did'),
        opt('startDate', 'timestamp'),
        opt('endDate', 'timestamp'),
        opt('quota', 'uint'),
        opt('state', 'int'),
        opt('payments', 'json'),
        opt('intents', 'int'),
      ],
      'high',
      ['Creates a claim collection. Confirm entity, payments, and quota.'],
    ],
    [
      'submit',
      'MsgSubmitClaim',
      [
        req('collectionId', 'string'),
        req('claimId', 'string'),
        req('agentDid', 'did'),
        req('agentAddress', 'address'),
        req('adminAddress', 'address'),
        opt('useIntent', 'bool'),
        opt('amount', 'coinArray'),
        opt('cw20Payment', 'jsonArray'),
      ],
      'high',
      ['Submits a claim. May trigger payment workflows.'],
    ],
    [
      'evaluate',
      'MsgEvaluateClaim',
      [
        req('claimId', 'string'),
        req('collectionId', 'string'),
        req('oracle', 'did'),
        req('agentDid', 'did'),
        req('agentAddress', 'address'),
        req('adminAddress', 'address'),
        req('status', 'int'),
        opt('reason', 'int'),
        opt('verificationProof', 'string'),
        opt('amount', 'coinArray'),
        opt('cw20Payment', 'jsonArray'),
      ],
      'critical',
      [
        'Sets a claim evaluation status, which can release payments. Confirm status code and amounts.',
      ],
    ],
    [
      'dispute',
      'MsgDisputeClaim',
      [
        req('subjectId', 'string'),
        req('agentDid', 'did'),
        req('agentAddress', 'address'),
        req('disputeType', 'int'),
        opt('data', 'json'),
      ],
      'high',
      ['Raises a dispute against a claim or evaluation.'],
    ],
    [
      'update-collection-state',
      'MsgUpdateCollectionState',
      [
        req('collectionId', 'string'),
        req('state', 'int'),
        req('adminAddress', 'address'),
      ],
      'high',
      ['Changes collection state (e.g. open/paused/closed).'],
    ],
    [
      'update-collection-dates',
      'MsgUpdateCollectionDates',
      [
        req('collectionId', 'string'),
        opt('startDate', 'timestamp'),
        opt('endDate', 'timestamp'),
        req('adminAddress', 'address'),
      ],
      'medium',
      ['Changes a collection validity window.'],
    ],
    [
      'update-collection-payments',
      'MsgUpdateCollectionPayments',
      [
        req('collectionId', 'string'),
        req('payments', 'json'),
        req('adminAddress', 'address'),
      ],
      'critical',
      [
        'Changes collection payment configuration. Confirm amounts and recipients.',
      ],
    ],
    [
      'update-collection-intents',
      'MsgUpdateCollectionIntents',
      [
        req('collectionId', 'string'),
        req('intents', 'int'),
        req('adminAddress', 'address'),
      ],
      'high',
      ['Changes collection intent options.'],
    ],
    [
      'claim-intent',
      'MsgClaimIntent',
      [
        req('agentDid', 'did'),
        req('agentAddress', 'address'),
        req('collectionId', 'string'),
        opt('amount', 'coinArray'),
        opt('cw20Payment', 'jsonArray'),
      ],
      'medium',
      ['Reserves an intent to submit a claim against a collection.'],
    ],
    [
      'create-claim-authorization',
      'MsgCreateClaimAuthorization',
      [
        req('creatorAddress', 'address'),
        req('creatorDid', 'did'),
        req('granteeAddress', 'address'),
        req('adminAddress', 'address'),
        req('collectionId', 'string'),
        req('authType', 'int'),
        req('agentQuota', 'uint'),
        opt('maxAmount', 'coinArray'),
        opt('maxCw20Payment', 'jsonArray'),
        opt('expiration', 'timestamp'),
        opt('intentDurationNs', 'json'),
        opt('beforeDate', 'timestamp'),
      ],
      'critical',
      [
        'Authorizes an agent to submit/evaluate claims with payment limits. Confirm grantee, quota, and max amounts.',
      ],
    ],
  ]),

  ...buildModule('token', 'token.v1beta1', [
    [
      'create',
      'MsgCreateToken',
      [
        req('minter', 'address'),
        req('class', 'string'),
        req('name', 'string'),
        opt('description', 'string'),
        opt('image', 'string'),
        req('tokenType', 'string'),
        opt('cap', 'string'),
      ],
      'critical',
      [
        'Creates a new impact-credit token class. Confirm class, type, and cap.',
      ],
    ],
    [
      'mint',
      'MsgMintToken',
      [
        req('minter', 'address'),
        req('contractAddress', 'address'),
        req('owner', 'address'),
        req('mintBatch', 'jsonArray'),
      ],
      'critical',
      ['Mints impact credits. Confirm batches, amounts, and owner.'],
    ],
    [
      'transfer',
      'MsgTransferToken',
      [
        req('owner', 'address'),
        req('recipient', 'address'),
        req('tokens', 'tokenBatchArray'),
      ],
      'critical',
      ['Transfers impact credits to another address.'],
    ],
    [
      'retire',
      'MsgRetireToken',
      [
        req('owner', 'address'),
        req('tokens', 'tokenBatchArray'),
        req('jurisdiction', 'string'),
        req('reason', 'string'),
      ],
      'critical',
      ['Permanently retires (burns) impact credits. Irreversible.'],
    ],
    [
      'transfer-credit',
      'MsgTransferCredit',
      [
        req('owner', 'address'),
        req('tokens', 'tokenBatchArray'),
        req('jurisdiction', 'string'),
        opt('reason', 'string'),
        req('authorizationId', 'string'),
      ],
      'critical',
      ['Transfers credits under an authorization. Confirm authorization id.'],
    ],
    [
      'cancel',
      'MsgCancelToken',
      [
        req('owner', 'address'),
        req('tokens', 'tokenBatchArray'),
        req('reason', 'string'),
      ],
      'critical',
      ['Cancels (voids) impact credits. Irreversible.'],
    ],
    [
      'pause',
      'MsgPauseToken',
      [
        req('minter', 'address'),
        req('contractAddress', 'address'),
        req('paused', 'bool'),
      ],
      'high',
      ['Pauses or unpauses a token contract.'],
    ],
    [
      'stop',
      'MsgStopToken',
      [req('minter', 'address'), req('contractAddress', 'address')],
      'critical',
      ['Stops a token contract permanently.'],
    ],
  ]),

  ...buildModule('smart-account', 'smartaccount.v1beta1', [
    [
      'add-authenticator',
      'MsgAddAuthenticator',
      [
        req('sender', 'address'),
        req('authenticatorType', 'string'),
        req('data', 'bytes'),
      ],
      'critical',
      ['Adds an account authenticator. Wrong data can lock the account.'],
    ],
    [
      'remove-authenticator',
      'MsgRemoveAuthenticator',
      [req('sender', 'address'), req('id', 'uint')],
      'critical',
      ['Removes an account authenticator. Can lock the account out.'],
    ],
    [
      'set-active-state',
      'MsgSetActiveState',
      [req('sender', 'address'), req('active', 'bool')],
      'critical',
      ['Enables or disables smart-account authentication globally.'],
    ],
  ]),
] as const;

export function findMessageByRoute(
  module: string,
  action: string,
): MessageSpec | undefined {
  return MESSAGE_CATALOG.find(
    (entry) => entry.module === module && entry.action === action,
  );
}

export function findMessageByTypeUrl(typeUrl: string): MessageSpec | undefined {
  return MESSAGE_CATALOG.find((entry) => entry.typeUrl === typeUrl);
}

export function routeForMessageName(
  messageName: string,
): MessageSpec | undefined {
  const normalized = messageName.toLowerCase();
  return MESSAGE_CATALOG.find(
    (entry) => entry.messageName.toLowerCase() === normalized,
  );
}
