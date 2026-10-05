/**
 * The catalog against `@ixo/impactxclient-sdk` — the version the lockfile
 * resolves (`3.0.0`). Every catalog entry must name a Msg the SDK generates,
 * list exactly that Msg's fields, and produce (from samples of its field
 * kinds) proto-JSON the SDK's codec reads and encodes; every nested schema
 * must use the SDK message's field names.
 */
import { cosmos, google, ixo } from '@ixo/impactxclient-sdk';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { MESSAGE_CATALOG } from '../src/catalog.js';
import { resolveProtoCodec, toEncodeObject } from '../src/react/proto.js';
import {
  AUTHORIZATION_TYPE_URLS,
  AccordedRightSchema,
  AdjudicationDidSchema,
  AuthzGrantSchema,
  CW1155PaymentSchema,
  CW20PaymentSchema,
  CoinSchema,
  Contract1155PaymentSchema,
  ContextSchema,
  DisputeDataSchema,
  DurationSchema,
  GenericAuthorizationSchema,
  LinkedClaimSchema,
  LinkedEntitySchema,
  LinkedResourceSchema,
  MintBatchSchema,
  PaymentSchema,
  PaymentsSchema,
  SendAuthorizationSchema,
  ServiceSchema,
  TokenBatchSchema,
  TokenDataSchema,
  VerificationMethodSchema,
  VerificationSchema,
  type FieldKind,
} from '../src/schemas.js';
import {
  describeValidationError,
  validateTransactionDraft,
} from '../src/validate.js';
import {
  ADDRESS,
  ADDRESS_2,
  DID,
  ENTITY_DID,
  verification,
} from './fixtures.js';

interface FullCodec {
  fromPartial(object: object): object;
  fromJSON(object: unknown): unknown;
  encode(message: unknown): { finish(): Uint8Array };
  decode(bytes: Uint8Array): unknown;
  toJSON(message: unknown): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFullCodec(value: unknown): value is FullCodec {
  return (
    isRecord(value) &&
    typeof value.fromPartial === 'function' &&
    typeof value.fromJSON === 'function' &&
    typeof value.encode === 'function' &&
    typeof value.decode === 'function' &&
    typeof value.toJSON === 'function'
  );
}

function codecAt(root: unknown, path: string): FullCodec {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) throw new Error(`No SDK namespace at ${path}`);
    current = current[segment];
  }
  if (!isFullCodec(current)) throw new Error(`No SDK codec at ${path}`);
  return current;
}

const sortedKeys = (value: object): string[] => Object.keys(value).sort();

/** A valid proto-JSON sample for each field kind. */
const SAMPLES: Record<FieldKind, unknown> = {
  string: 'sample',
  stringArray: ['sample'],
  did: DID,
  didArray: [DID],
  address: ADDRESS,
  bool: true,
  int: 1,
  uint: '7',
  timestamp: '2026-01-02T03:04:05.000Z',
  coinArray: [{ denom: 'uixo', amount: '1' }],
  bytes: 'AQID',
  duration: { seconds: '3600', nanos: 5 },
  payments: {
    submission: {
      account: ADDRESS,
      amount: [{ denom: 'uixo', amount: '10' }],
      contract_1155Payment: { address: ADDRESS_2, tokenId: 't1', amount: 3 },
      timeoutNs: { seconds: '60', nanos: 0 },
      cw20Payment: [{ address: ADDRESS_2, amount: '5' }],
      isOraclePayment: true,
      cw1155Payment: [{ address: ADDRESS_2, tokenId: ['t1'], amount: '2' }],
    },
    approval: { account: ADDRESS_2, amount: [{ denom: 'uixo', amount: '1' }] },
  },
  disputeData: {
    uri: 'https://x.test/dispute',
    type: 'Evidence',
    proof: 'proof-1',
    encrypted: true,
  },
  cw20PaymentArray: [{ address: ADDRESS_2, amount: '5' }],
  cw1155PaymentArray: [
    { address: ADDRESS_2, tokenId: ['t1', 't2'], amount: '2' },
  ],
  adjudicationDidArray: [{ did: DID, rewardPercentage: '0.1' }],
  mintBatchArray: [
    {
      name: 'CARBON',
      index: '1',
      amount: '10',
      collection: 'collection-1',
      tokenData: [
        {
          uri: 'https://x.test/token',
          encrypted: true,
          proof: 'proof-2',
          type: 'Data',
          id: 'token-data-1',
        },
      ],
    },
  ],
  verification: verification[0],
  verificationArray: verification,
  service: { id: 'svc', type: 'Service', serviceEndpoint: 'https://x.test' },
  serviceArray: [
    { id: 'svc', type: 'Service', serviceEndpoint: 'https://x.test' },
  ],
  context: { key: 'k', val: 'v' },
  contextArray: [{ key: 'k', val: 'v' }],
  linkedResource: {
    id: 'res',
    type: 'Settings',
    serviceEndpoint: 'https://x.test',
  },
  linkedResourceArray: [
    { id: 'res', type: 'Settings', serviceEndpoint: 'https://x.test' },
  ],
  linkedEntity: { id: ENTITY_DID, type: 'Entity', relationship: 'parent' },
  linkedEntityArray: [
    { id: ENTITY_DID, type: 'Entity', relationship: 'parent' },
  ],
  linkedClaim: { id: 'claim', type: 'Claim' },
  linkedClaimArray: [{ id: 'claim', type: 'Claim' }],
  accordedRight: { id: 'right', type: 'Right' },
  accordedRightArray: [{ id: 'right', type: 'Right' }],
  tokenBatchArray: [{ id: 'CREDIT-1', amount: '1' }],
  authzGrant: {
    authorization: {
      typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
      value: { msg: '/ixo.claims.v1beta1.MsgSubmitClaim' },
    },
    expiration: '2026-12-31T00:00:00.000Z',
  },
};

