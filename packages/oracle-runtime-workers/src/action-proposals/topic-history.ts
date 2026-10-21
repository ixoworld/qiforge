import {
  assertContract,
  resolveEffectiveTopicShape,
  parseTopicOperationPayload,
} from '@ixo/topic-protocol';
import { z } from 'zod';
import { canonicalizeIxoJson } from '@ixo/ixo-transaction/action-proposals';
import type { TopicMatrixReader } from './topic-matrix';
import { TopicMatrixEventSchema, readTopicEvent } from './topic-matrix';
import { digestTopicProposalEffect } from './topic-store';
import { ActionProposalConflict } from './store';

const State = z.object({
  version: z.literal(4),
  topicId: z.string(),
  anchor: z.object({ roomId: z.string(), rootEventId: z.string() }),
  contracts: z.object({
    proposed: z.unknown().optional(),
    effective: z.unknown().optional(),
  }),
  projection: z.object({ revision: z.string(), contractRevision: z.string() }),
  shape: z.object({ digest: z.string() }),
});
const Ref = z.object({
  revision: z.string(),
  bodyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  bodyRef: z.object({
    provider: z.literal('matrix'),
    roomId: z.string(),
    eventId: z.string(),
    contentHash: z.string(),
  }),
});
const Body = z
  .object({
    version: z.literal(4),
    revision: z.string(),
    authoredBy: z.string(),
    kindRef: z.object({
      source: z.literal('standard'),
      kind: z.enum([
        'project',
        'task',
        'agent_task',
        'proposal',
        'evaluation',
        'claims',
        'question',
        'discussion',
        'incident',
      ]),
    }),
    baseRecipe: z.enum([
      'project',
      'flow',
      'proposal',
      'evaluation',
      'claims',
      'research',
      'discussion',
      'incident',
    ]),
    shapeSources: z.array(z.unknown()),
    shapeDigest: z.string(),
    claimBinding: z
      .object({ entityDid: z.string(), collectionId: z.string() })
      .passthrough()
      .optional(),
    roles: z
      .array(z.object({ roleId: z.string(), assignees: z.array(z.string()) }))
      .default([]),
    ownerId: z.string().optional(),
  })
  .passthrough();
