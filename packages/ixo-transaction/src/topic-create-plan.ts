import {
  assertContract,
  buildTopicRootContent,
  buildTopicOperationContent,
  resolveEffectiveTopicShape,
  topicSetupFieldState,
  projectTopicProgress,
  replayTopicShape,
  type TopicEvaluationTimeV1,
} from '@ixo/topic-protocol';
import { z } from 'zod';
import { canonicalizeIxoJson } from './final-subject.js';

const MatrixId = z
  .string()
  .regex(/^@[^:]+:.+$/)
  .max(512);
export const CreateDiscussionDraftSchema = z
  .object({
    title: z.string().trim().min(1).max(280),
    ownerId: MatrixId,
    participants: z
      .array(z.object({ id: MatrixId }).strict())
      .min(1)
      .max(32),
    roles: z
      .array(
        z
          .object({
            roleId: z.enum([
              'worker',
              'decision-authority',
              'action-requester',
              'action-confirmer',
              'settlement-controller',
            ]),
            assignees: z.array(MatrixId).min(1).max(32),
          })
          .strict(),
      )
      .max(32),
    tags: z.array(z.string().min(1).max(100)).max(32),
    temporalMode: z.enum(['finite', 'ongoing']).optional(),
  })
  .strict()
  .superRefine((draft, ctx) => {
    const ids = draft.participants.map(({ id }) => id);
    if (new Set(ids).size !== ids.length || !ids.includes(draft.ownerId))
      ctx.addIssue({
        code: 'custom',
        message: 'Participants must be unique and include the owner',
      });
    if (
      new Set(draft.roles.map(({ roleId }) => roleId)).size !==
      draft.roles.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Role assignments must be unique',
      });
    if (
      draft.roles.some(
        ({ assignees }) =>
          new Set(assignees).size !== assignees.length ||
          assignees.some((id) => !ids.includes(id)),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Every assigned actor must be an explicit participant',
      });
  });
export type CreateDiscussionDraft = z.infer<typeof CreateDiscussionDraftSchema>;
export const CreatePlanInputSchema = z
  .object({
    draft: CreateDiscussionDraftSchema,
    roomId: z
      .string()
      .regex(/^![^:]+:.+$/)
      .max(512),
    actor: MatrixId,
    identity: z
      .object({
        topicId: z
          .string()
          .regex(
            /^ixo:topic:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          ),
        operationId: z
          .string()
          .regex(
            /^ixo:topic-operation:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          ),
        createdAt: z.string().datetime(),
        transactionIdPrefix: z.string().min(1).max(128),
      })
      .strict(),
    evaluationTime: z
      .object({
        at: z.string().datetime(),
        source: z.enum(['matrix', 'server', 'client', 'system']),
        trusted: z.boolean(),
        freshUntil: z.string().datetime().optional(),
      })
      .strict(),
    encrypted: z.boolean(),
    proposalId: z.string().regex(/^ap_[0-9a-f-]{36}$/),
  })
  .strict();
export type CreatePlanInput = z.infer<typeof CreatePlanInputSchema>;
/**
 * `protocol` and every `sourceVersion` below name the topic SHAPE release
 * (`TOPIC_SHAPE_RELEASE`), not the package version: package 1.0.0-rc.8
 * still ships shape release 1.0.0-rc.7 (and refuses an unknown one with
 * SHAPE_SOURCE_NOT_FOUND). It is part of every sealed plan's digest and of
 * the Portal's strict parser, so it moves only with a new shape release.
 */
