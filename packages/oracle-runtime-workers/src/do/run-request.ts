/**
 * What a run row stores so a later incarnation of the user object can
 * rebuild the attempt: the `TurnRequest` (minus attachments — they are in
 * the checkpointed first message), the client-declared tool surface of the
 * turn (browser tools + AG-UI actions: the portal and agui plugins bind
 * them at build time, so an attempt cannot recover them from anywhere
 * else), and the stream options the frame producer needs.
 */
import type { RunSummary, TurnRequest } from './contracts';
import type { RunRecord } from './run-store';
import type { TurnBody } from './turn-body';

/** The client-declared surface of a turn, as the body carries it. */
export type ClientSurfaceBody = Pick<TurnBody, 'tools' | 'agActions'>;

export interface StoredRunRequest extends ClientSurfaceBody {
  turn: Omit<TurnRequest, 'attachments'> & {
    attachments?: TurnRequest['attachments'];
  };
  timezone?: string;
  stream?: boolean;
}

export function storedRunRequest(
  req: TurnRequest,
  extra: Pick<
    StoredRunRequest,
    'timezone' | 'tools' | 'agActions' | 'stream'
  > = {},
): StoredRunRequest {
  const { attachments, ...turn } = req;
  return {
    turn: { ...turn, ...(attachments?.length ? { attachments } : {}) },
    ...(extra.timezone ? { timezone: extra.timezone } : {}),
    ...(extra.tools?.length ? { tools: extra.tools } : {}),
    ...(extra.agActions?.length ? { agActions: extra.agActions } : {}),
    ...(extra.stream !== undefined ? { stream: extra.stream } : {}),
  };
}

/** The surface as the graph state stores it (`browserTools` / `agActions`). */
export interface ClientSurfaceState {
  browserTools?: TurnBody['tools'];
  agActions?: TurnBody['agActions'];
}

/**
 * The client-declared surface of one attempt, by the Node agent-builder's
 * rule: what the body carries, else what the thread's checkpoint holds.
 *
 * `state` feeds the agent build (the portal / agui plugins read it from
 * `history.state`, so it must be complete). `input` is what the graph input
 * writes back to the checkpoint: only what THIS body declared, so a turn
 * without a catalogue (a resumed attempt, a Matrix turn, a task run) never
 * erases the one the client sent earlier.
 */
export function clientSurfaceFor(
  body: ClientSurfaceBody,
  prior: ClientSurfaceState,
): { state: Required<ClientSurfaceState>; input: ClientSurfaceState } {
  return {
    state: {
      browserTools: body.tools ?? prior.browserTools ?? [],
      agActions: body.agActions ?? prior.agActions ?? [],
    },
    input: {
      ...(body.tools !== undefined ? { browserTools: body.tools } : {}),
      ...(body.agActions !== undefined ? { agActions: body.agActions } : {}),
    },
  };
}

export function runSummaryOf(record: RunRecord): RunSummary {
  return {
    runId: record.runId,
    sessionId: record.sessionId,
    requestId: record.requestId,
    client: record.client,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    lastSeq: record.lastSeq,
    ...(record.messageId ? { messageId: record.messageId } : {}),
    ...(record.partialText && record.status !== 'finished'
      ? { partialText: record.partialText }
      : {}),
  };
}
