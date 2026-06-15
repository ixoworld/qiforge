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
  portalRegistry: boolean;
};

const optional = (name: string, kind: FieldKind): FieldSpec => ({ name, kind });
const required = (name: string, kind: FieldKind): FieldSpec => ({
  name,
  kind,
  required: true,
});

const commonEntityCreateFields: FieldSpec[] = [
  required('entityType', 'string'),
  required('verification', 'verificationArray'),
  required('ownerDid', 'did'),
  required('ownerAddress', 'address'),
  required('relayerNode', 'did'),
  optional('entityStatus', 'int'),
  optional('controller', 'didArray'),
  optional('context', 'contextArray'),
  optional('service', 'serviceArray'),
  optional('accordedRight', 'accordedRightArray'),
  optional('linkedResource', 'linkedResourceArray'),
  optional('linkedEntity', 'linkedEntityArray'),
  optional('linkedClaim', 'linkedClaimArray'),
  optional('startDate', 'timestamp'),
  optional('endDate', 'timestamp'),
  optional('credentials', 'stringArray'),
  optional('data', 'json'),
  optional('alsoKnownAs', 'string'),
];

export const QUERY_ONLY_MODULES = ['epochs', 'mint'] as const;

export const MESSAGE_CATALOG: readonly MessageSpec[] = [
  {
    module: 'entity',
    action: 'create',
    messageName: 'MsgCreateEntity',
    typeUrl: '/ixo.entity.v1beta1.MsgCreateEntity',
    fields: commonEntityCreateFields,
    risks: [
      'Creates a new entity, admin account, DID document, and ownership NFT. The entity DID is chain-derived and cannot be chosen.',
    ],
    riskLevel: 'high',
    portalRegistry: true,
  },
  {
    module: 'entity',
    action: 'update',
    messageName: 'MsgUpdateEntity',
    typeUrl: '/ixo.entity.v1beta1.MsgUpdateEntity',
    fields: [
      required('id', 'did'),
      required('controllerDid', 'did'),
      required('controllerAddress', 'address'),
      optional('entityStatus', 'int'),
      optional('startDate', 'timestamp'),
      optional('endDate', 'timestamp'),
      optional('credentials', 'stringArray'),
    ],
    risks: [
      'Overwrites mutable entity fields. Omitted update fields can become chain zero values if the caller intended a partial update.',
    ],
    riskLevel: 'high',
    portalRegistry: true,
  },
  {
    module: 'entity',
    action: 'update-verified',
    messageName: 'MsgUpdateEntityVerified',
    typeUrl: '/ixo.entity.v1beta1.MsgUpdateEntityVerified',
    fields: [
      required('id', 'did'),
      required('entityVerified', 'bool'),
      required('relayerNodeDid', 'did'),
      required('relayerNodeAddress', 'address'),
    ],
    risks: [
      'Changes entity verification status. Only the stored relayer node can perform this transaction.',
    ],
    riskLevel: 'critical',
    portalRegistry: true,
  },
  {
    module: 'entity',
    action: 'transfer',
    messageName: 'MsgTransferEntity',
    typeUrl: '/ixo.entity.v1beta1.MsgTransferEntity',
    fields: [
      required('id', 'did'),
      required('ownerDid', 'did'),
      required('ownerAddress', 'address'),
      required('recipientDid', 'did'),
    ],
    risks: [
      'Transfers the entity ownership NFT and rewrites controllers to the recipient.',
    ],
    riskLevel: 'critical',
    portalRegistry: true,
  },
  {
    module: 'entity',
    action: 'create-account',
    messageName: 'MsgCreateEntityAccount',
    typeUrl: '/ixo.entity.v1beta1.MsgCreateEntityAccount',
    fields: [
      required('id', 'did'),
      required('name', 'string'),
      required('ownerAddress', 'address'),
    ],
    risks: ['Creates a deterministic module account controlled by the entity.'],
    riskLevel: 'medium',
    portalRegistry: true,
  },
  {
    module: 'entity',
    action: 'grant-account-authz',
    messageName: 'MsgGrantEntityAccountAuthz',
    typeUrl: '/ixo.entity.v1beta1.MsgGrantEntityAccountAuthz',
    fields: [
      required('id', 'did'),
      required('name', 'string'),
      required('granteeAddress', 'address'),
      required('grant', 'authzGrant'),
      required('ownerAddress', 'address'),
    ],
    risks: [
      'Grants another address authority from an entity account. Scope, expiration, and target message type must be reviewed.',
    ],
    riskLevel: 'critical',
    portalRegistry: true,
  },
  {
    module: 'entity',
    action: 'revoke-account-authz',
    messageName: 'MsgRevokeEntityAccountAuthz',
    typeUrl: '/ixo.entity.v1beta1.MsgRevokeEntityAccountAuthz',
    fields: [
      required('id', 'did'),
      required('name', 'string'),
      required('granteeAddress', 'address'),
      required('msgTypeUrl', 'string'),
      required('ownerAddress', 'address'),
    ],
    risks: [
      'Revokes entity-account authority and may interrupt dependent automation.',
    ],
    riskLevel: 'high',
    portalRegistry: false,
  },

  ...([
    [
      'create',
      'MsgCreateIidDocument',
      [
        required('id', 'did'),
        required('signer', 'address'),
        optional('controllers', 'didArray'),
        optional('verification', 'verificationArray'),
        optional('service', 'serviceArray'),
        optional('context', 'contextArray'),
      ],
      'critical',
    ],
    [
      'update',
      'MsgUpdateIidDocument',
      [
        required('id', 'did'),
        required('signer', 'address'),
        optional('controllers', 'didArray'),
        optional('verification', 'verificationArray'),
        optional('service', 'serviceArray'),
        optional('context', 'contextArray'),
      ],
      'high',
    ],
    [
      'add-verification',
      'MsgAddVerification',
      [
        required('id', 'did'),
        required('verification', 'verificationArray'),
        required('signer', 'address'),
      ],
      'high',
    ],
    [
      'revoke-verification',
      'MsgRevokeVerification',
      [
        required('id', 'did'),
        required('methodId', 'string'),
        required('signer', 'address'),
      ],
      'high',
    ],
    [
      'set-verification-relationships',
      'MsgSetVerificationRelationships',
      [
        required('id', 'did'),
        required('methodId', 'string'),
        required('relationships', 'stringArray'),
        required('signer', 'address'),
      ],
      'high',
    ],
    [
      'add-service',
      'MsgAddService',
      [
        required('id', 'did'),
        required('service', 'serviceArray'),
        required('signer', 'address'),
      ],
      'medium',
    ],
    [
      'delete-service',
      'MsgDeleteService',
      [
        required('id', 'did'),
        required('serviceId', 'string'),
        required('signer', 'address'),
      ],
      'medium',
    ],
    [
      'add-controller',
      'MsgAddController',
      [
        required('id', 'did'),
        required('controllerDid', 'did'),
        required('signer', 'address'),
      ],
      'critical',
    ],
    [
      'delete-controller',
      'MsgDeleteController',
      [
        required('id', 'did'),
        required('controllerDid', 'did'),
        required('signer', 'address'),
      ],
      'critical',
    ],
    [
      'add-linked-resource',
      'MsgAddLinkedResource',
      [
        required('id', 'did'),
        required('linkedResource', 'linkedResource'),
        required('signer', 'address'),
      ],
      'medium',
    ],
    [
      'delete-linked-resource',
      'MsgDeleteLinkedResource',
      [
        required('id', 'did'),
        required('resourceId', 'string'),
        required('signer', 'address'),
      ],
      'medium',
    ],
    [
      'add-linked-claim',
      'MsgAddLinkedClaim',
      [
        required('id', 'did'),
        required('linkedClaim', 'linkedClaim'),
        required('signer', 'address'),
      ],
      'medium',
    ],
    [
      'delete-linked-claim',
      'MsgDeleteLinkedClaim',
      [
        required('id', 'did'),
        required('claimId', 'string'),
        required('signer', 'address'),
      ],
      'medium',
    ],
    [
      'add-linked-entity',
      'MsgAddLinkedEntity',
      [
        required('id', 'did'),
        required('linkedEntity', 'linkedEntity'),
        required('signer', 'address'),
      ],
      'medium',
    ],
    [
      'delete-linked-entity',
      'MsgDeleteLinkedEntity',
      [
        required('id', 'did'),
        required('entityId', 'did'),
        required('signer', 'address'),
      ],
      'medium',
    ],
    [
      'add-accorded-right',
      'MsgAddAccordedRight',
      [
        required('id', 'did'),
        required('accordedRight', 'accordedRight'),
        required('signer', 'address'),
      ],
      'medium',
    ],
    [
      'delete-accorded-right',
      'MsgDeleteAccordedRight',
      [
        required('id', 'did'),
        required('rightId', 'string'),
        required('signer', 'address'),
      ],
      'medium',
    ],
    [
      'add-context',
      'MsgAddIidContext',
      [
        required('id', 'did'),
        required('context', 'contextArray'),
        required('signer', 'address'),
      ],
      'medium',
    ],
    [
      'delete-context',
      'MsgDeleteIidContext',
      [
        required('id', 'did'),
        required('contextKey', 'string'),
        required('signer', 'address'),
      ],
      'medium',
    ],
    [
      'deactivate',
      'MsgDeactivateIID',
      [required('id', 'did'), required('signer', 'address')],
      'critical',
    ],
  ].map(([action, messageName, fields, riskLevel]) => ({
    module: 'iid',
    action,
    messageName,
    typeUrl: `/ixo.iid.v1beta1.${messageName}`,
    fields,
    risks: [
      'Changes an IID/DID document. Confirm signer authority and downstream identity effects.',
    ],
    riskLevel,
    portalRegistry: [
      'MsgAddLinkedEntity',
      'MsgDeleteLinkedEntity',
      'MsgAddVerification',
      'MsgDeleteLinkedResource',
      'MsgAddLinkedResource',
    ].includes(messageName as string),
  })) as MessageSpec[]),

  ...([
    [
      'create-collection',
      'MsgCreateCollection',
      [
        required('entity', 'did'),
        required('adminAddress', 'address'),
        optional('protocol', 'did'),
        optional('startDate', 'timestamp'),
        optional('endDate', 'timestamp'),
        optional('payments', 'json'),
        optional('intents', 'json'),
      ],
      'high',
    ],
    [
      'submit',
      'MsgSubmitClaim',
      [
        required('collectionId', 'string'),
        required('claimId', 'string'),
        required('agentAddress', 'address'),
        required('agentDid', 'did'),
        required('adminAddress', 'address'),
        optional('useIntent', 'bool'),
      ],
      'high',
    ],
    [
      'evaluate',
      'MsgEvaluateClaim',
      [
        required('collectionId', 'string'),
        required('claimId', 'string'),
        required('agentAddress', 'address'),
        required('agentDid', 'did'),
        required('adminAddress', 'address'),
        required('status', 'int'),
        optional('reason', 'int'),
        optional('verificationProof', 'string'),
        optional('amount', 'coin'),
      ],
      'critical',
    ],
    [
      'dispute',
      'MsgDisputeClaim',
      [
        required('collectionId', 'string'),
        required('claimId', 'string'),
        required('agentAddress', 'address'),
        required('agentDid', 'did'),
        required('adminAddress', 'address'),
        optional('reason', 'int'),
      ],
      'high',
    ],
    [
      'withdraw-payment',
      'MsgWithdrawPayment',
      [
        required('claimId', 'string'),
        required('inputs', 'json'),
        required('toAddress', 'address'),
        required('fromAddress', 'address'),
      ],
      'high',
    ],
    [
      'update-collection-state',
      'MsgUpdateCollectionState',
      [
        required('collectionId', 'string'),
        required('state', 'int'),
        required('adminAddress', 'address'),
      ],
      'high',
    ],
    [
      'update-collection-dates',
      'MsgUpdateCollectionDates',
      [
        required('collectionId', 'string'),
        required('adminAddress', 'address'),
        optional('startDate', 'timestamp'),
        optional('endDate', 'timestamp'),
      ],
      'medium',
    ],
    [
      'update-collection-payments',
      'MsgUpdateCollectionPayments',
      [
        required('collectionId', 'string'),
        required('payments', 'json'),
        required('adminAddress', 'address'),
      ],
      'critical',
    ],
    [
      'update-collection-intents',
      'MsgUpdateCollectionIntents',
      [
        required('collectionId', 'string'),
        required('intents', 'json'),
        required('adminAddress', 'address'),
      ],
      'high',
    ],
    [
      'update-collection-quota',
      'MsgUpdateCollectionQuota',
      [
        required('collectionId', 'string'),
        required('quota', 'uint'),
        required('adminAddress', 'address'),
      ],
      'high',
    ],
    [
      'claim-intent',
      'MsgClaimIntent',
      [
        required('collectionId', 'string'),
        required('agentAddress', 'address'),
        required('agentDid', 'did'),
        optional('amount', 'coin'),
      ],
      'medium',
    ],
    [
      'create-claim-authorization',
      'MsgCreateClaimAuthorization',
      [
        required('creatorAddress', 'address'),
        required('creatorDid', 'did'),
        required('agentAddress', 'address'),
        required('agentDid', 'did'),
        required('adminAddress', 'address'),
        required('collectionId', 'string'),
      ],
      'critical',
    ],
    [
      'set-collection-members',
      'MsgSetCollectionMembers',
      [
        required('collectionId', 'string'),
        required('members', 'json'),
        required('adminAddress', 'address'),
      ],
      'high',
    ],
    [
      'remove-collection-members',
      'MsgRemoveCollectionMembers',
      [
        required('collectionId', 'string'),
        required('members', 'stringArray'),
        required('adminAddress', 'address'),
      ],
      'high',
    ],
    [
      'update-collection-dispute-config',
      'MsgUpdateCollectionDisputeConfig',
      [
        required('collectionId', 'string'),
        required('disputeConfig', 'json'),
        required('adminAddress', 'address'),
      ],
      'high',
    ],
    [
      'add-performance-deposit',
      'MsgAddPerformanceDeposit',
      [
        required('collectionId', 'string'),
        required('claimId', 'string'),
        required('fromAddress', 'address'),
        required('amount', 'coin'),
      ],
      'critical',
    ],
    [
      'withdraw-performance-deposit',
      'MsgWithdrawPerformanceDeposit',
      [
        required('collectionId', 'string'),
        required('claimId', 'string'),
        required('toAddress', 'address'),
      ],
      'critical',
    ],
    [
      'adjudicate-dispute',
      'MsgAdjudicateDispute',
      [
        required('collectionId', 'string'),
        required('claimId', 'string'),
        required('adminAddress', 'address'),
        required('status', 'int'),
      ],
      'critical',
    ],
  ].map(([action, messageName, fields, riskLevel]) => ({
    module: 'claims',
    action,
    messageName,
    typeUrl: `/ixo.claims.v1beta1.${messageName}`,
    fields,
    risks: [
      'Changes claim lifecycle, authorization, payments, or collection policy. Confirm admin authority and payment effects.',
    ],
    riskLevel,
    portalRegistry:
      messageName === 'MsgSubmitClaim' || messageName === 'MsgEvaluateClaim',
  })) as MessageSpec[]),

  ...([
    [
      'create',
      'MsgCreateToken',
      [required('minter', 'address'), required('class', 'json')],
      'critical',
    ],
    [
      'mint',
      'MsgMintToken',
      [
        required('minter', 'address'),
        required('tokens', 'tokenBatchArray'),
        optional('recipient', 'address'),
      ],
      'critical',
    ],
    [
      'transfer',
      'MsgTransferToken',
      [
        required('owner', 'address'),
        required('recipient', 'address'),
        required('tokens', 'tokenBatchArray'),
      ],
      'critical',
    ],
    [
      'retire',
      'MsgRetireToken',
      [
        required('owner', 'address'),
        required('tokens', 'tokenBatchArray'),
        required('jurisdiction', 'string'),
        required('reason', 'string'),
      ],
      'critical',
    ],
    [
      'transfer-credit',
      'MsgTransferCredit',
      [
        required('owner', 'address'),
        required('recipient', 'address'),
        required('tokens', 'tokenBatchArray'),
      ],
      'critical',
    ],
    [
      'cancel',
      'MsgCancelToken',
      [
        required('owner', 'address'),
        required('tokens', 'tokenBatchArray'),
        required('reason', 'string'),
      ],
      'critical',
    ],
    [
      'pause',
      'MsgPauseToken',
      [
        required('minter', 'address'),
        required('contractAddress', 'address'),
        required('paused', 'bool'),
      ],
      'high',
    ],
    [
      'stop',
      'MsgStopToken',
      [required('minter', 'address'), required('contractAddress', 'address')],
      'critical',
    ],
  ].map(([action, messageName, fields, riskLevel]) => ({
    module: 'token',
    action,
    messageName,
    typeUrl: `/ixo.token.v1beta1.${messageName}`,
    fields,
    risks: [
      'Moves, mints, burns, pauses, or retires impact credits. Confirm denom, amount, recipient, and irreversibility.',
    ],
    riskLevel,
    portalRegistry: [
      'MsgMintToken',
      'MsgRetireToken',
      'MsgTransferToken',
    ].includes(messageName as string),
  })) as MessageSpec[]),

  ...([
    ['create', 'MsgCreateBond'],
    ['edit', 'MsgEditBond'],
    ['set-next-alpha', 'MsgSetNextAlpha'],
    ['update-state', 'MsgUpdateBondState'],
    ['buy', 'MsgBuy'],
    ['sell', 'MsgSell'],
    ['swap', 'MsgSwap'],
    ['make-outcome-payment', 'MsgMakeOutcomePayment'],
    ['withdraw-share', 'MsgWithdrawShare'],
    ['withdraw-reserve', 'MsgWithdrawReserve'],
  ].map(([action, messageName]) => ({
    module: 'bonds',
    action,
    messageName,
    typeUrl: `/ixo.bonds.v1beta1.${messageName}`,
    fields: [
      required('bondDid', 'did'),
      required('signer', 'address'),
      optional('amount', 'coin'),
      optional('reserveTokens', 'coinArray'),
      optional('settings', 'json'),
    ],
    risks: [
      'Changes bonding-curve state or moves reserve/share funds. Confirm economic terms and amounts.',
    ],
    riskLevel: 'critical',
    portalRegistry: false,
  })) as MessageSpec[]),

  ...([
    ['stake', 'MsgLiquidStake'],
    ['unstake', 'MsgLiquidUnstake'],
    ['redeem', 'MsgRedeem'],
    ['claim', 'MsgClaim'],
    ['create-validator', 'MsgCreateValidator'],
    ['add-validator', 'MsgAddValidator'],
    ['remove-validator', 'MsgRemoveValidator'],
    ['update-validator', 'MsgUpdateValidator'],
    ['update-params', 'MsgUpdateParams'],
    ['set-module-paused', 'MsgSetModulePaused'],
  ].map(([action, messageName]) => ({
    module: 'liquidstake',
    action,
    messageName,
    typeUrl: `/ixo.liquidstake.v1beta1.${messageName}`,
    fields: [
      required('delegatorAddress', 'address'),
      optional('validatorAddress', 'string'),
      optional('amount', 'coin'),
      optional('poolId', 'uint'),
      optional('authority', 'address'),
      optional('params', 'json'),
    ],
    risks: [
      'Moves or configures staked IXO/LST positions. Confirm pool, validator, amount, and SDK support for the chain proto.',
    ],
    riskLevel: 'critical',
    portalRegistry: false,
  })) as MessageSpec[]),

  ...([
    [
      'create-namespace',
      'MsgCreateNamespace',
      [
        required('name', 'string'),
        required('ownerAddress', 'address'),
        required('ownerDid', 'did'),
      ],
    ],
    [
      'update-namespace',
      'MsgUpdateNamespace',
      [
        required('namespace', 'string'),
        required('ownerAddress', 'address'),
        optional('settings', 'json'),
      ],
    ],
    [
      'register',
      'MsgRegisterName',
      [
        required('name', 'string'),
        required('namespace', 'string'),
        required('ownerDid', 'did'),
        required('ownerAddress', 'address'),
      ],
    ],
    [
      'register-by-registrar',
      'MsgRegisterNameByRegistrar',
      [
        required('name', 'string'),
        required('namespace', 'string'),
        required('ownerDid', 'did'),
        required('registrarAddress', 'address'),
      ],
    ],
    [
      'update-by-registrar',
      'MsgUpdateNameByRegistrar',
      [
        required('name', 'string'),
        required('namespace', 'string'),
        required('registrarAddress', 'address'),
        optional('data', 'json'),
      ],
    ],
    [
      'transfer',
      'MsgTransferName',
      [
        required('name', 'string'),
        required('namespace', 'string'),
        required('ownerAddress', 'address'),
        required('recipientDid', 'did'),
      ],
    ],
    [
      'set-status',
      'MsgSetNameStatus',
      [
        required('name', 'string'),
        required('namespace', 'string'),
        required('ownerAddress', 'address'),
        required('status', 'int'),
      ],
    ],
  ].map(([action, messageName, fields]) => ({
    module: 'names',
    action,
    messageName,
    typeUrl: `/ixo.names.v1beta1.${messageName}`,
    fields,
    risks: [
      'Changes name or namespace ownership/status. Confirm namespace authority and recipient DID.',
    ],
    riskLevel: 'high',
    portalRegistry: false,
  })) as MessageSpec[]),

  ...([
    [
      'add-authenticator',
      'MsgAddAuthenticator',
      [
        required('sender', 'address'),
        required('authenticatorType', 'string'),
        required('data', 'bytes'),
      ],
      'critical',
    ],
    [
      'remove-authenticator',
      'MsgRemoveAuthenticator',
      [required('sender', 'address'), required('id', 'uint')],
      'critical',
    ],
    [
      'set-active-state',
      'MsgSetActiveState',
      [required('sender', 'address'), required('active', 'bool')],
      'critical',
    ],
  ].map(([action, messageName, fields, riskLevel]) => ({
    module: 'smart-account',
    action,
    messageName,
    typeUrl: `/ixo.smartaccount.v1beta1.${messageName}`,
    fields,
    risks: [
      'Changes smart-account authentication. Confirm authenticator id, data, and account lockout risk.',
    ],
    riskLevel,
    portalRegistry: false,
  })) as MessageSpec[]),
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
