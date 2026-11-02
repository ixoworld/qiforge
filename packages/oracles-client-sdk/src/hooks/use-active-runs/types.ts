/** Every status a durable run can have on the runtime. */
export type ChatRunStatus =
  | 'queued'
  | 'running'
  | 'recovering'
  | 'finished'
  | 'aborted'
  | 'interrupted'
  | 'failed';

/** The statuses of a run that has not ended: the chat is busy. */
export type ActiveChatRunStatus = 'queued' | 'running' | 'recovering';

/**
 * A durable run as the runtime's user-wide listings report it
 * (`GET /runs/active`, `activeRun` on `GET /sessions` rows): the runtime's
 * `RunSummary` without `partialText`, which only the session's own
 * `GET /sessions/:id/run` carries.
 */
export interface ChatRunSummary {
  runId: string;
  sessionId: string;
  requestId: string;
  /** Which client sent the message: the Portal, a Matrix room, or a channel (WhatsApp, ...). */
  client: 'portal' | 'matrix' | 'channel';
  status: ChatRunStatus;
  /**
   * When the runtime recorded the message's run, unchanged when a queued
   * run starts: a dequeued run's elapsed time includes its wait.
   */
  startedAt: string;
  updatedAt: string;
  /**
   * The run's last frame sequence as its row holds it — written when the
   * run ends, so not a live cursor while it is active (re-join from the
   * `id:` of the last frame seen instead).
   */
  lastSeq: number;
  messageId?: string;
  /**
   * Set while the run is blocked on a call to the user's browser that no
   * browser could take: a browser tool (`browser`) or an AG-UI action
   * (`agui`) of this session that the runtime parked because no socket of
   * the session that can run it is connected — typically the chat is not
   * open in any tab. Opening the chat (which mounts `useWebSocketEvents`
   * for the session) lets the runtime dispatch the parked call, and the
   * run goes on. `toolName` and `since` (ISO time the call was parked)
   * describe the oldest parked call. Computed for each response, never
   * stored: absent when nothing is parked, and absent from a runtime that
   * does not park calls. Use `isWaitingOnUser` rather than reading it
   * directly: it also checks the run is active and the value well formed.
   */
  waitingFor?: ChatRunWaitingFor;
}

/** What an active run is waiting for (`ChatRunSummary.waitingFor`). */
export interface ChatRunWaitingFor {
  /** `browser`: a browser tool call; `agui`: an AG-UI action call. */
  kind: 'browser' | 'agui';
  /** The tool or action the oldest parked call is for. */
  toolName: string;
  /** When that call was parked (ISO 8601). */
  since: string;
}

/** `GET /runs/active`. */
export interface ActiveRunsResponse {
  /** Every active run of the user's chats on this oracle, oldest first. */
  runs: ChatRunSummary[];
}

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set<ActiveChatRunStatus>([
  'queued',
  'running',
  'recovering',
]);

/** Whether a run with this status is still going (`queued`, `running` or `recovering`). */
export function isActiveRunStatus(
  status: string | null | undefined,
): status is ActiveChatRunStatus {
  return typeof status === 'string' && ACTIVE_RUN_STATUSES.has(status);
}

const WAITING_FOR_KINDS: ReadonlySet<string> = new Set<
  ChatRunWaitingFor['kind']
>(['browser', 'agui']);

/**
 * Whether the run is active and waiting for the user to open its chat: a
 * browser tool or AG-UI action call of the session is parked until a
 * browser of the session connects (`ChatRunSummary.waitingFor`). A
 * malformed `waitingFor` (an unknown `kind`, an empty `toolName`, a
 * missing `since`) counts as not waiting, so a host can still show the
 * run as an ordinary active one.
 */
export function isWaitingOnUser<
  T extends Pick<ChatRunSummary, 'status' | 'waitingFor'>,
>(
  run: T | null | undefined,
): run is T & { status: ActiveChatRunStatus; waitingFor: ChatRunWaitingFor } {
  if (!run || !isActiveRunStatus(run.status)) return false;
  const waitingFor: unknown = run.waitingFor;
  return (
    typeof waitingFor === 'object' &&
    waitingFor !== null &&
    'kind' in waitingFor &&
    typeof waitingFor.kind === 'string' &&
    WAITING_FOR_KINDS.has(waitingFor.kind) &&
    'toolName' in waitingFor &&
    typeof waitingFor.toolName === 'string' &&
    waitingFor.toolName.length > 0 &&
    'since' in waitingFor &&
    typeof waitingFor.since === 'string' &&
    waitingFor.since.length > 0
  );
}
