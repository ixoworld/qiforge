import { prepareCreatePlan } from '@ixo/ixo-transaction/topic-create-plan';
import { buildTopicGrant } from '@ixo/ixo-transaction/topic-grants';
import type { TopicProposalSubject } from '@ixo/ixo-transaction/topic-proposals';
import { OWNER, NOW, SIGNER, RECIPIENT } from './proposal';
export const actor = `@did-ixo-${SIGNER}:mx.test`;
export const executor = { matrixUserId: actor, homeserver: 'https://mx.test' };
/** A sealed claim-access grant card: the owner grants `RECIPIENT` submit access on one collection. */
export function grantSubject(
  overrides: Partial<TopicProposalSubject['origin']> = {},
  at = NOW,
): TopicProposalSubject {
  const id = `ap_${crypto.randomUUID()}`;
  const granteeDid = `did:ixo:${RECIPIENT}`;
  const expiresAt = new Date(at + 365 * 86400000).toISOString();
  const message = buildTopicGrant({
    role: 'submit',
    ownerAddress: SIGNER,
    entityDid: 'did:ixo:entity:harvest',
    adminAddress: SIGNER,
    granteeAddress: RECIPIENT,
    collectionId: 'col-1',
    agentQuota: '5',
    expiresAt,
  });
  return {
    v: 2,
    id,
    ownerDid: OWNER,
    title: 'Grant topic claim access',
    origin: {
      sessionId: '$session',
      runId: 'run',
      invocationId: `run:${id}`,
      ...overrides,
    },
    action: {
      name: 'grant_topic_access',
      schemaVersion: '1',
      network: 'testnet',
      roomId: '!room:mx.test',
      topicId: 'ixo:topic:0192a751-5234-7123-8123-0123456789ab',
      owner: { did: OWNER, ...executor, bindingDigest: 'a'.repeat(64) },
      authority: {
        rootEventId: '$root',
        contractBodyEventId: '$body',
        operationEventId: '$operation',
        stateEventId: '$state',
        contractBodyHash: `sha256:${'c'.repeat(64)}`,
        revision: 'ixo:topic-operation:0192a751-5234-7123-8123-0123456789ac',
        shapeDigest: 'shape',
      },
      chainId: 'pandora-8',
      signerAddress: SIGNER,
      entityDid: 'did:ixo:entity:harvest',
      adminAddress: SIGNER,
      collectionId: 'col-1',
      grants: [
        {
          grantee: {
            did: granteeDid,
            matrixUserId: `@did-ixo-${RECIPIENT}:mx.test`,
            homeserver: 'https://mx.test',
            bindingDigest: 'a'.repeat(64),
          },
          address: RECIPIENT,
          role: 'submit',
          message,
        },
      ],
      memo: `Qi topic access ${id}`,
      dependencies: [{ kind: 'matrix', key: 'power', digest: 'b'.repeat(64) }],
    },
    evidenceRefs: ['source'],
    createdAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 900000).toISOString(),
  };
}
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
