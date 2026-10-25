export { MemoryImportTestDO } from '../src/organisation-memory/test-do';
export { ChannelTurnsTestDO } from '../src/channels/test-do';
export { ArtifactStoreTestDO } from '../src/artifacts/test-do';
export { FeedbackTestDO } from '../src/feedback/test-do';
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
export { RunStoreTestDO } from '../src/do/run-store-test-do';
export { ResultStoreTestDO } from '../src/do/result-store-test-do';

/**
 * Stub endpoints behind the `LOOPBACK` service binding (this worker bound to
 * itself), so a test can drive production code through workerd's real
 * `fetch` — its request validation included — instead of a stubbed global.
 * Paths under `/domain-context-stub/` play Blocksync and a document host for
 * the domain-context transport.
 */
async function domainContextStub(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/domain-context-stub/')) return null;
  const redirectTo = (target: string) =>
    new Response(null, {
      status: 302,
      headers: { location: new URL(target, url).href },
    });
  if (path === '/domain-context-stub/graphql' && request.method === 'POST') {
    const body = await request.json<{ variables?: { id?: string } }>();
    const id = body.variables?.id ?? '';
    // An IID without a `#dom` resource: the anchor is missing, not failed.
    return Response.json({
      data: { iids: { nodes: [{ id, linkedResource: [] }] } },
    });
  }
  if (path === '/domain-context-stub/graphql-redirect')
    return redirectTo('/domain-context-stub/graphql');
  if (path === '/domain-context-stub/doc.md')
    return new Response('hello from loopback');
  if (path === '/domain-context-stub/redirect')
    return redirectTo('/domain-context-stub/doc.md');
  return new Response('not found', { status: 404 });
}

export default {
  async fetch(request: Request): Promise<Response> {
    return (
      (await domainContextStub(request)) ??
      new Response('oracle-runtime-workers test worker', { status: 200 })
    );
  },
};
