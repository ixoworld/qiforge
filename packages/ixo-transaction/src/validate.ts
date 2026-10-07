import { z } from 'zod';

import {
  findMessageByTypeUrl,
  type FieldSpec,
  type MessageSpec,
  type RiskLevel,
} from './catalog.js';
import { resolveIntent, type IntentResult } from './intent.js';
import {
  ITrxMsgSchema,
  TransactionBatchSchema,
  TransactionDraftSchema,
  schemaForFieldKind,
  type ITrxMsg,
  type RiskConfirmation,
  type TransactionBatch,
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

/**
 * The risk gate: when the transaction is risky and the caller signs
 * (`requireRiskConfirmation`), every one of `risks` must be accepted word for
 * word and `confirmed` must be true.
 */
function assertRiskGate(
  subject: string,
  risky: boolean,
  risks: readonly string[],
  confirmation: RiskConfirmation | undefined,
  options: ValidationOptions,
): void {
  if (!risky || !options.requireRiskConfirmation) return;
  const accepted = new Set(confirmation?.acceptedRisks ?? []);
  const missing = risks.filter((risk) => !accepted.has(risk));
  if (confirmation?.confirmed === true && missing.length === 0) return;
  throw new Error(
    `Risk confirmation required before signing ${subject}: the user must accept, word for word, ${missing
      .map((risk) => JSON.stringify(risk))
      .join(', ')}`,
  );
}

function requireSpec(typeUrl: string): MessageSpec {
  const spec = findMessageByTypeUrl(typeUrl);
  if (!spec) {
    throw new Error(
      `Unsupported message typeUrl ${typeUrl}: not in the IXO transaction catalog`,
    );
  }
  return spec;
}

/**
 * Strictly validate one proto-JSON message against the catalog: a known
 * typeUrl and exactly its fields, each of its kind. The Portal handler runs
 * this on every message it is asked to sign.
 */
export function validateMessage(input: unknown): ITrxMsg {
  const message = ITrxMsgSchema.parse(input);
  const spec = requireSpec(message.typeUrl);
  return {
    typeUrl: spec.typeUrl,
    value: buildValueSchema(spec.fields).parse(message.value),
  };
}

const RISK_ORDER: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'];

/** The highest of the levels (`low` for none). */
function highestRiskLevel(levels: readonly RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>(
    (highest, level) =>
      RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(highest) ? level : highest,
    'low',
  );
}

/** One message of a validated batch, as its catalog entry names it. */
export type BatchMessageRoute = Pick<
  MessageSpec,
  'module' | 'action' | 'messageName' | 'typeUrl'
>;

export type ValidatedTransactionBatch = {
  /** Every message, validated and canonicalised, in the batch's order. */
  messages: ITrxMsg[];
  /** The catalog route of each message, in the same order. */
  routes: BatchMessageRoute[];
  summary: string;
  /** Every message's risks, each once, in message order. */
  risks: string[];
  /** The highest risk level of any message. */
  riskLevel: RiskLevel;
  /** True when any message is risky. */
  requiresConfirmation: boolean;
  network: TransactionBatch['network'];
  memo?: string;
};

/**
 * Strictly validate a batch — several catalogued messages signed together in
 * one wallet transaction. Every message passes the same check as a single
 * message (`validateMessage`); the risks are every message's risks and the
 * level is the highest of them. Mainnet needs `allowMainnet`; a batch carries
 * no testnet receipt (each caller owns its mainnet policy). With
 * `requireRiskConfirmation`, every risk must be accepted word for word.
 * Throws on the first failure.
 */
export function validateTransactionBatch(
  input: unknown,
  options: ValidationOptions = {},
): ValidatedTransactionBatch {
  const batch = TransactionBatchSchema.parse(input);
  if (batch.network === 'mainnet' && options.allowMainnet !== true) {
    throw new Error(
      'Mainnet transactions are disabled for this oracle: prepare the transaction on testnet instead',
    );
  }
  const specs = batch.messages.map((message) => requireSpec(message.typeUrl));
  const messages = batch.messages.map(validateMessage);
  const risks = [...new Set(specs.flatMap((spec) => spec.risks))];
  const requiresConfirmation = specs.some(isRisky);
  assertRiskGate(
    `the batch of ${messages.length} message${messages.length === 1 ? '' : 's'}`,
    requiresConfirmation,
    risks,
    batch.riskConfirmation,
    options,
  );
  return {
    messages,
    routes: specs.map(({ module, action, messageName, typeUrl }) => ({
      module,
      action,
      messageName,
      typeUrl,
    })),
    summary: batch.summary,
    risks,
    riskLevel: highestRiskLevel(specs.map((spec) => spec.riskLevel)),
    requiresConfirmation,
    network: batch.network,
    memo: batch.memo,
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
  assertRiskGate(
    spec.messageName,
    isRisky(spec),
    spec.risks,
    draft.riskConfirmation,
    options,
  );

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
