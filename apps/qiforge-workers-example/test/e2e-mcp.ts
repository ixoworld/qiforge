/**
 * End-to-end test of the MCP plugin path (memory) against the local harness:
 *
 *   pnpm test:e2e:mcp
 *   MOCK_MCP_PORT=34676 pnpm test:e2e:mcp   # when 34675 is taken
 *
 * Boots a REAL wire-protocol MCP server in-process (Streamable HTTP via
 * `@modelcontextprotocol/sdk`, stateless mode — see `lib/mock-mcp.ts`; only
 * the memory store behind the tools is fake) and proves, with a real LLM, in
 * this order:
 *
 *   1. the memory plugin activates from `MEMORY_MCP_URL` env alone;
 *   2. a chat turn drives `MultiServerMCPClient` INSIDE workerd through the
 *      full handshake (initialize → tools/list → tools/call) and stores a
 *      fact with `add_memory`;
 *   3. with the batch endpoint serving no memories, a FRESH session recalls
 *      the fact through a real `search_memory_engine` MCP round trip (the
 *      answer carries a reference only that tool prints). The `add_memory`
 *      call invalidated the room's prefetch cache, so this session's gather
 *      is `fresh` and comes back empty — nothing is pre-loaded;
 *   4. a FRESH session's first turn is pre-loaded with the user's memory: a
 *      second memory write invalidates the room again, the runtime POSTs the
 *      engine's `/search-enhanced-batch` once (UCAN headers + `x-room-id`)
 *      and the model answers without a memory tool;
 *   5. every request the memory engine received (MCP, batch and the
 *      session-history upload) carries the
 *      per-user UCAN invocation headers (Authorization: Bearer +
 *      X-Auth-Type: ucan) minted from the user's `ixo:memory` delegation —
 *      the mint targets the service DID resolved from the engine's
 *      /.well-known/did.json — and `x-oracle-entity-did` naming the oracle's
 *      domain entity, which the engine keys every memory space by. The
 *      oracle is provisioned with an entity DISTINCT from its account DID,
 *      so the drill proves the header (and the batch's `oracle_dids`) carry
 *      the entity and never the account.
 */
import assert from 'node:assert/strict';
import { ChatClient } from './lib/chat-client';
import {
  ensureNamedAccount,
  matrixLogin,
  mintAuthInvocation,
  mintDelegation,
} from './lib/harness';
import { ensureUserOracleRoom } from './lib/matrix-room';
import {
  BOT_USER_ID,
  ORACLE_DID,
  ORACLE_ENTITY_DID,
  provisionDevVars,
  startOracle,
  waitForMatrixGateway,
} from './lib/oracle';
import { startMockMcpServer } from './lib/mock-mcp';

const MOCK_MCP_PORT = Number(process.env.MOCK_MCP_PORT ?? 34675);

