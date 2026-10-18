import { describe, it, expect } from 'vitest';
import protobuf from 'protobufjs/minimal.js';
import fixture from './fixtures/topic-access.json';
import { readTopicAuthority } from './topic-history';
import { prepareTopicSubject } from './topic-prepare';
import { resolveTopicIdentity, type TopicMatrixReader } from './topic-matrix';
import { digestTopicProposalEffect } from './topic-store';
import { assertTopicDependencies } from './topic-verify';
import {
  TopicProposalV2Schema,
  digestTopicProposal,
} from '@ixo/ixo-transaction/topic-proposals';
import { OWNER, SIGNER, RECIPIENT, NOW } from './fixtures/proposal';
import {
  QueryEntityResponse,
  QueryParamsResponse,
} from '@ixo/impactxclient-sdk/module/codegen/ixo/entity/v1beta1/query.js';
import { QueryCollectionResponse } from '@ixo/impactxclient-sdk/module/codegen/ixo/claims/v1beta1/query.js';
import { QueryGrantsResponse } from '@ixo/impactxclient-sdk/module/codegen/cosmos/authz/v1beta1/query.js';
import { QuerySmartContractStateResponse } from '@ixo/impactxclient-sdk/module/codegen/cosmwasm/wasm/v1/query.js';
const ADMIN = SIGNER;
const actor = `@${OWNER.replaceAll(':', '-')}:example.org`;
const recipient = `@did-ixo-${RECIPIENT}:example.org`;
function stateEvents(owner = actor) {
  return [
    {
      event_id: '$create',
      type: 'm.room.create',
      state_key: '',
      sender: owner,
      content: { creator: owner },
    },
    {
      event_id: '$member',
      type: 'm.room.member',
      state_key: owner,
      sender: owner,
      content: { membership: 'join' },
    },
    {
      event_id: '$power',
      type: 'm.room.power_levels',
      state_key: '',
      sender: owner,
      content: { users: { [owner]: 100 }, state_default: 50 },
    },
    {
      event_id: '$encryption',
      type: 'm.room.encryption',
      state_key: '',
      sender: owner,
      content: { algorithm: 'm.megolm.v1.aes-sha2' },
    },
  ];
}
function simpleReader(): TopicMatrixReader {
  return {
    state: async () => stateEvents(),
    event: async () => null,
    history: async () => [],
  };
}
function identityFetch(
  overrides: { owner?: string; indexed?: boolean; badService?: boolean } = {},
): typeof fetch {
  return async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname === 'blocksync.test') {
      const did = JSON.parse(String(init?.body)).variables.id;
      return Response.json({
        data: {
          iids: {
            nodes:
              overrides.indexed === false
                ? []
                : [
                    {
                      id: did,
                      service: [
                        {
                          type: 'MatrixHomeServer',
                          serviceEndpoint: overrides.badService
                            ? 'https://evil.test/path'
                            : 'https://example.org',
                        },
                      ],
                    },
                  ],
          },
        },
      });
    }
    if (u.pathname.endsWith('/status'))
      return Response.json({ result: { node_info: { network: 'pandora-8' } } });
    const method = JSON.parse(u.searchParams.get('path') ?? 'null');
    let value: Uint8Array;
    if (method === '/ixo.entity.v1beta1.Query/Entity')
      value = QueryEntityResponse.encode(
        QueryEntityResponse.fromJSON({
          entity: {
            id: 'did:ixo:entity:test',
            accounts: [{ name: 'admin', address: ADMIN }],
          },
        }),
        new protobuf.Writer(),
      ).finish();
    else if (method === '/ixo.entity.v1beta1.Query/Params')
      value = QueryParamsResponse.encode(
        QueryParamsResponse.fromJSON({
          params: { nftContractAddress: 'ixo1contract' },
        }),
        new protobuf.Writer(),
      ).finish();
    else if (method === '/ixo.claims.v1beta1.Query/Collection')
      value = QueryCollectionResponse.encode(
        QueryCollectionResponse.fromJSON({
          collection: {
            id: 'collection-1',
            entity: 'did:ixo:entity:test',
            admin: ADMIN,
          },
        }),
        new protobuf.Writer(),
      ).finish();
    else if (method === '/cosmwasm.wasm.v1.Query/SmartContractState')
      value = QuerySmartContractStateResponse.encode(
        {
          data: new TextEncoder().encode(
            JSON.stringify({ owner: overrides.owner ?? SIGNER }),
          ),
        },
        new protobuf.Writer(),
      ).finish();
    else if (method === '/cosmos.authz.v1beta1.Query/Grants')
      value = QueryGrantsResponse.encode(
        { grants: [] },
        new protobuf.Writer(),
      ).finish();
    else throw new Error(`Unexpected trusted request ${String(input)}`);
    return Response.json({
      result: {
        response: {
          code: 0,
          height: '123',
          value: btoa(
            Array.from(value, (c) => String.fromCharCode(c)).join(''),
          ),
        },
      },
    });
  };
}
async function canonicalReader() {
  const raw = JSON.parse(
    JSON.stringify(fixture)
      .replaceAll('@alice:example.org', actor)
      .replaceAll('@worker:example.org', recipient),
  );
  const original = raw.bodyHash;
  const hash = `sha256:${await digestTopicProposalEffect(raw.body.content.contract)}`;
  const rebound = JSON.parse(JSON.stringify(raw).replaceAll(original, hash));
  return {
    value: rebound,
    reader: {
      state: async () => [
        ...stateEvents(),
        { ...rebound.snapshot, state_key: rebound.topicId },
      ],
      event: async (_room: string, id: string) =>
        [rebound.root, rebound.body, rebound.operation].find(
          (e) => e.event_id === id,
        ) ?? null,
      history: async () => [rebound.operation],
    } satisfies TopicMatrixReader,
  };
}
describe('canonical topic authority', () => {
  it('authenticates a real Portal producer fixture instead of trusting the projection', async () => {
    const reader: TopicMatrixReader = {
      state: async () => [{ ...fixture.snapshot, state_key: fixture.topicId }],
      event: async (_room, id) =>
        [fixture.root, fixture.body].find((e) => e.event_id === id) ?? null,
      history: async () => [fixture.operation],
    };
    const result = await readTopicAuthority(
      reader,
      fixture.roomId,
      fixture.topicId,
      fixture.owner,
    );
    expect(result.body.claimBinding).toEqual({
      entityDid: 'did:ixo:entity:test',
      collectionId: 'collection-1',
    });
    expect(result.body.roles.map((r) => r.roleId)).toEqual([
      'worker',
      'evaluator',
    ]);
    await expect(
      readTopicAuthority(
        { ...reader, history: async () => [] },
        fixture.roomId,
        fixture.topicId,
        fixture.owner,
      ),
    ).rejects.toThrow('history');
    await expect(
      readTopicAuthority(
        {
          ...reader,
          event: async (_room, id) =>
            id === '$root'
              ? { ...fixture.root, sender: '@attacker:evil.test' }
              : fixture.body,
        },
        fixture.roomId,
        fixture.topicId,
        fixture.owner,
      ),
    ).rejects.toThrow('owner-authored');
  });
  it('prepares a valid discussion through passive reads and rejects changed room policy', async () => {
    const reader = simpleReader();
    const fetcher = identityFetch();
    const s = await prepareTopicSubject(
      {
        action: 'create_topic',
        network: 'testnet',
        roomId: '!room:example.org',
        title: 'Harvest',
        participants: [OWNER],
        roles: [],
        tags: [],
      },
      ['evidence'],
      {
        ownerDid: OWNER,
        sessionId: '$session',
        runId: 'run',
        invocationId: 'run:call',
        blocksync: 'https://blocksync.test/graphql',
        rpc: undefined,
        chainId: 'pandora-8',
        reader,
        fetcher,
        now: NOW,
      },
    );
    expect(s.action.name).toBe('create_topic');
    const p = TopicProposalV2Schema.parse({
      ...s,
      digest: await digestTopicProposal(s),
      lifecycle: {
        status: 'prepared',
        steps: ['anchor', 'body', 'operation', 'snapshot'].map((step) => ({
          step,
          status: 'pending',
        })),
      },
    });
    await expect(
      assertTopicDependencies(p, {
        reader: {
          ...reader,
          state: async () =>
            stateEvents().map((e) =>
              e.type === 'm.room.power_levels'
                ? {
                    ...e,
                    event_id: '$changed',
                    content: { users: { [actor]: 0 } },
                  }
                : e,
            ),
        },
        blocksync: 'https://blocksync.test/graphql',
        rpc: undefined,
        fetcher,
      }),
    ).rejects.toThrow();
    expect(Object.keys(reader)).toEqual(['state', 'event', 'history']);
  });
  it('prepares a real canonical worker grant only for the chain NFT owner', async () => {
    const { reader } = await canonicalReader();
    const fetcher = identityFetch();
    const candidate = {
      action: 'grant_topic_access',
      network: 'testnet',
      roomId: fixture.roomId,
      topicId: fixture.topicId,
      grants: [
        {
          did: `did:ixo:${RECIPIENT}`,
          role: 'submit',
          agentQuota: '5',
          expiresAt: '2027-10-18T10:00:00.000Z',
        },
      ],
    };
    const ctx = {
      ownerDid: OWNER,
      sessionId: '$session',
      runId: 'run',
      invocationId: 'run:grant',
      blocksync: 'https://blocksync.test/graphql',
      rpc: 'https://rpc.test/rpc/',
      chainId: 'pandora-8',
      reader,
      fetcher,
      now: NOW,
    };
    const subject = await prepareTopicSubject(candidate, ['evidence'], ctx);
    expect(subject.action.name).toBe('grant_topic_access');
    if (subject.action.name !== 'grant_topic_access')
      throw new Error('Expected access');
    expect(subject.action.grants[0]?.address).toBe(RECIPIENT);
    expect(
      subject.action.dependencies.some((d) => d.kind === 'nft-owner'),
    ).toBe(true);
    await expect(
      prepareTopicSubject(candidate, ['evidence'], {
        ...ctx,
        fetcher: identityFetch({ owner: RECIPIENT }),
      }),
    ).rejects.toThrow('NFT owner');
  });
  it('rejects missing DID service and never guesses a homeserver', async () => {
    await expect(
      resolveTopicIdentity(
        OWNER,
        'https://blocksync.test/graphql',
        identityFetch({ indexed: false }),
      ),
    ).rejects.toThrow('indexed');
    await expect(
      resolveTopicIdentity(
        OWNER,
        'https://blocksync.test/graphql',
        identityFetch({ badService: true }),
      ),
    ).rejects.toThrow('Matrix service');
    await expect(resolveTopicIdentity(OWNER, undefined)).rejects.toThrow(
      'resolver',
    );
  });
});
