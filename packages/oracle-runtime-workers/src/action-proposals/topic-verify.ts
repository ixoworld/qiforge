import { withTopicReadBudget } from './topic-budget';
import { canonicalizeIxoJson } from '@ixo/ixo-transaction/action-proposals';
import {
  digestTopicEffect,
  type TopicActionProposal,
  type ExpectedTopicEffect,
  type TopicReceiptReferences,
} from '@ixo/ixo-transaction/topic-proposals';
import { assertCreatePlanUnchanged } from '@ixo/ixo-transaction/topic-create-plan';
import {
  TopicMatrixEventSchema,
  assertTopicRoomUnchanged,
  readTopicEvent,
  type TopicMatrixReader,
} from './topic-matrix';
import { readTopicAuthority } from './topic-history';
import { TopicChainReader } from './topic-chain';
import {
  digestTopicProposalEffect,
  type TopicProposalStore,
} from './topic-store';
import {
  ActionProposalConflict,
  TRANSACTION_CARD_BOUND_MISMATCH,
  TRANSACTION_REJECTIONS,
} from './store';
import { TopicReadUnavailable } from './topic-errors';
import { verifyTopicGrantTransaction } from './verify';
export type TopicVerificationContext = {
  reader: TopicMatrixReader;
  blocksync: string | undefined;
  rpc: string | undefined;
  fetcher?: typeof fetch;
  onAttempt?: () => void;
  /** An outer wall budget (the alarm tick's) every read here also obeys. */
  signal?: AbortSignal;
};
export async function assertTopicDependencies(
  proposal: TopicActionProposal,
  ctx: TopicVerificationContext,
) {
  return withTopicReadBudget(
    ctx.reader,
    ctx.fetcher ?? fetch,
    (reader, fetcher) =>
      assertTopicDependenciesWithinBudget(proposal, {
        ...ctx,
        reader,
        fetcher,
      }),
    ctx.signal,
  );
}
async function assertTopicDependenciesWithinBudget(
  proposal: TopicActionProposal,
  ctx: TopicVerificationContext,
) {
  const room = await assertTopicRoomUnchanged(
    proposal,
    ctx.reader,
    ctx.blocksync,
    ctx.fetcher,
  );
  if (proposal.action.name === 'create_topic') {
    try {
      await assertCreatePlanUnchanged(proposal.action.plan);
    } catch (error) {
      // The plan builder's own refusals describe the plan's internals; what
      // the owner is told is that the reviewed plan no longer builds the same.
      console.warn(
        `[topic-actions] ${proposal.id} creation plan check: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ActionProposalConflict(
        'The reviewed topic creation plan changed',
      );
    }
    return;
  }
  if (!ctx.rpc)
    throw new TopicReadUnavailable('Trusted chain endpoint unavailable');
  const action = proposal.action;
  // The room state just read is the state the authority is judged on: one
  // state read, not two.
  const topic = await readTopicAuthority(
    ctx.reader,
    action.roomId,
    action.topicId,
    action.owner.matrixUserId,
    room.state,
  );
  const chain = new TopicChainReader(ctx.rpc, action.chainId, ctx.fetcher);
  const collection = await chain.collection(
    action.entityDid,
    action.collectionId,
    action.signerAddress,
  );
  // One authorization query per grant, all at once: the ten second budget
  // has to cover the topic history and the collection reads as well.
  const authorizations = await Promise.all(
    action.grants.map((grant) =>
      chain.authorization(action.adminAddress, grant.address, grant.role),
    ),
  );
  const current: TopicActionProposal['action']['dependencies'] = [
    ...topic.dependencies,
    ...collection.dependencies,
    ...authorizations.map((a) => a.dependency),
  ];
  for (const dep of action.dependencies.filter((d) => d.kind !== 'matrix'))
    if (
      !current.some(
        (d) =>
          d.kind === dep.kind && d.key === dep.key && d.digest === dep.digest,
      )
    )
      // A fact the card was sealed on moved: a conflict the Portal can show
      // and retry after a re-read, not a server fault.
      throw new ActionProposalConflict('Topic or chain authority changed');
}
export async function verifyTopicReference(
  proposal: TopicActionProposal,
  effect: ExpectedTopicEffect,
  reference: TopicReceiptReferences['references'][number],
  ctx: TopicVerificationContext,
) {
  if (effect.kind === 'chain') {
    if (reference.kind !== 'chain' || !ctx.rpc)
      throw new ActionProposalConflict('Expected a chain reference');
    const verified = await verifyTopicGrantTransaction(
      effect,
      reference.transactionHash,
      ctx.rpc,
      ctx.fetcher,
    );
    return {
      kind: 'chain' as const,
      chainId: effect.chainId,
      ...verified,
      messageDigest: await digestTopicEffect(effect),
    };
  }
  if (reference.kind !== 'matrix')
    throw new ActionProposalConflict('Expected a Matrix reference');
  const event = await readTopicEvent(
    ctx.reader,
    effect.roomId,
    reference.eventId,
  );
  if (
    event.event_id !== reference.eventId ||
    event.room_id !== effect.roomId ||
    event.sender !== effect.sender ||
    event.type !== effect.eventType ||
    event.state_key !== effect.stateKey ||
    canonicalizeIxoJson(event.content) !== canonicalizeIxoJson(effect.content)
  )
    throw new ActionProposalConflict(
      'Matrix receipt does not match the reviewed effect',
    );
  if (reference.step === 'snapshot') {
    const state = await ctx.reader.state(effect.roomId);
    const { z } = await import('zod');
    const events = z.array(TopicMatrixEventSchema).parse(state);
    if (
      !events.some(
        (e) =>
          e.event_id === event.event_id &&
          e.state_key === effect.stateKey &&
          e.type === effect.eventType,
      )
    )
      throw new ActionProposalConflict(
        'Topic snapshot was replaced before verification',
      );
    if (proposal.action.name === 'create_topic') {
      const current = await readTopicAuthority(
        ctx.reader,
        effect.roomId,
        proposal.action.plan.identity.topicId,
        effect.sender,
      );
      if (
        current.authority.revision !==
          proposal.action.plan.identity.operationId ||
        current.authority.contractBodyHash !== proposal.action.plan.bodyHash
      )
        throw new ActionProposalConflict(
          'Created topic is not canonically readable',
        );
    }
  }
  return {
    kind: 'matrix' as const,
    roomId: effect.roomId,
    eventId: event.event_id,
    sender: event.sender,
    eventType: event.type,
    ...(event.state_key !== undefined ? { stateKey: event.state_key } : {}),
    contentDigest: await digestTopicProposalEffect(event.content),
    verifiedAt: new Date().toISOString(),
  };
}
export async function reconcileTopicReferences(
  store: TopicProposalStore,
  p: TopicActionProposal,
  input: TopicReceiptReferences,
  ctx: TopicVerificationContext,
  verificationClaimed = false,
) {
  let newReference = false;
  for (const reference of input.references) {
    newReference ||= !(await store.hasReference(
      p.ownerDid,
      p.id,
      reference.step,
    ));
    await store.recordReference(p.ownerDid, p.id, reference);
  }
  const claimed =
    verificationClaimed || (await store.claimVerification(p.ownerDid, p.id));
  if (!claimed && !newReference)
    return (await store.get(p.ownerDid, p.id)) ?? p;
  ctx.onAttempt?.();
  return withTopicReadBudget(
    ctx.reader,
    ctx.fetcher ?? fetch,
    (reader, fetcher) =>
      reconcileWithinBudget(store, p, input, { ...ctx, reader, fetcher }),
    ctx.signal,
  ).catch(async () => (await store.get(p.ownerDid, p.id)) ?? p);
}
async function reconcileWithinBudget(
  store: TopicProposalStore,
  p: TopicActionProposal,
  input: TopicReceiptReferences,
  ctx: TopicVerificationContext,
) {
  let current = p;
  const all = [
    ...input.references,
    ...(await store.references(p.ownerDid, p.id)).filter(
      (r) => !input.references.some((s) => s.step === r.step),
    ),
  ];
  for (const reference of all) {
    const effect = await store.recordReference(p.ownerDid, p.id, reference);
    try {
      const receipt = await verifyTopicReference(
        current,
        effect,
        reference,
        ctx,
      );
      current = await store.verifyStep(
        p.ownerDid,
        p.id,
        reference.step,
        receipt,
      );
    } catch (error) {
      if (reference.kind === 'chain' && error instanceof Error) {
        if (error.message === TRANSACTION_CARD_BOUND_MISMATCH)
          // The transaction carries THIS card's memo and other messages: an
          // effect the owner bound to the card went wrong. It stays listed
          // and the card is blocked, never re-permitted over it.
          await store.blockExecution(p.ownerDid, p.id, error.message);
        else if (TRANSACTION_REJECTIONS.has(error.message))
          // Provably another transaction (the chain holds it under another
          // card's memo or none): set aside so the owner can record the
          // right one.
          await store.rejectReference(p.ownerDid, p.id, reference);
      }
      // A read that failed or a transaction not indexed yet is retried on
      // the cooldown.
      current = (await store.get(p.ownerDid, p.id)) ?? current;
    }
  }
  return current;
}
