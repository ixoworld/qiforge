import { describe, it, expect } from 'vitest';
import { bech32 } from '@scure/base';
import {
  prepareCreatePlan,
  materializeCreateStep,
} from '../src/topic-create-plan.js';
import {
  TopicProposalV2Schema,
  digestTopicProposal,
  assertTopicProposalUnchanged,
  TopicActionOutcomeSchema,
  TopicReceiptReferencesSchema,
} from '../src/topic-proposals.js';
import { buildTopicGrant, decodeTopicGrant } from '../src/topic-grants.js';
import protobuf from 'protobufjs/minimal.js';
import {
  SubmitClaimAuthorization,
  SubmitClaimConstraints,
  EvaluateClaimAuthorization,
  EvaluateClaimConstraints,
} from '@ixo/impactxclient-sdk/module/codegen/ixo/claims/v1beta1/authz.js';
const owner = bech32.encodeFromBytes('ixo', new Uint8Array(20).fill(1));
const grantee = bech32.encodeFromBytes('ixo', new Uint8Array(20).fill(2));
const admin = bech32.encodeFromBytes('ixo', new Uint8Array(20).fill(3));
const actor = `@did-ixo-${owner}:mx.test`;
const id = 'ap_01234567-0123-4123-8123-0123456789ab';
async function subject() {
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
      createdAt: '2026-10-18T10:00:00.000Z',
      transactionIdPrefix: 'qa_abc',
    },
    evaluationTime: {
      at: '2026-10-18T10:00:00.000Z',
      source: 'server',
      trusted: true,
    },
    encrypted: true,
    proposalId: id,
  });
  return {
    v: 2 as const,
    id,
    ownerDid: `did:ixo:${owner}`,
    title: 'Discuss the harvest',
    origin: { sessionId: '$session', runId: 'run', invocationId: 'run:call' },
    action: {
      name: 'create_topic' as const,
      schemaVersion: '1' as const,
      network: 'testnet' as const,
      roomId: '!room:mx.test',
      owner: {
        did: `did:ixo:${owner}`,
        matrixUserId: actor,
        homeserver: 'https://mx.test',
        bindingDigest: 'a'.repeat(64),
      },
      participants: [
        {
          did: `did:ixo:${owner}`,
          matrixUserId: actor,
          homeserver: 'https://mx.test',
          bindingDigest: 'a'.repeat(64),
        },
      ],
      plan,
      dependencies: [
        { kind: 'matrix' as const, key: 'power', digest: 'b'.repeat(64) },
      ],
    },
    evidenceRefs: ['source'],
    createdAt: '2026-10-18T10:00:00.000Z',
    expiresAt: '2026-10-18T10:15:00.000Z',
  };
}
describe('durable topic contract', () => {
  it('freezes canonical rc7 body and transport-only references', async () => {
    const s = await subject();
    const digest = await digestTopicProposal(s);
    const p = TopicProposalV2Schema.parse({
      ...s,
      digest,
      lifecycle: {
        status: 'prepared',
        steps: [
          { step: 'anchor', status: 'pending' },
          { step: 'body', status: 'pending' },
          { step: 'operation', status: 'pending' },
          { step: 'snapshot', status: 'pending' },
        ],
      },
    });
    expect(await assertTopicProposalUnchanged(p)).toEqual(p);
    const anchor = await materializeCreateStep(s.action.plan, 'anchor', {});
    expect(anchor.content['ixo.action_proposal']).toEqual({
      v: 1,
      proposalId: id,
      operationId: s.action.plan.identity.operationId,
    });
    const body = await materializeCreateStep(s.action.plan, 'body', {
      rootEventId: '$root',
    });
    expect(body.content.contract).toEqual(s.action.plan.body);
    await expect(
      assertTopicProposalUnchanged({
        ...p,
        action: { ...p.action, roomId: '!other:mx.test' },
      }),
    ).rejects.toThrow();
    await expect(
      assertTopicProposalUnchanged({
        ...p,
        action: {
          ...p.action,
          plan: {
            ...s.action.plan,
            draft: { ...s.action.plan.draft, title: 'Different' },
          },
        },
      }),
    ).rejects.toThrow();
  });
  it('requires real receipts on terminal outcomes and accepts read-only reconciliation', () => {
    expect(
      TopicReceiptReferencesSchema.parse({ v: 2, references: [] }),
    ).toEqual({ v: 2, references: [] });
    expect(() =>
      TopicActionOutcomeSchema.parse({
        v: 2,
        status: 'succeeded',
        proposalId: id,
        digest: 'a'.repeat(64),
      }),
    ).toThrow();
  });
});
describe('exact owner grants', () => {
  const common = {
    ownerAddress: owner,
    entityDid: 'did:ixo:entity:123',
    adminAddress: admin,
    granteeAddress: grantee,
    collectionId: 'target',
    agentQuota: '7',
    expiresAt: '2027-10-18T10:00:00.000Z',
  };
  it('replaces target quota exactly once while preserving unrelated Submit constraints', () => {
    const prior = SubmitClaimAuthorization.fromPartial({
      admin,
      constraints: [
        SubmitClaimConstraints.fromJSON({
          collectionId: 'target',
          agentQuota: '2',
        }),
        SubmitClaimConstraints.fromJSON({
          collectionId: 'other',
          agentQuota: '9',
          maxAmount: [{ denom: 'uixo', amount: '123' }],
          memberAddress: grantee,
        }),
      ],
    });
    const message = buildTopicGrant({
      ...common,
      role: 'submit',
      existing: {
        typeUrl: '/ixo.claims.v1beta1.SubmitClaimAuthorization',
        valueBase64: Buffer.from(
          SubmitClaimAuthorization.encode(
            prior,
            new protobuf.Writer(),
          ).finish(),
        ).toString('base64'),
      },
    });
    const decoded = decodeTopicGrant(message);
    const authorization = SubmitClaimAuthorization.decode(
      decoded.message.value.grant!.authorization!.value,
    );
    expect(authorization.constraints.map((c) => c.collectionId)).toEqual([
      'target',
      'other',
    ]);
    expect(authorization.constraints[0]!.agentQuota.toString()).toBe('7');
    expect(
      SubmitClaimConstraints.encode(
        authorization.constraints[1]!,
        new protobuf.Writer(),
      ).finish(),
    ).toEqual(
      SubmitClaimConstraints.encode(
        prior.constraints[1]!,
        new protobuf.Writer(),
      ).finish(),
    );
    expect(decoded.review.expiresAt).toBe(common.expiresAt);
  });
  it('preserves evaluator claim-only constraints and fixed beforeDate', () => {
    const prior = EvaluateClaimAuthorization.fromPartial({
      admin,
      constraints: [
        EvaluateClaimConstraints.fromJSON({
          collectionId: 'target',
          agentQuota: '2',
        }),
        EvaluateClaimConstraints.fromJSON({
          claimIds: ['claim-a'],
          agentQuota: '9',
          maxCustomAmount: [{ denom: 'uixo', amount: '123' }],
        }),
      ],
    });
    const msg = buildTopicGrant({
      ...common,
      role: 'evaluate',
      beforeDate: '2027-09-18T10:00:00.000Z',
      existing: {
        typeUrl: '/ixo.claims.v1beta1.EvaluateClaimAuthorization',
        valueBase64: Buffer.from(
          EvaluateClaimAuthorization.encode(
            prior,
            new protobuf.Writer(),
          ).finish(),
        ).toString('base64'),
      },
    });
    const decoded = decodeTopicGrant(msg);
    const authorization = EvaluateClaimAuthorization.decode(
      decoded.message.value.grant!.authorization!.value,
    );
    expect(authorization.constraints).toHaveLength(2);
    expect(
      EvaluateClaimConstraints.encode(
        authorization.constraints[1]!,
        new protobuf.Writer(),
      ).finish(),
    ).toEqual(
      EvaluateClaimConstraints.encode(
        prior.constraints[1]!,
        new protobuf.Writer(),
      ).finish(),
    );
    expect(decoded.review.role).toBe('evaluate');
    expect(() => buildTopicGrant({ ...common, role: 'evaluate' })).toThrow(
      'beforeDate',
    );
  });
  it('rejects malformed nested protobufs and bad checksummed accounts', () => {
    expect(() =>
      buildTopicGrant({ ...common, role: 'submit', granteeAddress: 'ixo1bad' }),
    ).toThrow();
    expect(() =>
      buildTopicGrant({
        ...common,
        role: 'submit',
        existing: {
          typeUrl: '/ixo.claims.v1beta1.SubmitClaimAuthorization',
          valueBase64: '////',
        },
      }),
    ).toThrow();
  });
});

