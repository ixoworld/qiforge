import { z } from 'zod';
import { bech32 } from '@scure/base';
import { SignTransactionActionArgsSchema } from './action.js';
import { validateMessage } from './validate.js';

export const IxoAddressSchema = z
  .string()
  .max(90)
  .refine((address) => {
    try {
      const decoded = bech32.decodeToBytes(address);
      return (
        decoded.prefix === 'ixo' &&
        decoded.bytes.length === 20 &&
        bech32.encodeFromBytes('ixo', decoded.bytes) === address
      );
    } catch {
      return false;
    }
  }, 'Expected a lowercase IXO Bech32 account address with a valid checksum and 20-byte payload');

export const ActionProposalIdSchema = z
  .string()
  .regex(
    /^ap_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const ActionProposalDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const origin = z.strictObject({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  invocationId: z.string().min(1),
});
export const ActionProposalSubjectSchema = z
  .strictObject({
    v: z.literal(1),
    id: ActionProposalIdSchema,
    ownerDid: z.string().startsWith('did:'),
    title: z.string().trim().min(1).max(160),
    origin,
    action: z.strictObject({
      name: z.literal('sign_transaction'),
      schemaVersion: z.literal('1'),
      network: z.enum(['devnet', 'testnet', 'mainnet']),
      chainId: z.string().min(1),
      signerAddress: IxoAddressSchema,
      inputs: SignTransactionActionArgsSchema,
      targets: z.array(IxoAddressSchema).max(64),
    }),
    evidenceRefs: z.array(z.string().min(1)).min(1).max(64),
    createdAt: timestamp,
    expiresAt: timestamp,
  })
  .superRefine((p, ctx) => {
    if (p.action.inputs.messages.length !== 1)
      ctx.addIssue({
        code: 'custom',
        path: ['action', 'inputs', 'messages'],
        message: 'One action card signs one transfer',
      });
    for (const message of p.action.inputs.messages) {
      try {
        validateMessage(message);
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['action', 'inputs', 'messages'],
          message: 'Invalid catalog message',
        });
      }
      const signerField =
        message.typeUrl === '/cosmos.bank.v1beta1.MsgSend'
          ? 'fromAddress'
          : message.typeUrl === '/ixo.token.v1beta1.MsgTransferToken'
            ? 'owner'
            : undefined;
      const targetField =
        message.typeUrl === '/cosmos.bank.v1beta1.MsgSend'
          ? 'toAddress'
          : 'recipient';
      for (const field of [signerField, targetField]) {
        if (field && !IxoAddressSchema.safeParse(message.value[field]).success)
          ctx.addIssue({
            code: 'custom',
            path: ['action', 'inputs', 'messages'],
            message: `Invalid transfer account address in ${field}`,
          });
      }
      if (
        !signerField ||
        message.value[signerField] !== p.action.signerAddress ||
        p.action.targets.length !== 1 ||
        message.value[targetField] !== p.action.targets[0]
      )
        ctx.addIssue({
          code: 'custom',
          path: ['action'],
          message: 'Unsupported transfer or mismatched signer and target',
        });
    }
    if (
      p.action.inputs.intent.source === 'batch' ||
      p.action.inputs.intent.typeUrl !== p.action.inputs.messages[0]?.typeUrl
    )
      ctx.addIssue({
        code: 'custom',
        path: ['action', 'inputs', 'intent'],
        message: 'Intent must match the transfer',
      });
    // The signed transaction carries the card's own id in its memo, so a
    // transaction can only ever verify the one card it was signed for.
    if (p.action.inputs.memo !== p.id)
      ctx.addIssue({
        code: 'custom',
        path: ['action', 'inputs', 'memo'],
        message: 'The transaction memo must carry the proposal ID',
      });
    if (Date.parse(p.expiresAt) <= Date.parse(p.createdAt))
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Expiry must follow creation',
      });
    if (
      p.action.inputs.chainId !== p.action.chainId ||
      p.action.inputs.network !== p.action.network
    )
      ctx.addIssue({
        code: 'custom',
        path: ['action'],
        message: 'Execution network must match the proposal',
      });
  });
