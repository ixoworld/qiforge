import { z } from 'zod';

import {
  ITrxMsgSchema,
  MAX_BATCH_MESSAGES,
  MAX_BATCH_SUMMARY_LENGTH,
  NetworkSchema,
  RiskConfirmationSchema,
  TestnetReceiptSchema,
  TransactionBatchSchema,
  TransactionDraftSchema,
  type ITrxMsg,
  type Network,
} from './schemas.js';
import {
  describeValidationError,
  validateMessage,
  validateTransactionBatch,
  validateTransactionDraft,
  type ValidationOptions,
} from './validate.js';

export const SIGN_TRANSACTION_ACTION_NAME = 'sign_transaction';

/**
 * The chain id of each IXO network, as each network's RPC `/status` reports
 * it (`node_info.network`, checked 2026-10-05). The oracle puts the target
 * chain id in every signing request and the Portal refuses one that is not
 * its wallet's chain; the network label alone proves nothing.
 */
export const DEFAULT_CHAIN_IDS: Readonly<Record<Network, string>> = {
  devnet: 'devnet-1',
  testnet: 'pandora-8',
  mainnet: 'ixo-5',
};

export const ChainIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,48}$/, 'Expected a Cosmos chain id');

export const SIGN_TRANSACTION_ACTION_DESCRIPTION =
  'Sign a validated IXO transaction in the user Portal wallet.';

export const IntentActionMetadataSchema = z
  .object({
    source: z.enum([
      'slash-command',
      'natural-language',
      'type-url',
      'explicit-route',
    ]),
    module: z.string().min(1),
    action: z.string().min(1),
    messageName: z.string().min(1),
    typeUrl: z.string().regex(/^\/[A-Za-z0-9.]+\.Msg[A-Za-z0-9]+$/),
    confidence: z.number().min(0).max(1),
    ambiguities: z.array(z.string()),
  })
  .strict();

export type IntentActionMetadata = z.infer<typeof IntentActionMetadataSchema>;

const MsgTypeUrlSchema = IntentActionMetadataSchema.shape.typeUrl;

/**
 * The intent of a batch request: what the batch does as a whole, and the
 * catalog route of each of its messages, in order.
 */
export const BatchIntentSchema = z
  .object({
    source: z.literal('batch'),
    summary: z.string().trim().min(1).max(MAX_BATCH_SUMMARY_LENGTH),
    messages: z
      .array(
        z
          .object({
            module: z.string().min(1),
            action: z.string().min(1),
            messageName: z.string().min(1),
            typeUrl: MsgTypeUrlSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BATCH_MESSAGES),
  })
  .strict();

export type BatchIntent = z.infer<typeof BatchIntentSchema>;

/**
 * The `sign_transaction` action args. Two forms, told apart by
 * `intent.source`:
 *
 * - a single message (a conversational draft): exactly one message, whose
 *   route `intent` describes; mainnet needs a `testnetReceipt`;
 * - a batch (`intent.source: 'batch'`): 1 to `MAX_BATCH_MESSAGES` catalogued
 *   messages signed together in one wallet transaction; `intent.messages`
 *   names each message's route in order; no `testnetReceipt`.
 *
 * Either way the Portal validates every message against the catalog and the
 * risks and level cover every message.
 */
export const SignTransactionActionArgsSchema = z
  .object({
    action: z.literal(SIGN_TRANSACTION_ACTION_NAME),
    network: NetworkSchema,
    /** The chain the transaction is for; the Portal refuses any other. */
    chainId: ChainIdSchema,
    messages: z.array(ITrxMsgSchema).min(1).max(MAX_BATCH_MESSAGES),
    memo: z.string().optional(),
    intent: z.discriminatedUnion('source', [
      IntentActionMetadataSchema,
      BatchIntentSchema,
    ]),
    risks: z.array(z.string()),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
    requiresConfirmation: z.boolean(),
    riskConfirmation: RiskConfirmationSchema.optional(),
    testnetReceipt: TestnetReceiptSchema.optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.intent.source !== 'batch') {
      // A conversational draft: the oracle validates and the user reviews
      // exactly one message at a time.
      if (args.messages.length !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['messages'],
          message:
            "A single-message request carries exactly one message; several are sent as a batch (intent.source 'batch')",
        });
      }
      return;
    }
    const named = args.intent.messages.map((route) => route.typeUrl);
    const sent = args.messages.map((message) => message.typeUrl);
    if (
      named.length !== sent.length ||
      named.some((typeUrl, index) => typeUrl !== sent[index])
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['intent', 'messages'],
        message: 'The batch intent must name every message, in order',
      });
    }
    if (args.testnetReceipt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['testnetReceipt'],
        message: 'A batch carries no testnet receipt',
      });
    }
  });

