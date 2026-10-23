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

/**
 * How long a chain RPC's answer to `/status` is trusted per isolate: the
 * network an origin serves does not change between lookups, and `/status`
 * would otherwise be half of all verification traffic.
 */
export const CHAIN_NETWORK_CACHE_MS = 5 * 60_000;
const chainNetworks = new Map<string, { network: string; at: number }>();
/** Tests only: forget every cached `/status` answer. */
export function resetChainNetworkCache(): void {
  chainNetworks.clear();
}
/**
 * The network (chain id) an RPC origin serves, from `/status`, cached per
 * isolate for `CHAIN_NETWORK_CACHE_MS`. Only a parsed answer is cached; a
 * failed read is retried on the next lookup.
 */
export async function chainNetwork(
  origin: string,
  readStatus: () => Promise<unknown>,
  now = Date.now(),
): Promise<string> {
  const cached = chainNetworks.get(origin);
  if (cached && now - cached.at < CHAIN_NETWORK_CACHE_MS) return cached.network;
  const network = StatusResponse.parse(await readStatus()).result.node_info
    .network;
  chainNetworks.set(origin, { network, at: now });
  return network;
}

/**
 * The node does not hold the transaction (yet): not indexed, or not
 * broadcast. CometBFT answers `/tx` for an unknown hash with a JSON-RPC
 * error whose text says "not found" (HTTP 200 or 500 by version).
 */
export const TRANSACTION_NOT_FOUND = 'Transaction not found';
function isTransactionNotFound(text: string): boolean {
  try {
    const body = JSON.parse(text) as {
      error?: { message?: unknown; data?: unknown };
    };
    return (
      !!body.error &&
      /not found/i.test(`${body.error.message ?? ''} ${body.error.data ?? ''}`)
    );
  } catch {
    return false;
  }
}

export async function verifyActionTransaction(
  proposal: ActionProposal,
  transactionHash: string,
  rpcOrigin: string,
  fetcher: typeof fetch = fetch,
  /** The caller's wall budget (the alarm's); each read also stops at 10 s. */
  signal?: AbortSignal,
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
  const request = async (path: string, notFound = false) => {
    const response = await fetcher(
      new URL(path, `${origin.href.replace(/\/$/, '')}/`),
      {
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      },
    );
    if (notFound && response.status === 404)
      throw new Error(TRANSACTION_NOT_FOUND);
    if (!response.ok && !notFound)
      throw new Error('Chain verification unavailable');
    const text = new TextDecoder().decode(
      await boundedBytes(response, 1_500_000),
    );
    if (notFound && isTransactionNotFound(text))
      throw new Error(TRANSACTION_NOT_FOUND);
    if (!response.ok) throw new Error('Chain verification unavailable');
    return JSON.parse(text) as unknown;
  };
  const network = await chainNetwork(origin.href, () => request('status'));
  if (network !== proposal.action.chainId) throw new Error('Chain mismatch');
  const tx = TxResponse.parse(
    await request(
      `tx?hash=0x${transactionHash.toUpperCase()}&prove=false`,
      true,
    ),
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
