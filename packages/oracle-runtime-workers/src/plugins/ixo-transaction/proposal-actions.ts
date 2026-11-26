/**
 * What a DAO DAO proposal will do when it is carried out, read from its
 * `msgs` as `dao-proposal-single` 2.0.3 answers them (cw `CosmosMsg` JSON).
 * Every action a proposal made here can hold is read back and worded with
 * its values and risks: a `stargate` action decoded from its protobuf with
 * the SDK's codec into proto-JSON, a `wasm.execute` with its contract
 * message decoded from base64 JSON, and `bank`, `staking`, `distribution`
 * and `wasm.update_admin` as they are, each checked against its one shape
 * (`DaoDaoProposalActionSchema`). Any other action (another stargate type,
 * another contract message, a migrate) is named, never guessed: the user is
 * told it cannot be read here.
 */
import {
  DaoDaoProposalActionSchema,
  daoDaoGroupActionKind,
  daoDaoGroupActionSpec,
  describeProposalAction,
  findMessageForValue,
  type DAODAO_PROPOSAL_ACTION_ACTORS,
  type DaoDaoGroupStargateTypeUrl,
} from '@ixo/ixo-transaction';
import {
  MsgGrant,
  MsgRevoke,
} from '@ixo/impactxclient-sdk/module/codegen/cosmos/authz/v1beta1/tx.js';
import { GenericAuthorization } from '@ixo/impactxclient-sdk/module/codegen/cosmos/authz/v1beta1/authz.js';
import { MsgSend } from '@ixo/impactxclient-sdk/module/codegen/cosmos/bank/v1beta1/tx.js';
import { MsgVote } from '@ixo/impactxclient-sdk/module/codegen/cosmos/gov/v1beta1/tx.js';
import { MsgCreateCollection } from '@ixo/impactxclient-sdk/module/codegen/ixo/claims/v1beta1/tx.js';
import {
  MsgCreateEntityAccount,
  MsgRevokeEntityAccountAuthz,
} from '@ixo/impactxclient-sdk/module/codegen/ixo/entity/v1beta1/tx.js';
import {
  MsgRetireToken,
  MsgTransferToken,
} from '@ixo/impactxclient-sdk/module/codegen/ixo/token/v1beta1/tx.js';
import { base64ToBytes } from '../base64';

/** One action of a proposal, as the user is shown it. */
export type ProposalAction =
  | {
      decoded: true;
      /** The message with its values, e.g. `MsgSend (to address …, amount 5 uixo)`. */
      text: string;
      /** Its catalog risks. */
      risks: string[];
    }
  | {
      decoded: false;
      /** What kind of action it is, and that it cannot be read here. */
      text: string;
    };

type ActionTypeUrl =
  | keyof typeof DAODAO_PROPOSAL_ACTION_ACTORS
  | DaoDaoGroupStargateTypeUrl;

/** A codec's protobuf bytes to proto-JSON. */
const reader =
  <T>(codec: { decode(input: Uint8Array): T; toJSON(message: T): unknown }) =>
  (bytes: Uint8Array): unknown =>
    codec.toJSON(codec.decode(bytes));

