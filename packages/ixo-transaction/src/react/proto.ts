import { cosmos, ixo } from '@ixo/impactxclient-sdk';

import { AUTHORIZATION_TYPE_URLS, type ITrxMsg } from '../schemas.js';

/** Cosmos `EncodeObject` — the decoded, wallet-ready message. */
export interface EncodeObject {
  typeUrl: string;
  value: unknown;
}

interface ProtoJsonCodec {
  fromJSON(object: unknown): unknown;
}

interface ProtoEncodeCodec extends ProtoJsonCodec {
  encode(message: unknown): { finish(): Uint8Array };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasFromJSON(value: unknown): value is ProtoJsonCodec {
  return isRecord(value) && typeof value.fromJSON === 'function';
}

function hasEncode(value: unknown): value is ProtoEncodeCodec {
  return (
    hasFromJSON(value) && isRecord(value) && typeof value.encode === 'function'
  );
}

function walk(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const GRANT_ENTITY_ACCOUNT_AUTHZ =
  '/ixo.entity.v1beta1.MsgGrantEntityAccountAuthz';

/**
 * Encode an allowlisted authorization, given as structured proto-JSON, into
 * the proto-JSON of a `google.protobuf.Any` (`value` = the encoded message,
 * base64) with the SDK's codec for that authorization type.
 */
export function encodeAuthorization(authorization: {
  typeUrl: string;
  value: unknown;
}): { typeUrl: string; value: string } {
  const allowed: readonly string[] = AUTHORIZATION_TYPE_URLS;
  if (!allowed.includes(authorization.typeUrl)) {
    throw new Error(`Authorization type not allowed: ${authorization.typeUrl}`);
  }
  // Allowlisted types are all `/cosmos.*`.
  const codec = walk(
    cosmos,
    authorization.typeUrl.replace(/^\/cosmos\./, '').split('.'),
  );
  if (!hasEncode(codec)) {
    throw new Error(`No codec found for ${authorization.typeUrl}`);
  }
  return {
    typeUrl: authorization.typeUrl,
    value: toBase64(codec.encode(codec.fromJSON(authorization.value)).finish()),
  };
}

/** Replace the grant's structured authorization with its encoded `Any`. */
function withEncodedAuthorization(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const grant = value.grant;
  if (!isRecord(grant)) return value;
  const authorization = grant.authorization;
  if (!isRecord(authorization) || typeof authorization.typeUrl !== 'string') {
    return value;
  }
  return {
    ...value,
    grant: {
      ...grant,
      authorization: encodeAuthorization({
        typeUrl: authorization.typeUrl,
        value: authorization.value,
      }),
    },
  };
}

/**
 * Resolve the generated protobuf codec for an IXO Msg typeUrl by walking the
 * `ixo` namespace — e.g. `/ixo.entity.v1beta1.MsgCreateEntity` resolves to
 * `ixo.entity.v1beta1.MsgCreateEntity`.
 */
export function resolveProtoCodec(typeUrl: string): ProtoJsonCodec {
  const segments = typeUrl.replace(/^\//, '').split('.');
  if (segments[0] !== 'ixo') {
    throw new Error(
      `Unsupported typeUrl namespace (expected ixo.*): ${typeUrl}`,
    );
  }
  const current = walk(ixo, segments.slice(1));
  if (!hasFromJSON(current)) {
    throw new Error(`No fromJSON codec found for ${typeUrl}`);
  }
  return current;
}

/**
 * Convert a proto-JSON `{ typeUrl, value }` produced by the oracle into a Cosmos
 * `EncodeObject` the wallet can sign. The SDK's generated `fromJSON` decodes the
 * lossy fields (`bytes` from base64, `Long`, `Timestamp`) into their real
 * runtime types so `transactSignX` encodes them correctly.
 */
export function toEncodeObject(message: ITrxMsg): EncodeObject {
  const codec = resolveProtoCodec(message.typeUrl);
  const value =
    message.typeUrl === GRANT_ENTITY_ACCOUNT_AUTHZ
      ? withEncodedAuthorization(message.value)
      : message.value;
  return { typeUrl: message.typeUrl, value: codec.fromJSON(value) };
}