const ContractOperation = z.object({
  version: z.literal(2),
  operationId: z.string(),
  topicId: z.string(),
  type: z.enum(['propose-contract', 'update-contract', 'supersede-contract']),
  previousRevision: z.string(),
  actor: z.string(),
  createdAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
  capability: z.string().optional(),
});
export async function readTopicAuthority(
  reader: TopicMatrixReader,
  room: string,
  topicId: string,
  owner: string,
) {
  const stateEvents = z
    .array(TopicMatrixEventSchema)
    .max(2048)
    .parse(await reader.state(room));
  const stateEvent = stateEvents.find(
    (e) => e.type === 'ixo.topic.contract' && e.state_key === topicId,
  );
  if (!stateEvent)
    throw new ActionProposalConflict('Canonical topic state is unavailable');
  const state = State.parse(stateEvent.content);
  if (state.topicId !== topicId || state.anchor.roomId !== room)
    throw new ActionProposalConflict('Topic locator mismatch');
  const root = await readTopicEvent(reader, room, state.anchor.rootEventId);
  if (
    root.sender !== owner ||
    root.type !== 'm.room.message' ||
    root.room_id !== room
  )
    throw new ActionProposalConflict(
      'Only owner-authored topic history is supported',
    );
  const history = z
    .array(TopicMatrixEventSchema)
    .max(256)
    .parse(await reader.history(room, root.event_id));
  const contracts = history
    .filter((e) => e.type === 'ixo.topic.operation')
    .flatMap((event) => {
      const raw = z
        .object({
          operation: z
            .object({ topicId: z.string(), type: z.string() })
            .passthrough(),
        })
        .parse(event.content).operation;
      if (
        raw.topicId !== topicId ||
        !['propose-contract', 'update-contract', 'supersede-contract'].includes(
          raw.type,
        )
      )
        return [];
      const operation = ContractOperation.parse(raw);
      if (
        event.room_id !== room ||
        z
          .object({
            'm.relates_to': z.object({
              rel_type: z.literal('m.reference'),
              event_id: z.literal(root.event_id),
            }),
          })
          .safeParse(event.content).success !== true
      )
        throw new ActionProposalConflict(
          'Topic operation root binding mismatch',
        );
      parseTopicOperationPayload(operation);
      return [{ event, operation }];
    });
  let prior = root.event_id;
  let selected: (typeof contracts)[number] | undefined;
  const remaining = [...contracts];
  while (remaining.length) {
    const next = remaining.filter(
      (e) => e.operation?.previousRevision === prior,
    );
    if (next.length !== 1)
      throw new ActionProposalConflict('Topic history is incomplete or forked');
    const entry = next[0]!;
    const op = entry.operation;
    if (entry.event.sender !== owner || op.actor !== owner)
      throw new ActionProposalConflict(
        'Delegated contract mutation requires an unsupported authority proof',
      );
    if (
      op.payload.previousRevision !== prior &&
      op.payload.topicPreviousRevision !== prior
    )
      throw new ActionProposalConflict('Topic operation revision mismatch');
    prior = op.operationId;
    selected = entry;
    remaining.splice(remaining.indexOf(entry), 1);
  }
  if (!selected?.operation || prior !== state.projection.contractRevision)
    throw new ActionProposalConflict(
      'Topic projection is not backed by complete contract history',
    );
  const ref = Ref.parse(
    selected.operation.payload.contractRef ??
      selected.operation.payload.contract,
  );
  if (
    ref.revision !== prior ||
    ref.bodyRef.roomId !== room ||
    ref.bodyRef.contentHash !== ref.bodyHash
  )
    throw new ActionProposalConflict('Pinned body reference mismatch');
  const selectedHead = Ref.parse(
    state.contracts.proposed ?? state.contracts.effective,
  );
  if (canonicalizeIxoJson(selectedHead) !== canonicalizeIxoJson(ref))
    throw new ActionProposalConflict(
      'Projection body head differs from authenticated history',
    );
  const bodyEvent = await readTopicEvent(reader, room, ref.bodyRef.eventId);
  if (
    bodyEvent.sender !== owner ||
    bodyEvent.room_id !== room ||
    bodyEvent.type !== 'ixo.topic.contract.body' ||
    z
      .object({ 'm.relates_to': z.object({ event_id: z.string() }) })
      .parse(bodyEvent.content)['m.relates_to'].event_id !== root.event_id
  )
    throw new ActionProposalConflict('Pinned body sender mismatch');
  const body = Body.parse(bodyEvent.content.contract);
  assertContract('topic-contract-body', body);
  const bodyHash = `sha256:${await digestTopicProposalEffect(bodyEvent.content.contract)}`;
  if (
    bodyHash !== ref.bodyHash ||
    body.revision !== prior ||
    body.authoredBy !== owner
  )
    throw new ActionProposalConflict('Pinned body integrity mismatch');
  const shape = resolveEffectiveTopicShape({
    baseRecipe: body.baseRecipe,
    kind: body.kindRef.kind,
    sourceVersion: '1.0.0-rc.7',
  });
  if (
    shape.digest !== body.shapeDigest ||
    shape.digest !== state.shape.digest ||
    canonicalizeIxoJson(shape.sources) !==
      canonicalizeIxoJson(body.shapeSources)
  )
    throw new ActionProposalConflict('Pinned shape is unsupported or changed');
  const authority = {
    rootEventId: root.event_id,
    contractBodyEventId: bodyEvent.event_id,
    operationEventId: selected.event.event_id,
    stateEventId: stateEvent.event_id,
    contractBodyHash: bodyHash,
    revision: prior,
    shapeDigest: shape.digest,
  };
  // The state event is re-emitted by ordinary projection activity; the
  // contract head it points at is what carries authority.
  const { stateEventId: _state, ...pinned } = authority;
  return {
    authority,
    body,
    // The fingerprint is the authority chain's head and the pinned body: a
    // new contract operation changes `authority.revision`, while ordinary
    // activity in the topic thread (a reply, a reaction) does not block the
    // owner's claim.
    dependencies: [
      {
        kind: 'topic' as const,
        key: topicId,
        digest: await digestTopicProposalEffect({ authority: pinned, body }),
      },
    ],
  };
}
