import { z } from 'zod';

import {
  findMessageByTypeUrl,
  type FieldSpec,
  type MessageSpec,
} from './catalog.js';
import { resolveIntent, type IntentResult } from './intent.js';
import {
  ITrxMsgSchema,
  TransactionDraftSchema,
  schemaForFieldKind,
  type ITrxMsg,
  type TransactionDraft,
} from './schemas.js';

export type ValidatedTransaction = {
  intent: IntentResult;
  message: ITrxMsg;
  risks: string[];
  riskLevel: MessageSpec['riskLevel'];
  requiresConfirmation: boolean;
  network: TransactionDraft['network'];
  memo?: string;
};

export type ValidationOptions = {
  /** Enforce the risk gate (signing). Validation alone only reports the risks. */
  requireRiskConfirmation?: boolean;
  /**
   * Whether mainnet drafts may pass at all. Off unless the caller (the
   * oracle operator's configuration) turns it on; when on, a mainnet draft
   * still needs a `testnetReceipt`, which the caller must verify against its
   * own record of the testnet signing — this package only checks its shape.
   */
  allowMainnet?: boolean;
};

/**
 * One readable line for a validation failure: each Zod issue as
 * `path: message`, or the error's own message.
 */
export function describeValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join('.')}: ${issue.message}`
          : issue.message,
      )
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

function buildValueSchema(
  fields: readonly FieldSpec[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    const schema = schemaForFieldKind(field.kind);
    shape[field.name] = field.required ? schema : schema.optional();
  }
  return z.object(shape).strict();
}

function assertTypeUrlConflict(
  draftTypeUrl: string | undefined,
  resolvedTypeUrl: string,
): void {
  if (draftTypeUrl && draftTypeUrl !== resolvedTypeUrl) {
    throw new Error(
      `typeUrl conflict: draft provided ${draftTypeUrl}, but intent resolves to ${resolvedTypeUrl}`,
    );
  }
}

function assertMainnetGate(
  draft: TransactionDraft,
  options: ValidationOptions,
): void {
  if (draft.network !== 'mainnet') return;
  if (options.allowMainnet !== true) {
    throw new Error(
      'Mainnet transactions are disabled for this oracle: prepare the transaction on testnet instead',
    );
  }
  if (draft.testnetReceipt) return;
  throw new Error(
    'Mainnet draft blocked: sign the same transaction on testnet first and pass the testnetReceipt that signing returned',
  );
}

function isRisky(spec: MessageSpec): boolean {
  return spec.riskLevel !== 'low' || spec.risks.length > 0;
}

function assertRiskGate(
  spec: MessageSpec,
  draft: TransactionDraft,
  options: ValidationOptions,
): void {
  if (!isRisky(spec) || !options.requireRiskConfirmation) return;
  const accepted = new Set(draft.riskConfirmation?.acceptedRisks ?? []);
  const missing = spec.risks.filter((risk) => !accepted.has(risk));
  if (draft.riskConfirmation?.confirmed === true && missing.length === 0)
    return;
  throw new Error(
    `Risk confirmation required before signing ${spec.messageName}: the user must accept, word for word, ${missing
      .map((risk) => JSON.stringify(risk))
      .join(', ')}`,
  );
}

/**
 * Strictly validate one proto-JSON message against the catalog: a known
 * typeUrl and exactly its fields, each of its kind. The Portal handler runs
 * this on every message it is asked to sign.
 */
export function validateMessage(input: unknown): ITrxMsg {
  const message = ITrxMsgSchema.parse(input);
  const spec = findMessageByTypeUrl(message.typeUrl);
  if (!spec) {
    throw new Error(
      `Unsupported message typeUrl ${message.typeUrl}: not in the IXO transaction catalog`,
    );
  }
  return {
    typeUrl: spec.typeUrl,
    value: buildValueSchema(spec.fields).parse(message.value),
  };
}

/**
 * Resolve, strictly validate, and canonicalize a transaction draft into the
 * proto-JSON `{ typeUrl, value }` the Portal wallet handler decodes. Always
 * enforces the mainnet gate; with `requireRiskConfirmation`, the risk gate
 * too. Throws on the first failure (`describeValidationError` renders it).
 */
export function validateTransactionDraft(
  input: unknown,
  options: ValidationOptions = {},
): ValidatedTransaction {
  const draft = TransactionDraftSchema.parse(input);
  const intent = resolveIntent(draft);
  const spec = findMessageByTypeUrl(intent.typeUrl);
  if (!spec) throw new Error(`Resolved unsupported typeUrl: ${intent.typeUrl}`);

  assertTypeUrlConflict(draft.typeUrl, intent.typeUrl);
  assertMainnetGate(draft, options);
  assertRiskGate(spec, draft, options);

  const value = buildValueSchema(spec.fields).parse(draft.value);
  const message = ITrxMsgSchema.parse({ typeUrl: spec.typeUrl, value });

  return {
    intent,
    message,
    risks: spec.risks,
    riskLevel: spec.riskLevel,
    requiresConfirmation: isRisky(spec),
    network: draft.network,
    memo: draft.memo,
  };
}
