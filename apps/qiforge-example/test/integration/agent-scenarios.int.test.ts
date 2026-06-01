/**
 * Cross-plugin agent scenarios — the agentic-glue layer.
 *
 * Each scenario tests something nothing else in the suite catches: the agent
 * STITCHING multiple plugins together on a single user task. Per-plugin tests
 * already prove individual routing decisions; this file proves the chains.
 *
 * Three scenarios, chosen for value:
 *   1. Full skill chain — discover → load → run, with the cid flowing from
 *      one tool's output into the next tool's args. Per-plugin tests cover
 *      each link in isolation; only this one proves the agent threads them.
 *   2. IXO entity routing → memory — "look up IXO X" must hit Domain Indexer
 *      (not Firecrawl) AND chain into memory. Catches manifest drift that
 *      would route IXO lookups to the generic web tool.
 *   3. Preference immediacy — setting a behavioral preference must apply on
 *      the SAME turn AND persist. Per-plugin test only checks the tool fired;
 *      a pref that doesn't kick in immediately is half-broken.
 */
import { EditorPlugin } from '@ixo/oracle-runtime';
import {
  allCaps,
  ChatClient,
  createIntegrationOracle,
  mintUserDelegation,
  waitForMatrixLoaded,
  type IntegrationOracle,
} from '@ixo/oracle-runtime/testing/integration';
import * as sdk from 'matrix-js-sdk';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { WeatherPlugin } from '../../src/plugins/weather/index.js';

const REQUIRED_ENV = [
  'MATRIX_BASE_URL',
  'MATRIX_ORACLE_ADMIN_USER_ID',
  'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
  'TEST_USER_MNEMONIC',
  'TEST_USER_DID',
  'ORACLE_DID',
  'ORACLE_ENTITY_DID',
  'SECP_MNEMONIC',
  'OPEN_ROUTER_API_KEY',
  'MEMORY_MCP_URL',
  'SANDBOX_MCP_URL',
] as const;
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `agent-scenarios.int.test.ts requires the following env vars (see apps/qiforge-example/.env.integration): ${missing.join(', ')}`,
  );
}

interface TranscriptToolCall {
  name: string;
  args: unknown;
  id: string;
  output?: string;
  status?: 'isRunning' | 'done';
}

const flatCalls = (
  messages: Array<{ toolCalls?: TranscriptToolCall[] }>,
): TranscriptToolCall[] => messages.flatMap((m) => m.toolCalls ?? []);

const callNames = (calls: TranscriptToolCall[]): string =>
  calls.map((c) => c.name).join(', ') || '<no tool calls>';

/**
 * `toolCall.output` is the tool's response JSON-stringified TWICE by the
 * transcript transformer: the tool's `toolMsg.content` is already a JSON
 * string, and the transformer wraps it again with `JSON.stringify`. Unwrap
 * both layers, then return the parsed object — caller decides what to read.
 */
const parseToolOutput = (output: string | undefined): unknown => {
  if (!output) return undefined;
  try {
    const once = JSON.parse(output);
    return typeof once === 'string' ? JSON.parse(once) : once;
  } catch {
    return undefined;
  }
};

