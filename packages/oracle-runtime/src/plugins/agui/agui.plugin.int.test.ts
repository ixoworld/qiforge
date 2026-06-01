/**
 * AG-UI plugin integration tests.
 *
 * AG-UI is a per-request plugin: the sub-agent is built ONLY when the
 * client declares `agActions` on the request body. Without them, the
 * plugin contributes nothing and the agent has no rendering tools.
 *
 * Why each test exists:
 *   - B1 with agActions: proves the full client → runtime → sub-agent →
 *     action_call round-trip. The client declares an action, asks the
 *     agent to use it, and the SSE stream surfaces an `action_call`
 *     event (carrying the declared `toolName`) the frontend uses to
 *     render the corresponding component. This is the ONLY way an
 *     oracle ships interactive UI — a regression here breaks every
 *     AG-UI feature in the portal.
 *   - B2 without agActions: inverse — no declared actions ⇒ no
 *     action_call for the declared name. Catches a regression where
 *     the AG-UI sub-agent is mistakenly built for every request (or
 *     where the agent fabricates UI events from cached state).
 *
 * Note: AG-UI's `callAgAction` opens a per-request waiter for the
 * client to round-trip the action result back. Integration tests use
 * a short per-action timeout (15s upstream) — the client doesn't
 * respond, so the action will eventually time out. That's fine: the
 * `action_call` SSE event is emitted BEFORE the result is awaited,
 * so the assertion holds regardless of the timeout outcome.
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
  type SSEActionCallEventData,
  type SSEEvent,
  type SSEToolCallEventData,
  waitForMatrixLoaded,
} from '../../testing/integration/index.js';
import { AGUIPlugin } from './agui.plugin.js';

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
] as const;

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `agui.plugin.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missing.join(', ')}`,
  );
}

const DATA_TABLE_ACTION = {
  name: 'render_data_table',
  description:
    "Render an interactive data table in the user's browser. Use when the user asks for a table view of structured data.",
  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Table title shown above the grid.',
      },
      rows: {
        type: 'array',
        description: 'Array of row objects to display.',
        items: { type: 'object' },
      },
    },
    required: ['title', 'rows'],
    additionalProperties: false,
  },
  hasRender: true,
};

describe('agui plugin — integration', () => {
  let oracle: IntegrationOracle;
  let chatClient: ChatClient;
  let sharedSessionId: string;

  beforeAll(async () => {
    oracle = await createIntegrationOracle({
      plugins: [new AGUIPlugin()],
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

  test('B1 — with declared agActions, the agent invokes the action and SSE emits an action_call for it', async () => {
    const stream = chatClient.stream(
      sharedSessionId,
      'Please render a data table titled "Sample" with these two rows: [{"name":"Alice"},{"name":"Bob"}].',
      { agActions: [DATA_TABLE_ACTION] },
    );
    const events: SSEEvent[] = [];
    for await (const evt of stream) events.push(evt);

    // The `action_call` event is AG-UI's SSE signal — it carries the
    // declared `toolName` (i.e. the action's name) and the args the
    // agent supplied. A render_component event is NOT emitted for
    // sub-agent forwarded tools; clients render by mapping the action
    // name from `action_call` to their declared renderer.
    const actionCalls = events.filter(
      (e): e is { event: 'action_call'; data: SSEActionCallEventData } =>
        e.event === 'action_call',
    );
    expect(
      actionCalls.length,
      `expected at least one action_call event; saw events: ${events.map((e) => e.event).join(', ')}`,
    ).toBeGreaterThan(0);

    // The action_call must carry the action name we declared — proves
    // the SSE payload is sourced from the agui sub-agent's tool call,
    // not from some other path.
    const matching = actionCalls.find(
      (e) => e.data.toolName === DATA_TABLE_ACTION.name,
    );
    expect(
      matching,
      `no action_call fired for "${DATA_TABLE_ACTION.name}"; saw: ${actionCalls.map((e) => e.data.toolName).join(', ')}`,
    ).toBeDefined();

    // The agui sub-agent is on-demand: the agent must invoke
    // call_ag-ui_agent before the action surfaces.
    const toolCalls = events.filter(
      (e): e is { event: 'tool_call'; data: SSEToolCallEventData } =>
        e.event === 'tool_call',
    );
    const aguiInvokeIdx = toolCalls.findIndex((c) =>
      c.data.toolName.toLowerCase().includes('ag-ui'),
    );
    expect(
      aguiInvokeIdx,
      `expected a call_ag-ui_agent (or similar) in: ${toolCalls.map((c) => c.data.toolName).join(', ')}`,
    ).toBeGreaterThanOrEqual(0);
  }, 240_000);

  test('B2 — without agActions, no action_call fires for the declared action name', async () => {
    const stream = chatClient.stream(
      sharedSessionId,
      'Please render a data table titled "Empty Probe" with these rows: [{"a":1}].',
      // No agActions — getRequestSubAgents returns [] for AG-UI, so the
      // plugin contributes nothing this request.
    );
    const events: SSEEvent[] = [];
    for await (const evt of stream) events.push(evt);

    const actionCallsForDeclared = events.filter(
      (e): e is { event: 'action_call'; data: SSEActionCallEventData } =>
        e.event === 'action_call' && e.data.toolName === DATA_TABLE_ACTION.name,
    );
    expect(
      actionCallsForDeclared,
      `action_call fired for "${DATA_TABLE_ACTION.name}" despite no agActions declared; events: ${events.map((e) => e.event).join(', ')}`,
    ).toEqual([]);
  }, 180_000);
});