export type SignTransactionActionArgs = z.infer<
  typeof SignTransactionActionArgsSchema
>;

/** The single-message form, as `buildSignTransactionActionArgs` returns it. */
export type SingleSignTransactionActionArgs = SignTransactionActionArgs & {
  intent: IntentActionMetadata;
};

/** The batch form, as `buildBatchSignTransactionActionArgs` returns it. */
export type BatchSignTransactionActionArgs = SignTransactionActionArgs & {
  intent: BatchIntent;
};

export const SignTransactionActionResultSchema = z
  .object({
    success: z.boolean(),
    transactionHash: z.string().min(1).optional(),
    code: z.number().int().optional(),
    height: z.union([z.string(), z.number().int()]).optional(),
    error: z.string().optional(),
    /**
     * Set when the transaction was included in a block but failed (non-zero
     * code). The call itself succeeded — `success` is true — so the hash and
     * code reach the oracle; `error` carries the chain's log.
     */
    delivered: z
      .object({
        code: z.number().int(),
        transactionHash: z.string().min(1).optional(),
        height: z.union([z.string(), z.number().int()]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SignTransactionActionResult = z.infer<
  typeof SignTransactionActionResultSchema
>;

export type WalletSignTransactionFn = (
  messages: readonly ITrxMsg[],
  memo?: string,
) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(
  value: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function readNumberField(
  value: Record<string, unknown>,
  fields: readonly string[],
): number | undefined {
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate === 'number' && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Validate a draft for signing (risk gate on, mainnet gate as configured) and
 * render the `sign_transaction` action args the Portal handler receives.
 */
export type BuildSignTransactionOptions = Pick<
  ValidationOptions,
  'allowMainnet'
> & {
  /** Chain id per network; `DEFAULT_CHAIN_IDS` when omitted. */
  chainIds?: Readonly<Record<Network, string>>;
};

export function buildSignTransactionActionArgs(
  input: unknown,
  options: BuildSignTransactionOptions = {},
): SingleSignTransactionActionArgs {
  const draft = TransactionDraftSchema.parse(input);
  const validated = validateTransactionDraft(draft, {
    requireRiskConfirmation: true,
    allowMainnet: options.allowMainnet,
  });

  const args = SignTransactionActionArgsSchema.parse({
    action: SIGN_TRANSACTION_ACTION_NAME,
    network: validated.network,
    chainId: (options.chainIds ?? DEFAULT_CHAIN_IDS)[validated.network],
    messages: [validated.message],
    memo: validated.memo,
    intent: validated.intent,
    risks: validated.risks,
    riskLevel: validated.riskLevel,
    requiresConfirmation: validated.requiresConfirmation,
    riskConfirmation: draft.riskConfirmation,
    testnetReceipt: draft.testnetReceipt,
  });
  const { intent } = args;
  if (intent.source === 'batch') {
    throw new Error('A conversational draft never builds a batch');
  }
  return { ...args, intent };
}

/**
 * Validate a batch for signing (`validateTransactionBatch` with the risk gate
 * on and the mainnet gate as configured) and render the batch form of the
 * `sign_transaction` action args: every message in one wallet transaction.
 */
export function buildBatchSignTransactionActionArgs(
  input: unknown,
  options: BuildSignTransactionOptions = {},
): BatchSignTransactionActionArgs {
  const batch = TransactionBatchSchema.parse(input);
  const validated = validateTransactionBatch(batch, {
    requireRiskConfirmation: true,
    allowMainnet: options.allowMainnet,
  });

  const args = SignTransactionActionArgsSchema.parse({
    action: SIGN_TRANSACTION_ACTION_NAME,
    network: validated.network,
    chainId: (options.chainIds ?? DEFAULT_CHAIN_IDS)[validated.network],
    messages: validated.messages,
    memo: validated.memo,
    intent: {
      source: 'batch',
      summary: validated.summary,
      messages: validated.routes,
    },
    risks: validated.risks,
    riskLevel: validated.riskLevel,
    requiresConfirmation: validated.requiresConfirmation,
    riskConfirmation: batch.riskConfirmation,
  });
  const { intent } = args;
  if (intent.source !== 'batch') {
    throw new Error('A batch always builds the batch form');
  }
  return { ...args, intent };
}

/**
 * Reduce whatever the wallet returned to the JSON-safe summary that travels
 * back over the socket. The wallet's own response object is never forwarded:
 * a cosmjs `DeliverTxResponse` carries `bigint` gas fields, which socket.io's
 * JSON encoder cannot serialise — the emit would fail and a signed
 * transaction would reach the oracle as an error.
 */
export function normalizeWalletSignResult(
  result: unknown,
): SignTransactionActionResult {
  if (result === undefined || result === null) {
    return {
      success: false,
      error: 'Portal wallet did not return a transaction result',
    };
  }

  if (!isRecord(result)) return { success: true };

  const transactionHash = readStringField(result, [
    'transactionHash',
    'txHash',
    'hash',
  ]);
  const code = readNumberField(result, ['code']);
  const height =
    readStringField(result, ['height']) ?? readNumberField(result, ['height']);
  const log = readStringField(result, ['error', 'rawLog', 'log']);

  // A non-zero code is a delivery result: the transaction is on chain and
  // failed. The call succeeded, so its hash and code are not lost.
  if (code !== undefined && code !== 0) {
    return SignTransactionActionResultSchema.parse({
      success: true,
      delivered: { code, transactionHash, height },
      error: log ?? `Transaction failed with code ${code}`,
    });
  }
  if (result.success === false) {
    return {
      success: false,
      error: log ?? 'The wallet reported a failure',
    };
  }
  return SignTransactionActionResultSchema.parse({
    success: true,
    transactionHash,
    code,
    height,
  });
}

export interface WalletSigningOptions {
  /** The chain id of the Portal's wallet, read from its own wallet config. */
  walletChainId: string;
}

/**
 * The Portal side of `sign_transaction`: re-validate the action args and
 * every message against the catalog (known typeUrl, exactly its fields, each
 * of its kind), refuse a transaction for another chain than the wallet's,
 * hand the messages to the wallet in one transaction — one message, or every
 * message of a batch — and summarise its answer. Never throws — a failure is
 * `{ success: false, error }`, which the oracle receives as a failed action.
 */
export async function signIxoTransactionWithWallet(
  input: unknown,
  transactSignX: WalletSignTransactionFn,
  options: WalletSigningOptions,
): Promise<SignTransactionActionResult> {
  try {
    const args = SignTransactionActionArgsSchema.parse(input);
    if (args.chainId !== options.walletChainId) {
      return {
        success: false,
        error: `Chain mismatch: the transaction is for ${args.chainId} (${args.network}) but this Portal wallet is on ${options.walletChainId}; nothing was signed`,
      };
    }
    const messages = args.messages.map(validateMessage);
    const result = await transactSignX(messages, args.memo);
    return normalizeWalletSignResult(result);
  } catch (error) {
    return {
      success: false,
      error: describeValidationError(error),
    };
  }
}
