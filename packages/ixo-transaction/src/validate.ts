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
  portalRegistry: boolean;
  network: TransactionDraft['network'];
};

export type ValidationOptions = {
  requireRiskConfirmation?: boolean;
};

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

function assertMainnetGate(draft: TransactionDraft): void {
  if (draft.network !== 'mainnet') return;
  if (draft.testnetReceipt || draft.overrideMainnet === true) return;
  throw new Error(
    'Mainnet draft blocked: provide a successful Pandora testnet receipt or set overrideMainnet with overrideReason',
  );
}

function assertRiskGate(
  spec: MessageSpec,
  draft: TransactionDraft,
  options: ValidationOptions,
): void {
  const risky = spec.riskLevel !== 'low' || spec.risks.length > 0;
  if (!risky || !options.requireRiskConfirmation) return;
  if (draft.riskConfirmation?.confirmed === true) return;
  throw new Error(
    `Risk confirmation required before signing ${spec.messageName}`,
  );
}

export function validateTransactionDraft(
  input: unknown,
  options: ValidationOptions = {},
): ValidatedTransaction {
  const draft = TransactionDraftSchema.parse(input);
  const intent = resolveIntent(draft);
  const spec = findMessageByTypeUrl(intent.typeUrl);
  if (!spec) throw new Error(`Resolved unsupported typeUrl: ${intent.typeUrl}`);

  assertTypeUrlConflict(draft.typeUrl, intent.typeUrl);
  assertMainnetGate(draft);
  assertRiskGate(spec, draft, options);

  const value = buildValueSchema(spec.fields).parse(draft.value);
  const message = ITrxMsgSchema.parse({ typeUrl: spec.typeUrl, value });

  return {
    intent,
    message,
    risks: spec.risks,
    riskLevel: spec.riskLevel,
    requiresConfirmation: spec.riskLevel !== 'low' || spec.risks.length > 0,
    portalRegistry: spec.portalRegistry,
    network: draft.network,
  };
}
