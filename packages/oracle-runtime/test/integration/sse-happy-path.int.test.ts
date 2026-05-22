/**
 * SSE happy-path integration test.
 *
 * Boots a real oracle, mints a real UCAN delegation, and drives one stream
 * through `ChatClient`. The four assertions guard regressions in the wire
 * contract between `AgentBuilder`, `SseStreamRunner`, and the SDK-mirror
 * SSE parser:
 *
 *   - `x-request-id` header — catches header-wiring drift.
 *   - exactly one terminal `done` event, last in the stream — catches the
 *     `langGraphConfig.version === 'v2'` regression that hangs the client.
 *   - non-empty assistant text — catches AgentBuilder↔SseStreamRunner
 *     contract drift (silently empty streams).
 *   - zero `error` events — catches happy-path regressions that quietly
 *     emit error frames before completing.
 *
 * One oracle, one ChatClient, one shared sessionId across all tests — Tier
 * B convention. Missing env throws at file load, not silently skipped.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  allCaps,
  ChatClient,
  createIntegrationOracle,
  mintUserDelegation,
  waitForMatrixLoaded,
  type IntegrationOracle,
} from '../../src/testing/integration/index.js';

const REQUIRED_ENV = [
  'TEST_USER_MNEMONIC',
  'TEST_USER_DID',
  'ORACLE_DID',
  'ORACLE_ENTITY_DID',
  'MATRIX_BASE_URL',
  'OPEN_ROUTER_API_KEY',
] as const;
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `sse-happy-path.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missing.join(', ')}`,
  );
}

describe('SSE happy path (integration)', () => {
  let oracle: IntegrationOracle;
  let client: ChatClient;
  let sessionId: string;

  beforeAll(async () => {
    oracle = await createIntegrationOracle({
      plugins: [],
      bundledPlugins: [],
    });
    await waitForMatrixLoaded(oracle);

    const delegation = await mintUserDelegation({
      userMnemonic: process.env.TEST_USER_MNEMONIC!,
      userDid: process.env.TEST_USER_DID!,
      oracleDid: process.env.ORACLE_DID!,
      capabilities: allCaps,
    });
    client = new ChatClient(oracle.baseUrl, { delegation });
    sessionId = await client.createSession();
  }, 120_000);

  afterAll(async () => {
    if (oracle) await oracle.close();
  });

  // `ChatClient.stream()` returns a lazy async generator — the underlying
  // fetch + SSE parse only runs when something iterates it, and `.final()`
  // resolves AFTER the iterator drains. Drain explicitly, then read the
  // summary. Sharing one drained stream across the assertions keeps the
  // test cheap (one model call instead of four).
  let final: Awaited<ReturnType<ReturnType<ChatClient['stream']>['final']>>;
  beforeAll(async () => {
    const stream = client.stream(sessionId, 'hello');
    for await (const _ of stream) {
      // drain — events are accumulated inside the generator's closure
    }
    final = await stream.final();
  }, 120_000);

  test('stream response carries x-request-id header', () => {
    expect(typeof final.requestId).toBe('string');
    expect(final.requestId.length).toBeGreaterThan(0);
  });

  test('stream yields exactly one terminal done event', () => {
    const doneEvents = final.events.filter((e) => e.event === 'done');
    expect(doneEvents).toHaveLength(1);
    expect(final.events[final.events.length - 1]?.event).toBe('done');
  });

  test('final assistantText is non-empty', () => {
    expect(final.text.length).toBeGreaterThan(0);
  });

  test('no error events emitted on happy path', () => {
    const errorEvents = final.events.filter((e) => e.event === 'error');
    expect(errorEvents).toHaveLength(0);
  });
});
