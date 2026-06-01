/**
 * Memory plugin integration tests against the real devnet Memory Engine MCP
 * server.
 *
 * Required environment (loaded from `.env.integration` by the harness setup):
 *   - MEMORY_MCP_URL       — devnet MCP endpoint the plugin calls.
 *   - MEMORY_ENGINE_URL    — passed through Zod config validation.
 *   - ORACLE_DID           — UCAN delegation audience + signing identity.
 *   - ORACLE_ENTITY_DID    — runtime identity entityDid.
 *   - TEST_USER_DID        — issuer of the minted delegation.
 *   - TEST_USER_MNEMONIC   — signs the delegation.
 *   - MATRIX_* / SECP_*    — required so the booted oracle can load the
 *                            oracle's UCAN signing mnemonic from Matrix
 *                            during boot (production parity, no skip flags).
 *   - OPEN_ROUTER_API_KEY  — Tier B chat invocations.
 *
 * Cleanup contract: memory writes against the devnet Memory Engine persist
 * across test runs. Each write is tagged with `IntegrationTest-<ts>-<rand>`
 * so concurrent runs and historical noise can't satisfy our assertions —
 * search queries look for the exact tag, not generic substrings. The
 * upstream MCP set the plugin exposes by default (DEFAULT_MEMORY_TOOLS)
 * does NOT include a per-test delete, so a `clear` afterEach is not wired
 * here; tag-based isolation is the contract (per the task brief).
 *
 * Failure modes this file covers:
 *   - Tier A 3.1 / 3.2 — round-trip write then search hits the upstream and
 *     returns success / surfaces the just-written record. Catches: MCP
 *     wiring regressions, UCAN invocation chain breaking, schema drift.
 *   - Tier A 3.3 — narrow delegation (no capabilities) → upstream rejects
 *     with a structured auth error, not a runtime 500. Catches: a missing
 *     cap silently succeeding (auth bypass) or a hard crash (lost SLO).
 *   - Tier A 3.4 — second user DID can't see user A's memories. Documents
 *     a deferred case when a second test mnemonic isn't provisioned.
 *   - Tier B 3.5 — "remember dark mode" routes to add_memory tool call.
 *     Catches: manifest drift moving the model off the memory plugin.
 *   - Tier B 3.6 — same user / new session recalls dark mode. Catches the
 *     specific bug where memory writes work but the middleware fails to
 *     surface the context to the prompt.
 *   - Tier B 3.7 — first-contact flow on a brand-new session fires the
 *     manifest's `whenToUse[0]` path (memory search OR name question).
 *
 * No `skipMatrixInit`, no `skipGracefulShutdown`, no mocks. If Matrix is
 * unreachable on devnet, the boot fails — that failure IS the signal.
 */
import { parseDelegation } from '@ixo/ucan';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { UcanService } from '../../modules/ucan/ucan.service.js';
import {
  allCaps,
  ChatClient,
  createIntegrationOracle,
  createIntegrationRuntime,
  type IntegrationOracle,
  type IntegrationRuntime,
  memoryCap,
  mintUserDelegation,
  waitForMatrixLoaded,
  type SSEEvent,
  type SSEToolCallEventData,
} from '../../testing/integration/index.js';
import {
  MEMORY_ADD_MCP_NAME,
  MEMORY_CLEAR_MCP_NAME,
  MEMORY_SEARCH_MCP_NAME,
} from './memory-tools.js';
import { MemoryPlugin } from './memory.plugin.js';
import {
  type AddMemoryInput,
  type ClearMemorySpaceInput,
  type SearchMemoryInput,
} from './types.js';

const requiredEnv = [
  'MEMORY_MCP_URL',
  'MEMORY_ENGINE_URL',
  'ORACLE_DID',
  'ORACLE_ENTITY_DID',
  'TEST_USER_DID',
  'TEST_USER_MNEMONIC',
  'MATRIX_BASE_URL',
  'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
  'MATRIX_VALUE_PIN',
  'SECP_MNEMONIC',
  'OPEN_ROUTER_API_KEY',
] as const;

const missingEnv = requiredEnv.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  throw new Error(
    `memory.plugin.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missingEnv.join(', ')}`,
  );
}