describe('cross-plugin agent scenarios — integration', () => {
  let oracle: IntegrationOracle;
  let chatClient: ChatClient;

  beforeAll(async () => {
    const matrixClient = sdk.createClient({
      baseUrl: process.env.MATRIX_BASE_URL!,
      userId: process.env.MATRIX_ORACLE_ADMIN_USER_ID!,
      accessToken: process.env.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN!,
    });
    oracle = await createIntegrationOracle({
      config,
      plugins: [new EditorPlugin({ matrixClient }), new WeatherPlugin()],
    });
    // Without this the signing mnemonic isn't bound yet and /messages/* 401s.
    await waitForMatrixLoaded(oracle, 90_000);

    const delegation = await mintUserDelegation({
      userMnemonic: process.env.TEST_USER_MNEMONIC!,
      oracleDid: process.env.ORACLE_DID!,
      userDid: process.env.TEST_USER_DID!,
      capabilities: allCaps,
    });

    chatClient = new ChatClient(oracle.baseUrl, { delegation });
  }, 180_000);

  afterAll(async () => {
    await oracle?.close();
  });

  test('1 — full skill chain: discover → load → run a Invoice skill with the cid threaded through', async () => {
    const sessionId = await chatClient.createSession();
    const { body } = await chatClient.send(
      sessionId,
      'I need to generate an invoice right now to send to a client. Please find a skill that can create an invoice for me with the following details:\n\n- Invoice Number: INV-2043\n- Date: 2024-06-20\n- Bill To: Acme Corp, 123 Main St.\n- Items:\n  - Web Design: $2,000\n  - Hosting (1 year): $120\n  - Support: $300\n- Subtotal: $2,420\n- Tax (10%): $242\n- Total: $2,662\n- Due Date: 2024-07-01\n\nPlease generate the full invoice as a downloadable PDF so I can send it immediately.',
    );

    const calls = flatCalls(body.messages);
    const search = calls.find(
      (c) => c.name === 'search_skills' || c.name === 'list_skills',
    );
    const load = calls.find((c) => c.name === 'load_skill');
    const run = calls.find((c) => c.name === 'sandbox_run');

    expect(
      search,
      `expected a discovery call; saw: ${callNames(calls)}`,
    ).toBeDefined();
    expect(
      load,
      `expected load_skill after discovery; saw: ${callNames(calls)}`,
    ).toBeDefined();
    expect(
      run,
      `expected sandbox_run after load_skill; saw: ${callNames(calls)}`,
    ).toBeDefined();

    // The cid threading is the actual contract — if the agent invents a cid
    // (a hallucination, not a registry result), the chain is broken even
    // though every tool fired.
    const discoveryPayload = parseToolOutput(search!.output) as
      | { skills?: Array<{ cid?: string }> }
      | undefined;
    const discoveredCids = new Set(
      (discoveryPayload?.skills ?? [])
        .map((s) => s.cid)
        .filter((c): c is string => typeof c === 'string'),
    );
    const loadedCid = (load!.args as { cid?: string }).cid;
    const ranCid = (run!.args as { cid?: string }).cid;
    expect(loadedCid, 'load_skill must carry a cid').toBeTruthy();
    expect(
      discoveredCids.has(loadedCid!),
      `load_skill cid "${loadedCid}" not found in discovery output cids: [${[...discoveredCids].join(', ') || 'none'}]`,
    ).toBe(true);
    expect(
      ranCid,
      'sandbox_run must run the same skill the agent just loaded — otherwise the chain is broken',
    ).toBe(loadedCid);
  }, 300_000);

  test('2 — language preference applies on the SAME turn AND persists to the per-room store', async () => {
    const sessionId = await chatClient.createSession();
    const { body } = await chatClient.send(
      sessionId,
      'From now on always answer me in Spanish. Now — in one sentence — what is a vector database?',
    );

    const calls = flatCalls(body.messages);
    const setPref = calls.find((c) => c.name === 'set_user_preferences');
    expect(
      setPref,
      `expected set_user_preferences; saw: ${callNames(calls)}`,
    ).toBeDefined();

    // `language` is free-form (`z.string().max(20)`), so accept the obvious
    // encodings the model might pick.
    const argText = JSON.stringify(setPref!.args ?? {}).toLowerCase();
    expect(argText).toMatch(/spanish|español|"es(-[a-z]{2})?"/);

    // Immediacy — the final assistant message must already be in Spanish,
    // not "OK, I'll switch next turn." Look for Spanish-only function words
    // and common vocabulary that would never form an English answer.
    const assistantText = body.message.content.toLowerCase();
    const spanishMarkers = assistantText.match(
      /\b(una?|el|la|los|las|es|son|para|por|con|del|que|qué|cómo|datos|vectorial|índice|base|almacena)\b/g,
    );
    expect(
      spanishMarkers && spanishMarkers.length >= 2,
      `expected the answer to be in Spanish on the same turn; got: ${body.message.content}`,
    ).toBe(true);

    // Persistence — proves the preference landed in the per-room store, not
    // just in the tool-call args. Read it back through the plugin's own
    // HTTP route, which is the surface other clients (mobile, portal) use.
    const httpRes = await chatClient.fetch('/user-preferences');
    expect(httpRes.status).toBe(200);
    const prefs = (await httpRes.json()) as { language?: string } | null;
    expect(
      prefs,
      'GET /user-preferences must return the saved preference',
    ).not.toBeNull();
    expect((prefs!.language ?? '').toLowerCase()).toMatch(
      /spanish|español|^es(-[a-z]{2})?$/,
    );
  }, 240_000);
});
