/**
 * What a run row stores so a later incarnation of the user object can
 * rebuild the attempt: the `TurnRequest` (minus attachments — they are in
 * the checkpointed first message) and the stream options the frame producer
 * needs. The browser tool catalogue and the AG-UI action schemas are NOT
 * stored: they live in the graph state (`browserTools` / `agActions`), which
 * a resumed attempt reads back from the checkpoint.
 */
import type { RunSummary, TurnRequest } from './contracts';
import type { RunRecord } from './run-store';

export interface StoredRunRequest {
  turn: Omit<TurnRequest, 'attachments'> & {
    attachments?: TurnRequest['attachments'];
  };
  timezone?: string;
  /** Names the client declared as AG-UI actions (rendered as `action_call`). */
  agActionNames?: string[];
  stream?: boolean;
}

export function storedRunRequest(
  req: TurnRequest,
  extra: Pick<StoredRunRequest, 'timezone' | 'agActionNames' | 'stream'> = {},
): StoredRunRequest {
  const { attachments, ...turn } = req;
  return {
    turn: { ...turn, ...(attachments?.length ? { attachments } : {}) },
    ...(extra.timezone ? { timezone: extra.timezone } : {}),
    ...(extra.agActionNames?.length
      ? { agActionNames: extra.agActionNames }
      : {}),
    ...(extra.stream !== undefined ? { stream: extra.stream } : {}),
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
