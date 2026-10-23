import { createTopicId, createTopicOperationId } from '@ixo/topic-protocol';
import { withTopicReadBudget } from './topic-budget';
import { z } from 'zod';
import { prepareCreatePlan } from '@ixo/ixo-transaction/topic-create-plan';
import { buildTopicGrant } from '@ixo/ixo-transaction/topic-grants';
import { IxoAddressSchema } from '@ixo/ixo-transaction/action-proposals';
import {
  TopicProposalSubjectSchema,
  type TopicProposalSubject,
} from '@ixo/ixo-transaction/topic-proposals';
import {
  resolveTopicIdentity,
  readTopicRoom,
  type TopicMatrixReader,
} from './topic-matrix';
import { readTopicAuthority } from './topic-history';
import { TopicChainReader } from './topic-chain';
import { digestTopicProposalEffect } from './topic-store';
import { ActionProposalConflict } from './store';
const network = z.enum(['devnet', 'testnet', 'mainnet']);
const did = z.string().startsWith('did:ixo:').max(256);
export const TopicCandidateSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create_topic'),
    network,
    roomId: z.string().startsWith('!').max(512),
    title: z.string().trim().min(1).max(160),
    participants: z.array(did).min(1).max(32),
    roles: z
      .array(
        z.strictObject({
          roleId: z.enum([
            'worker',
            'decision-authority',
            'action-requester',
            'action-confirmer',
            'settlement-controller',
          ]),
          assignees: z.array(did).min(1).max(32),
        }),
      )
      .max(32)
      .default([]),
    tags: z.array(z.string().min(1).max(100)).max(32).default([]),
  }),
  z.strictObject({
    action: z.literal('grant_topic_access'),
    network,
    roomId: z.string().startsWith('!').max(512),
    topicId: z.string().min(1).max(255),
    grants: z
      .array(
        z.strictObject({
          did,
          role: z.enum(['submit', 'evaluate']),
          agentQuota: z.string().regex(/^[1-9]\d*$/),
          expiresAt: z.iso.datetime(),
          beforeDate: z.iso.datetime().optional(),
        }),
      )
      .min(1)
      .max(8),
  }),
]);
export type TopicCandidate = z.infer<typeof TopicCandidateSchema>;
export type TopicPreparationContext = {
  ownerDid: string;
  sessionId: string;
  runId: string;
  invocationId: string;
  blocksync: string | undefined;
  rpc: string | undefined;
  chainId: string;
  reader: TopicMatrixReader;
  fetcher?: typeof fetch;
  now?: number;
};
export async function prepareTopicSubject(
  raw: unknown,
  evidenceRefs: string[],
  ctx: TopicPreparationContext,
): Promise<TopicProposalSubject> {
  return withTopicReadBudget(
    ctx.reader,
    ctx.fetcher ?? fetch,
    (reader, fetcher) =>
      prepareTopicSubjectWithinBudget(raw, evidenceRefs, {
        ...ctx,
        reader,
        fetcher,
      }),
  );
}
async function prepareTopicSubjectWithinBudget(
  raw: unknown,
  evidenceRefs: string[],
  ctx: TopicPreparationContext,
): Promise<TopicProposalSubject> {
  const candidate = TopicCandidateSchema.parse(raw);
  if (candidate.network === 'mainnet')
    throw new Error('Mainnet topic preparation is disabled');
  const now = ctx.now ?? Date.now();
  const createdAt = new Date(now).toISOString();
  const id = `ap_${crypto.randomUUID()}`;
  const owner = await resolveTopicIdentity(
    ctx.ownerDid,
    ctx.blocksync,
    ctx.fetcher,
  );
  const room = await readTopicRoom(
    ctx.reader,
    candidate.roomId,
    owner.matrixUserId,
  );
  const base = {
    v: 2 as const,
    id,
    ownerDid: ctx.ownerDid,
    origin: {
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      invocationId: ctx.invocationId,
    },
    evidenceRefs,
    createdAt,
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
  };
  if (candidate.action === 'create_topic') {
    if (!candidate.participants.includes(ctx.ownerDid))
      throw new Error('Explicit participants must include the owner');
    const participants = await Promise.all(
      candidate.participants.map((p) =>
        resolveTopicIdentity(p, ctx.blocksync, ctx.fetcher),
      ),
    );
    const bindings = new Map(participants.map((p) => [p.did, p.matrixUserId]));
    const roles = candidate.roles.map((role) => ({
      roleId: role.roleId,
      assignees: role.assignees.map((did) => {
        const user = bindings.get(did);
        if (!user)
          throw new Error('Every role must name an explicit participant');
        return user;
      }),
    }));
    const plan = await prepareCreatePlan({
      draft: {
        title: candidate.title,
        ownerId: owner.matrixUserId,
        participants: participants.map((p) => ({ id: p.matrixUserId })),
        roles,
        tags: candidate.tags,
      },
      roomId: candidate.roomId,
      actor: owner.matrixUserId,
      identity: {
        topicId: createTopicId(),
        operationId: createTopicOperationId(),
        createdAt,
        transactionIdPrefix: `qa_${id.slice(3)}`,
      },
      evaluationTime: {
        at: createdAt,
        source: 'server',
        trusted: true,
        freshUntil: base.expiresAt,
      },
      encrypted: room.encrypted,
      proposalId: id,
    });
    return TopicProposalSubjectSchema.parse({
      ...base,
      title: `Create topic: ${candidate.title}`,
      action: {
        name: 'create_topic',
        schemaVersion: '1',
        network: candidate.network,
        roomId: candidate.roomId,
        owner,
        participants,
        plan,
        dependencies: room.dependencies,
      },
    });
  }
  if (!ctx.rpc) throw new Error('Trusted chain endpoint unavailable');
  const signerAddress = IxoAddressSchema.parse(
    ctx.ownerDid.replace(/^did:ixo:/, ''),
  );
  const topic = await readTopicAuthority(
    ctx.reader,
    candidate.roomId,
    candidate.topicId,
    owner.matrixUserId,
    room.state,
  );
  if (!topic.body.claimBinding)
    throw new Error('The authenticated topic has no claim collection binding');
  const chain = new TopicChainReader(ctx.rpc, ctx.chainId, ctx.fetcher);
  const collection = await chain.collection(
    topic.body.claimBinding.entityDid,
    topic.body.claimBinding.collectionId,
    signerAddress,
  );
  const dependencies: TopicProposalSubject['action']['dependencies'] = [
    ...room.dependencies,
    ...topic.dependencies,
    ...collection.dependencies,
  ];
  const unique = new Set<string>();
  for (const requested of candidate.grants) {
    const key = `${requested.did}:${requested.role}`;
    if (unique.has(key)) throw new Error('Duplicate grant');
    unique.add(key);
    if (
      Date.parse(requested.expiresAt) <= now ||
      Date.parse(requested.expiresAt) > now + 3 * 365 * 86400000
    )
      throw new Error('Grant expiry must be within three years');
    if (requested.beforeDate && Date.parse(requested.beforeDate) <= now)
      throw new Error('Evaluator beforeDate must be in the future');
  }
  // Each grant needs a DID lookup and a chain query; they are independent,
  // so they run together inside the read budget instead of one after another.
  const resolved = await Promise.all(
    candidate.grants.map(async (requested) => {
      const address = IxoAddressSchema.parse(
        requested.did.replace(/^did:ixo:/, ''),
      );
      const [grantee, authorization] = await Promise.all([
        resolveTopicIdentity(requested.did, ctx.blocksync, ctx.fetcher),
        chain.authorization(collection.adminAddress, address, requested.role),
      ]);
      return { requested, address, grantee, authorization };
    }),
  );
  const grants = [];
  for (const { requested, address, grantee, authorization } of resolved) {
    const roleId = requested.role === 'submit' ? 'worker' : 'evaluator';
    if (
      !topic.body.roles.some(
        (role) =>
          role.roleId === roleId &&
          role.assignees.includes(grantee.matrixUserId),
      )
    )
      throw new Error(
        'The grant recipient must hold the explicit claim role in the authenticated topic body',
      );
    dependencies.push(authorization.dependency);
    let message;
    try {
      message = buildTopicGrant({
        role: requested.role,
        ownerAddress: signerAddress,
        entityDid: topic.body.claimBinding.entityDid,
        adminAddress: collection.adminAddress,
        granteeAddress: address,
        collectionId: topic.body.claimBinding.collectionId,
        agentQuota: requested.agentQuota,
        expiresAt: requested.expiresAt,
        ...(requested.beforeDate ? { beforeDate: requested.beforeDate } : {}),
        ...(authorization.existing ? { existing: authorization.existing } : {}),
      });
    } catch (error) {
      // The builder's refusals (an existing grant under another expiry, an
      // evaluator date outside the grant) are the owner's to read; a shape
      // it rejects is not.
      throw new ActionProposalConflict(
        error instanceof Error && !(error instanceof z.ZodError)
          ? error.message
          : 'Grant cannot be built',
      );
    }
    grants.push({ grantee, address, role: requested.role, message });
  }
  return TopicProposalSubjectSchema.parse({
    ...base,
    title: 'Grant topic claim access',
    action: {
      name: 'grant_topic_access',
      schemaVersion: '1',
      network: candidate.network,
      roomId: candidate.roomId,
      topicId: candidate.topicId,
      owner,
      authority: topic.authority,
      chainId: ctx.chainId,
      signerAddress,
      entityDid: topic.body.claimBinding.entityDid,
      adminAddress: collection.adminAddress,
      collectionId: topic.body.claimBinding.collectionId,
      grants,
      memo: `Qi topic access ${id}`,
      dependencies,
    },
  });
}
export const topicCandidateEvidenceDigest = digestTopicProposalEffect;
