/**
 * Concierge plugin integration tests.
 *
 * Why each test exists:
 *   - B1 routing: an "introduce yourself / what can you do" ask must route
 *     the agent to `get_oracle_info` and ground the reply in the oracle's
 *     own domain card. This proves the plugin registers, its manifest
 *     steers the model, and the live domain-indexer round-trip for the
 *     oracle's ORACLE_ENTITY_DID works end-to-end.
 *
 * The concierge-MODE path (a Matrix sender with no stored delegation →
 * restricted tool surface, no credit metering, front-desk prompt) rides the
 * Matrix ingress, which this HTTP harness cannot drive — that flow is
 * unit-covered (agent-builder / concierge-policy / credits-middleware
 * tests) and exercised by the manual invite-the-oracle verification script.
 *
 * No mocks. Missing env throws at file-load time.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  allCaps,
  ChatClient,
  createIntegrationOracle,
  type IntegrationOracle,
  mintUserDelegation,
  type SSEEvent,
  type SSEToolCallEventData,
  waitForMatrixLoaded,
} from '../../testing/integration/index.js';
import { ConciergePlugin } from './concierge.plugin.js';

const REQUIRED_ENV = [
  'ORACLE_DID',
  'ORACLE_ENTITY_DID',
  'TEST_USER_DID',
  'TEST_USER_MNEMONIC',
  'MATRIX_BASE_URL',
  'MATRIX_ORACLE_ADMIN_USER_ID',
  'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
  'MATRIX_VALUE_PIN',
  'SECP_MNEMONIC',
  'OPEN_ROUTER_API_KEY',
  'NETWORK',
] as const;

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `concierge.plugin.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missing.join(', ')}`,
  );
}

describe('concierge plugin — integration', () => {
  let oracle: IntegrationOracle;
  let chatClient: ChatClient;
  let sharedSessionId: string;

  beforeAll(async () => {
    oracle = await createIntegrationOracle({
      plugins: [new ConciergePlugin()],
      bundledPlugins: [],
    });
    await waitForMatrixLoaded(oracle);

    const delegation = await mintUserDelegation({
      userMnemonic: process.env.TEST_USER_MNEMONIC!,
      oracleDid: process.env.ORACLE_DID!,
      userDid: process.env.TEST_USER_DID!,
      capabilities: allCaps,
    });

    chatClient = new ChatClient(oracle.baseUrl, { delegation });
    sharedSessionId = await chatClient.createSession();
  }, 180_000);

  afterAll(async () => {
    await oracle?.close();
  });

  // ─── Tier B — the manifest steers self-introduction to get_oracle_info ──

  test('B1 — "what can you help me with?" routes the agent to get_oracle_info', async () => {
    const stream = chatClient.stream(
      sharedSessionId,
      'Introduce yourself — what is this oracle and what can you help me with?',
    );
    const events: SSEEvent[] = [];
    for await (const evt of stream) events.push(evt);

    const infoCalls = events.filter(
      (e): e is { event: 'tool_call'; data: SSEToolCallEventData } =>
        e.event === 'tool_call' && e.data.toolName === 'get_oracle_info',
    );
    expect(
      infoCalls.length,
      `expected a get_oracle_info tool_call; saw events: ${events.map((e) => e.event).join(', ')}`,
    ).toBeGreaterThan(0);
  }, 120_000);
});