export type TopicCreatePlan = CreatePlanInput & {
  v: 1;
  encoderVersion: 'portal-create-plan/1';
  protocol: '1.0.0-rc.7';
  body: Record<string, unknown>;
  bodyHash: `sha256:${string}`;
  resolvedShape: ReturnType<typeof resolveEffectiveTopicShape>;
  shapeSources: ReturnType<typeof resolveEffectiveTopicShape>['sources'];
};
export const TopicCreatePlanSchema = z
  .object({
    ...CreatePlanInputSchema.shape,
    v: z.literal(1),
    encoderVersion: z.literal('portal-create-plan/1'),
    protocol: z.literal('1.0.0-rc.7'),
    body: z.record(z.string(), z.unknown()),
    bodyHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .transform((value) => `sha256:${value.slice(7)}` as const),
    resolvedShape: z.unknown(),
    shapeSources: z.unknown(),
  })
  .strict()
  .transform((value, ctx) => {
    const expected = resolveEffectiveTopicShape({
      baseRecipe: 'discussion',
      kind: 'discussion',
      sourceVersion: '1.0.0-rc.7',
    });
    if (
      canonicalizeIxoJson(value.resolvedShape) !==
        canonicalizeIxoJson(expected) ||
      canonicalizeIxoJson(value.shapeSources) !==
        canonicalizeIxoJson(expected.sources)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'The pinned discussion shape changed',
      });
      return z.NEVER;
    }
    try {
      assertContract('topic-contract-body', value.body);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid rc7 contract body' });
      return z.NEVER;
    }
    return {
      ...value,
      resolvedShape: expected,
      shapeSources: expected.sources,
    };
  });
export type TopicCreateStep = 'anchor' | 'body' | 'operation' | 'snapshot';
export type VerifiedCreateReferences = {
  rootEventId?: string;
  bodyEventId?: string;
};
export type ExpectedMatrixEffect = {
  kind: 'matrix';
  step: TopicCreateStep;
  roomId: string;
  sender: string;
  eventType: string;
  stateKey?: string;
  transactionId: string;
  content: Record<string, unknown>;
};

