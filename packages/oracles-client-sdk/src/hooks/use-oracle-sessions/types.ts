import type { ChatRunSummary } from '../use-active-runs/types.js';

export interface IChatSession {
  sessionId: string;
  title: string;
  lastUpdatedAt: string;
  createdAt: string;
  oracleName: string;
  roomId?: string;
  /**
   * The run the session was busy with when the list was fetched (absent
   * when none, and on runtimes that predate the field). A snapshot of the
   * list request; `useActiveRuns` is the live view.
   */
  activeRun?: ChatRunSummary;
}
