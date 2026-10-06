/** Shared, additive lifecycle contract. Evidence stays out of reaction content. */
export type InteractionState =
  | 'seen'
  | 'accepted'
  | 'working'
  | 'waiting'
  | 'completed'
  | 'achieved'
  | 'failed'
  | 'cancelled'
  | 'superseded';
export interface InteractionAchievement {
  kind: 'artifact' | 'task';
  /** Reference to an outcome verified by host code, never a model assertion. */
  reference: string;
}
export interface OracleInteraction {
  sessionId: string;
  requestId: string;
  runId?: string;
  oracleDid: string;
  oracleUserId: string;
  oracleName: string;
  roomId?: string;
  sourceEventId?: string;
  threadId?: string;
  state: InteractionState;
  revision: number;
  updatedAt: string;
}
export const INTERACTION_EMOJI: Record<InteractionState, string> = {
  seen: '👀',
  accepted: '👍',
  working: '👍',
  waiting: '⏸️',
  completed: '✅',
  achieved: '🎉',
  failed: '⚠️',
  cancelled: '⏹️',
  superseded: '⏹️',
};
export function isTerminalInteraction(state: InteractionState): boolean {
  return [
    'completed',
    'achieved',
    'failed',
    'cancelled',
    'superseded',
  ].includes(state);
}
export function parseOracleInteraction(
  value: unknown,
): OracleInteraction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string' ||
    !('requestId' in value) ||
    typeof value.requestId !== 'string' ||
    !('oracleDid' in value) ||
    typeof value.oracleDid !== 'string' ||
    !('oracleUserId' in value) ||
    typeof value.oracleUserId !== 'string' ||
    !('oracleName' in value) ||
    typeof value.oracleName !== 'string' ||
    !('state' in value) ||
    typeof value.state !== 'string' ||
    !Object.hasOwn(INTERACTION_EMOJI, value.state) ||
    !('revision' in value) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !('updatedAt' in value) ||
    typeof value.updatedAt !== 'string'
  )
    return undefined;
  const state = Object.keys(INTERACTION_EMOJI).find(
    (key): key is InteractionState => key === value.state,
  );
  if (!state) return undefined;
  return {
    sessionId: value.sessionId,
    requestId: value.requestId,
    oracleDid: value.oracleDid,
    oracleUserId: value.oracleUserId,
    oracleName: value.oracleName,
    state,
    revision: value.revision,
    updatedAt: value.updatedAt,
    ...('runId' in value && typeof value.runId === 'string'
      ? { runId: value.runId }
      : {}),
    ...('roomId' in value && typeof value.roomId === 'string'
      ? { roomId: value.roomId }
      : {}),
    ...('sourceEventId' in value &&
    typeof value.sourceEventId === 'string' &&
    value.sourceEventId.startsWith('$')
      ? { sourceEventId: value.sourceEventId }
      : {}),
    ...('threadId' in value && typeof value.threadId === 'string'
      ? { threadId: value.threadId }
      : {}),
  };
}
