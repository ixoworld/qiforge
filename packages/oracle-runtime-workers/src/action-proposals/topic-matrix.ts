import { z } from 'zod';
import { boundedBytes } from '../core/domain-context/transport';
import { digestTopicProposalEffect } from './topic-store';
import type { TopicActionProposal } from '@ixo/ixo-transaction/topic-proposals';

export const TopicMatrixEventSchema = z.object({
  event_id: z.string().startsWith('$').max(512),
  type: z.string().min(1),
  state_key: z.string().optional(),
  content: z.record(z.string(), z.unknown()),
  sender: z.string().regex(/^@[^:]+:.+$/),
  room_id: z.string().optional(),
  origin_server_ts: z.number().optional(),
});
export type TopicMatrixEvent = z.infer<typeof TopicMatrixEventSchema>;
export interface TopicMatrixReader {
  state(roomId: string): Promise<unknown>;
  event(roomId: string, eventId: string): Promise<unknown>;
  history(roomId: string, root: string): Promise<unknown>;
}
const DidResponse = z.object({
  data: z.object({
    iids: z.object({
      nodes: z
        .array(
          z.object({
            id: z.string(),
            service: z.array(
              z.object({ type: z.string(), serviceEndpoint: z.string() }),
            ),
          }),
        )
        .max(2),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});
export async function resolveTopicIdentity(
  did: string,
  blocksync: string | undefined,
  fetcher: typeof fetch = fetch,
) {
  if (!blocksync) throw new Error('Trusted DID resolver is unavailable');
  const endpoint = new URL(blocksync);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
    throw new Error('Invalid trusted DID endpoint');
  const response = await fetcher(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query:
        'query TopicIdentity($id:String!){iids(filter:{id:{equalTo:$id}}){nodes{id service}}}',
      variables: { id: did },
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('DID lookup unavailable');
  const raw = DidResponse.parse(
    JSON.parse(new TextDecoder().decode(await boundedBytes(response, 65536))),
  );
  if (raw.errors?.length || raw.data.iids.nodes.length !== 1)
    throw new Error('Identity is not indexed');
  const record = raw.data.iids.nodes[0]!;
  if (record.id !== did) throw new Error('DID lookup mismatch');
  const services = record.service.filter((s) => s.type === 'MatrixHomeServer');
  if (services.length !== 1)
    throw new Error('Exactly one Matrix homeserver is required');
  const url = new URL(services[0]!.serviceEndpoint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    url.port
  )
    throw new Error('Invalid DID Matrix service');
  const homeserver = url.origin;
  const matrixUserId = `@${did.replaceAll(':', '-')}:${url.hostname}`;
  return {
    did,
    matrixUserId,
    homeserver,
    bindingDigest: await digestTopicProposalEffect({
      did,
      service: services[0],
    }),
  };
}
export async function readTopicRoom(
  reader: TopicMatrixReader,
  room: string,
  owner: string,
) {
  const state = z
    .array(TopicMatrixEventSchema)
    .max(2048)
    .parse(await reader.state(room));
  if (
    new Set(state.map((e) => `${e.type}\0${e.state_key ?? ''}`)).size !==
    state.length
  )
    throw new Error('Room state has duplicate keys');
  const membership = state.find(
    (e) => e.type === 'm.room.member' && e.state_key === owner,
  );
  const power = state.find(
    (e) => e.type === 'm.room.power_levels' && e.state_key === '',
  );
  const encryption = state.find(
    (e) => e.type === 'm.room.encryption' && e.state_key === '',
  );
  const creation = state.find(
    (e) => e.type === 'm.room.create' && e.state_key === '',
  );
  if (membership?.content.membership !== 'join' || !power || !creation)
    throw new Error('Owner membership and room policy are unavailable');
  const levels = z
    .object({
      users: z.record(z.string(), z.number()).default({}),
      users_default: z.number().default(0),
      events: z.record(z.string(), z.number()).default({}),
      events_default: z.number().default(0),
      state_default: z.number().default(50),
    })
    .parse(power.content);
  const level = levels.users[owner] ?? levels.users_default;
  for (const type of [
    'm.room.message',
    'ixo.topic.contract.body',
    'ixo.topic.operation',
    'ixo.topic.contract',
  ]) {
    const required =
      levels.events[type] ??
      (type === 'ixo.topic.contract'
        ? levels.state_default
        : levels.events_default);
    if (level < required)
      throw new Error('Owner cannot write the topic event types');
  }
  const selected = [
    creation,
    membership,
    power,
    ...(encryption ? [encryption] : []),
  ];
  const dependencies = await Promise.all(
    selected.map(async (e) => ({
      kind: 'matrix' as const,
      key: `${e.type}\0${e.state_key ?? ''}`,
      digest: await digestTopicProposalEffect(e),
    })),
  );
  if (!encryption)
    dependencies.push({
      kind: 'matrix',
      key: 'm.room.encryption\0',
      digest: await digestTopicProposalEffect(null),
    });
  return { state, dependencies, encrypted: !!encryption };
}
export async function assertTopicRoomUnchanged(
  proposal: TopicActionProposal,
  reader: TopicMatrixReader,
  blocksync: string | undefined,
  fetcher: typeof fetch = fetch,
) {
  const owner = await resolveTopicIdentity(
    proposal.ownerDid,
    blocksync,
    fetcher,
  );
  if (
    owner.bindingDigest !== proposal.action.owner.bindingDigest ||
    owner.matrixUserId !== proposal.action.owner.matrixUserId ||
    owner.homeserver !== proposal.action.owner.homeserver
  )
    throw new Error('Owner Matrix identity changed');
  const current = await readTopicRoom(
    reader,
    proposal.action.roomId,
    owner.matrixUserId,
  );
  for (const dep of proposal.action.dependencies.filter(
    (d) => d.kind === 'matrix',
  ))
    if (
      !current.dependencies.some(
        (d) => d.key === dep.key && d.digest === dep.digest,
      )
    )
      throw new Error('Room authority changed');
  const people =
    proposal.action.name === 'create_topic'
      ? proposal.action.participants
      : proposal.action.grants.map((g) => g.grantee);
  for (const person of people) {
    const binding = await resolveTopicIdentity(person.did, blocksync, fetcher);
    if (
      binding.bindingDigest !== person.bindingDigest ||
      binding.matrixUserId !== person.matrixUserId
    )
      throw new Error('Participant identity changed');
  }
  return current;
}
