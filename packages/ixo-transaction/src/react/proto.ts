import { ixo } from '@ixo/impactxclient-sdk';

import type { ITrxMsg } from '../schemas.js';

/** Cosmos `EncodeObject` — the decoded, wallet-ready message. */
export interface EncodeObject {
  typeUrl: string;
  value: unknown;
}

interface ProtoJsonCodec {
  fromJSON(object: unknown): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasFromJSON(value: unknown): value is ProtoJsonCodec {
  return isRecord(value) && typeof value.fromJSON === 'function';
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
  let current: unknown = ixo;
  for (const segment of segments.slice(1)) {
    if (!isRecord(current)) {
      throw new Error(`Cannot resolve protobuf codec for ${typeUrl}`);
    }
    current = current[segment];
  }
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
  return { typeUrl: message.typeUrl, value: codec.fromJSON(message.value) };
}