export const ActionProposalLifecycleSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('prepared') }),
  z.strictObject({ status: z.literal('claimed'), claimedAt: timestamp }),
  z.strictObject({
    status: z.literal('unknown'),
    claimedAt: timestamp,
    transactionHash: z
      .string()
      .regex(/^[A-Fa-f0-9]{64}$/)
      .optional(),
  }),
  z.strictObject({
    status: z.enum(['rejected', 'revoked', 'superseded']),
    endedAt: timestamp,
  }),
  z.strictObject({
    status: z.enum(['succeeded', 'failed']),
    claimedAt: timestamp,
    transactionHash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    height: z.number().int().positive(),
    code: z.number().int().nonnegative(),
    verifiedAt: timestamp,
  }),
]);
export const ActionProposalSchema = z
  .strictObject({
    ...ActionProposalSubjectSchema.shape,
    digest: ActionProposalDigestSchema,
    lifecycle: ActionProposalLifecycleSchema,
  })
  .superRefine((p, ctx) => {
    const subject = ActionProposalSubjectSchema.safeParse(
      actionProposalSubject(p),
    );
    if (!subject.success)
      for (const issue of subject.error.issues)
        ctx.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
  });
export type ActionProposal = z.infer<typeof ActionProposalSchema>;
export type ActionProposalSubject = z.infer<typeof ActionProposalSubjectSchema>;
export const ActionReferenceSchema = z
  .strictObject({
    proposalId: ActionProposalIdSchema,
    title: z.string().trim().min(1).max(160),
    url: z.url(),
    expiresAt: timestamp,
    digest: ActionProposalDigestSchema,
  })
  .superRefine((ref, ctx) => {
    const url = new URL(ref.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/a/${ref.proposalId}`
    )
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message:
          'Expected a trusted HTTPS action review URL with only its opaque proposal ID',
      });
  });
export type ActionReference = z.infer<typeof ActionReferenceSchema>;
export const ActionProposalClaimSchema = z.strictObject({
  digest: ActionProposalDigestSchema,
});
export const ActionProposalReconcileSchema = z.strictObject({
  transactionHash: z
    .string()
    .regex(/^[A-Fa-f0-9]{64}$/)
    .optional(),
});
export const parseActionProposal = (input: unknown): ActionProposal =>
  ActionProposalSchema.parse(input);
export function actionProposalSubject(
  proposal: ActionProposal,
): ActionProposalSubject {
  const { digest: _digest, lifecycle: _lifecycle, ...subject } = proposal;
  return subject;
}

export * from './final-subject.js';
import {
  digestFinalDecisionSubject,
  assertFinalDecisionSubjectUnchanged,
  type FinalDecisionSubject,
} from './final-subject.js';
function proposalDecisionSubject(
  proposal: ActionProposalSubject,
): FinalDecisionSubject {
  return { kind: 'action-proposal/v1', action: z.json().parse(proposal) };
}
export async function digestActionProposal(
  subject: ActionProposalSubject,
): Promise<string> {
  return (
    await digestFinalDecisionSubject(
      proposalDecisionSubject(ActionProposalSubjectSchema.parse(subject)),
    )
  ).subjectDigest;
}
export async function assertActionProposalUnchanged(
  input: unknown,
): Promise<ActionProposal> {
  const proposal = parseActionProposal(input);
  await assertFinalDecisionSubjectUnchanged(
    {
      algorithm: 'sha256',
      canonicalization: 'ixo-json-v1',
      subjectDigest: proposal.digest,
    },
    proposalDecisionSubject(actionProposalSubject(proposal)),
  );
  return proposal;
}

export const ActionOutcomeSchema = z.strictObject({
  proposalId: ActionProposalIdSchema,
  digest: ActionProposalDigestSchema,
  status: z.enum([
    'prepared',
    'claimed',
    'unknown',
    'succeeded',
    'failed',
    'rejected',
    'revoked',
    'superseded',
    'expired',
  ]),
  transactionHash: z
    .string()
    .regex(/^[A-Fa-f0-9]{64}$/)
    .optional(),
  height: z.number().int().positive().optional(),
  code: z.number().int().nonnegative().optional(),
});
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;
export function actionOutcome(
  proposal: ActionProposal,
  now = Date.now(),
): ActionOutcome {
  const l = proposal.lifecycle;
  const status =
    l.status === 'prepared' && Date.parse(proposal.expiresAt) <= now
      ? 'expired'
      : l.status;
  return {
    proposalId: proposal.id,
    digest: proposal.digest,
    status,
    ...('transactionHash' in l && l.transactionHash
      ? { transactionHash: l.transactionHash }
      : {}),
    ...('height' in l ? { height: l.height, code: l.code } : {}),
  };
}

export const ActionProposalRpcSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), proposal: ActionProposalSchema }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
