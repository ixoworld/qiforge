import protobuf from 'protobufjs/minimal.js';
import { boundedBytes } from '../core/domain-context/transport';
import {
  TxRaw,
  TxBody,
} from '@ixo/impactxclient-sdk/module/codegen/cosmos/tx/v1beta1/tx.js';
import { MsgSend } from '@ixo/impactxclient-sdk/module/codegen/cosmos/bank/v1beta1/tx.js';
import { MsgTransferToken } from '@ixo/impactxclient-sdk/module/codegen/ixo/token/v1beta1/tx.js';
import type { ActionProposal } from '@ixo/ixo-transaction/action-proposals';
import { z } from 'zod';

const TxResponse = z.object({
  result: z.object({
    hash: z.string().regex(/^[a-fA-F0-9]{64}$/),
    height: z.string().regex(/^[1-9]\d*$/),
    tx: z.string().min(1).max(1_000_000),
    tx_result: z.object({ code: z.number().int().nonnegative() }),
  }),
});
const StatusResponse = z.object({
  result: z.object({ node_info: z.object({ network: z.string().min(1) }) }),
});
const decode64 = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
export type VerifiedActionTransaction = {
  transactionHash: string;
  height: number;
  code: number;
  verifiedAt: string;
};

export async function verifyActionTransaction(
  proposal: ActionProposal,
  transactionHash: string,
  rpcOrigin: string,
  fetcher: typeof fetch = fetch,
): Promise<VerifiedActionTransaction> {
  const origin = new URL(rpcOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error('Expected configured HTTPS RPC origin');
  const request = async (path: string) => {
    const response = await fetcher(
      new URL(path, `${origin.href.replace(/\/$/, '')}/`),
      { redirect: 'error', signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error('Chain verification unavailable');
    const text = new TextDecoder().decode(
      await boundedBytes(response, 1_500_000),
    );
    return JSON.parse(text) as unknown;
  };
  const status = StatusResponse.parse(await request('status'));
  if (status.result.node_info.network !== proposal.action.chainId)
    throw new Error('Chain mismatch');
  const tx = TxResponse.parse(
    await request(`tx?hash=0x${transactionHash.toUpperCase()}&prove=false`),
  ).result;
  const bytes = decode64(tx.tx);
  const digest = hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  );
  if (
    digest !== transactionHash.toLowerCase() ||
    tx.hash.toLowerCase() !== digest
  )
    throw new Error('Transaction hash mismatch');
  const raw = TxRaw.decode(bytes);
  if (raw.signatures.length === 0) throw new Error('Unsigned transaction');
  const body = TxBody.decode(raw.bodyBytes);
  const inputs = proposal.action.inputs;
  // The memo is the card's id: a transaction signed for another card, or
  // with no card at all, never verifies this one.
  if (body.memo !== proposal.id) throw new Error('Transaction memo mismatch');
  if (body.messages.length !== inputs.messages.length)
    throw new Error('Transaction subject mismatch');
  for (let i = 0; i < inputs.messages.length; i++) {
    const expected = inputs.messages[i]!;
    const actual = body.messages[i]!;
    const expectedBytes =
      expected.typeUrl === '/cosmos.bank.v1beta1.MsgSend'
        ? MsgSend.encode(
            MsgSend.fromJSON(expected.value),
            new protobuf.Writer(),
          ).finish()
        : expected.typeUrl === '/ixo.token.v1beta1.MsgTransferToken'
          ? MsgTransferToken.encode(
              MsgTransferToken.fromJSON(expected.value),
              new protobuf.Writer(),
            ).finish()
          : undefined;
    if (
      !expectedBytes ||
      actual.typeUrl !== expected.typeUrl ||
      !equal(actual.value, expectedBytes)
    )
      throw new Error('Transaction subject mismatch');
  }
  const height = Number(tx.height);
  if (!Number.isSafeInteger(height))
    throw new Error('Invalid transaction height');
  return {
    transactionHash: transactionHash.toUpperCase(),
    height,
    code: tx.tx_result.code,
    verifiedAt: new Date().toISOString(),
  };
}
