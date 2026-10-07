/**
 * The ixo-transaction tools. Three read tools resolve and validate a draft;
 * `sign_ixo_transaction` dispatches the validated transaction to the user's
 * Portal wallet as the hidden `sign_transaction` AG-UI action over the
 * realtime channel (`ctx.frontend.callAgAction`) and maps the answer to a
 * status. The oracle never signs, broadcasts or holds a key: the wallet does,
 * in the user's browser.
 *
 * Every request names its chain id; the Portal refuses any other chain. A
 * signed testnet transaction is recorded as a receipt (`receipts.ts`), and a
 * mainnet draft is dispatched only when it cites the receipt of the same
 * message.
 */
import {
  DEFERRED_MODULES,
  MESSAGE_CATALOG,
  QUERY_ONLY_MODULES,
  SIGN_TRANSACTION_ACTION_NAME,
  TransactionDraftInputSchema,
  TransactionDraftSchema,
  buildSignTransactionActionArgs,
  classifyIntent,
  describeValidationError,
  validateTransactionDraft,
  type Network,
  type SingleSignTransactionActionArgs,
  type ITrxMsg,
  type TestnetReceipt,
} from '@ixo/ixo-transaction';
import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';
import { logActionToMatrix } from '../portal/action-log';
import { recordTestnetReceipt, testnetReceiptProblem } from './receipts';
import {
  requestWalletSignature,
  walletUnavailableReason,
  type WalletSignatureOutcome,
} from './wallet-signing';

export interface IxoTransactionToolOptions {
  /** How long the wallet has to answer a signing request. */
  signTimeoutMs: number;
  /** Whether mainnet drafts may pass validation at all. */
  allowMainnet: boolean;
  /** The chain id each network's requests are for. */
  chainIds: Readonly<Record<Network, string>>;
}

/** What `sign_ixo_transaction` returns to the model. */
export type SignIxoTransactionResult =
  | {
      status: 'signed';
      network: Network;
      chainId: string;
      typeUrl: string;
      transactionHash?: string;
      code?: number;
      height?: string | number;
      /** Testnet only: cite it in the mainnet draft of the same message. */
      testnetReceipt?: TestnetReceipt & { expiresInHours: number };
      /** Testnet only: why no receipt could be recorded. */
      receiptError?: string;
    }
  | {
      /** Included in a block but failed: the hash and code are real. */
      status: 'failed';
      network: Network;
      chainId: string;
      typeUrl: string;
      code: number;
      transactionHash?: string;
      height?: string | number;
      error: string;
    }
  | {
      status: 'rejected' | 'error';
      network: Network;
      typeUrl: string;
      error: string;
    }
  | {
      status: 'timeout';
      /** The wallet may still sign after the oracle stopped waiting. */
      outcome: 'unknown';
      network: Network;
      typeUrl: string;
      error: string;
    }
  | { status: 'validation_error' | 'unavailable'; error: string };

const RouteListToolSchema = z.object({
  messageType: z
    .string()
    .optional()
    .describe(
      'Module to list (entity, iid, claims, token, smart-account); all when omitted',
    ),
});

