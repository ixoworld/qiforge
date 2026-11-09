import { cosmos, cosmwasm, ixo } from '@ixo/impactxclient-sdk';

import {
  DaoDaoExecuteValueSchema,
  DaoDaoInstantiateValueSchema,
  WASM_EXECUTE_TYPE_URL,
  WASM_INSTANTIATE_TYPE_URL,
  type DaoDaoExecuteValue,
  type DaoDaoInstantiateValue,
  type DaoDaoProposalAction,
} from '../daodao-schemas.js';
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

const NAMESPACES: Readonly<Record<string, unknown>> = { ixo, cosmos, cosmwasm };

/**
 * Resolve the generated protobuf codec for a Msg typeUrl by walking the SDK's
 * `ixo`, `cosmos` or `cosmwasm` namespace — e.g.
 * `/ixo.entity.v1beta1.MsgCreateEntity` resolves to
 * `ixo.entity.v1beta1.MsgCreateEntity`.
 */
export function resolveProtoCodec(typeUrl: string): ProtoJsonCodec {
  const [namespace, ...segments] = typeUrl.replace(/^\//, '').split('.');
  const root =
    namespace !== undefined && Object.hasOwn(NAMESPACES, namespace)
      ? NAMESPACES[namespace]
      : undefined;
  if (root === undefined) {
    throw new Error(
      `Unsupported typeUrl namespace (expected ixo.*, cosmos.* or cosmwasm.*): ${typeUrl}`,
    );
  }
  const current = walk(root, segments);
  if (!hasFromJSON(current)) {
    throw new Error(`No fromJSON codec found for ${typeUrl}`);
  }
  return current;
}

/** Base64 of the UTF-8 JSON of a contract message: a CosmWasm `Binary`. */
function jsonBinary(json: unknown): string {
  return toBase64(new TextEncoder().encode(JSON.stringify(json)));
}

/**
 * The `dao_core` instantiate message as the contract reads it: each module's
 * message (shown decoded) as a `Binary`.
 */
function chainInstantiateMsg(msg: DaoDaoInstantiateValue['msg']): unknown {
  return {
    ...msg,
    proposal_modules_instantiate_info:
      msg.proposal_modules_instantiate_info.map((module) => {
        const { info } = module.msg.pre_propose_info.module_may_propose;
        return {
          ...module,
          msg: jsonBinary({
            ...module.msg,
            pre_propose_info: {
              module_may_propose: {
                info: { ...info, msg: jsonBinary(info.msg) },
              },
            },
          }),
        };
      }),
    voting_module_instantiate_info: {
      ...msg.voting_module_instantiate_info,
      msg: jsonBinary(msg.voting_module_instantiate_info.msg),
    },
  };
}

/** A proposal action as the contract reads it: `value` the encoded protobuf. */
function chainProposalAction(action: DaoDaoProposalAction): unknown {
  const message = {
    typeUrl: action.stargate.type_url,
    value: action.stargate.value,
  };
  const codec = resolveProtoCodec(message.typeUrl);
  if (!hasEncode(codec)) {
    throw new Error(`No codec found for ${message.typeUrl}`);
  }
  return {
    stargate: {
      type_url: message.typeUrl,
      value: toBase64(codec.encode(toEncodeObject(message).value).finish()),
    },
  };
}

/** The execute message as the contract reads it: proposal actions encoded. */
function chainExecuteMsg(msg: DaoDaoExecuteValue['msg']): unknown {
  if (!('propose' in msg)) return msg;
  const { propose } = msg;
  if ('msg' in propose) {
    const content = propose.msg.propose;
    return {
      propose: {
        msg: {
          propose: { ...content, msgs: content.msgs.map(chainProposalAction) },
        },
      },
    };
  }
  return {
    propose: { ...propose, msgs: propose.msgs.map(chainProposalAction) },
  };
}

/**
 * A DAO DAO message's proto-JSON value with its `msg` (shown decoded) as the
 * proto-JSON of the bytes field: base64 of the UTF-8 JSON the contract
 * reads, which `fromJSON` turns into those bytes. Throws on a value that is
 * not a DAO DAO shape.
 */
function withWasmMsgBytes(message: ITrxMsg): Record<string, unknown> {
  if (message.typeUrl === WASM_INSTANTIATE_TYPE_URL) {
    const value = DaoDaoInstantiateValueSchema.parse(message.value);
    return { ...value, msg: jsonBinary(chainInstantiateMsg(value.msg)) };
  }
  const value = DaoDaoExecuteValueSchema.parse(message.value);
  return { ...value, msg: jsonBinary(chainExecuteMsg(value.msg)) };
}

function encodableValue(message: ITrxMsg): Record<string, unknown> {
  switch (message.typeUrl) {
    case GRANT_ENTITY_ACCOUNT_AUTHZ:
      return withEncodedAuthorization(message.value);
    case WASM_INSTANTIATE_TYPE_URL:
    case WASM_EXECUTE_TYPE_URL:
      return withWasmMsgBytes(message);
    default:
      return message.value;
  }
}

/**
 * Convert a proto-JSON `{ typeUrl, value }` produced by the oracle into a Cosmos
 * `EncodeObject` the wallet can sign. The SDK's generated `fromJSON` decodes the
 * lossy fields (`bytes` from base64, `Long`, `Timestamp`) into their real
 * runtime types so `transactSignX` encodes them correctly. A DAO DAO
 * message's `msg` becomes the UTF-8 JSON bytes the contract reads, its
 * nested module messages and proposal actions encoded first.
 */
export function toEncodeObject(message: ITrxMsg): EncodeObject {
  const codec = resolveProtoCodec(message.typeUrl);
  return {
    typeUrl: message.typeUrl,
    value: codec.fromJSON(encodableValue(message)),
  };
}
