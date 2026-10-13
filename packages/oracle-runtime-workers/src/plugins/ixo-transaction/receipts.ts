/**
 * Testnet receipts: the oracle's own record that a user signed a transaction
 * on testnet, which a mainnet draft of the same message must cite.
 *
 * Kept in the user's blob store (`ctx.blobStore`, Durable Object storage of
 * the user's object, scoped to the user's DID). The store hands out its own
 * random ids and keeps an entry at most 24 hours, so a receipt is cited by
 * that id plus the transaction hash, and expires a day after the testnet
 * signing. The model can only cite an id it was given: it cannot make one up,
 * read another user's, or pass off another plugin's blob (the name is
 * checked). Any store failure refuses the mainnet draft.
 */
import type { ITrxMsg, TestnetReceipt } from '@ixo/ixo-transaction';
import { z } from 'zod';
import { operationKey } from '../../core/middlewares/tool-execution';
import type { RuntimeContext } from '../../plugin-api/types';

export const RECEIPT_NAME_PREFIX = 'ixo-transaction/receipt:';
/** The blob store's maximum lifetime. */
export const RECEIPT_TTL_SECONDS = 24 * 60 * 60;

const ReceiptRecordSchema = z
  .object({
    transactionHash: z.string(),
    digest: z.string(),
    chainId: z.string(),
  })
  .strict();

type ReceiptStoreContext = Pick<RuntimeContext, 'blobStore' | 'user'>;

/** SHA-256 of the message's canonical form (typeUrl + canonical value). */
export function messageDigest(message: ITrxMsg): Promise<string> {
  return operationKey(message.typeUrl, message.value);
}

/** Record a signed testnet transaction; returns the receipt to cite. */
export async function recordTestnetReceipt(
  ctx: ReceiptStoreContext,
  signed: { transactionHash: string; message: ITrxMsg; chainId: string },
): Promise<TestnetReceipt> {
  const receiptId = await ctx.blobStore.put({
    userDid: ctx.user.did,
    name: `${RECEIPT_NAME_PREFIX}${signed.transactionHash}`,
    value: JSON.stringify({
      transactionHash: signed.transactionHash,
      digest: await messageDigest(signed.message),
      chainId: signed.chainId,
    }),
    ttlSeconds: RECEIPT_TTL_SECONDS,
  });
  return { transactionHash: signed.transactionHash, receiptId };
}

/**
 * Why `receipt` does not prove a testnet signing of `message` by this user
 * on `testnetChainId`, or null when it does.
 */
export async function testnetReceiptProblem(
  ctx: ReceiptStoreContext,
  receipt: TestnetReceipt,
  message: ITrxMsg,
  testnetChainId: string,
): Promise<string | null> {
  const unknown = `Testnet receipt ${receipt.receiptId} is not one this oracle recorded for this user (or it is older than 24 hours): sign the same transaction on testnet and use the testnetReceipt that returns`;
  if (!ctx.blobStore.isValidBlobId(receipt.receiptId)) return unknown;
  let entry: { name: string; value: string } | null;
  try {
    entry = await ctx.blobStore.get({
      userDid: ctx.user.did,
      blobId: receipt.receiptId,
    });
  } catch (error) {
    return `Testnet receipts cannot be checked right now (${error instanceof Error ? error.message : String(error)}), so the mainnet transaction was refused`;
  }
  if (!entry) return unknown;

  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.value);
  } catch {
    return unknown;
  }
  const record = ReceiptRecordSchema.safeParse(parsed);
  if (!record.success) return unknown;
  if (
    entry.name !== `${RECEIPT_NAME_PREFIX}${receipt.transactionHash}` ||
    record.data.transactionHash !== receipt.transactionHash
  ) {
    return `Testnet receipt ${receipt.receiptId} is not for transaction ${receipt.transactionHash}`;
  }
  if (record.data.chainId !== testnetChainId) {
    return `Testnet receipt ${receipt.receiptId} was signed on ${record.data.chainId}, not on the testnet chain ${testnetChainId}`;
  }
  if (record.data.digest !== (await messageDigest(message))) {
    return `Testnet receipt ${receipt.receiptId} is for a different transaction: the mainnet draft must be the same message that was signed on testnet`;
  }
  return null;
}
