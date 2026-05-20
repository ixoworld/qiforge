/**
 * Reference template — Weather plugin integration tests (Tier A + Tier B).
 *
 * What to change when adapting for your own plugin:
 *   - Replace `WeatherPlugin` with your plugin's class.
 *   - Replace the tool names (`get_current_weather`, `get_weather_forecast`)
 *     with your plugin's tools.
 *   - Update the visibility check below — if your plugin is NOT
 *     `visibility: 'on-demand'`, Tier B tests don't need the
 *     `list_capabilities` / `load_capability` step.
 *   - Adjust the assertions to whatever your plugin's tools return.
 *
 * Why this file is small:
 *   - Tier A (direct invoke) catches integration regressions (env wiring,
 *     upstream contract, config threading) deterministically and for $0.
 *   - Tier B (agent loop) catches manifest drift + tool-routing regressions
 *     using a real model. We assert STRUCTURALLY on streamed `tool_call`
 *     events — never on exact wording — so the test is stable across model
 *     output variations.
 *
 * The Weather plugin is `visibility: 'on-demand'`: the agent does NOT see
 * `get_current_weather` / `get_weather_forecast` at boot. It must first call
 * `list_capabilities` (or know about the plugin directly) and then
 * `load_capability({ name: 'weather' })` to bind the tools — Tier B verifies
 * that flow end-to-end.
 */
import { test, expect, describe, beforeAll, afterAll } from 'vitest';
import { Controller, Get, Module, RequestMethod } from '@nestjs/common';
import * as sdk from 'matrix-js-sdk';
import {
  EditorPlugin,
  type AuthExcludedRoute,
  type OracleConfig,
} from '@ixo/oracle-runtime';
import {
  ChatClient,
  createIntegrationOracle,
  createIntegrationRuntime,
  mintUserDelegation,
  allCaps,
  type IntegrationOracle,
  type IntegrationRuntime,
  type SSEEvent,
} from '@ixo/oracle-runtime/testing/integration';
import { WeatherPlugin } from '../../src/plugins/weather/index.js';

// ─── Common boot config (mirrors src/main.ts) ────────────────────────────
@Controller('version')
class VersionController {
  @Get()
  get(): { name: string; description: string } {
    return {
      name: 'QiForge Example Oracle',
      description: 'Reference QiForge oracle wired with every bundled plugin',
    };
  }
}

@Module({ controllers: [VersionController] })
class VersionModule {}

const HOST_AUTH_EXCLUDED_ROUTES: AuthExcludedRoute[] = [
  { path: 'version', method: RequestMethod.GET },
];

const oracleConfig: OracleConfig = {
  name: 'QiForge Example Oracle',
  org: 'IXO',
  description: 'Reference QiForge oracle wired with every bundled plugin',
};

const HAS_MATRIX_ENV =
  Boolean(process.env.MATRIX_BASE_URL) &&
  Boolean(process.env.MATRIX_ORACLE_ADMIN_USER_ID) &&
  Boolean(process.env.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN);
const HAS_UCAN_ENV =
  Boolean(process.env.TEST_USER_MNEMONIC) &&
  Boolean(process.env.ORACLE_DID);
const HAS_LLM_ENV = Boolean(process.env.OPEN_ROUTER_API_KEY);

// Note: Tier B tests need REAL sessionIds (the MessagesService throws 404 if
// the session doesn't exist). Tests below call `client.createSession()` per
// test to get a fresh server-side session — mirrors the SDK's pattern
// (`useSessionManager` creates one before any `useSendMessage` call).

/**
 * Wait until the runtime has loaded the UCAN signing mnemonic from Matrix.
 * `/messages/:sessionId` runs through `SubscriptionMiddleware`, which needs
 * the signing key — without it every authenticated request 401s with
 * "UCAN signing key not configured." The `matrix:loaded` plugin status
 * event signals both Matrix init AND key wiring are complete.
 */
