import { z } from 'zod';
import {
  ActionProposalIdSchema,
  ActionProposalDigestSchema,
  ActionProposalSchema,
  ActionOutcomeSchema,
  IxoAddressSchema,
} from './action-proposals.js';
import { TopicCreatePlanSchema } from './topic-create-plan.js';
import { digestFinalDecisionSubject } from './final-subject.js';

const instant = z.iso.datetime();
const eventId = z.string().min(2).max(512).startsWith('$');
const roomId = z.string().min(3).max(512).startsWith('!');
const hash = z.string().regex(/^[A-Fa-f0-9]{64}$/);
export const TopicStepIdSchema = z.enum([
  'anchor',
  'body',
  'operation',
  'snapshot',
  'grant',
]);
export type TopicStepId = z.infer<typeof TopicStepIdSchema>;
/** The Matrix identity a step's event is sent from, as step records and permits carry it. */
export const TopicExecutorIdentitySchema = z.strictObject({
  matrixUserId: z
    .string()
    .regex(/^@[^:]+:.+$/)
    .max(512),
  homeserver: z.string().max(255),
});
export type TopicExecutorIdentity = z.infer<typeof TopicExecutorIdentitySchema>;
/**
 * The executor as a begin-step REQUEST names it: the identity plus the
 * Matrix device that will send the step's event. A step permit is re-issued
 * only to the executor that holds it, device included (the homeserver
 * deduplicates a transaction id per device, so another device resending
 * the same effect would post it twice). The device is compared, never
 * echoed: records and permits carry the identity alone.
 */
export const TopicExecutorSchema = z.strictObject({
  ...TopicExecutorIdentitySchema.shape,
  deviceId: z.string().min(1).max(255).optional(),
});
export type TopicExecutor = z.infer<typeof TopicExecutorSchema>;
export const VerifiedTopicEffectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('matrix'),
    roomId,
    eventId,
    sender: z.string().min(1),
    eventType: z.string().min(1),
    stateKey: z.string().optional(),
    contentDigest: ActionProposalDigestSchema,
    verifiedAt: instant,
  }),
  z.strictObject({
    kind: z.literal('chain'),
    chainId: z.string().min(1),
    transactionHash: hash,
    height: z.number().int().positive(),
    code: z.number().int().nonnegative(),
    messageDigest: ActionProposalDigestSchema,
    verifiedAt: instant,
  }),
]);
export const TopicActionReceiptSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('topic-created'),
    roomId,
    topicId: z.string().min(1),
    rootEventId: eventId,
    bodyEventId: eventId,
    operationEventId: eventId,
    stateEventId: eventId,
    verifiedAt: instant,
  }),
  z.strictObject({
    kind: z.literal('topic-access-granted'),
    transactionHash: hash,
    chainId: z.string().min(1),
    height: z.number().int().positive(),
    code: z.literal(0),
    verifiedAt: instant,
  }),
  z.strictObject({
    kind: z.literal('topic-access-failed'),
    transactionHash: hash,
    chainId: z.string().min(1),
    height: z.number().int().positive(),
    code: z.number().int().positive(),
    verifiedAt: instant,
  }),
]);
export type TopicActionReceipt = z.infer<typeof TopicActionReceiptSchema>;
export const TopicActionOutcomeSchema = z
  .strictObject({
    v: z.literal(2),
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
    receipt: TopicActionReceiptSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.status === 'succeeded' || value.status === 'failed') &&
      !value.receipt
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Verified terminal outcomes require a receipt',
      });
    if (
      value.receipt &&
      ((value.status === 'failed') !==
        (value.receipt.kind === 'topic-access-failed') ||
        !['succeeded', 'failed'].includes(value.status))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Receipt must match terminal status',
      });
  });
