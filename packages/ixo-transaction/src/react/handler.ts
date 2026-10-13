import {
  signIxoTransactionWithWallet,
  type SignTransactionActionResult,
} from '../action.js';
import { toEncodeObject, type EncodeObject } from './proto.js';

/** The Portal's wallet entry point (`transactSignX` from `OraclesProvider`). */
export type EncodedTransactFn = (
  messages: readonly EncodeObject[],
  memo?: string,
) => Promise<unknown>;

export interface SignTransactionHandlerOptions {
  /**
   * The chain id of the Portal's wallet (e.g. `pandora-8`), read from the
   * Portal's own wallet configuration. A request for any other chain is
   * refused before the wallet is touched.
   */
  chainId: string;
  transactSignX: EncodedTransactFn;
}

/**
 * The `sign_transaction` action handler: validates the oracle's args and the
 * message against the catalog, refuses another chain than the wallet's,
 * decodes the proto-JSON message into a
 * wallet-ready `EncodeObject` with the SDK's generated `fromJSON` (bytes from
 * base64, `Long`, `Timestamp`), signs with the user's wallet and returns the
 * JSON-safe summary the socket carries back.
 */
export function createSignTransactionHandler(
  options: SignTransactionHandlerOptions,
): (args: unknown) => Promise<SignTransactionActionResult> {
  return (args) =>
    signIxoTransactionWithWallet(
      args,
      (messages, memo) =>
        options.transactSignX(messages.map(toEncodeObject), memo),
      { walletChainId: options.chainId },
    );
}
