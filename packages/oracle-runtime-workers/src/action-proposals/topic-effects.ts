import {
  materializeCreateStep,
  TopicCreatePlanSchema,
} from '@ixo/ixo-transaction/topic-create-plan';
import {
  ExpectedTopicEffectSchema,
  type TopicActionProposal,
  type TopicStepId,
  type ExpectedTopicEffect,
} from '@ixo/ixo-transaction/topic-proposals';
export const topicIdFromPlan = (plan: unknown): string =>
  TopicCreatePlanSchema.parse(plan).identity.topicId;
export async function topicExpectedEffect(
  proposal: TopicActionProposal,
  step: TopicStepId,
): Promise<ExpectedTopicEffect> {
  const action = proposal.action;
  if (action.name === 'grant_topic_access') {
    if (step !== 'grant') throw new Error('Invalid grant step');
    return {
      kind: 'chain',
      chainId: action.chainId,
      signerAddress: action.signerAddress,
      memo: action.memo,
      messages: action.grants.map((g) => g.message),
    };
  }
  if (step === 'grant') throw new Error('Invalid creation step');
  const verified = (name: TopicStepId) => {
    const s = proposal.lifecycle.steps.find((s) => s.step === name);
    return s?.status === 'verified' && s.receipt.kind === 'matrix'
      ? s.receipt.eventId
      : undefined;
  };
  const effect = await materializeCreateStep(action.plan, step, {
    rootEventId: verified('anchor'),
    bodyEventId: verified('body'),
  });
  const { step: _step, ...wire } = effect;
  return ExpectedTopicEffectSchema.parse({
    ...wire,
    transactionId: wire.transactionId ?? `${proposal.id}:${step}`,
  });
}
