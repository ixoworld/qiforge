import { useAgAction, useOraclesContext } from '@ixo/oracles-client-sdk';
// `@ixo/oracles-client-sdk` builds on Zod 3, while this package validates with
// Zod 4. `useAgAction` types `parameters` against its own Zod 3, so the FE
// action schema is declared with the matching Zod 3 (`zod3`). It is only
// decorative here: the action is hidden (`exposeToAgent: false`) and the handler
// re-validates with the real Zod 4 `SignTransactionActionArgsSchema`.
import { z as zod3 } from 'zod3';

import {
  SIGN_TRANSACTION_ACTION_DESCRIPTION,
  SIGN_TRANSACTION_ACTION_NAME,
  signIxoTransactionWithWallet,
  type WalletSignTransactionFn,
} from '../action.js';
import { toEncodeObject } from './proto.js';

/**
 * Register the hidden `sign_transaction` wallet action in the Portal oracle UI.
 *
 * `exposeToAgent: false` keeps the raw wallet action OFF the agent's tool list —
 * the agent can only reach the wallet through the validated `sign_ixo_transaction`
 * Qiforge tool, never by calling `sign_transaction` directly. The handler decodes
 * each proto-JSON message into a wallet-ready EncodeObject (via the SDK's
 * `fromJSON`) right before signing with `transactSignX`.
 */
export function useIxoTransactionSigningAction(): void {
  const { transactSignX } = useOraclesContext();

  useAgAction({
    name: SIGN_TRANSACTION_ACTION_NAME,
    description: SIGN_TRANSACTION_ACTION_DESCRIPTION,
    parameters: zod3.unknown(),
    exposeToAgent: false,
    handler: async (args) => {
      const signWithEncoding: WalletSignTransactionFn = (messages, memo) =>
        transactSignX(messages.map(toEncodeObject), memo);
      return signIxoTransactionWithWallet(args, signWithEncoding);
    },
  });
}

export { resolveProtoCodec, toEncodeObject } from './proto.js';
export {
  SIGN_TRANSACTION_ACTION_DESCRIPTION,
  SIGN_TRANSACTION_ACTION_NAME,
  SignTransactionActionArgsSchema,
  SignTransactionActionResultSchema,
  signIxoTransactionWithWallet,
} from '../action.js';
export type {
  SignTransactionActionArgs,
  SignTransactionActionResult,
  WalletSignTransactionFn,
} from '../action.js';