/**
 * Nested kinds whose sample must come back out of the SDK codec intact
 * (`toJSON` of the decoded message contains the sample): proves the schema's
 * field names and value shapes are the ones the codec reads.
 */
const ROUND_TRIP_KINDS: ReadonlySet<FieldKind> = new Set([
  'duration',
  'payments',
  'disputeData',
  'cw20PaymentArray',
  'cw1155PaymentArray',
  'adjudicationDidArray',
  'mintBatchArray',
  'coinArray',
  'tokenBatchArray',
]);

const STRING_KINDS: ReadonlySet<FieldKind> = new Set([
  'string',
  'did',
  'address',
]);

describe('the SDK the catalog is verified against', () => {
  it('is the version the lockfile resolves', () => {
    const require = createRequire(import.meta.url);
    const manifest: unknown = require('@ixo/impactxclient-sdk/package.json');
    expect(isRecord(manifest) && manifest.version).toBe('3.0.0');
  });
});

describe.each(MESSAGE_CATALOG.map((spec) => [spec.typeUrl, spec] as const))(
  'catalog entry %s',
  (typeUrl, spec) => {
    const codec = codecAt(ixo, typeUrl.replace(/^\/ixo\./, ''));

    it('lists exactly the SDK message fields', () => {
      expect(spec.fields.map((field) => field.name).sort()).toEqual(
        sortedKeys(codec.fromPartial({})),
      );
    });

    it('validates a sample of every field and the SDK codec encodes it', () => {
      const value = Object.fromEntries(
        spec.fields.map((field) => [field.name, SAMPLES[field.kind]]),
      );
      const validated = validateTransactionDraft({ typeUrl, value });
      expect(resolveProtoCodec(typeUrl).fromJSON).toBe(codec.fromJSON);

      // The Portal's own conversion (authorizations encoded into `Any`).
      const bytes = codec
        .encode(toEncodeObject(validated.message).value)
        .finish();
      const decoded = codec.decode(bytes);
      if (!isRecord(decoded)) throw new Error('decoded to a non-object');
      const json = codec.toJSON(decoded);
      if (!isRecord(json)) throw new Error('toJSON gave a non-object');
      const nestedFields = spec.fields.filter((field) =>
        ROUND_TRIP_KINDS.has(field.kind),
      );
      expect(
        Object.fromEntries(
          nestedFields.map((field) => [field.name, json[field.name]]),
        ),
      ).toMatchObject(
        Object.fromEntries(
          nestedFields.map((field) => [field.name, SAMPLES[field.kind]]),
        ),
      );
      const stringFields = spec.fields.filter((field) =>
        STRING_KINDS.has(field.kind),
      );
      expect(
        Object.fromEntries(
          stringFields.map((field) => [field.name, decoded[field.name]]),
        ),
      ).toEqual(
        Object.fromEntries(
          stringFields.map((field) => [field.name, SAMPLES[field.kind]]),
        ),
      );
    });
  },
);

