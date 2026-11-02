/**
 * The user-wide view of runs: which of the user's chats are busy right now
 * (`GET /runs/active`, and `activeRun` on the rows of `GET /sessions`).
 * Task runs (`task:<id>` sessions) are not chats and stay out, as they stay
 * out of the session list; Matrix and channel runs are the user's chats
 * whichever client sent the message, and are in.
 */
import type { FrontendWaitingFor } from '../plugin-api/types';
import { TASK_SESSION_PREFIX } from '../tasks/scheduler';
import type { RunSummary, SessionSummary } from './contracts';
import { runSummaryOf } from './run-request';
import { ACTIVE_RUN_STATUSES, type RunRecord } from './run-store';

/**
 * Every active (queued / running / recovering) chat run, oldest first (run
 * id breaks a tie). `live` are the coordinator's records, `stored` the
 * store's active rows (`RunStore.listActive()`): a run in both is listed
 * once with its live record, which is ahead of the row between writes (a
 * dequeued run is `running` in memory before its row says so). After a boot
 * whose recovery scan succeeded every active row is live and the host
 * passes no `stored` rows: a run leaves the live map before its row is
 * closed, so a row read then would still say it runs.
 */
export function activeChatRuns(
  live: Iterable<RunRecord>,
  stored: Iterable<RunRecord>,
): RunRecord[] {
  const byRunId = new Map<string, RunRecord>();
  for (const record of stored) byRunId.set(record.runId, record);
  for (const record of live) byRunId.set(record.runId, record);
  return [...byRunId.values()]
    .filter(
      (record) =>
        ACTIVE_RUN_STATUSES.has(record.status) &&
        !record.sessionId.startsWith(TASK_SESSION_PREFIX),
    )
    .sort(
      (a, b) =>
        (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0) ||
        a.runId.localeCompare(b.runId),
    );
}

/** The room a run's stored request names (`turn.roomId`), if any. */
export function storedTurnRoomId(request: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(request);
  } catch {
    return undefined;
  }
  const turn: unknown =
    typeof parsed === 'object' && parsed !== null
      ? Reflect.get(parsed, 'turn')
      : undefined;
  const roomId: unknown =
    typeof turn === 'object' && turn !== null
      ? Reflect.get(turn, 'roomId')
      : undefined;
  return typeof roomId === 'string' ? roomId : undefined;
}

/**
 * The runs of the chats `GET /sessions` lists: with a main oracle room, only
 * sessions in that room (`sessionRooms`: the room of each run's session
 * that has a row). A run whose session has no row yet — a Matrix thread is
 * recorded inside its first attempt — is placed by the room its request
 * names; a Portal run without one is listed (the Portal opens its sessions
 * in the main room). Without a main room every chat is listed, as
 * `listSessions` lists every session then. Task runs are already out
 * (`activeChatRuns`).
 */
export function listedChatRuns(
  runs: readonly RunRecord[],
  o: {
    mainRoomId: string | null;
    sessionRooms: ReadonlyMap<string, string | null>;
  },
): RunRecord[] {
  const { mainRoomId, sessionRooms } = o;
  if (mainRoomId === null) return [...runs];
  return runs.filter((run) => {
    if (sessionRooms.has(run.sessionId))
      return sessionRooms.get(run.sessionId) === mainRoomId;
    const roomId = storedTurnRoomId(run.request);
    if (roomId !== undefined) return roomId === mainRoomId;
    return run.client === 'portal';
  });
}

/** `running` before `recovering` before `queued`, as `RunStore.activeForSession` ranks them. */
const STATUS_RANK: Partial<Record<RunRecord['status'], number>> = {
  running: 0,
  recovering: 1,
  queued: 2,
};

/**
 * The run each session is busy with, from `activeChatRuns` (oldest first):
 * the running or recovering one, else the oldest queued one — the run
 * `GET /sessions/:id/run` reports for that session.
 */
export function activeRunBySession(
  runs: readonly RunRecord[],
): Map<string, RunRecord> {
  const bySession = new Map<string, RunRecord>();
  for (const run of runs) {
    const current = bySession.get(run.sessionId);
    if (
      !current ||
      (STATUS_RANK[run.status] ?? 3) < (STATUS_RANK[current.status] ?? 3)
    )
      bySession.set(run.sessionId, run);
  }
  return bySession;
}

/**
 * The session's parked frontend call, if any (`ctx.frontend.parkedFor`):
 * the object's live realtime state, never stored.
 */
export type ParkedCallLookup = (sessionId: string) => FrontendWaitingFor | null;

/**
 * `summary` with `waitingFor` set when the run executes (`running` or
 * `recovering`) and its session has a parked call: only the executing run
 * of a session can have made one. No field at all otherwise (a queued run,
 * a run that is over).
 */
export function withWaitingFor(
  summary: RunSummary,
  parkedFor?: ParkedCallLookup,
): RunSummary {
  if (
    !parkedFor ||
    (summary.status !== 'running' && summary.status !== 'recovering')
  )
    return summary;
  const waitingFor = parkedFor(summary.sessionId);
  return waitingFor ? { ...summary, waitingFor } : summary;
}

/** A run as the user-wide listings report it: without the kept reply text. */
export function activeRunSummaryOf(
  record: RunRecord,
  parkedFor?: ParkedCallLookup,
): RunSummary {
  return withWaitingFor(
    runSummaryOf(record, { withPartialText: false }),
    parkedFor,
  );
}

/**
 * Session rows with `activeRun` set on the ones that have an active run.
 * A row without one gets no field at all (never `null`), so clients that
 * predate it see the rows they always did.
 */
export function withActiveRuns(
  sessions: readonly SessionSummary[],
  runs: readonly RunRecord[],
  parkedFor?: ParkedCallLookup,
): SessionSummary[] {
  const bySession = activeRunBySession(runs);
  return sessions.map((session) => {
    const run = bySession.get(session.sessionId);
    return run
      ? { ...session, activeRun: activeRunSummaryOf(run, parkedFor) }
      : session;
  });
}
