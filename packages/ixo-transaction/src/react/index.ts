import { useAgAction, useOraclesContext } from '@ixo/oracles-client-sdk';
import { useRef } from 'react';
import { z } from 'zod';

import {
  SIGN_TRANSACTION_ACTION_DESCRIPTION,
  SIGN_TRANSACTION_ACTION_NAME,
} from '../action.js';
import {
  createSignTransactionHandler,
  type SignTransactionHandlerOptions,
} from './handler.js';

export interface IxoTransactionSigningOptions {
  /**
   * The chain id of the Portal's wallet (e.g. `ixo-5`, `pandora-8`), read
   * from the Portal's own wallet/chain configuration — never a constant
   * copied from an example. `OraclesProvider`'s wallet props carry no chain
   * id, so the Portal has to supply it. A request for any other chain is
   * refused before it reaches the wallet.
   */
  chainId: string;
}

/**
 * Register the hidden `sign_transaction` wallet action in the Portal oracle UI.
 * Mount it inside `OraclesProvider`, next to the chat.
 *
 * `exposeToAgent: false` keeps the raw wallet action off the `agActions` the
 * client sends with each turn, so the agent never sees it as a tool: it can
 * only reach the wallet through the validated `sign_ixo_transaction` tool,
 * whose action call this handler answers over the socket.
 */
export function useIxoTransactionSigningAction(
  options: IxoTransactionSigningOptions,
): void {
  const { transactSignX } = useOraclesContext();
  // `useAgAction` registers its handler once per action name, so the handler
  // reads the chain and wallet of the latest render through a ref.
  const latest = useRef<SignTransactionHandlerOptions>({
    chainId: options.chainId,
    transactSignX,
  });
  latest.current = { chainId: options.chainId, transactSignX };

  useAgAction({
    name: SIGN_TRANSACTION_ACTION_NAME,
    description: SIGN_TRANSACTION_ACTION_DESCRIPTION,
    // Validated by the handler (`SignTransactionActionArgsSchema`), which
    // answers a malformed call with `{ success: false, error }`.
    parameters: z.unknown(),
    exposeToAgent: false,
    handler: (args) => createSignTransactionHandler(latest.current)(args),
  });
}

export { createSignTransactionHandler } from './handler.js';
export type {
  EncodedTransactFn,
  SignTransactionHandlerOptions,
} from './handler.js';
export {
  encodeAuthorization,
  resolveProtoCodec,
  toEncodeObject,
} from './proto.js';
export type { EncodeObject } from './proto.js';