/** The part of `GET /debug/context` `userContext` this drill reads. */
interface UserContextDebug {
  enabled: boolean;
  room?: string;
  cached?: boolean;
  lastOutcome?: string;
  lastSlots?: Record<string, string>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse `GET /debug/context` into the `userContext` block; throws if malformed. */
function parseUserContextDebug(body: unknown): UserContextDebug {
  const block = isRecord(body) ? body.userContext : undefined;
  if (!isRecord(block) || typeof block.enabled !== 'boolean') {
    throw new Error(
      `/debug/context has no valid userContext block: ${JSON.stringify(body)}`,
    );
  }
  const slots = block.lastSlots;
  return {
    enabled: block.enabled,
    ...(typeof block.room === 'string' ? { room: block.room } : {}),
    ...(typeof block.cached === 'boolean' ? { cached: block.cached } : {}),
    ...(typeof block.lastOutcome === 'string'
      ? { lastOutcome: block.lastOutcome }
      : {}),
    ...(isRecord(slots)
      ? {
          lastSlots: Object.fromEntries(
            Object.entries(slots).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          ),
        }
      : {}),
  };
}

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
    // The memory plugin requires a domain entity; a distinct one lets every
    // assertion below tell it from the account DID.
    distinctEntity: true,
    extra: {
      MEMORY_MCP_URL: mock.mcpUrl,
      MEMORY_ENGINE_URL: mock.origin,
    },
  });
  assert.match(ORACLE_ENTITY_DID, /^did:ixo:entity:[0-9a-f]{32}$/);
  assert.notEqual(ORACLE_ENTITY_DID, ORACLE_DID);
  const oracle = await startOracle();
  console.log(`oracle at ${oracle.url} (entity ${ORACLE_ENTITY_DID})`);
  try {
    const user = await ensureNamedAccount('qf-mcp-user');
    const invocation = await mintAuthInvocation(user, ORACLE_DID);
    const delegation = await mintDelegation(user, ORACLE_DID, [
      { can: 'memory/*', with: 'ixo:memory' },
    ]);
    const client = new ChatClient(oracle.url, { invocation, delegation });
    /** The `userContext` block of `GET /debug/context` for one session. */
    const readUserContextDebug = async (
      sid: string,
    ): Promise<UserContextDebug> => {
      const res = await fetch(
        `${oracle.url}/debug/context?session=${encodeURIComponent(sid)}`,
        { headers: client.headers() },
      );
      assert.equal(res.status, 200, await res.clone().text());
      return parseUserContextDebug(await res.json());
    };

    // Every memory-engine call carries the user↔oracle room (`x-room-id`);
    // the prefetch is skipped without one. In production the rooms
    // appservice creates it; on the harness the user does. The gateway maps
    // the room through its alias, which names the oracle's entity.
    await step('the user↔oracle room exists and the bot is in it', async () => {
      const session = await matrixLogin(user.matrixUserId, user.matrixPassword);
      await ensureUserOracleRoom({
        session,
        userDid: user.did,
        oracleDid: ORACLE_ENTITY_DID,
        botUserId: BOT_USER_ID,
        roomName: 'qf-mcp-user ↔ QiForge Workers',
      });
      await waitForMatrixGateway(oracle.url);
    });

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
      'a FRESH session recalls the fact via a real MCP search round trip',
      async () => {
        // `add_memory` invalidated the room's prefetch cache, so this
        // session gathers afresh — and gets nothing, because the batch
        // endpoint serves no memories here. The lookup reference is printed
        // by the search tool alone, so it proves the MCP wire.
        mock.state.batchServesMemories = false;
        const before = mock.state.toolCalls.filter(
          (c) => c.tool === 'search_memory_engine',
        ).length;
        const freshSession = await client.createSession();
        const r = await client.stream(
          freshSession,
          'Use your memory search tool to find my favourite sea, ' +
            'then reply with the name of that sea followed by the ' +
            '"Lookup reference" value the tool returned.',
        );
        assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
        const after = mock.state.toolCalls.filter(
          (c) => c.tool === 'search_memory_engine',
        ).length;
        assert.ok(
          after > before,
          'no search_memory_engine tools/call reached the MCP server',
        );
        assert.match(r.text, /Aegean/i, `expected Aegean in "${r.text}"`);
        assert.ok(
          r.text.includes(mock.state.lookupReference),
          `expected ${mock.state.lookupReference} in "${r.text}"`,
        );
      },
    );

    await step(
      "a FRESH session's first turn is pre-loaded with the user's memory",
      async () => {
        mock.state.batchServesMemories = true;
        // The previous step left an empty answer in the room's cache (kept
        // 30 s); a second memory write drops it, as any write does.
        const w = await client.stream(
          sessionId,
          'Store this fact in your long-term memory using your memory tool: ' +
            '"My favourite mountain is Mount Olympus." ' +
            'After the memory tool reports success, reply with exactly: SAVED',
        );
        assert.equal(w.status, 200, `status ${w.status}: ${w.text}`);
        assert.match(w.text, /SAVED/i, `expected SAVED in "${w.text}"`);
        assert.equal(
          mock.state.memories.length,
          2,
          `expected two stored memories, got ${JSON.stringify(mock.state.memories)}`,
        );

        const batchRequests = () =>
          mock.state.requests.filter(
            (q) => q.pathname === '/search-enhanced-batch',
          );
        const searchCalls = () =>
          mock.state.toolCalls.filter((c) => c.tool === 'search_memory_engine')
            .length;
        const batchesBefore = batchRequests().length;
        const searchesBefore = searchCalls();

        const preloaded = await client.createSession();
        const r = await client.stream(
          preloaded,
          'Without using any tool, what is my favourite sea? ' +
            'Reply with only its name.',
        );
        assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);

        // Read the prefetch status first: it says what the turn was given.
        const userContext = await readUserContextDebug(preloaded);
        assert.match(
          r.text,
          /Aegean/i,
          `expected Aegean in "${r.text}" (prefetch: ${JSON.stringify(userContext)}; batches so far: ${batchRequests().length})`,
        );

        const batches = batchRequests().slice(batchesBefore);
        assert.equal(
          batches.length,
          1,
          `expected one /search-enhanced-batch request, got ${batches.length}`,
        );
        const batch = batches[0];
        assert.ok(batch, 'no /search-enhanced-batch request recorded');
        assert.equal(batch.xAuthType, 'ucan');
        assert.ok(
          batch.authorization?.startsWith('Bearer ') &&
            batch.authorization.length > 100,
          'the batch request carried no Bearer UCAN invocation',
        );
        assert.ok(batch.xRoomId, 'the batch request carried no x-room-id');
        assert.equal(
          batch.xOracleEntityDid,
          ORACLE_ENTITY_DID,
          'the batch request did not name the oracle entity',
        );
        assert.equal(batch.queryCount, 6, 'the batch is the six context slots');
        assert.deepEqual(
          batch.oracleDids,
          Array.from({ length: 6 }, () => [ORACLE_ENTITY_DID]),
          'every batch query searches the oracle entity (oracle_dids), not the account DID',
        );
        assert.equal(
          searchCalls(),
          searchesBefore,
          'the model called search_memory_engine instead of using the pre-loaded context',
        );

        assert.equal(userContext.enabled, true);
        assert.equal(
          userContext.lastOutcome,
          'fresh',
          `the memory write should have invalidated the room's cache: ${JSON.stringify(userContext)}`,
        );
        assert.equal(
          userContext.room,
          batch.xRoomId,
          'the status room is not the room the batch request carried',
        );
        // Both stored memories come back as facts in the identity slot.
        assert.equal(
          userContext.lastSlots?.['identity'],
          'f2/e0/p0/c0',
          `lastSlots: ${JSON.stringify(userContext.lastSlots)}`,
        );
      },
    );

    await step(
      'a gather slower than the cap still fills the room for the next session',
      async () => {
        // A third memory write drops the room's cache; the engine then
        // answers slower than the 3 s cap, so this first contact goes
        // without the block and the gather finishes in the background.
        const w = await client.stream(
          sessionId,
          'Store this fact in your long-term memory using your memory tool: ' +
            '"My favourite river is the Danube." ' +
            'After the memory tool reports success, reply with exactly: SAVED',
        );
        assert.match(w.text, /SAVED/i, `expected SAVED in "${w.text}"`);
        const batchRequests = () =>
          mock.state.requests.filter(
            (q) => q.pathname === '/search-enhanced-batch',
          ).length;
        // Creating a session uploads the previous one to the engine, and an
        // accepted upload drops the room's prefetched context (new history
        // may hold new facts). This step is about the cache, so the mock
        // refuses uploads until the step ends (the runtime gives up after
        // its retries; nothing is retried later).
        mock.state.historyUploads = 'refuse';
        mock.state.batchDelayMs = 5000;
        try {
          const before = batchRequests();
          const slow = await client.createSession();
          const r = await client.stream(
            slow,
            'Without using any tool, what is my favourite river? ' +
              'Reply with only its name.',
          );
          assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
          const during = await readUserContextDebug(slow);
          assert.equal(
            during.lastOutcome,
            'timeout',
            `expected the cap to win: ${JSON.stringify(during)}`,
          );
          assert.equal(batchRequests() - before, 1, 'one gather was started');

          // Past the mock's delay the background gather has landed.
          await sleep(5000 + 2500);
          const after = await readUserContextDebug(slow);
          assert.equal(
            after.lastOutcome,
            'fresh',
            `the late gather did not settle: ${JSON.stringify(after)}`,
          );
          assert.equal(after.cached, true, JSON.stringify(after));
          mock.state.batchDelayMs = 0;

          // The next session is served from that cache: no new request.
          const before2 = batchRequests();
          const next = await client.createSession();
          const r2 = await client.stream(
            next,
            'Without using any tool, what is my favourite river? ' +
              'Reply with only its name.',
          );
          const status = await readUserContextDebug(next);
          assert.match(
            r2.text,
            /Danube/i,
            `expected Danube in "${r2.text}" (prefetch: ${JSON.stringify(status)})`,
          );
          assert.equal(status.lastOutcome, 'cached', JSON.stringify(status));
          assert.equal(batchRequests() - before2, 0, 'served from the cache');
        } finally {
          mock.state.batchDelayMs = 0;
          mock.state.historyUploads = 'accept';
        }
      },
    );

    await step(
      'every memory-engine request carried the per-user UCAN headers and the oracle entity',
      async () => {
        const engineRequests = mock.state.requests;
        assert.ok(engineRequests.length > 0, 'no memory-engine requests');
        assert.ok(
          engineRequests.some((q) => q.pathname === '/mcp') &&
            engineRequests.some((q) => q.pathname === '/search-enhanced-batch'),
          'expected both MCP and batch requests',
        );
        // The session-history indexer uploads the earlier sessions when new
        // ones are created; its upload names the entity like every request.
        // (The cache step above refused its uploads; the earlier steps'
        // were accepted.)
        const uploads = engineRequests.filter(
          (q) => q.pathname === '/messages',
        );
        assert.ok(uploads.length > 0, 'no session-history upload (/messages)');
        assert.ok(
          uploads.some((q) => !q.refused && (q.messageCount ?? 0) > 0),
          'no accepted session-history upload carrying messages',
        );
        for (const upload of uploads) {
          assert.equal(
            upload.xOracleEntityDid,
            ORACLE_ENTITY_DID,
            'the session-history upload did not name the oracle entity',
          );
        }
        for (const q of engineRequests) {
          const what = `${q.pathname} ${q.rpcMethods.join(',')}`;
          assert.equal(q.xAuthType, 'ucan', `x-auth-type missing on ${what}`);
          assert.ok(
            q.authorization?.startsWith('Bearer ') &&
              q.authorization.length > 100,
            `no Bearer UCAN invocation on ${what}`,
          );
          assert.equal(
            q.xOracleEntityDid,
            ORACLE_ENTITY_DID,
            `x-oracle-entity-did is not the oracle entity on ${what}`,
          );
        }
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
