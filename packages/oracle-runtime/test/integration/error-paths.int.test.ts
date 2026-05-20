/**
 * Phase 1 — Runtime error paths.
 *
 * Items the spec calls out (§8 Phase 1, items 1.8–1.11):
 *  - 1.8  upstream returns 5xx mid-tool-call
 *  - 1.9  model emits malformed tool_calls.args (fails Zod parse)
 *  - 1.10 stream aborted mid-flight via POST /messages/abort
 *  - 1.11 server-side request timeout
 *
 * Only 1.10 is deterministic without stub upstreams or scripted model
 * outputs — the rest are documented as `test.skip` with the precise
 * shape of fixture/stub needed to make them deterministic. The spec
 * explicitly allows this ("if you can implement deterministically, do
 * so. If not, write the test file with test.skip placeholders +
 * comments explaining what's needed. Don't fake-pass them.").
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ChatClient,
  createIntegrationOracle,
  mintUserDelegation,
  allCaps,
  type IntegrationOracle,
} from '../../src/testing/integration/index.js';

const REQUIRED_ENV = [
  'MATRIX_BASE_URL',
  'TEST_USER_MNEMONIC',
  'ORACLE_DID',
  'ORACLE_ENTITY_DID',
] as const;
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
const skipReason =
  missing.length > 0 ? `missing env: ${missing.join(', ')}` : undefined;

describe.skipIf(skipReason)('Phase 1 — error paths', () => {
  let oracle: IntegrationOracle | undefined;
  let client: ChatClient | undefined;

  beforeAll(async () => {
    oracle = await createIntegrationOracle({
      plugins: [],
      bundledPlugins: [],
    });
    const delegation = await mintUserDelegation({
      userMnemonic: process.env.TEST_USER_MNEMONIC!,
      oracleDid: process.env.ORACLE_DID!,
      userDid: process.env.TEST_USER_DID!,
      capabilities: allCaps,
    });
    client = new ChatClient(oracle.baseUrl, { delegation });
  }, 60_000);

  afterAll(async () => {
    if (oracle) await oracle.close();
  });

  // 1.10 — Abort an in-flight stream. POST /messages/abort closes the
  // connection on the server side; the SSE iterator returns; a fresh
  // request on the same sessionId works.
  test('1.10 POST /messages/abort closes the stream cleanly', async () => {
    if (!client) throw new Error('client not ready');
    const sessionId = `phase1-abort-${Date.now()}`;

    // Kick off a stream but don't fully drain it. We don't await `.final()` —
    // we expect the abort to terminate the iterator.
    const stream = client.stream(
      sessionId,
      'Tell me an extremely long story about the history of the internet.',
    );
    // Iterate just enough to start receiving events, then call abort.
    const iter = stream[Symbol.asyncIterator]();
    // Give the server a moment to begin streaming before aborting.
    void iter.next();
    await new Promise((r) => setTimeout(r, 250));

    const abortRes = await client.abort(sessionId);
    expect(abortRes.status).toBe(200);

    // Drain whatever the iterator has left; it must not throw — abort is
    // graceful, not a hard error.
    try {
      for await (const _ of stream) {
        // drain
      }
    } catch (err) {
      // Some abort paths surface as a thrown AbortError on the SSE reader;
      // treat that as expected for this scenario.
      const message = err instanceof Error ? err.message : String(err);
      expect(message.toLowerCase()).toMatch(/abort|cancel|closed/);
    }

    // Next request on the same sessionId must work — the abort cleared the
    // in-flight controller, didn't poison the session.
    const followup = await client.send(sessionId, 'Are you still there?');
    expect(followup.status).not.toBe(401);
    // A successful follow-up returns 2xx; if the runtime returns an
    // application-level 4xx for "session not found" or similar, the auth
    // layer at least didn't reject. The contract this test enforces is
    // "abort doesn't break the session for future requests."
    expect(followup.status).toBeLessThan(500);
  }, 60_000);

  // 1.8 — Upstream returns 5xx mid-tool-call. Needs an upstream stub
  // (e.g. `undici.MockAgent` pointed at MEMORY_MCP_URL) so the 5xx is
  // deterministic. Without that the test would either flake on devnet
  // health or never reproduce the failure mode.
  test.skip(
    '1.8 upstream 5xx mid-tool-call surfaces a structured error (DEFERRED — needs MockAgent stub for an upstream)',
    () => {
      // To implement:
      //   1. Spin up `MockAgent` from `undici`, point at SANDBOX_MCP_URL.
      //   2. Boot oracle with sandbox plugin.
      //   3. Set up an interceptor that returns 503 on the next tool call.
      //   4. Send a chat that forces the sandbox tool, assert response
      //      contains an error message but HTTP status is 200 (the runtime
      //      surfaced the error gracefully, didn't 500).
      //   5. Tear down MockAgent.
    },
  );

  // 1.9 — Model emits malformed tool_calls.args. Forcing the model to
  // produce malformed args is non-deterministic; the cheap-test model
  // generally produces well-formed args. A deterministic version would
  // mock the LLM adapter's response — that's unit-test territory, not
  // integration. Defer.
  test.skip(
    '1.9 malformed tool_calls.args returns a structured tool error (DEFERRED — non-deterministic without LLM mock)',
    () => {
      // To implement deterministically: stub `MainAgentHooks.resolveModel`
      // to return a fake model that emits `{ tool_calls: [{ name, args: <bad shape> }] }`.
      // Then verify the runtime catches the Zod parse failure and surfaces
      // it as a tool message, without 500-ing.
    },
  );

  // 1.11 — Server-side request timeout. Currently the runtime does not
  // expose a request-level timeout configuration; the closest reachable
  // behavior is per-request `signal` abort from the client (covered by 1.10).
  // A genuine server-side timeout test needs `MessagesService` to grow a
  // configurable timeout — that's a feature, not a test.
  test.skip(
    '1.11 server-side timeout surfaces a timeout error (DEFERRED — runtime has no server-side timeout knob today)',
    () => {
      // To implement: add a `requestTimeoutMs` env to the runtime,
      // wire it through the messages controller, then verify that a slow
      // tool call gets cut off and the response is a structured timeout.
    },
  );
});