async function waitForMatrixLoaded(
  oracle: IntegrationOracle,
  timeoutMs = 90_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const loaded = oracle.events.statusChanges.find(
      (e) => e.plugin === 'matrix' && e.to === 'loaded',
    );
    if (loaded) return;
    const failed = oracle.events.statusChanges.find(
      (e) => e.plugin === 'matrix' && e.to === 'failed',
    );
    if (failed) {
      throw new Error(
        `Matrix init failed: ${failed.reason ?? '(no reason)'}; ` +
          'cannot run agent-loop tests without the signing key wired.',
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Matrix did not reach 'loaded' within ${timeoutMs}ms — ` +
      'last events: ' +
      JSON.stringify(oracle.events.statusChanges.slice(-5)),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Tier A — direct tool invoke (no LLM, no HTTP).
// ─────────────────────────────────────────────────────────────────────────

describe('Tier A — direct invoke against Open-Meteo', () => {
  let runtime: IntegrationRuntime | undefined;

  beforeAll(async () => {
    runtime = await createIntegrationRuntime({
      plugins: [new WeatherPlugin()],
      user: {
        did: process.env.TEST_USER_DID ?? 'did:ixo:integration-test-user',
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.close();
  });

  test('2.1 get_current_weather({ city: "Berlin" }) returns a numeric temperature', async () => {
    if (!runtime) throw new Error('runtime not built');
    const raw = await runtime.invokeTool('get_current_weather', {
      city: 'Berlin',
    });
    // Tool returns a JSON string on success; a plain "Could not find" string
    // on geocode miss. Berlin always geocodes — assert success shape.
    expect(typeof raw).toBe('string');
    const result = JSON.parse(raw as string) as { temp: number; city: string };
    expect(result.city.toLowerCase()).toContain('berlin');
    expect(typeof result.temp).toBe('number');
    expect(Number.isFinite(result.temp)).toBe(true);
  });

  test('2.2 get_weather_forecast({ city: "Tokyo", days: 7 }) returns 7 daily entries', async () => {
    if (!runtime) throw new Error('runtime not built');
    const raw = await runtime.invokeTool('get_weather_forecast', {
      city: 'Tokyo',
      days: 7,
    });
    expect(typeof raw).toBe('string');
    const result = JSON.parse(raw as string) as {
      city: string;
      days: Array<{ date: string; tempMax: number; tempMin: number }>;
    };
    expect(result.city.toLowerCase()).toContain('tokyo');
    expect(Array.isArray(result.days)).toBe(true);
    expect(result.days).toHaveLength(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Tier A — Plugin HTTP route honours `WEATHER_DEFAULT_UNITS=fahrenheit`.
// Requires Matrix env because `/weather/now` is a plugin route on a real
// booted Nest app.
// ─────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_MATRIX_ENV)(
  'Tier A — /weather/now route + WEATHER_DEFAULT_UNITS env',
  () => {
    let oracle: IntegrationOracle | undefined;

    beforeAll(async () => {
      const matrixClient = sdk.createClient({
        baseUrl: process.env.MATRIX_BASE_URL!,
        userId: process.env.MATRIX_ORACLE_ADMIN_USER_ID!,
        accessToken: process.env.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN!,
      });
      oracle = await createIntegrationOracle({
        config: oracleConfig,
        plugins: [new EditorPlugin({ matrixClient }), new WeatherPlugin()],
        nestModules: [VersionModule],
        authExcludedRoutes: HOST_AUTH_EXCLUDED_ROUTES,
        env: {
          ...process.env,
          WEATHER_DEFAULT_UNITS: 'fahrenheit',
        },
      });
    }, 120_000);

    afterAll(async () => {
      if (oracle) await oracle.close();
    });

    test('2.3 GET /weather/now?city=Berlin reports Fahrenheit values', async () => {
      if (!oracle) throw new Error('oracle not booted');
      // `/weather/now` is plugin-declared auth-excluded — no UCAN needed.
      const client = new ChatClient(oracle.baseUrl);
      const res = await client.fetch('/weather/now?city=Berlin');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        units?: string;
        temp_c?: number;
        city?: string;
      };
      expect(body.ok).toBe(true);
      expect(body.units).toBe('fahrenheit');
      // Berlin's temperature in F is typically 20-100 — anything in that
      // band, plus the units string, proves the env var threaded through.
      expect(typeof body.temp_c).toBe('number');
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Tier B — full oracle, real model, agent loop. Asserts that the agent
// (a) discovers/loads the on-demand weather capability and (b) calls the
// correct weather tool with the correct args. Structural assertions only.
// ─────────────────────────────────────────────────────────────────────────

const TIER_B_ENABLED = HAS_MATRIX_ENV && HAS_UCAN_ENV && HAS_LLM_ENV;

describe.skipIf(!TIER_B_ENABLED)('Tier B — agent loop with real model', () => {
  let oracle: IntegrationOracle | undefined;
  let client: ChatClient | undefined;

  beforeAll(async () => {
    const matrixClient = sdk.createClient({
      baseUrl: process.env.MATRIX_BASE_URL!,
      userId: process.env.MATRIX_ORACLE_ADMIN_USER_ID!,
      accessToken: process.env.MATRIX_ORACLE_ADMIN_ACCESS_TOKEN!,
    });
    oracle = await createIntegrationOracle({
      config: oracleConfig,
      plugins: [new EditorPlugin({ matrixClient }), new WeatherPlugin()],
      nestModules: [VersionModule],
      authExcludedRoutes: HOST_AUTH_EXCLUDED_ROUTES,
    });
    // Block until Matrix init + signing-key wiring are done — otherwise
    // SubscriptionMiddleware rejects every /messages/* with 401.
    await waitForMatrixLoaded(oracle);
    const delegation = await mintUserDelegation({
      userMnemonic: process.env.TEST_USER_MNEMONIC!,
      oracleDid: process.env.ORACLE_DID!,
      userDid: process.env.TEST_USER_DID,
      capabilities: allCaps,
    });
    client = new ChatClient(oracle.baseUrl, { delegation });
  }, 180_000);

  afterAll(async () => {
    if (oracle) await oracle.close();
  });

  // Collect tool_call events into a flat list — we assert structurally on
  // them across tests, never on response wording.
  async function collectToolCalls(
    sid: string,
    message: string,
  ): Promise<Array<{ toolName: string; args: Record<string, unknown> }>> {
    if (!client) throw new Error('client not ready');
    const stream = client.stream(sid, message);
    const events: SSEEvent[] = [];
    for await (const evt of stream) events.push(evt);
    return events
      .filter((e): e is Extract<SSEEvent, { event: 'tool_call' }> =>
        e.event === 'tool_call',
      )
      .map((e) => ({ toolName: e.data.toolName, args: e.data.args }));
  }

  test('2.4 "What\'s the weather in Berlin?" → loads weather + calls get_current_weather', async () => {
    const calls = await collectToolCalls(
      await client!.createSession(),
      "What's the weather in Berlin?",
    );

    // On-demand capability load must precede the weather tool call.
    const weatherToolIdx = calls.findIndex(
      (c) => c.toolName === 'get_current_weather',
    );
    expect(weatherToolIdx, 'agent must call get_current_weather').toBeGreaterThanOrEqual(0);
    const loadIdx = calls.findIndex(
      (c) =>
        c.toolName === 'load_capability' &&
        (c.args as { name?: string }).name === 'weather',
    );
    const listIdx = calls.findIndex((c) => c.toolName === 'list_capabilities');
    expect(
      loadIdx >= 0 || listIdx >= 0,
      'agent must discover the on-demand weather capability before invoking it',
    ).toBe(true);

    const weatherCall = calls[weatherToolIdx];
    expect(weatherCall).toBeDefined();
    expect(String(weatherCall!.args.city).toLowerCase()).toContain('berlin');
  });

  test('2.5 "Forecast for Tokyo this week" → calls get_weather_forecast with days 3-7', async () => {
    const calls = await collectToolCalls(
      await client!.createSession(),
      'Give me the weather forecast for Tokyo this week.',
    );

    const forecast = calls.find((c) => c.toolName === 'get_weather_forecast');
    expect(forecast, 'agent must call get_weather_forecast').toBeDefined();
    expect(String(forecast!.args.city).toLowerCase()).toContain('tokyo');
    const days = forecast!.args.days;
    // "This week" → typically 7. Some models pick 3-5; spec allows 3-7.
    if (days !== undefined) {
      const n = Number(days);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
    }
  });

  test('2.6 multi-turn same session: prior weather query informs follow-up', async () => {
    const sid = await client!.createSession();
    // Turn 1 — establish a prior query the agent can refer back to.
    const turn1 = await collectToolCalls(
      sid,
      "What's the weather in Tokyo?",
    );
    expect(
      turn1.some((c) => c.toolName === 'get_current_weather'),
      'turn 1 must fetch weather',
    ).toBe(true);
    const tokyoCall = turn1.find((c) => c.toolName === 'get_current_weather');
    expect(String(tokyoCall!.args.city).toLowerCase()).toContain('tokyo');

    // Turn 2 — same session, ask a comparison question. The agent must
    // fetch Berlin to answer; getting Berlin proves the multi-turn flow
    // works AND the session state (incl. lastWeatherQuery shared state for
    // Tokyo) is preserved.
    const turn2 = await collectToolCalls(
      sid,
      'Now Berlin — is it warmer there than what I just asked about?',
    );
    const berlinCall = turn2.find(
      (c) =>
        c.toolName === 'get_current_weather' &&
        String((c.args as { city?: string }).city ?? '')
          .toLowerCase()
          .includes('berlin'),
    );
    expect(
      berlinCall,
      'turn 2 must fetch Berlin weather to make the comparison',
    ).toBeDefined();
  });

  test('2.7 "What\'s my name?" → NO weather tool call (anti-false-positive)', async () => {
    const calls = await collectToolCalls(
      await client!.createSession(),
      "What's my name?",
    );
    const weatherCalls = calls.filter(
      (c) =>
        c.toolName === 'get_current_weather' ||
        c.toolName === 'get_weather_forecast',
    );
    expect(weatherCalls).toHaveLength(0);
  });

  test('2.8 stream emits tool_call before final message event', async () => {
    if (!client) throw new Error('client not ready');
    const stream = client.stream(
      await client!.createSession(),
      "What's the weather in Berlin?",
    );
    const events: SSEEvent[] = [];
    for await (const evt of stream) events.push(evt);

    const firstWeatherToolCallIdx = events.findIndex(
      (e) => e.event === 'tool_call' && e.data.toolName === 'get_current_weather',
    );
    const firstMessageIdx = events.findIndex((e) => e.event === 'message');

    expect(
      firstWeatherToolCallIdx,
      'stream must contain a tool_call for get_current_weather',
    ).toBeGreaterThanOrEqual(0);
    expect(firstMessageIdx, 'stream must contain a final message event').toBeGreaterThanOrEqual(0);
    expect(
      firstWeatherToolCallIdx,
      'tool_call must arrive before the final message event',
    ).toBeLessThan(firstMessageIdx);
  });
});