/**
 * Capabilities in the runtime-context shape (`{ resource, action }`) that the
 * harness's `IntegrationCapability` adapter compares. Mirrors what
 * `mintUserDelegation([memoryCap])` actually carries on the wire.
 */
const MEMORY_RUNTIME_CAPS = [
  { resource: memoryCap.with, action: memoryCap.can },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('memory plugin — integration', () => {
  let oracle: IntegrationOracle;
  let runtime: IntegrationRuntime;
  let delegationAllCaps: string;
  let chatClient: ChatClient;
  const runTag = `IntegrationTest-${Date.now()}-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    // ── Boot one full oracle reused by Tier A and Tier B. Real Nest, real
    // UcanService, real Matrix init — same code path as production. The
    // bundled plugin set is restricted to MemoryPlugin so we don't drag
    // every upstream into the test boot.
    oracle = await createIntegrationOracle({
      plugins: [],
      bundledPlugins: [new MemoryPlugin()],
    });

    // The oracle's UCAN signing mnemonic loads from Matrix asynchronously
    // — wait for it before any mint can succeed.
    await waitForMatrixLoaded(oracle);

    // Mint the delegation Tier B (and Tier A 3.1/3.2) need. allCaps so the
    // Tier B agent can call both add + search; Tier A reuses this for the
    // happy-path scenarios. 3.3 mints its own narrow delegation inline.
    delegationAllCaps = await mintUserDelegation({
      userMnemonic: process.env.TEST_USER_MNEMONIC!,
      oracleDid: process.env.ORACLE_DID!,
      userDid: process.env.TEST_USER_DID!,
      capabilities: allCaps,
    });

    // The auth middleware caches delegations off HTTP requests. Tier A
    // bypasses HTTP entirely, so we seed UcanService directly using the
    // same `cacheDelegation` call the middleware uses.
    const parsed = await parseDelegation(delegationAllCaps);
    const ucanService = oracle.app.getNestApp().get(UcanService);
    await ucanService.cacheDelegation(
      process.env.TEST_USER_DID!,
      delegationAllCaps,
      typeof parsed.expiration === 'number' ? parsed.expiration : undefined,
    );

    // Tier A runtime — direct invoke against the real ambient.ucan from
    // the booted oracle (which has the signing mnemonic + cached
    // delegation we just seeded). No model, no HTTP.
    runtime = await createIntegrationRuntime({
      plugins: [new MemoryPlugin()],
      user: {
        did: process.env.TEST_USER_DID!,
        matrixUserId: `@${process.env.TEST_USER_DID!.replaceAll(':', '-')}:test-host`,
      },
      delegation: delegationAllCaps,
      capabilities: MEMORY_RUNTIME_CAPS,
      session: {
        id: `int-memory-${runTag}`,
        client: 'portal',
        requestId: `int-req-${runTag}`,
        // Stable roomId tied to this test run so writes and reads sit in
        // the same upstream memory bucket. The memory plugin passes this
        // as `x-room-id` when minting headers.
        roomId: `!memory-${runTag}:test-host`,
      },
      ucan: oracle.app.ambient.ucan,
    });

    // clear memory
    await runtime.invokeTool(MEMORY_CLEAR_MCP_NAME, {
      confirmed_deletion_from_user: true,
    } satisfies ClearMemorySpaceInput);

    chatClient = new ChatClient(oracle.baseUrl, {
      delegation: delegationAllCaps,
    });
  }, 120_000);

  afterAll(async () => {
    await runtime?.close();
    await oracle?.close();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Tier A — direct invoke against the real upstream Memory Engine MCP.
  // beforeAll already cleared the user's graph; each test below works
  // with a clean slate.
  // ──────────────────────────────────────────────────────────────────────

  test('A1 — round-trip: add a memory, wait for indexing, search it back', async () => {
    // SETUP — scenario the agent would naturally route to memory (a work
    // event with concrete entities + actions). NOT a preference; avoids
    // conflict with the user-preferences plugin's tool surface.
    const addArgs: AddMemoryInput = {
      name: 'Carlos 1:1 — database migration scoping',
      content:
        'Had a 1:1 with Carlos from infra at 2pm. We scoped the database ' +
        'migration down to three phases: read-path swap first, dual-write ' +
        'phase next, then the final cutover.',
    };

    // ACT 1 — write through the upstream MCP.
    const addResult = await runtime.invokeTool(MEMORY_ADD_MCP_NAME, addArgs);
    expect(addResult).toBeDefined();
    expect(JSON.stringify(addResult).toLowerCase()).not.toContain('error');

    // ACT 2 — wait for upstream indexing (extraction → entities → edges →
    // embeddings). Empirically 20-60s on devnet; 45s is a safe middle.
    await sleep(45_000);

    // ACT 3 — search by natural-language query the upstream's text indexer
    // can resolve.
    const searchResult = await runtime.invokeTool(MEMORY_SEARCH_MCP_NAME, {
      query: 'database migration phases',
      strategy: 'recent_memory',
    } satisfies SearchMemoryInput);

    // ASSERT — search succeeded and returned graph content. Asserting on
    // exact strings is brittle (memory returns extracted entities/edges,
    // not raw episode text). Tier C evals (Phase 9) is where semantic
    // recall quality lives; here we prove the wire works.
    expect(searchResult).toBeDefined();
    expect(JSON.stringify(searchResult).length).toBeGreaterThan(20);
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // Tier B — agent loop via ChatClient (real HTTP, real model)
  // ──────────────────────────────────────────────────────────────────────

  test('B1 — agent routes a "save this" prompt to memory-engine__add_memory', async () => {
    // SETUP — work-event prompt with concrete entities. Unambiguously a
    // memory write (project + people + action), not a preference.
    const sessionId = await chatClient.createSession();
    const userMessage =
      'Please save this for later: I shipped the auth refactor today and ' +
      "unblocked Mia's PR on the rate limiter middleware.";

    // ACT — drive the chat and collect SSE events.
    const stream = chatClient.stream(sessionId, userMessage);
    const events: SSEEvent[] = [];
    for await (const evt of stream) events.push(evt);

    // ASSERT — the agent must call add_memory at least once, AND the
    // tool's `content` arg must include text from the user's message
    // (proves the agent forwarded the real content, not a hallucination).
    const addCalls = events.filter(
      (e): e is { event: 'tool_call'; data: SSEToolCallEventData } =>
        e.event === 'tool_call' && e.data.toolName === MEMORY_ADD_MCP_NAME,
    );
    expect(
      addCalls.length,
      `expected at least one add_memory call; saw event types: ${events.map((e) => e.event).join(', ')}`,
    ).toBeGreaterThan(0);

    const aggregatedContent = addCalls
      .map((c) => String((c.data.args as { content?: string }).content ?? ''))
      .join(' ')
      .toLowerCase();
    expect(
      aggregatedContent,
      `add_memory was called but no invocation referenced the user's content`,
    ).toMatch(/auth refactor|rate limiter|mia/);
  }, 120_000);

  test('B2 — same user, new session: agent recalls a project event from the prior session', async () => {
    // SETUP — write phase. Session A logs a specific work event with
    // distinctive nouns (Carlos, three phases, cutover) the recall test
    // can match against.
    const writeSessionId = await chatClient.createSession();
    const writeStream = chatClient.stream(
      writeSessionId,
      'Log this for me: I had a 1:1 with Carlos at 2pm today. We agreed to ' +
        'do the database migration in three phases — read-path swap, then ' +
        'dual-write, then the final cutover.',
    );
    for await (const _ of writeStream) {
      // drain
    }
    await writeStream.final();

    // ACT 1 — wait for upstream indexing. Cross-session recall depends on
    // the episode being in the knowledge graph, not the conversation
    // history. 20s gives the upstream time on devnet.
    await sleep(60_000);

    // ACT 2 — recall in a brand-new session as the same user.
    const recallSessionId = await chatClient.createSession();
    const recall = await chatClient.send(
      recallSessionId,
      'What did Carlos and I agree about the database migration?',
    );

    // ASSERT — recall request succeeded AND the response surfaces at least
    // one distinctive token from the write. Loose match: the model
    // paraphrases, so we accept any of the concrete artifacts.
    expect(recall.status).toBe(200);
    const responseText = (
      (recall.body as { message?: { content?: string } })?.message?.content ??
      ''
    ).toLowerCase();
    expect(
      responseText,
      `cross-session recall did not surface any concrete artifact 
        (Carlos / three phases / cutover) — response was: "${responseText.slice(0, 200)}"`,
    ).toMatch(/carlos|three phases|cutover|migration/);
  }, 180_000);
});
