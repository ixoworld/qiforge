import protobuf from 'protobufjs/minimal.js';
import { z } from 'zod';
import { MsgGrantEntityAccountAuthz } from '@ixo/impactxclient-sdk/module/codegen/ixo/entity/v1beta1/tx.js';
import {
  SubmitClaimAuthorization,
  SubmitClaimConstraints,
  EvaluateClaimAuthorization,
  EvaluateClaimConstraints,
} from '@ixo/impactxclient-sdk/module/codegen/ixo/claims/v1beta1/authz.js';
import { Timestamp } from '@ixo/impactxclient-sdk/module/codegen/google/protobuf/timestamp.js';
import { IxoAddressSchema } from './action-proposals.js';
import { EncodedTopicGrantSchema } from './topic-proposals.js';

const Submit = '/ixo.claims.v1beta1.SubmitClaimAuthorization';
const Evaluate = '/ixo.claims.v1beta1.EvaluateClaimAuthorization';
const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const base64 = (v: Uint8Array) =>
  btoa(Array.from(v, (c) => String.fromCharCode(c)).join(''));
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const constraintQuota = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
const quota = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((s) => BigInt(s) <= 9223372036854775807n);
/**
 * The grant the chain already holds for this admin, grantee and role. Its
 * expiry is the whole authorization's: merging a new constraint into it
 * re-grants every constraint with the new expiry, so a merge is only allowed
 * when the requested expiry is the existing one (`null` = no expiry on
 * chain, which a dated grant would silently shorten).
 */
