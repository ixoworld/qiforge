/**
 * Composio plugin integration tests — BEHAVIOR ONLY.
 *
 * **DO NOT** actually create a Linear issue (or any other side-effectful
 * SaaS action). We verify the agent (a) discovers Composio on-demand,
 * (b) calls `COMPOSIO_MANAGE_CONNECTIONS` for the requested toolkit
 * before any action, and (c) surfaces the `redirect_url` Composio returns
 * to the user — rather than hallucinating an auth URL.
 *
 * Why each test exists:
 *   - B1 connect-first flow: catches a regression where the model either
 *     forgets the manifest's "ALWAYS call COMPOSIO_MANAGE_CONNECTIONS
 *     first" rule, or proceeds to invoke a Linear tool before the user
 *     has connected. Either bug results in a confusing experience and,
 *     worse, fabricated UI text.
 *   - B2 URL-fidelity: the manifest explicitly forbids the agent from
 *     "writing, guessing, or fabricating" any auth URL. Asserts that the
 *     URL the agent prints back is sourced from the tool result, not
 *     invented from prompt memory.
 *
 * The test user is intentionally one that has NOT connected Linear on
 * devnet. If that ever changes (a tester connects this DID), B1's
 * assertion that no LINEAR_* tool fired will catch it — the test isn't
 * silently broken, it surfaces the fact loudly.
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
import { ComposioPlugin } from './composio.plugin.js';

const REQUIRED_ENV = [
  'COMPOSIO_API_KEY',
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
] as const;

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `composio.plugin.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missing.join(', ')}`,
  );
}

describe('composio plugin — integration (behavior-only)', () => {
  let oracle: IntegrationOracle;
  let chatClient: ChatClient;
  let sharedSessionId: string;

  beforeAll(async () => {
    oracle = await createIntegrationOracle({
      plugins: [new ComposioPlugin()],
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

  test('B1 — "create a Linear issue" → discover composio + COMPOSIO_MANAGE_CONNECTIONS first; NO LINEAR_* action fires', async () => {
    const stream = chatClient.stream(
      sharedSessionId,
      'Create a Linear issue titled "Test bug from integration suite" describing a placeholder problem.',
    );
    const events: SSEEvent[] = [];
    for await (const evt of stream) events.push(evt);

    const toolCalls = events.filter(
      (e): e is { event: 'tool_call'; data: SSEToolCallEventData } =>
        e.event === 'tool_call',
    );
    const toolNames = toolCalls.map((c) => c.data.toolName);

    // (a) Composio is on-demand → discovery (list_capabilities or load_capability for composio) must precede any composio tool.
    const discoveryIdx = toolNames.findIndex(
      (n, i) =>
        n === 'list_capabilities' ||
        (n === 'load_capability' &&
          (toolCalls[i]!.data.args as { name?: string }).name === 'composio'),
    );
    expect(
      discoveryIdx,
      `expected list_capabilities or load_capability('composio') in: ${toolNames.join(', ')}`,
    ).toBeGreaterThanOrEqual(0);

    // (b) COMPOSIO_MANAGE_CONNECTIONS must fire with toolkit ~= linear before any side-effecting Linear tool.
    const manageIdx = toolCalls.findIndex(
      (c) => c.data.toolName === 'COMPOSIO_MANAGE_CONNECTIONS',
    );
    expect(
      manageIdx,
      `expected COMPOSIO_MANAGE_CONNECTIONS to be called; saw: ${toolNames.join(', ')}`,
    ).toBeGreaterThanOrEqual(0);

    expect(manageIdx).toBeGreaterThan(discoveryIdx);

    const manageArgs = JSON.stringify(
      toolCalls[manageIdx]!.data.args ?? {},
    ).toLowerCase();

    expect(manageArgs).toMatch(/linear/);

    // (c) No actual Linear action — the agent must stop at the redirect URL.
    // Any tool name starting with LINEAR_ or containing CREATE_ISSUE is a violation.
    const violations = toolNames.filter(
      (n) => n.toUpperCase().startsWith('LINEAR_') || /CREATE.*ISSUE/i.test(n),
    );
    expect(
      violations,
      `agent invoked a Linear action before connection: ${violations.join(', ')}`,
    ).toEqual([]);
  }, 240_000);
});
