import protobuf from 'protobufjs/minimal.js';
import {
  TxRaw,
  TxBody,
} from '@ixo/impactxclient-sdk/module/codegen/cosmos/tx/v1beta1/tx.js';
import { MsgSend } from '@ixo/impactxclient-sdk/module/codegen/cosmos/bank/v1beta1/tx.js';
import type { ActionProposal } from '@ixo/ixo-transaction/action-proposals';
export async function indexedTransaction(proposal: ActionProposal) {
  const message = proposal.action.inputs.messages[0]!;
  const value = MsgSend.encode(
    MsgSend.fromJSON(message.value),
    new protobuf.Writer(),
  ).finish();
  const body = TxBody.encode(
    TxBody.fromPartial({
      messages: [{ typeUrl: message.typeUrl, value }],
      memo: proposal.action.inputs.memo ?? '',
    }),
    new protobuf.Writer(),
  ).finish();
  const bytes = TxRaw.encode(
    TxRaw.fromPartial({
      bodyBytes: body,
      authInfoBytes: new Uint8Array(),
      signatures: [new Uint8Array([1])],
    }),
    new protobuf.Writer(),
  ).finish();
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (v) => v.toString(16).padStart(2, '0'),
  )
    .join('')
    .toUpperCase();
  return {
    hash,
    json: JSON.stringify({
      result: {
        hash,
        height: '42',
        tx: btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')),
        tx_result: { code: 0 },
      },
    }),
  };
}