describe('nested schemas use the SDK field names', () => {
  it.each([
    ['iid.v1beta1.Verification', VerificationSchema],
    ['iid.v1beta1.VerificationMethod', VerificationMethodSchema],
    ['iid.v1beta1.Service', ServiceSchema],
    ['iid.v1beta1.Context', ContextSchema],
    ['iid.v1beta1.LinkedResource', LinkedResourceSchema],
    ['iid.v1beta1.LinkedEntity', LinkedEntitySchema],
    ['iid.v1beta1.LinkedClaim', LinkedClaimSchema],
    ['iid.v1beta1.AccordedRight', AccordedRightSchema],
    ['token.v1beta1.TokenBatch', TokenBatchSchema],
    ['token.v1beta1.MintBatch', MintBatchSchema],
    ['token.v1beta1.TokenData', TokenDataSchema],
    ['claims.v1beta1.Payments', PaymentsSchema],
    ['claims.v1beta1.Payment', PaymentSchema],
    ['claims.v1beta1.Contract1155Payment', Contract1155PaymentSchema],
    ['claims.v1beta1.CW20Payment', CW20PaymentSchema],
    ['claims.v1beta1.CW1155Payment', CW1155PaymentSchema],
    ['claims.v1beta1.AdjudicationDid', AdjudicationDidSchema],
    ['claims.v1beta1.DisputeData', DisputeDataSchema],
  ] as const)('ixo.%s', (path, schema) => {
    expect(sortedKeys(schema.shape)).toEqual(
      sortedKeys(codecAt(ixo, path).fromPartial({})),
    );
  });

  it.each([
    ['base.v1beta1.Coin', CoinSchema],
    ['authz.v1beta1.Grant', AuthzGrantSchema],
    [
      'authz.v1beta1.GenericAuthorization',
      GenericAuthorizationSchema.shape.value,
    ],
    ['bank.v1beta1.SendAuthorization', SendAuthorizationSchema.shape.value],
  ] as const)('cosmos.%s', (path, schema) => {
    expect(sortedKeys(schema.shape)).toEqual(
      sortedKeys(codecAt(cosmos, path).fromPartial({})),
    );
  });

  it('google.protobuf.Duration', () => {
    expect(sortedKeys(DurationSchema.shape)).toEqual(
      sortedKeys(codecAt(google, 'protobuf.Duration').fromPartial({})),
    );
  });
});

describe('entity-account authorization grants', () => {
  const grantMessage = (authorization: unknown) => ({
    typeUrl: '/ixo.entity.v1beta1.MsgGrantEntityAccountAuthz',
    value: {
      id: ENTITY_DID,
      name: 'admin',
      granteeAddress: ADDRESS_2,
      ownerAddress: ADDRESS,
      grant: { authorization },
    },
  });

  it('allows only the listed authorization types, each with an SDK codec', () => {
    expect(AUTHORIZATION_TYPE_URLS).toEqual([
      '/cosmos.authz.v1beta1.GenericAuthorization',
      '/cosmos.bank.v1beta1.SendAuthorization',
    ]);
    for (const typeUrl of AUTHORIZATION_TYPE_URLS) {
      expect(codecAt(cosmos, typeUrl.replace(/^\/cosmos\./, ''))).toBeDefined();
    }
    const failure = (authorization: unknown): string => {
      try {
        validateTransactionDraft(grantMessage(authorization));
      } catch (error) {
        return describeValidationError(error);
      }
      return 'accepted';
    };
    expect(
      failure({
        typeUrl: '/cosmos.staking.v1beta1.StakeAuthorization',
        value: {},
      }),
    ).toMatch(/^grant\.authorization\.typeUrl: Invalid discriminator value/);
    // An opaque, already-encoded Any is refused: the value must be structured.
    expect(
      failure({
        typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
        value: 'CgIveA==',
      }),
    ).toMatch(/^grant\.authorization\.value: /);
  });

  it.each([
    [
      '/cosmos.authz.v1beta1.GenericAuthorization',
      { msg: '/ixo.claims.v1beta1.MsgSubmitClaim' },
    ],
    [
      '/cosmos.bank.v1beta1.SendAuthorization',
      {
        spendLimit: [{ denom: 'uixo', amount: '1000' }],
        allowList: [ADDRESS_2],
      },
    ],
  ] as const)(
    'encodes %s into the grant Any with the SDK codec',
    (typeUrl, value) => {
      const validated = validateTransactionDraft(
        grantMessage({ typeUrl, value }),
      );
      const encoded = toEncodeObject(validated.message).value;
      if (!isRecord(encoded) || !isRecord(encoded.grant))
        throw new Error('no grant');
      const any = encoded.grant.authorization;
      if (!isRecord(any) || !(any.value instanceof Uint8Array))
        throw new Error('authorization is not an encoded Any');
      expect(any.typeUrl).toBe(typeUrl);
      const inner = codecAt(cosmos, typeUrl.replace(/^\/cosmos\./, ''));
      expect(inner.toJSON(inner.decode(any.value))).toMatchObject(value);
    },
  );
});