export const ActionOutcomeWireSchema = z.union([
  ActionOutcomeSchema,
  TopicActionOutcomeSchema,
]);
export type TopicActionOutcome = z.infer<typeof TopicActionOutcomeSchema>;
export type ActionOutcomeWire = z.infer<typeof ActionOutcomeWireSchema>;
export const TopicStepRecordSchema = z.discriminatedUnion('status', [
  z.strictObject({ step: TopicStepIdSchema, status: z.literal('pending') }),
  z.strictObject({
    step: TopicStepIdSchema,
    status: z.enum(['started', 'unknown']),
    startedAt: instant,
    expectedDigest: ActionProposalDigestSchema,
    executor: TopicExecutorIdentitySchema,
  }),
  z.strictObject({
    step: TopicStepIdSchema,
    status: z.literal('verified'),
    receipt: VerifiedTopicEffectSchema,
  }),
]);
export const TopicLifecycleSchema = z
  .strictObject({
    status: z.enum([
      'prepared',
      'claimed',
      'unknown',
      'succeeded',
      'failed',
      'rejected',
      'revoked',
      'superseded',
    ]),
    claimedAt: instant.optional(),
    endedAt: instant.optional(),
    executionBlockedAt: instant.optional(),
    steps: z.array(TopicStepRecordSchema).min(1).max(4),
    receipt: TopicActionReceiptSchema.optional(),
  })
  .superRefine((l, ctx) => {
    if (new Set(l.steps.map((s) => s.step)).size !== l.steps.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate step' });
    if (
      ['claimed', 'unknown', 'succeeded', 'failed'].includes(l.status) &&
      !l.claimedAt
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Consumed lifecycle requires claimedAt',
      });
    if (['succeeded', 'failed'].includes(l.status) && !l.receipt)
      ctx.addIssue({
        code: 'custom',
        message: 'Terminal lifecycle requires verified receipt',
      });
  });
export const TopicIdentitySchema = z
  .strictObject({
    did: z.string().startsWith('did:ixo:'),
    ...TopicExecutorIdentitySchema.shape,
    bindingDigest: ActionProposalDigestSchema,
  })
  .superRefine((identity, ctx) => {
    try {
      const url = new URL(identity.homeserver);
      if (
        url.protocol !== 'https:' ||
        url.origin !== identity.homeserver ||
        url.port ||
        url.username ||
        url.password ||
        identity.matrixUserId !==
          `@${identity.did.replaceAll(':', '-')}:${url.hostname}`
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Matrix identity must match its canonical DID and registered HTTPS homeserver',
        });
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid Matrix homeserver' });
    }
  });
export const TopicDependencySchema = z.strictObject({
  kind: z.enum([
    'matrix',
    'entity',
    'collection',
    'nft-owner',
    'authorization',
    'topic',
  ]),
  key: z.string().min(1).max(1024),
  digest: ActionProposalDigestSchema,
});
export const EncodedTopicGrantSchema = z.strictObject({
  typeUrl: z.literal('/ixo.entity.v1beta1.MsgGrantEntityAccountAuthz'),
  valueBase64: z.string().min(1).max(131072),
});
export const TopicCreateActionSchema = z.strictObject({
  name: z.literal('create_topic'),
  schemaVersion: z.literal('1'),
  network: z.enum(['devnet', 'testnet', 'mainnet']),
  roomId,
  owner: TopicIdentitySchema,
  participants: z.array(TopicIdentitySchema).max(32),
  plan: TopicCreatePlanSchema,
  dependencies: z.array(TopicDependencySchema).min(1).max(64),
});
export const TopicAccessActionSchema = z.strictObject({
  name: z.literal('grant_topic_access'),
  schemaVersion: z.literal('1'),
  network: z.enum(['devnet', 'testnet', 'mainnet']),
  roomId,
  topicId: z.string().min(1).max(255),
  owner: TopicIdentitySchema,
  authority: z.strictObject({
    rootEventId: eventId,
    contractBodyEventId: eventId,
    operationEventId: eventId,
    stateEventId: eventId,
    contractBodyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    revision: z.string().min(1),
    shapeDigest: z.string().min(1),
  }),
  chainId: z.string().min(1),
  signerAddress: IxoAddressSchema,
  entityDid: z.string().startsWith('did:ixo:'),
  adminAddress: IxoAddressSchema,
  collectionId: z.string().min(1),
  grants: z
    .array(
      z.strictObject({
        grantee: TopicIdentitySchema,
        address: IxoAddressSchema,
        role: z.enum(['submit', 'evaluate']),
        message: EncodedTopicGrantSchema,
      }),
    )
    .min(1)
    // Each grant is a DID lookup and two chain reads inside one ten second
    // budget, and Workers allow six open connections per invocation: eight
    // is what reliably fits.
    .max(8),
  memo: z.string().max(256),
  dependencies: z.array(TopicDependencySchema).min(1).max(64),
});
export const TopicProposalSubjectSchema = z
  .strictObject({
    v: z.literal(2),
    id: ActionProposalIdSchema,
    ownerDid: z.string().startsWith('did:'),
    title: z.string().trim().min(1).max(160),
    origin: z.strictObject({
      sessionId: z.string().min(1),
      runId: z.string().min(1),
      invocationId: z.string().min(1),
    }),
    action: z.discriminatedUnion('name', [
      TopicCreateActionSchema,
      TopicAccessActionSchema,
    ]),
    evidenceRefs: z.array(z.string().min(1)).min(1).max(64),
    createdAt: instant,
    expiresAt: instant,
  })
  .superRefine((p, ctx) => {
    if (Date.parse(p.expiresAt) <= Date.parse(p.createdAt))
      ctx.addIssue({
        code: 'custom',
        message: 'Expiry must follow preparation',
      });
    if (JSON.stringify(p).length > 262144)
      ctx.addIssue({
        code: 'custom',
        message: 'Topic subject exceeds 256 KiB',
      });
    if (p.action.owner.did !== p.ownerDid)
      ctx.addIssue({ code: 'custom', message: 'Owner identity mismatch' });
  });