const READERS: Readonly<Record<ActionTypeUrl, (bytes: Uint8Array) => unknown>> =
  {
    '/cosmos.bank.v1beta1.MsgSend': reader(MsgSend),
    '/ixo.token.v1beta1.MsgTransferToken': reader(MsgTransferToken),
    '/ixo.token.v1beta1.MsgRetireToken': reader(MsgRetireToken),
    '/ixo.claims.v1beta1.MsgCreateCollection': reader(MsgCreateCollection),
    '/ixo.entity.v1beta1.MsgCreateEntityAccount': reader(
      MsgCreateEntityAccount,
    ),
    '/ixo.entity.v1beta1.MsgRevokeEntityAccountAuthz': reader(
      MsgRevokeEntityAccountAuthz,
    ),
    '/cosmos.gov.v1beta1.MsgVote': reader(MsgVote),
    '/cosmos.authz.v1beta1.MsgRevoke': reader(MsgRevoke),
    // The grant's authorization is an `Any`: shown structured, as built.
    '/cosmos.authz.v1beta1.MsgGrant': (bytes) => {
      const grant = MsgGrant.decode(bytes);
      const json = MsgGrant.toJSON(grant) as Record<string, unknown>;
      const authorization = grant.grant?.authorization;
      if (
        authorization?.typeUrl !== '/cosmos.authz.v1beta1.GenericAuthorization'
      )
        return json;
      return {
        ...json,
        grant: {
          ...(json.grant as Record<string, unknown>),
          authorization: {
            typeUrl: authorization.typeUrl,
            value: GenericAuthorization.toJSON(
              GenericAuthorization.decode(authorization.value),
            ),
          },
        },
      };
    },
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isActionTypeUrl(typeUrl: string): typeUrl is ActionTypeUrl {
  return Object.hasOwn(READERS, typeUrl);
}

/** A type url or message kind as text inside a sentence: printable, one line, short. */
function named(text: string): string {
  const line = text.replace(/[^\x21-\x7e]+/g, '');
  return line.length <= 100 ? line : `${line.slice(0, 99)}…`;
}

const unreadable = (what: string): ProposalAction => ({
  decoded: false,
  text: `an action this oracle cannot read (${what}): its effect is not shown here, so check it in the Portal’s Decisions tab before carrying the proposal out`,
});

/**
 * A chain `CosmosMsg` in the decoded form a proposal action is checked in:
 * a stargate value as proto-JSON, a contract message as JSON. A string
 * saying why when it cannot be decoded.
 */
function decodedForm(msg: Record<string, unknown>): unknown {
  const stargate = msg.stargate;
  if (isRecord(stargate)) {
    const typeUrl = stargate.type_url;
    const value = stargate.value;
    if (typeof typeUrl !== 'string' || typeof value !== 'string')
      return 'a stargate message without a type and value';
    if (!isActionTypeUrl(typeUrl)) return `a ${named(typeUrl)} message`;
    let json: unknown;
    try {
      json = READERS[typeUrl](base64ToBytes(value));
    } catch {
      return `a ${typeUrl} message whose content does not decode`;
    }
    if (!isRecord(json))
      return `a ${typeUrl} message whose content does not decode`;
    return { stargate: { type_url: typeUrl, value: json } };
  }
  const wasm = msg.wasm;
  if (isRecord(wasm) && isRecord(wasm.execute)) {
    const { msg: binary, ...rest } = wasm.execute;
    if (typeof binary !== 'string')
      return 'a contract message without its content';
    try {
      const json: unknown = JSON.parse(
        new TextDecoder().decode(base64ToBytes(binary)),
      );
      return { wasm: { execute: { ...rest, msg: json } } };
    } catch {
      return 'a contract message whose content does not decode';
    }
  }
  return msg;
}

/** One cw `CosmosMsg` of a proposal, as the user is shown it. */
export function readProposalAction(msg: unknown): ProposalAction {
  if (!isRecord(msg)) return unreadable('not a chain message');
  const kinds = Object.keys(msg);
  if (kinds.length !== 1)
    return unreadable(`a ${named(kinds.join(', ')) || 'empty'} message`);
  const decoded = decodedForm(msg);
  if (typeof decoded === 'string') return unreadable(decoded);
  const parsed = DaoDaoProposalActionSchema.safeParse(decoded);
  // Not one of the shapes a proposal made here holds: named, never guessed.
  if (!parsed.success) return unreadable(`a ${named(kinds[0] ?? '')} message`);
  const action = parsed.data;
  const kind = daoDaoGroupActionKind(action);
  if (kind === undefined)
    return unreadable(`a ${named(kinds[0] ?? '')} message`);
  if (kind !== 'catalog')
    return {
      decoded: true,
      text: describeProposalAction(action),
      risks: daoDaoGroupActionSpec(kind).risks,
    };
  if (!('stargate' in action)) return unreadable('a message');
  const catalogMessage = {
    typeUrl: action.stargate.type_url,
    value: action.stargate.value,
  };
  const spec = findMessageForValue(catalogMessage);
  if (!spec) return unreadable(`a ${catalogMessage.typeUrl} message`);
  return {
    decoded: true,
    text: describeProposalAction(catalogMessage),
    risks: spec.risks,
  };
}
