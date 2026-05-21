/**
 * Firecrawl plugin integration tests against the real Firecrawl MCP server.
 *
 * Why each test exists:
 *   - A1 firecrawl_scrape against a stable URL: proves the upstream
 *     Firecrawl MCP server is reachable and that the configured tool name
 *     (`firecrawl__firecrawl_scrape`) actually exists on it. Markdown
 *     coming back is the contract the plugin relies on. A regression in
 *     the MCP transport, the server prefix, or the upstream tool registry
 *     surfaces here.
 *   - B1 routing: an on-demand plugin must be discovered first
 *     (`list_capabilities` or `load_capability`) before its tools are
 *     callable. The Tier B test verifies that flow AND that the agent
 *     ultimately routes a "search the web" prompt through
 *     `call_firecrawl_agent` rather than inventing an answer.
 *
 * Tier A bypasses the plugin's getSubAgents wrapper and exercises the
 * tools the sub-agent uses directly — same upstream call path, no model.
 *
 * No mocks. Missing env throws at file-load time.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
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
import {
  createDefaultFirecrawlMcpFactory,
  createFirecrawlTools,
  FIRECRAWL_SCRAPE_TOOL,
} from './firecrawl-tools.js';
import { FirecrawlPlugin } from './firecrawl.plugin.js';

const REQUIRED_ENV = [
  'FIRECRAWL_MCP_URL',
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
    `firecrawl.plugin.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missing.join(', ')}`,
  );
}

describe('firecrawl plugin — integration', () => {
  // ─── Tier A — direct upstream call (no model) ─────────────────────────

  test('A1 — firecrawl_scrape returns markdown for a stable human-readable URL', async () => {
    const factory = createDefaultFirecrawlMcpFactory(
      process.env.FIRECRAWL_MCP_URL!,
    );
    const [, scrape] = createFirecrawlTools(factory);
    expect(scrape!.name).toBe(FIRECRAWL_SCRAPE_TOOL);

    // example.com is the canonical "always-up, plain HTML, no JS" page used
    // for scraper smoke tests — short, stable, no rate limits.
    const result = await scrape!.handler(
      { url: 'https://example.com', formats: ['markdown'] },
      // The firecrawl tool handler ignores its rtCtx — a minimal context
      // from the test fixtures satisfies the type without booting anything.
      makeRuntimeContext(),
    );

    const text = typeof result === 'string' ? result : JSON.stringify(result);
    // The page's only meaningful content. If the upstream returned anything
    // resembling markdown of example.com, this token shows up.
    expect(text.toLowerCase()).toContain('example domain');
  }, 120_000);

  // ─── Tier B — agent loop with on-demand discovery + dispatch ──────────

  describe('Tier B — agent routing', () => {
    let oracle: IntegrationOracle;
    let chatClient: ChatClient;
    let sharedSessionId: string;

    beforeAll(async () => {
      oracle = await createIntegrationOracle({
        plugins: [new FirecrawlPlugin()],
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

    test('B1 — "search the web for X" discovers firecrawl on-demand and calls call_firecrawl_agent', async () => {
      const stream = chatClient.stream(
        sharedSessionId,
        'Please search the web for current portfolio for www.youssefhany.dev',
      );
      const events: SSEEvent[] = [];
      for await (const evt of stream) events.push(evt);

      const toolCalls = events.filter(
        (e): e is { event: 'tool_call'; data: SSEToolCallEventData } =>
          e.event === 'tool_call',
      );

      const firecrawlInvokeIdx = toolCalls.findIndex(
        (c) => c.data.toolName === 'call_firecrawl_agent',
      );
      expect(
        firecrawlInvokeIdx,
        `expected call_firecrawl_agent in the tool_call stream; saw: ${toolCalls.map((c) => c.data.toolName).join(', ')}`,
      ).toBeGreaterThanOrEqual(0);

      // The on-demand plugin must be discovered before its sub-agent
      // invocation is callable. Either `list_capabilities` or
      // `load_capability({ name: 'firecrawl' })` satisfies that contract.
      const discoveryIdx = toolCalls.findIndex(
        (c) =>
          c.data.toolName === 'list_capabilities' ||
          (c.data.toolName === 'load_capability' &&
            (c.data.args as { name?: string }).name === 'firecrawl'),
      );
      expect(
        discoveryIdx,
        'agent must discover firecrawl (list_capabilities or load_capability) before invoking it',
      ).toBeGreaterThanOrEqual(0);
      expect(discoveryIdx).toBeLessThan(firecrawlInvokeIdx);
    }, 180_000);
  });
});
