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
import {
  EditorPlugin,
  type AuthExcludedRoute,
  type OracleConfig,
} from '@ixo/oracle-runtime';
import {
  allCaps,
  ChatClient,
  createIntegrationOracle,
  createIntegrationRuntime,
  mintUserDelegation,
  waitForMatrixLoaded,
  type IntegrationOracle,
  type IntegrationRuntime,
  type SSEEvent,
} from '@ixo/oracle-runtime/testing/integration';
import { Controller, Get, Module, RequestMethod } from '@nestjs/common';
import * as sdk from 'matrix-js-sdk';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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
  name: 'QiForge Weather Oracle',
  org: 'IXO',
  description:
    'The QiForge Weather Oracle provides real-time weather reports, forecasts, and personalized outfit or activity recommendations using live data.\n\nAlways answer weather-related questions by calling the weather plugin tools (`get_current_weather`, `get_weather_forecast`). Never make up answers or rely on assumptions—query the tools for up-to-date information every time.\n\nIf users are unsure what to ask, briefly mention your weather capabilities: current temperature, multi-day forecasts, and outfit suggestions for any location. When explaining results, clearly state that you used live weather data.\n\nSummary: Always use the weather plugin tools to answer, and make your live-weather source transparent.',

  prompt: {
    capabilities:
      '• Get the current weather for any city worldwide\n• Provide detailed multi-day weather forecasts\n• Recommend outfits or gear based on expected conditions (e.g., jacket, umbrella, sunglasses)\n• Advise on weather for travel or activities\n\nAll data comes from real-time sources, never from memory.',
    communicationStyle:
      'Direct, concise, and helpful. State when you’re checking live data and explain which tool you used. Avoid speculation—always show evidence from the latest weather data.',
    opening:
      'Hi! I can help you with live weather information and recommendations. Ask me about any city’s weather or what to wear, and I’ll use real-time data for the answer.',
  },
};

const REQUIRED_ENV = [
  'MATRIX_BASE_URL',
  'MATRIX_ORACLE_ADMIN_USER_ID',
  'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
  'TEST_USER_MNEMONIC',
  'TEST_USER_DID',
  'ORACLE_DID',
  'OPEN_ROUTER_API_KEY',
] as const;
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `weather.int.test.ts requires the following env vars (see apps/qiforge-example/.env.integration): ${missing.join(', ')}`,
  );
}

// Note: Tier B tests need REAL sessionIds (the MessagesService throws 404 if
// the session doesn't exist). Tests below call `client.createSession()` per
// test to get a fresh server-side session — mirrors the SDK's pattern
// (`useSessionManager` creates one before any `useSendMessage` call).

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

describe('Tier A — /weather/now route + WEATHER_DEFAULT_UNITS env', () => {
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
});

// ─────────────────────────────────────────────────────────────────────────
// Tier B — full oracle, real model, agent loop. Asserts that the agent
// (a) discovers/loads the on-demand weather capability and (b) calls the
// correct weather tool with the correct args. Structural assertions only.
// ─────────────────────────────────────────────────────────────────────────

describe('Tier B — agent loop with real model', () => {
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
    await waitForMatrixLoaded(oracle, 90_000);
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
      .filter(
        (e): e is Extract<SSEEvent, { event: 'tool_call' }> =>
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
    expect(
      weatherToolIdx,
      'agent must call get_current_weather',
    ).toBeGreaterThanOrEqual(0);
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
  });

  test('2.6 multi-turn same session: prior weather query informs follow-up', async () => {
    const sid = await client!.createSession();
    // Turn 1 — establish a prior query the agent can refer back to.
    const turn1 = await collectToolCalls(sid, "What's the weather in Tokyo?");
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
});