it('rejects digest-consistent but mismatched declared participants at the boundary', async () => {
  const s = await subject();
  const forged = { ...s, action: { ...s.action, participants: [] } };
  await expect(
    assertTopicProposalUnchanged({
      ...forged,
      digest: await digestTopicProposal(forged),
      lifecycle: {
        status: 'prepared',
        steps: ['anchor', 'body', 'operation', 'snapshot'].map((step) => ({
          step,
          status: 'pending',
        })),
      },
    }),
  ).rejects.toThrow('participant');
});

it('preserves same-collection member and claim-specific constraints when replacing a collection-wide grant', () => {
  const common = {
    ownerAddress: owner,
    entityDid: 'did:ixo:entity:123',
    adminAddress: admin,
    granteeAddress: grantee,
    collectionId: 'target',
    agentQuota: '7',
    expiresAt: '2027-10-18T10:00:00.000Z',
  };
  const member = SubmitClaimConstraints.fromJSON({
    collectionId: 'target',
    agentQuota: '0',
    memberAddress: grantee,
    maxAmount: [{ denom: 'uixo', amount: '12' }],
  });
  const submit = SubmitClaimAuthorization.fromPartial({
    admin,
    constraints: [member],
  });
  const submitMessage = buildTopicGrant({
    ...common,
    role: 'submit',
    existing: {
      typeUrl: '/ixo.claims.v1beta1.SubmitClaimAuthorization',
      valueBase64: Buffer.from(
        SubmitClaimAuthorization.encode(submit, new protobuf.Writer()).finish(),
      ).toString('base64'),
    },
  });
  const decodedSubmit = SubmitClaimAuthorization.decode(
    decodeTopicGrant(submitMessage).message.value.grant!.authorization!.value,
  );
  expect(SubmitClaimConstraints.toJSON(decodedSubmit.constraints[1]!)).toEqual(
    SubmitClaimConstraints.toJSON(member),
  );
  const claim = EvaluateClaimConstraints.fromJSON({
    collectionId: 'target',
    claimIds: ['specific'],
    agentQuota: '2',
  });
  const evaluate = EvaluateClaimAuthorization.fromPartial({
    admin,
    constraints: [claim],
  });
  const evaluateMessage = buildTopicGrant({
    ...common,
    role: 'evaluate',
    beforeDate: '2027-10-17T10:00:00.000Z',
    existing: {
      typeUrl: '/ixo.claims.v1beta1.EvaluateClaimAuthorization',
      valueBase64: Buffer.from(
        EvaluateClaimAuthorization.encode(
          evaluate,
          new protobuf.Writer(),
        ).finish(),
      ).toString('base64'),
    },
  });
  const decodedEvaluate = EvaluateClaimAuthorization.decode(
    decodeTopicGrant(evaluateMessage).message.value.grant!.authorization!.value,
  );
  expect(
    EvaluateClaimConstraints.toJSON(decodedEvaluate.constraints[1]!),
  ).toEqual(EvaluateClaimConstraints.toJSON(claim));
});
