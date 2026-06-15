import { validateTransactionDraft } from './validate.js';
import {
  SignxTransactionPayloadSchema,
  type SignxTransactionPayload,
} from './schemas.js';

export function renderSigningPayload(input: unknown): SignxTransactionPayload {
  const draft = input as { memo?: unknown };
  const validated = validateTransactionDraft(input, {
    requireRiskConfirmation: true,
  });
  return SignxTransactionPayloadSchema.parse({
    type: 'signxTransaction',
    messages: [validated.message],
    memo: typeof draft.memo === 'string' ? draft.memo : undefined,
  });
}
