/**
 * End-to-end test of the MCP plugin path (memory) against the local harness:
 *
 *   pnpm test:e2e:mcp
 *
 * Boots a REAL wire-protocol MCP server in-process (Streamable HTTP via
 * `@modelcontextprotocol/sdk`, stateless mode — see `lib/mock-mcp.ts`; only
 * the memory store behind the tools is fake) and proves, with a real LLM:
 *
 *   1. the memory plugin activates from `MEMORY_MCP_URL` env alone;
 *   2. a chat turn drives `MultiServerMCPClient` INSIDE workerd through the
 *      full handshake (initialize → tools/list → tools/call) and stores a
 *      fact with `add_memory`;
 *   3. every MCP request carries the per-user UCAN invocation headers
 *      (Authorization: Bearer + X-Auth-Type: ucan) minted from the user's
 *      `ixo:memory` delegation — the mint targets the service DID resolved
 *      from the MCP URL's /.well-known/did.json;
 *   4. a FRESH session (empty transcript) recalls the fact — reachable only
 *      through a real `search_memory_engine` MCP round trip.
 */
import assert from 'node:assert/strict';
import { ChatClient } from './lib/chat-client';
import {
  ensureNamedAccount,
  mintAuthInvocation,
  mintDelegation,
} from './lib/harness';
import { ORACLE_DID, provisionDevVars, startOracle } from './lib/oracle';
import { startMockMcpServer } from './lib/mock-mcp';

const MOCK_MCP_PORT = 34675;

const results: Array<{
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}> = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  process.stdout.write(`▶ ${name} … `);
  try {
    const out = await fn();
    results.push({ name, ok: true, ms: Date.now() - start });
    console.log(`ok (${Date.now() - start} ms)`);
    return out;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, ms: Date.now() - start, detail });
    console.log(`FAILED (${Date.now() - start} ms)\n    ${detail}`);
    throw err;
  }
}

async function main(): Promise<void> {
  const mock = await startMockMcpServer(MOCK_MCP_PORT);
  console.log(`mock memory-engine MCP at ${mock.mcpUrl} (${mock.did})`);
  await provisionDevVars({
    signing: true,
    extra: { MEMORY_MCP_URL: mock.mcpUrl, MEMORY_ENGINE_URL: mock.origin },
  });
  const oracle = await startOracle();
  console.log(`oracle at ${oracle.url}`);
  try {
    const user = await ensureNamedAccount('qf-mcp-user');
    const invocation = await mintAuthInvocation(user, ORACLE_DID);
    const delegation = await mintDelegation(user, ORACLE_DID, [
      { can: 'memory/*', with: 'ixo:memory' },
    ]);
    const client = new ChatClient(oracle.url, { invocation, delegation });

    const sessionId = await step('POST /sessions creates a session', () =>
      client.createSession(),
    );

    await step(
      'agent stores a fact through the real MCP wire (add_memory)',
      async () => {
        const r = await client.stream(
          sessionId,
          'Store this fact in your long-term memory using your memory tool: ' +
            '"My favourite sea is the Aegean Sea." ' +
            'After the memory tool reports success, reply with exactly: SAVED',
        );
        assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
        assert.match(r.text, /SAVED/i, `expected SAVED in "${r.text}"`);
        const add = mock.state.toolCalls.find((c) => c.tool === 'add_memory');
        assert.ok(
          add,
          `no add_memory tools/call reached the MCP server; calls: ${JSON.stringify(mock.state.toolCalls)}`,
        );
        assert.match(
          String(add.args.content ?? ''),
          /Aegean/i,
          `stored content: ${JSON.stringify(add.args)}`,
        );
        assert.ok(
          mock.state.requests.some((q) => q.rpcMethods.includes('tools/list')),
          'the client never listed tools',
        );
      },
    );

    await step(
      'every MCP request carried the per-user UCAN headers',
      async () => {
        const mcpRequests = mock.state.requests;
        assert.ok(mcpRequests.length > 0, 'no MCP requests recorded');
        for (const q of mcpRequests) {
          assert.equal(
            q.xAuthType,
            'ucan',
            `x-auth-type missing on ${q.rpcMethods.join(',')}`,
          );
          assert.ok(
            q.authorization?.startsWith('Bearer ') &&
              q.authorization.length > 100,
            `no Bearer UCAN invocation on ${q.rpcMethods.join(',')}`,
          );
        }
      },
    );

    await step(
      'a FRESH session recalls the fact via a real MCP search round trip',
      async () => {
        const before = mock.state.toolCalls.filter(
          (c) => c.tool === 'search_memory_engine',
        ).length;
        const freshSession = await client.createSession();
        const r = await client.stream(
          freshSession,
          'Use your memory search tool to find my favourite sea, ' +
            'then reply with only the name of that sea.',
        );
        assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
        const after = mock.state.toolCalls.filter(
          (c) => c.tool === 'search_memory_engine',
        ).length;
        assert.ok(
          after > before,
          'no search_memory_engine tools/call reached the MCP server',
        );
        // The transcript is empty in this session — "Aegean" can only have
        // come back over the MCP wire.
        assert.match(r.text, /Aegean/i, `expected Aegean in "${r.text}"`);
      },
    );
  } finally {
    await oracle.stop();
    await mock.stop();
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      const logs = oracle.logs();
      if (logs)
        console.error(`\n--- oracle logs (tail) ---\n${logs.slice(-6000)}`);
    }
    console.log('\n=== E2E (MCP / memory plugin) summary ===');
    for (const r of results)
      console.log(
        `${r.ok ? '✔' : '✘'} ${r.name} (${r.ms} ms)${r.detail ? `\n    ${r.detail}` : ''}`,
      );
    console.log(`${results.length - failed.length}/${results.length} passed`);
    if (failed.length) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
