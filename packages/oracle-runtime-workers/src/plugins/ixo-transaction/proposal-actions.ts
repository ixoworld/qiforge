/**
 * What a DAO DAO proposal will do when it is carried out, read from its
 * `msgs` as `dao-proposal-single` 2.0.3 answers them (cw `CosmosMsg` JSON).
 * A `stargate` action of a type a proposal made here can hold
 * (`DAODAO_PROPOSAL_ACTION_ACTORS`) is decoded from its protobuf with the
 * SDK's codec into the catalog's proto-JSON and worded with its catalog
 * values and risks. Any other action (another stargate type, a `bank`,
 * `wasm` or other message) is named, never guessed: the user is told it
 * cannot be read here.
 */
import {
  describeDaoDaoProposalAction,
  findMessageForValue,
  type DAODAO_PROPOSAL_ACTION_ACTORS,
} from '@ixo/ixo-transaction';
import { MsgSend } from '@ixo/impactxclient-sdk/module/codegen/cosmos/bank/v1beta1/tx.js';
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

type ActionTypeUrl = keyof typeof DAODAO_PROPOSAL_ACTION_ACTORS;

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

/** One cw `CosmosMsg` of a proposal, as the user is shown it. */
export function readProposalAction(msg: unknown): ProposalAction {
  if (!isRecord(msg)) return unreadable('not a chain message');
  const kinds = Object.keys(msg);
  const stargate = msg.stargate;
  if (kinds.length !== 1 || !isRecord(stargate))
    return unreadable(`a ${named(kinds.join(', ')) || 'empty'} message`);
  const typeUrl = stargate.type_url;
  const value = stargate.value;
  if (typeof typeUrl !== 'string' || typeof value !== 'string')
    return unreadable('a stargate message without a type and value');
  if (!isActionTypeUrl(typeUrl))
    return unreadable(`a ${named(typeUrl)} message`);
  let json: unknown;
  try {
    json = READERS[typeUrl](base64ToBytes(value));
  } catch {
    return unreadable(`a ${typeUrl} message whose content does not decode`);
  }
  if (!isRecord(json))
    return unreadable(`a ${typeUrl} message whose content does not decode`);
  const action = { typeUrl, value: json };
  const spec = findMessageForValue(action);
  if (!spec) return unreadable(`a ${typeUrl} message`);
  return {
    decoded: true,
    text: describeDaoDaoProposalAction(action),
    risks: spec.risks,
  };
}
