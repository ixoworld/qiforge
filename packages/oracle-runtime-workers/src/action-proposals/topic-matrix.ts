import { z } from 'zod';
import { boundedBytes } from '../core/domain-context/transport';
import { digestTopicProposalEffect } from './topic-store';
import { ActionProposalConflict } from './store';
import { TopicReadUnavailable } from './topic-errors';
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
  if (!blocksync)
    throw new TopicReadUnavailable('Trusted DID resolver is unavailable');
  const endpoint = new URL(blocksync);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
    throw new TopicReadUnavailable('Invalid trusted DID endpoint');
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
  if (!response.ok) throw new TopicReadUnavailable('DID lookup unavailable');
  const envelope = DidResponse.safeParse(
    JSON.parse(new TextDecoder().decode(await boundedBytes(response, 65536))),
  );
  // A GraphQL error envelope (`data: null`, `errors`) is the resolver
  // failing, not a fact about the DID.
  if (!envelope.success || envelope.data.errors?.length)
    throw new TopicReadUnavailable('DID lookup unavailable');
  const raw = envelope.data;
  if (raw.data.iids.nodes.length !== 1)
    throw new ActionProposalConflict('Identity is not indexed');
  const record = raw.data.iids.nodes[0]!;
  if (record.id !== did)
    throw new ActionProposalConflict('DID lookup mismatch');
  const services = record.service.filter((s) => s.type === 'MatrixHomeServer');
  if (services.length !== 1)
    throw new ActionProposalConflict(
      'Exactly one Matrix homeserver is required',
    );
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
    throw new ActionProposalConflict('Invalid DID Matrix service');
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
/**
 * One event, parsed. An event the gateway cannot hand over (not decrypted
 * yet, not found) comes back empty: a read that failed, not a fact about the
 * card.
 */
export async function readTopicEvent(
  reader: TopicMatrixReader,
  room: string,
  eventId: string,
) {
  const raw = await reader.event(room, eventId);
  if (raw === null || raw === undefined)
    throw new TopicReadUnavailable('Topic event is not readable');
  return TopicMatrixEventSchema.parse(raw);
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
    throw new TopicReadUnavailable('Room state has duplicate keys');
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
    throw new ActionProposalConflict(
      'The owner is not a member of the room, or its policy is unreadable',
    );
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
      throw new ActionProposalConflict(
        'Owner cannot write the topic event types',
      );
  }
  const selected = [
    creation,
    membership,
    power,
    ...(encryption ? [encryption] : []),
  ];
  // Only the facts that carry authority are fingerprinted: the owner's
  // membership value (not their avatar or display name) and each policy
  // event's content (not the event id a re-send would change).
  const topicTypes = [
    'm.room.message',
    'ixo.topic.contract.body',
    'ixo.topic.operation',
    'ixo.topic.contract',
  ];
  const authority = (e: TopicMatrixEvent) => ({
    type: e.type,
    state_key: e.state_key ?? '',
    content:
      e.type === 'm.room.member'
        ? { membership: e.content.membership }
        : e.type === 'm.room.power_levels'
          ? // Only the owner's level and the thresholds for the topic event
            // types: another member's level changing is not this card's
            // business.
            {
              owner: levels.users[owner] ?? levels.users_default,
              events: Object.fromEntries(
                topicTypes.map((type) => [
                  type,
                  levels.events[type] ??
                    (type === 'ixo.topic.contract'
                      ? levels.state_default
                      : levels.events_default),
                ]),
              ),
            }
          : e.content,
  });
  const dependencies = await Promise.all(
    selected.map(async (e) => ({
      kind: 'matrix' as const,
      key: `${e.type}\0${e.state_key ?? ''}`,
      digest: await digestTopicProposalEffect(authority(e)),
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
    throw new ActionProposalConflict('Owner Matrix identity changed');
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
      throw new ActionProposalConflict('Room authority changed');
  const people =
    proposal.action.name === 'create_topic'
      ? proposal.action.participants
      : proposal.action.grants.map((g) => g.grantee);
  const bindings = await Promise.all(
    people.map((person) =>
      resolveTopicIdentity(person.did, blocksync, fetcher),
    ),
  );
  people.forEach((person, i) => {
    const binding = bindings[i]!;
    if (
      binding.bindingDigest !== person.bindingDigest ||
      binding.matrixUserId !== person.matrixUserId
    )
      throw new ActionProposalConflict('Participant identity changed');
  });
  return current;
}