export async function topicCreateDigest(
  value: unknown,
): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalizeIxoJson(value)),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
export function discussionForm(input: CreatePlanInput) {
  const shape = resolveEffectiveTopicShape({
    baseRecipe: 'discussion',
    kind: 'discussion',
    sourceVersion: '1.0.0-rc.7',
  });
  return {
    ...input.draft,
    topicStatus: 'draft' as const,
    contractStatus: 'draft' as const,
    workingMode: 'solo' as const,
    kindRef: { source: 'standard' as const, kind: 'discussion' as const },
    baseRecipe: 'discussion' as const,
    effectiveShape: shape,
  };
}
export async function prepareCreatePlan(
  raw: CreatePlanInput,
): Promise<TopicCreatePlan> {
  const input = CreatePlanInputSchema.parse(raw);
  if (input.actor !== input.draft.ownerId)
    throw new Error('The creating account must own the discussion');
  const form = discussionForm(input);
  const body = {
    version: 4,
    revision: input.identity.operationId,
    authoredBy: input.actor,
    authoredAt: input.identity.createdAt,
    kindRef: form.kindRef,
    workingMode: form.workingMode,
    baseRecipe: form.baseRecipe,
    tags: form.tags,
    ownerId: form.ownerId,
    ...(form.participants.length ? { participants: form.participants } : {}),
    ...(form.roles.length ? { roles: form.roles } : {}),
    ...(form.temporalMode ? { temporalMode: form.temporalMode } : {}),
    shapeSources: form.effectiveShape.sources,
    shapeDigest: form.effectiveShape.digest,
  };
  assertContract('topic-contract-body', body);
  return {
    ...input,
    v: 1,
    encoderVersion: 'portal-create-plan/1',
    protocol: '1.0.0-rc.7',
    body,
    bodyHash: await topicCreateDigest(body),
    resolvedShape: form.effectiveShape,
    shapeSources: form.effectiveShape.sources,
  };
}
export async function assertCreatePlanUnchanged(
  plan: TopicCreatePlan,
): Promise<TopicCreatePlan> {
  const expected = await prepareCreatePlan(
    CreatePlanInputSchema.parse({
      draft: plan.draft,
      roomId: plan.roomId,
      actor: plan.actor,
      identity: plan.identity,
      evaluationTime: plan.evaluationTime,
      encrypted: plan.encrypted,
      proposalId: plan.proposalId,
    }),
  );
  if (canonicalizeIxoJson(expected) !== canonicalizeIxoJson(plan))
    throw new Error('The reviewed topic creation plan changed');
  return expected;
}
export async function materializeCreateStep(
  plan: TopicCreatePlan,
  step: TopicCreateStep,
  refs: VerifiedCreateReferences,
): Promise<ExpectedMatrixEffect> {
  const { identity, roomId, actor } = plan;
  const base = { kind: 'matrix' as const, step, roomId, sender: actor };
  if (step === 'anchor')
    return {
      ...base,
      eventType: 'm.room.message',
      transactionId: `${identity.transactionIdPrefix}:anchor`,
      content: {
        ...buildTopicRootContent({
          version: 4,
          id: identity.topicId,
          title: plan.draft.title,
          status: 'draft',
          kind: 'discussion',
          baseRecipe: 'discussion',
          shapeDigest: plan.resolvedShape.digest,
          createdBy: actor,
          createdAt: identity.createdAt,
        }),
        'ixo.action_proposal': {
          v: 1,
          proposalId: plan.proposalId,
          operationId: identity.operationId,
        },
      },
    };
  const rootEventId = refs.rootEventId;
  if (!rootEventId?.startsWith('$'))
    throw new Error('A verified root event is required');
  if (step === 'body')
    return {
      ...base,
      eventType: 'ixo.topic.contract.body',
      transactionId: `${identity.transactionIdPrefix}:contract-body`,
      content: {
        body: 'Topic contract',
        mediaType: 'application/vnd.ixo.topic-contract+json',
        'm.relates_to': { rel_type: 'm.thread', event_id: rootEventId },
        contract: plan.body,
      },
    };
  if (!refs.bodyEventId?.startsWith('$'))
    throw new Error('A verified body event is required');
  const ref = {
    revision: identity.operationId,
    bodyHash: plan.bodyHash,
    bodyRef: {
      provider: 'matrix',
      roomId,
      eventId: refs.bodyEventId,
      eventType: plan.encrypted
        ? 'm.room.encrypted'
        : 'ixo.topic.contract.body',
      contentHash: plan.bodyHash,
      mediaType: 'application/vnd.ixo.topic-contract+json',
      encryption: plan.encrypted ? 'matrix-e2ee' : 'none',
    },
  };
  const form = discussionForm(plan);
  if (step === 'operation') {
    const changedPaths = [
      '/title',
      '/topicStatus',
      ...[
        'kindRef',
        'workingMode',
        'baseRecipe',
        'temporalMode',
        'tags',
        'ownerId',
        'participants',
        'roles',
      ]
        .filter((key) => plan.body[key] !== undefined)
        .map((key) => `/${key}`),
      '/shapeSources',
      '/shapeDigest',
    ];
    const operation = {
      version: 2 as const,
      operationId: identity.operationId,
      topicId: identity.topicId,
      type: 'propose-contract' as const,
      previousRevision: rootEventId,
      actor,
      createdAt: identity.createdAt,
      payload: {
        previousRevision: rootEventId,
        topicPreviousRevision: rootEventId,
        nextRevision: identity.operationId,
        contractRef: ref,
        contract: { ...ref, bodyHash: plan.bodyHash.slice(7) },
        bodyHash: plan.bodyHash,
        changedPaths,
        projection: {
          title: form.title,
          status: 'draft',
          kindRef: form.kindRef,
          tags: form.tags,
          contractStatus: 'draft',
        },
      },
    };
    return {
      ...base,
      eventType: 'ixo.topic.operation',
      transactionId: `${identity.transactionIdPrefix}:propose-contract`,
      content: {
        body: `Topic created: “${form.title.trim()}”`,
        ...buildTopicOperationContent({ roomId, rootEventId }, operation),
      },
    };
  }
  return {
    ...base,
    eventType: 'ixo.topic.contract',
    stateKey: identity.topicId,
    transactionId: `${identity.transactionIdPrefix}:snapshot`,
    content: await buildDiscussionCreateSnapshot(plan, rootEventId, ref),
  };
}

