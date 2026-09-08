/**
 * Test-only Worker entry for the vitest Workers pool. It exposes the Durable
 * Object classes the unit tests drive directly through `env.*` bindings.
 *
 * Each subsystem owns its own test DO (kept next to the code it exercises):
 *   - `src/sqlite/test-do.ts`  → `SqliteTestDO`  (wa-sqlite over DO storage)
 *   - `src/tasks/test-do.ts`   → `TasksTestDO`   (task scheduler over real SQLite)
 *   - `src/realtime/test-do.ts` → `RealtimeTestDO` (socket.io endpoint over real WebSockets)
 */
export { SqliteTestDO } from '../src/sqlite/test-do';
export { TasksTestDO } from '../src/tasks/test-do';
export { RealtimeTestDO } from '../src/realtime/test-do';

export default {
  async fetch(): Promise<Response> {
    return new Response('oracle-runtime-workers test worker', { status: 200 });
  },
};
