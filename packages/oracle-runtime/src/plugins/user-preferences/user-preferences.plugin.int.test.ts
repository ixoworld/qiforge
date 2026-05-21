/**
 * User-preferences plugin integration tests.
 *
 * Why each test exists:
 *   - A1 GET /user-preferences: proves the plugin's HTTP route is registered
 *     under the same auth-protected surface as /messages, and the controller
 *     can resolve a UCAN-authed request all the way through to the
 *     UserPreferencesService.get() read path. A regression in the auth
 *     middleware, the plugin's getNestModules() wiring, or the controller's
 *     room resolution surfaces here.
 *   - B1 routing: "Be more concise" must route to set_user_preferences with
 *     a tone/formality arg. The plugin's whole value is that the manifest's
 *     `whenToUse` actually steers the agent here for behavioral asks.
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
import { UserPreferencesSchema } from './service/user-preferences.service.js';
import { UserPreferencesPlugin } from './user-preferences.plugin.js';

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
    `user-preferences.plugin.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missing.join(', ')}`,
  );
}

describe('user-preferences plugin — integration', () => {
  let oracle: IntegrationOracle;
  let chatClient: ChatClient;
  let sharedSessionId: string;

  beforeAll(async () => {
    oracle = await createIntegrationOracle({
      plugins: [new UserPreferencesPlugin()],
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

  // ─── Tier A — plugin HTTP route ──────────────────────────────────────

  test('A1 — GET /user-preferences returns 200 and a UserPreferencesSchema-shaped body (or null)', async () => {
    const res = await chatClient.fetch('/user-preferences');
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    // The controller returns `null` when no prefs have been set yet, or a
    // UserPreferences object otherwise. Both are valid — we assert on the
    // shape so this test stays meaningful regardless of whether a previous
    // run wrote anything to the room.
    if (!body) {
      return;
    }
    const parsed = UserPreferencesSchema.safeParse(body);
    expect(
      parsed.success,
      `body did not match UserPreferencesSchema: ${JSON.stringify(body).slice(0, 200)}`,
    ).toBe(true);
  }, 60_000);

  // ─── Tier B — agent routes a behavioral preference to set_user_preferences ──

  test('B1 — "be more concise" routes the agent to set_user_preferences', async () => {
    const stream = chatClient.stream(
      sharedSessionId,
      'From now on, please be more concise — drop long explanations.',
    );
    const events: SSEEvent[] = [];
    for await (const evt of stream) events.push(evt);

    const setCalls = events.filter(
      (e): e is { event: 'tool_call'; data: SSEToolCallEventData } =>
        e.event === 'tool_call' && e.data.toolName === 'set_user_preferences',
    );
    expect(
      setCalls.length,
      `expected set_user_preferences tool_call; saw events: ${events.map((e) => e.event).join(', ')}`,
    ).toBeGreaterThan(0);

    // The agent must capture a tone-ish field — the manifest example pairs
    // "be more concise" with `tone: 'concise'`. Accept either tone OR
    // formality since both express the same behavioral preference.
    const flattened = setCalls
      .map((c) => JSON.stringify(c.data.args ?? {}).toLowerCase())
      .join('\n');
    expect(flattened).toMatch(/tone|formality|concise|brief|terse/);
  }, 180_000);
});