export async function buildDiscussionCreateSnapshot(
  plan: TopicCreatePlan,
  rootEventId: string,
  ref: {
    revision: string;
    bodyHash: `sha256:${string}`;
    bodyRef: Record<string, unknown>;
  },
) {
  const form = discussionForm(plan);
  const { identity, actor } = plan;
  const policyDigest = await topicCreateDigest({});
  const explicitRoles = Object.fromEntries(
    form.roles.map(({ roleId, assignees }) => [roleId, assignees]),
  );
  const actorAssignments = {
    ...explicitRoles,
    'setup-editor': [],
    'setup-confirmer': [],
    'dispute-resolver': [],
    worker: explicitRoles.worker?.length
      ? explicitRoles.worker
      : [form.ownerId],
    'completion-authority': [],
    'project-lead': [],
    'project-closer': [],
  };
  const input = {
    topicId: identity.topicId,
    topicRevision: identity.operationId,
    contractRevision: identity.operationId,
    status: 'draft' as const,
    shape: form.effectiveShape,
    historyCompatible: true,
    sources: [
      {
        kind: 'operation' as const,
        type: 'topic-projection',
        id: identity.operationId,
        actor,
        contractRevision: identity.operationId,
        bodyHash: plan.bodyHash,
        policyDigest,
        authorityProofRef: identity.operationId,
      },
    ],
    contractBodyHash: plan.bodyHash,
    policyDigest,
    evaluationTime: plan.evaluationTime satisfies TopicEvaluationTimeV1,
    presentFields: [...topicSetupFieldState(form).presentFields],
    fieldValues: { '/temporalMode': form.temporalMode ?? 'finite' },
    acceptedFields: [],
    bindings: [],
    actorAssignments,
  };
  const axisStates = Object.fromEntries(
    form.effectiveShape.shape.axes.map((axis) => [
      axis.code,
      axis.code === 'contract'
        ? 'proposed'
        : axis.code === 'topic'
          ? 'open'
          : axis.initialState,
    ]),
  );
  const progress = projectTopicProgress({
    ...input,
    axisStates: replayTopicShape(input, axisStates),
  });
  const setupStatus =
    progress.dispute?.status === 'open'
      ? 'disputed'
      : progress.condition === 'expired'
        ? 'expired'
        : progress.condition === 'review-due'
          ? 'review-due'
          : progress.axisStates.contract === 'effective'
            ? 'confirmed'
            : progress.obligations.some(
                  ({ code }) => code === 'setup.scheduled',
                )
              ? 'scheduled'
              : progress.condition === 'needs-confirmation'
                ? 'awaiting-confirmation'
                : 'draft';
  const projection = {
    revision: identity.operationId,
    contractRevision: identity.operationId,
    title: form.title,
    status: 'draft',
    kindRef: form.kindRef,
    contractStatus: 'draft',
    ownerId: form.ownerId,
    attachmentCount: 0,
    operationCount: 1,
  };
  const projectionWithSetup = {
    ...projection,
    digest: (await topicCreateDigest(projection)).slice(7),
    setupStatus,
  };
  return {
    version: 4,
    profile: 'qi.topic-contract-state/v4',
    schema:
      'https://topic-protocol.ixo.world/schemas/topic-contract-state.schema.json',
    topicId: identity.topicId,
    anchor: {
      mode: 'native',
      roomId: plan.roomId,
      rootEventId,
      manifestSource: 'root-event',
    },
    manifest: {
      version: 4,
      id: identity.topicId,
      title: form.title,
      kind: 'discussion',
      status: 'draft',
      createdBy: actor,
      createdAt: identity.createdAt,
      baseRecipe: 'discussion',
      shapeDigest: form.effectiveShape.digest,
    },
    contracts: { proposed: ref },
    shape: {
      digest: form.effectiveShape.digest,
      sources: form.effectiveShape.sources,
    },
    progress,
    projection: {
      ...projectionWithSetup,
      digest: (await topicCreateDigest(projectionWithSetup)).slice(7),
    },
    policy: {
      confidentialityBoundary: 'matrix-room',
      e2eeRequired: plan.encrypted,
      attachmentBytesRequireSeparateGrant: true,
    },
    bindings: { context: [], flows: [] },
    extensions: { 'qi.search.tags': form.tags },
    provenance: {
      basis: 'explicit',
      acceptance: 'proposed',
      sourceEventIds: [rootEventId],
      createdBy: actor,
      createdAt: identity.createdAt,
    },
  };
}