export const TopicProposalV2Schema = z.strictObject({
  ...TopicProposalSubjectSchema.shape,
  digest: ActionProposalDigestSchema,
  lifecycle: TopicLifecycleSchema,
});
export type TopicProposalSubject = z.infer<typeof TopicProposalSubjectSchema>;
export type TopicActionProposal = z.infer<typeof TopicProposalV2Schema>;
export const ActionProposalWireSchema = z.union([
  ActionProposalSchema,
  TopicProposalV2Schema,
]);
export type ActionProposalWire = z.infer<typeof ActionProposalWireSchema>;
export const TopicReceiptReferencesSchema = z.strictObject({
  v: z.literal(2),
  references: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('matrix'),
          step: z.enum(['anchor', 'body', 'operation', 'snapshot']),
          eventId,
        }),
        z.strictObject({
          kind: z.literal('chain'),
          step: z.literal('grant'),
          transactionHash: hash,
        }),
      ]),
    )
    .max(4),
});
export type TopicReceiptReferences = z.infer<
  typeof TopicReceiptReferencesSchema
>;
export const BeginTopicStepSchema = z.strictObject({
  digest: ActionProposalDigestSchema,
  step: TopicStepIdSchema,
  executor: TopicExecutorSchema,
});
export type BeginTopicStep = z.infer<typeof BeginTopicStepSchema>;
export const ExpectedTopicEffectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('matrix'),
    roomId,
    sender: z.string().min(1),
    eventType: z.string().min(1),
    stateKey: z.string().optional(),
    transactionId: z.string().min(1).max(255),
    content: z.json(),
  }),
  z.strictObject({
    kind: z.literal('chain'),
    chainId: z.string().min(1),
    signerAddress: IxoAddressSchema,
    memo: z.string(),
    messages: z.array(EncodedTopicGrantSchema).min(1).max(32),
  }),
]);
export type ExpectedTopicEffect = z.infer<typeof ExpectedTopicEffectSchema>;
export const TopicStepPermitSchema = z.strictObject({
  proposalId: ActionProposalIdSchema,
  digest: ActionProposalDigestSchema,
  step: TopicStepIdSchema,
  executor: TopicExecutorIdentitySchema,
  expectedDigest: ActionProposalDigestSchema,
  effect: ExpectedTopicEffectSchema,
});
export type TopicStepPermit = z.infer<typeof TopicStepPermitSchema>;
export const BeginTopicStepResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('permitted'),
    permit: TopicStepPermitSchema,
  }),
  z.strictObject({
    status: z.literal('already_started'),
    proposal: TopicProposalV2Schema,
  }),
]);
export type BeginTopicStepResult = z.infer<typeof BeginTopicStepResultSchema>;
export function topicProposalSubject(
  p: TopicActionProposal,
): TopicProposalSubject {
  const { digest: _d, lifecycle: _l, ...subject } = p;
  return subject;
}
export async function digestTopicProposal(
  subject: TopicProposalSubject,
): Promise<string> {
  return (
    await digestFinalDecisionSubject({
      kind: 'action-proposal/v2',
      action: z.json().parse(TopicProposalSubjectSchema.parse(subject)),
    })
  ).subjectDigest;
}
export const parseActionProposalWire = (input: unknown): ActionProposalWire =>
  ActionProposalWireSchema.parse(input);
