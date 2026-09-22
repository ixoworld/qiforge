import { z } from 'zod';

import {
  ITrxMsgSchema,
  NetworkSchema,
  RiskConfirmationSchema,
  TestnetReceiptSchema,
  TransactionDraftSchema,
  type ITrxMsg,
} from './schemas.js';
import { validateTransactionDraft } from './validate.js';

export const SIGN_TRANSACTION_ACTION_NAME = 'sign_transaction';

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

export const SignTransactionActionArgsSchema = z
  .object({
    action: z.literal(SIGN_TRANSACTION_ACTION_NAME),
    network: NetworkSchema,
    messages: z.array(ITrxMsgSchema).min(1),
    memo: z.string().optional(),
    intent: IntentActionMetadataSchema,
    risks: z.array(z.string()),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
    requiresConfirmation: z.boolean(),
    riskConfirmation: RiskConfirmationSchema.optional(),
    testnetReceipt: TestnetReceiptSchema.optional(),
    overrideMainnet: z.boolean().optional(),
    overrideReason: z.string().min(1).optional(),
  })
  .strict();

export type SignTransactionActionArgs = z.infer<
  typeof SignTransactionActionArgsSchema
>;

export const SignTransactionActionResultSchema = z
  .object({
    success: z.boolean(),
    transactionHash: z.string().min(1).optional(),
    code: z.number().int().optional(),
    height: z.union([z.string(), z.number().int()]).optional(),
    error: z.string().optional(),
    result: z.unknown().optional(),
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

export function buildSignTransactionActionArgs(
  input: unknown,
): SignTransactionActionArgs {
  const draft = TransactionDraftSchema.parse(input);
  const validated = validateTransactionDraft(draft, {
    requireRiskConfirmation: true,
  });

  return SignTransactionActionArgsSchema.parse({
    action: SIGN_TRANSACTION_ACTION_NAME,
    network: validated.network,
    messages: [validated.message],
    memo: draft.memo,
    intent: validated.intent,
    risks: validated.risks,
    riskLevel: validated.riskLevel,
    requiresConfirmation: validated.requiresConfirmation,
    riskConfirmation: draft.riskConfirmation,
    testnetReceipt: draft.testnetReceipt,
    overrideMainnet: draft.overrideMainnet,
    overrideReason: draft.overrideReason,
  });
}

export function normalizeWalletSignResult(
  result: unknown,
): SignTransactionActionResult {
  if (result === undefined || result === null) {
    return SignTransactionActionResultSchema.parse({
      success: false,
      error: 'Portal wallet did not return a transaction result',
    });
  }

  if (!isRecord(result)) {
    return SignTransactionActionResultSchema.parse({
      success: true,
      result,
    });
  }

  const transactionHash = readStringField(result, [
    'transactionHash',
    'txHash',
    'hash',
  ]);
  const code = readNumberField(result, ['code']);
  const height =
    readStringField(result, ['height']) ?? readNumberField(result, ['height']);
  const explicitSuccess =
    typeof result.success === 'boolean' ? result.success : undefined;
  const success = explicitSuccess ?? (code === undefined || code === 0);
  const error = success
    ? undefined
    : (readStringField(result, ['error', 'rawLog', 'log']) ??
      `Transaction failed with code ${code ?? 'unknown'}`);

  return SignTransactionActionResultSchema.parse({
    success,
    transactionHash,
    code,
    height,
    error,
    result,
  });
}

export async function signIxoTransactionWithWallet(
  input: unknown,
  transactSignX: WalletSignTransactionFn,
): Promise<SignTransactionActionResult> {
  try {
    const args = SignTransactionActionArgsSchema.parse(input);
    const result = await transactSignX(args.messages, args.memo);
    return normalizeWalletSignResult(result);
  } catch (error) {
    return SignTransactionActionResultSchema.parse({
      success: false,
      error: error instanceof Error ? error.message : 'Wallet signing failed',
    });
  }
}
