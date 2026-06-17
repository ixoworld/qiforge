import { useAgAction, useOraclesContext } from '@ixo/oracles-client-sdk';

import {
  SIGN_TRANSACTION_ACTION_DESCRIPTION,
  SIGN_TRANSACTION_ACTION_NAME,
  SignTransactionActionArgsSchema,
  signIxoTransactionWithWallet,
} from '../action.js';

const hiddenSignTransactionParameters =
  SignTransactionActionArgsSchema as unknown as Parameters<
    typeof useAgAction
  >[0]['parameters'];

export function useIxoTransactionSigningAction(): void {
  const { transactSignX } = useOraclesContext();

  useAgAction({
    name: SIGN_TRANSACTION_ACTION_NAME,
    description: SIGN_TRANSACTION_ACTION_DESCRIPTION,
    parameters: hiddenSignTransactionParameters,
    exposeToAgent: false,
    handler: async (args) => {
      return await signIxoTransactionWithWallet(args, transactSignX);
    },
  });
}

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