export async function assertTopicProposalUnchanged(
  input: unknown,
): Promise<TopicActionProposal> {
  const p = TopicProposalV2Schema.parse(input);
  TopicProposalSubjectSchema.parse(topicProposalSubject(p));
  const expectedSteps =
    p.action.name === 'create_topic'
      ? ['anchor', 'body', 'operation', 'snapshot']
      : ['grant'];
  if (
    p.lifecycle.steps.map((s) => s.step).join(',') !== expectedSteps.join(',')
  )
    throw new Error('Topic journal steps mismatch');
  if (p.lifecycle.receipt) {
    const receipt = p.lifecycle.receipt;
    if (
      (p.action.name === 'create_topic') !==
        (receipt.kind === 'topic-created') ||
      (p.lifecycle.status === 'failed') !==
        (receipt.kind === 'topic-access-failed') ||
      !['succeeded', 'failed'].includes(p.lifecycle.status)
    )
      throw new Error('Topic receipt mismatch');
  }
  if (
    p.action.name === 'create_topic' &&
    (p.action.plan.proposalId !== p.id ||
      p.action.plan.roomId !== p.action.roomId ||
      p.action.plan.actor !== p.action.owner.matrixUserId)
  )
    throw new Error('Topic plan owner and provenance mismatch');
  if (p.action.name === 'create_topic') {
    const participants = p.action.participants
      .map((v) => v.matrixUserId)
      .sort();
    const planned = p.action.plan.draft.participants.map((v) => v.id).sort();
    if (
      JSON.stringify(participants) !== JSON.stringify(planned) ||
      !participants.includes(p.action.owner.matrixUserId) ||
      p.action.plan.draft.ownerId !== p.action.owner.matrixUserId
    )
      throw new Error('Topic participant bindings mismatch');
  }

  if (p.action.name === 'grant_topic_access') {
    if (p.ownerDid !== `did:ixo:${p.action.signerAddress}`)
      throw new Error('Topic signer mismatch');
    const { decodeTopicGrant } = await import('./topic-grants.js');
    for (const grant of p.action.grants) {
      const r = decodeTopicGrant(grant.message).review;
      if (
        grant.grantee.did !== `did:ixo:${grant.address}` ||
        r.ownerAddress !== p.action.signerAddress ||
        r.entityDid !== p.action.entityDid ||
        r.adminAddress !== p.action.adminAddress ||
        r.granteeAddress !== grant.address ||
        r.role !== grant.role ||
        Date.parse(r.expiresAt) <= Date.parse(p.createdAt)
      )
        throw new Error('Grant subject mismatch');
    }
  }
  if (p.action.name === 'create_topic') {
    const { assertCreatePlanUnchanged } =
      await import('./topic-create-plan.js');
    await assertCreatePlanUnchanged(p.action.plan);
  }
  if ((await digestTopicProposal(topicProposalSubject(p))) !== p.digest)
    throw new Error('Topic proposal changed');
  return p;
}
export async function assertActionProposalWireUnchanged(
  input: unknown,
): Promise<ActionProposalWire> {
  const p = parseActionProposalWire(input);
  if (p.v === 2) return assertTopicProposalUnchanged(p);
  const { assertActionProposalUnchanged } =
    await import('./action-proposals.js');
  return assertActionProposalUnchanged(p);
}
export function topicActionOutcome(
  p: TopicActionProposal,
  now = Date.now(),
): TopicActionOutcome {
  return TopicActionOutcomeSchema.parse({
    v: 2,
    proposalId: p.id,
    digest: p.digest,
    status:
      p.lifecycle.status === 'prepared' && Date.parse(p.expiresAt) <= now
        ? 'expired'
        : p.lifecycle.status,
    ...(p.lifecycle.receipt ? { receipt: p.lifecycle.receipt } : {}),
  });
}
export const ActionProposalWireRpcSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), proposal: ActionProposalWireSchema }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);

export async function digestTopicEffect(
  effect: ExpectedTopicEffect,
): Promise<string> {
  return (
    await digestFinalDecisionSubject({
      kind: 'topic-effect/v1',
      action: z.json().parse(effect),
    })
  ).subjectDigest;
}
