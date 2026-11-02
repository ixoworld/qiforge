import {
  SignTransactionActionArgsSchema,
  validateTransactionDraft,
} from '@ixo/ixo-transaction';
import type { ActionProposalSubject } from '@ixo/ixo-transaction/action-proposals';
export const OWNER = 'did:ixo:ixo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdxlvf0';
export const SIGNER = OWNER.slice('did:ixo:'.length);
export const RECIPIENT = 'ixo1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuzefze';
export const NOW = Date.parse('2026-10-18T10:00:00.000Z');
export function proposalSubject(
  overrides: Partial<ActionProposalSubject> = {},
  amount = '1500000',
): ActionProposalSubject {
  const draft = validateTransactionDraft({
    command: '/ixo bank send',
    network: 'testnet',
    value: {
      fromAddress: SIGNER,
      toAddress: RECIPIENT,
      amount: [{ denom: 'uixo', amount }],
    },
  });
  const id = overrides.id ?? `ap_${crypto.randomUUID()}`;
  return {
    v: 1,
    id,
    ownerDid: OWNER,
    title: 'Send 1.5 IXO',
    origin: {
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'run-1:call-1',
    },
    action: {
      name: 'sign_transaction',
      schemaVersion: '1',
      network: 'testnet',
      chainId: 'pandora-8',
      signerAddress: SIGNER,
      inputs: SignTransactionActionArgsSchema.parse({
        action: 'sign_transaction',
        network: 'testnet',
        chainId: 'pandora-8',
        messages: [draft.message],
        memo: id,
        intent: draft.intent,
        risks: draft.risks,
        riskLevel: draft.riskLevel,
        requiresConfirmation: true,
      }),
      targets: [RECIPIENT],
    },
    evidenceRefs: [
      'session:session-1:request:request-1',
      'decision:companion.action-intent@1.0.0',
    ],
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 900000).toISOString(),
    ...overrides,
  };
}
