/**
 * Standalone mock Memory-Engine MCP server, for runs where the oracle under
 * test lives in another process (the Node runtime, or a wrangler dev started
 * separately): `pnpm exec tsx test/lib/mock-mcp-main.ts [port]`.
 *
 * Test-side inspection over HTTP: `GET /__test/state`, `POST /__test/reset`.
 */
import { startMockMcpServer } from './mock-mcp';

const port = Number(process.argv[2] ?? 34675);
startMockMcpServer(port)
  .then((server) => {
    console.log(`mock memory-engine MCP at ${server.mcpUrl} (${server.did})`);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
