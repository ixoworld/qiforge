import { prepareCreatePlan } from '@ixo/ixo-transaction/topic-create-plan';
import type { TopicProposalSubject } from '@ixo/ixo-transaction/topic-proposals';
import { OWNER, NOW, SIGNER } from './proposal';
export const actor = `@did-ixo-${SIGNER}:mx.test`;
export const executor = { matrixUserId: actor, homeserver: 'https://mx.test' };
export async function subject(): Promise<TopicProposalSubject> {
  const id = `ap_${crypto.randomUUID()}`;
  const plan = await prepareCreatePlan({
    draft: {
      title: 'Discuss the harvest',
      ownerId: actor,
      participants: [{ id: actor }],
      roles: [],
      tags: [],
    },
    roomId: '!room:mx.test',
    actor,
    identity: {
      topicId: 'ixo:topic:0192a751-5234-7123-8123-0123456789ab',
      operationId: 'ixo:topic-operation:0192a751-5234-7123-8123-0123456789ac',
      createdAt: new Date(NOW).toISOString(),
      transactionIdPrefix: 'qa_test',
    },
    evaluationTime: {
      at: new Date(NOW).toISOString(),
      source: 'server',
      trusted: true,
    },
    encrypted: false,
    proposalId: id,
  });
  return {
    v: 2,
    id,
    ownerDid: OWNER,
    title: 'Discuss the harvest',
    origin: { sessionId: '$session', runId: 'run', invocationId: 'run:call' },
    action: {
      name: 'create_topic',
      schemaVersion: '1',
      network: 'testnet',
      roomId: '!room:mx.test',
      owner: { did: OWNER, ...executor, bindingDigest: 'a'.repeat(64) },
      participants: [
        { did: OWNER, ...executor, bindingDigest: 'a'.repeat(64) },
      ],
      plan,
      dependencies: [{ kind: 'matrix', key: 'power', digest: 'b'.repeat(64) }],
    },
    evidenceRefs: ['source'],
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 900000).toISOString(),
  };
}