const Existing = z.strictObject({
  typeUrl: z.enum([Submit, Evaluate]),
  valueBase64: z.string().min(1).max(131072),
  expiresAt: z.iso.datetime().nullable(),
});
export const BuildTopicGrantSchema = z.strictObject({
  role: z.enum(['submit', 'evaluate']),
  ownerAddress: IxoAddressSchema,
  entityDid: z.string().startsWith('did:ixo:'),
  adminAddress: IxoAddressSchema,
  granteeAddress: IxoAddressSchema,
  collectionId: z.string().min(1).max(256),
  agentQuota: quota,
  expiresAt: z.iso.datetime(),
  beforeDate: z.iso.datetime().optional(),
  existing: Existing.optional(),
});
function timestamp(value: string) {
  const ms = Date.parse(value);
  return Timestamp.fromJSON({
    seconds: String(Math.floor(ms / 1000)),
    nanos: (ms % 1000) * 1000000,
  });
}
function iso(value: Timestamp | undefined) {
  if (!value) throw new Error('Absolute grant expiry is required');
  const seconds = Number(value.seconds.toString());
  if (
    !Number.isSafeInteger(seconds) ||
    value.nanos < 0 ||
    value.nanos > 999999999
  )
    throw new Error('Invalid protobuf timestamp');
  return new Date(seconds * 1000 + value.nanos / 1e6).toISOString();
}
function nested(type: string, value: Uint8Array) {
  if (type === Submit) {
    const decoded = SubmitClaimAuthorization.decode(value);
    if (
      !same(
        value,
        SubmitClaimAuthorization.encode(
          decoded,
          new protobuf.Writer(),
        ).finish(),
      )
    )
      throw new Error('Noncanonical Submit authorization');
    IxoAddressSchema.parse(decoded.admin);
    if (decoded.constraints.length > 128)
      throw new Error('Too many constraints');
    for (const c of decoded.constraints) {
      z.string().min(1).parse(c.collectionId);
      constraintQuota.parse(c.agentQuota.toString());
      if (c.memberAddress) IxoAddressSchema.parse(c.memberAddress);
      for (const coin of c.maxAmount) {
        z.string().regex(/^\d+$/).parse(coin.amount);
        z.string().min(1).parse(coin.denom);
      }
    }
    return {
      role: 'submit' as const,
      admin: decoded.admin,
      value: SubmitClaimAuthorization.toJSON(decoded),
    };
  }
  if (type === Evaluate) {
    const decoded = EvaluateClaimAuthorization.decode(value);
    if (
      !same(
        value,
        EvaluateClaimAuthorization.encode(
          decoded,
          new protobuf.Writer(),
        ).finish(),
      )
    )
      throw new Error('Noncanonical Evaluate authorization');
    IxoAddressSchema.parse(decoded.admin);
    if (decoded.constraints.length > 128)
      throw new Error('Too many constraints');
    for (const c of decoded.constraints) {
      if (!c.collectionId && !c.claimIds.length)
        throw new Error('Missing authorization collection');
      constraintQuota.parse(c.agentQuota.toString());
      if (c.beforeDate) iso(c.beforeDate);
      for (const coin of c.maxCustomAmount) {
        z.string().regex(/^\d+$/).parse(coin.amount);
        z.string().min(1).parse(coin.denom);
      }
    }
    return {
      role: 'evaluate' as const,
      admin: decoded.admin,
      value: EvaluateClaimAuthorization.toJSON(decoded),
    };
  }
  throw new Error('Unsupported claims authorization');
}
export function buildTopicGrant(raw: z.infer<typeof BuildTopicGrantSchema>) {
  const p = BuildTopicGrantSchema.parse(raw);
  const typeUrl = p.role === 'submit' ? Submit : Evaluate;
  if (p.existing && p.existing.typeUrl !== typeUrl)
    throw new Error('Prior authorization role mismatch');
  if (
    p.existing &&
    nested(typeUrl, bytes(p.existing.valueBase64)).admin !== p.adminAddress
  )
    throw new Error('Prior authorization admin mismatch');
  if (p.existing) {
    if (p.existing.expiresAt === null)
      throw new Error(
        'The existing grant for this account has no expiry; a dated grant would shorten it',
      );
    if (
      new Date(p.existing.expiresAt).toISOString() !==
      new Date(p.expiresAt).toISOString()
    )
      throw new Error(
        `The existing grant for this account expires at ${p.existing.expiresAt}; request the same expiry so its other constraints keep it`,
      );
  }
  let encoded: Uint8Array;
  if (p.role === 'submit') {
    const prior = p.existing
      ? SubmitClaimAuthorization.decode(bytes(p.existing.valueBase64))
          .constraints
      : [];
    const next = SubmitClaimConstraints.fromJSON({
      collectionId: p.collectionId,
      agentQuota: p.agentQuota,
    });
    encoded = SubmitClaimAuthorization.encode(
      {
        admin: p.adminAddress,
        constraints: [
          next,
          ...prior.filter(
            (constraint) =>
              constraint.collectionId !== p.collectionId ||
              !!constraint.memberAddress,
          ),
        ],
      },
      new protobuf.Writer(),
    ).finish();
  } else {
    if (!p.beforeDate || Date.parse(p.beforeDate) > Date.parse(p.expiresAt))
      throw new Error(
        'Evaluator beforeDate must be absolute and within grant expiry',
      );
    const prior = p.existing
      ? EvaluateClaimAuthorization.decode(bytes(p.existing.valueBase64))
          .constraints
      : [];
    const next = EvaluateClaimConstraints.fromJSON({
      collectionId: p.collectionId,
      agentQuota: p.agentQuota,
      beforeDate: p.beforeDate,
    });
    encoded = EvaluateClaimAuthorization.encode(
      {
        admin: p.adminAddress,
        constraints: [
          next,
          ...prior.filter(
            (constraint) =>
              constraint.collectionId !== p.collectionId ||
              constraint.claimIds.length > 0,
          ),
        ],
      },
      new protobuf.Writer(),
    ).finish();
  }
  const message = MsgGrantEntityAccountAuthz.fromPartial({
    id: p.entityDid,
    ownerAddress: p.ownerAddress,
    name: 'admin',
    granteeAddress: p.granteeAddress,
    grant: {
      authorization: { typeUrl, value: encoded },
      expiration: timestamp(p.expiresAt),
    },
  });
  const result = {
    typeUrl: '/ixo.entity.v1beta1.MsgGrantEntityAccountAuthz' as const,
    valueBase64: base64(
      MsgGrantEntityAccountAuthz.encode(
        message,
        new protobuf.Writer(),
      ).finish(),
    ),
  };
  decodeTopicGrant(result);
  return result;
}
export function decodeTopicGrant(input: unknown) {
  const wire = EncodedTopicGrantSchema.parse(input);
  const encoded = bytes(wire.valueBase64);
  const decoded = MsgGrantEntityAccountAuthz.decode(encoded);
  if (
    !same(
      encoded,
      MsgGrantEntityAccountAuthz.encode(
        decoded,
        new protobuf.Writer(),
      ).finish(),
    )
  )
    throw new Error('Noncanonical grant message');
  IxoAddressSchema.parse(decoded.ownerAddress);
  IxoAddressSchema.parse(decoded.granteeAddress);
  if (
    decoded.name !== 'admin' ||
    !decoded.id.startsWith('did:ixo:') ||
    !decoded.grant?.authorization
  )
    throw new Error('Invalid owner grant');
  const auth = nested(
    decoded.grant.authorization.typeUrl,
    decoded.grant.authorization.value,
  );
  return {
    message: { typeUrl: wire.typeUrl, value: decoded },
    review: {
      ownerAddress: decoded.ownerAddress,
      entityDid: decoded.id,
      adminAddress: auth.admin,
      granteeAddress: decoded.granteeAddress,
      role: auth.role,
      expiresAt: iso(decoded.grant.expiration),
      authorization: auth.value,
    },
  };
}