const IntentInputToolSchema = z.object({
  input: z
    .string()
    .min(1)
    .describe('A slash command, Msg name, typeUrl, or the user request'),
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listRoutes(messageType: string | undefined) {
  const module = messageType?.trim().toLowerCase();
  return {
    slashCommandFormat: '/ixo {message-type} {message-action}',
    queryOnlyModules: QUERY_ONLY_MODULES,
    deferredModules: DEFERRED_MODULES,
    routes: MESSAGE_CATALOG.filter(
      (entry) => !module || entry.module === module,
    ).map((entry) => ({
      command: `/ixo ${entry.module} ${entry.action}`,
      messageName: entry.messageName,
      typeUrl: entry.typeUrl,
      fields: entry.fields,
      riskLevel: entry.riskLevel,
      risks: entry.risks,
    })),
  };
}

/** The tool's status for a signing outcome: which network, chain and message. */
function signResult(
  args: SingleSignTransactionActionArgs,
  outcome: WalletSignatureOutcome,
): SignIxoTransactionResult {
  const network = args.network;
  const typeUrl = args.intent.typeUrl;
  switch (outcome.status) {
    case 'signed':
    case 'failed':
      return { ...outcome, network, chainId: args.chainId, typeUrl };
    case 'rejected':
    case 'error':
    case 'timeout':
      return { ...outcome, network, typeUrl };
    case 'unavailable':
      return outcome;
  }
}

/**
 * For a mainnet draft: why its `testnetReceipt` does not prove a testnet
 * signing of the same message by this user, or null. Null for other networks.
 */
async function mainnetReceiptProblem(
  ctx: RuntimeContext,
  options: IxoTransactionToolOptions,
  network: Network,
  receipt: TestnetReceipt | undefined,
  message: ITrxMsg | undefined,
): Promise<string | null> {
  if (network !== 'mainnet') return null;
  if (!receipt || !message) {
    return 'Mainnet draft blocked: sign the same transaction on testnet first and pass the testnetReceipt that signing returned';
  }
  return testnetReceiptProblem(ctx, receipt, message, options.chainIds.testnet);
}

/** The draft's `testnetReceipt`, when it has a well-formed one. */
function testnetReceiptOf(input: unknown): TestnetReceipt | undefined {
  const parsed = TransactionDraftSchema.safeParse(input);
  return parsed.success ? parsed.data.testnetReceipt : undefined;
}

/** A signed testnet transaction gets a receipt the mainnet draft can cite. */
async function withTestnetReceipt(
  ctx: RuntimeContext,
  args: SingleSignTransactionActionArgs,
  result: SignIxoTransactionResult,
): Promise<SignIxoTransactionResult> {
  const message = args.messages[0];
  if (
    result.status !== 'signed' ||
    args.network !== 'testnet' ||
    result.transactionHash === undefined ||
    !message
  ) {
    return result;
  }
  try {
    const receipt = await recordTestnetReceipt(ctx, {
      transactionHash: result.transactionHash,
      message,
      chainId: args.chainId,
    });
    return { ...result, testnetReceipt: { ...receipt, expiresInHours: 24 } };
  } catch (error) {
    return {
      ...result,
      receiptError: `The testnet signing could not be recorded (${errorText(error)}); a mainnet run of this transaction will be refused until a testnet signing is recorded.`,
    };
  }
}

async function signIxoTransaction(
  input: unknown,
  ctx: RuntimeContext,
  options: IxoTransactionToolOptions,
): Promise<SignIxoTransactionResult> {
  let args: SingleSignTransactionActionArgs;
  try {
    args = buildSignTransactionActionArgs(input, {
      allowMainnet: options.allowMainnet,
      chainIds: options.chainIds,
    });
  } catch (error) {
    return {
      status: 'validation_error',
      error: describeValidationError(error),
    };
  }
  const receiptProblem = await mainnetReceiptProblem(
    ctx,
    options,
    args.network,
    args.testnetReceipt,
    args.messages[0],
  );
  if (receiptProblem !== null) {
    return { status: 'validation_error', error: receiptProblem };
  }
  // Nothing to log in the room when the request cannot be sent at all.
  const unavailable = walletUnavailableReason(ctx);
  if (unavailable !== null) {
    return { status: 'unavailable', error: unavailable };
  }

  const outcome = await requestWalletSignature(ctx, {
    args,
    callIdPrefix: 'ixo_tx',
    timeoutMs: options.signTimeoutMs,
  });
  const result = await withTestnetReceipt(ctx, args, signResult(args, outcome));
  logActionToMatrix(ctx, {
    name: SIGN_TRANSACTION_ACTION_NAME,
    args,
    result,
    success: result.status === 'signed',
    ...('error' in result ? { error: result.error } : {}),
  });
  return result;
}

export function createIxoTransactionTools(
  options: IxoTransactionToolOptions,
): PluginTool[] {
  return [
    tool(
      async (input) => {
        const { messageType } = RouteListToolSchema.parse(input);
        return listRoutes(messageType);
      },
      {
        name: 'list_ixo_transaction_routes',
        description:
          'List the supported IXO transaction routes with their fields, risk level and risks. Read-only.',
        schema: RouteListToolSchema,
        effect: 'read',
      },
    ),
    tool(
      async (input) => {
        const { input: text } = IntentInputToolSchema.parse(input);
        try {
          return { status: 'resolved', intent: classifyIntent(text) };
        } catch (error) {
          return { status: 'unresolved', error: errorText(error) };
        }
      },
      {
        name: 'classify_ixo_transaction_intent',
        description:
          'Resolve an IXO transaction route from a slash command, Msg name, typeUrl, or a natural-language request. Read-only.',
        schema: IntentInputToolSchema,
        effect: 'read',
      },
    ),
    tool(
      async (input, ctx) => {
        let validated: ReturnType<typeof validateTransactionDraft>;
        try {
          validated = validateTransactionDraft(input, {
            allowMainnet: options.allowMainnet,
          });
        } catch (error) {
          return { status: 'invalid', error: describeValidationError(error) };
        }
        const receiptProblem = await mainnetReceiptProblem(
          ctx,
          options,
          validated.network,
          testnetReceiptOf(input),
          validated.message,
        );
        if (receiptProblem !== null) {
          return { status: 'invalid', error: receiptProblem };
        }
        return {
          status: 'valid',
          ...validated,
          chainId: options.chainIds[validated.network],
        };
      },
      {
        name: 'validate_ixo_transaction_draft',
        description:
          'Strictly validate an IXO transaction draft WITHOUT signing: returns the canonical message, its risks and whether the user must confirm them, or what is wrong. Read-only.',
        schema: TransactionDraftInputSchema,
        effect: 'read',
      },
    ),
    tool((input, ctx) => signIxoTransaction(input, ctx, options), {
      name: 'sign_ixo_transaction',
      description:
        "Send a validated IXO transaction to the user's Portal wallet for them to sign, and return the outcome: signed (with the tx hash; on testnet also a testnetReceipt), failed (on chain, with hash and code), rejected, timeout (outcome unknown), error, validation_error or unavailable. Only after the user accepted every listed risk; quote each one exactly in riskConfirmation.acceptedRisks. Network defaults to testnet. Mainnet (when the oracle allows it) needs the testnetReceipt of the same transaction signed on testnet. The oracle never signs or broadcasts; the user does, in their wallet.",
      schema: TransactionDraftInputSchema,
    }),
  ];
}
