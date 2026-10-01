import { z } from 'zod';
import {
  OraclePlugin,
  type PluginRoute,
} from '../../../plugin-api/oracle-plugin';
import type {
  AgentMiddleware,
  AuthExcludedRoute,
  PluginContext,
  PluginManifest,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../../../plugin-api/types';
import { getCurrentWeather, type Units } from './weather-client';
import { buildWeatherMiddleware } from './weather-middleware';
import { buildWeatherPlannerSubAgent } from './weather-sub-agent';
import {
  buildCurrentWeatherTool,
  buildForecastTool,
  type LastQueryStore,
  type LastWeatherQuery,
} from './weather-tools';

const NAME = 'weather';
const VERSION = '0.1.0';

const configSchema = z.object({
  WEATHER_DEFAULT_UNITS: z.enum(['celsius', 'fahrenheit']).default('celsius'),
});

const manifest: PluginManifest = {
  title: 'Weather',
  summary:
    'ALWAYS use the provided weather tools to answer user questions about current weather, forecasts, or outfit recommendations. Do NOT attempt to answer from prior knowledge or assumptions—call the appropriate tool for every weather-related request to obtain up-to-date results. Powered by Open-Meteo (no API key required).',
  whenToUse: [
    'Whenever asked about current weather, temperature, precipitation, wind, or other weather conditions in any city or region.',
    'Any question related to forecasts (e.g., today, tomorrow, next week, weekend, specific date) for any location.',
    'Whenever the user asks "what should I wear", "do I need an umbrella", "do I need a jacket", or similar outfit/clothing guidance—ALWAYS use the weather tools to get real forecast data first.',
    'If the user inquires about whether to bring weather-related items (umbrella, jacket, sunglasses, etc.), make sure to call the relevant weather tool(s) before providing recommendations.',
  ],
  whenNotToUse: [
    'Questions about historical or long-term climate data (the tools provide only current or short-term forecast information).',
    'Locations smaller than city-level precision (e.g., a specific street address)—weather will be provided for the nearest city centroid.',
    'If the user asks about unrelated topics not connected to weather, temperature, climate, or outfit recommendations.',
  ],
  examples: [
    {
      user: "What's the weather in Berlin?",
      tool: 'get_current_weather',
      args: { city: 'Berlin' },
    },
    {
      user: 'Forecast for Tokyo this week.',
      tool: 'get_weather_forecast',
      args: { city: 'Tokyo', days: 7 },
    },
    {
      user: 'Should I bring a jacket to Berlin tomorrow?',
      tool: 'call_weather_planner_agent',
      args: {
        task: 'Decide whether the user needs a jacket in Berlin tomorrow. Always fetch a 2-day weather forecast for Berlin, select the tomorrow value, and then recommend an outfit. Do NOT answer without calling get_weather_forecast first.',
      },
    },
    {
      user: 'Do I need an umbrella in Paris today?',
      tool: 'get_current_weather',
      args: { city: 'Paris' },
    },
    {
      user: 'Is it cold in San Francisco this weekend?',
      tool: 'get_weather_forecast',
      args: { city: 'San Francisco', days: 3 },
    },
  ],
  tags: [
    'weather',
    'forecast',
    'outfit',
    'travel',
    'temperature',
    'rain',
    'umbrella',
    'jacket',
    'clothing',
    'recommendation',
  ],
  category: 'data',
  visibility: 'on-demand',
  stability: 'experimental',
};

interface WeatherNowResponse {
  ok: boolean;
  city?: string;
  temp_c?: number;
  units?: Units;
  conditions?: string;
  latitude?: number;
  longitude?: number;
  error?: string;
}

/**
 * Weather plugin — exercises every documented `OraclePlugin` hook:
 *  • `getTools`                 → `get_current_weather` (boot-time, uses config)
 *  • `getRequestTools`          → `get_weather_forecast` (reads `rtCtx.user.timezone`)
 *  • `getSubAgents`             → Weather Planner Agent (forecast → outfit chain)
 *  • `getMiddlewares`           → logs before/after every model call w/ elapsed ms
 *  • `getRoutes`                → `GET /weather/now?city=X` (Open-Meteo via fetch)
 *  • `getAuthExcludedRoutes`    → opts `/weather/now` out of UCAN auth
 *  • `getSharedState`           → `lastWeatherQuery` accessor for other plugins
 *  • `configSchema`             → optional `WEATHER_DEFAULT_UNITS` (celsius|fahrenheit)
 *  • `autoDetect`               → always-on (no env gate)
 *  • `manifest.visibility`      → `on-demand` so `load_capability` is testable
 *
 * Port of `apps/qiforge-example/src/plugins/weather` — identical except the
 * NestJS controller became a `getRoutes()` entry.
 */
export class WeatherPlugin extends OraclePlugin {
  static readonly NAME = NAME;

  readonly name = NAME;

  readonly version = VERSION;

  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  override readonly autoDetectHint =
    'always on (set WEATHER_DEFAULT_UNITS to celsius|fahrenheit)';

  /** Most recent query per session — written by tools, read via `getSharedState`. */
  private readonly lastBySession: LastQueryStore = new Map<
    string,
    LastWeatherQuery
  >();

  override autoDetect(): boolean {
    return true;
  }

  private units(config: unknown): Units {
    return configSchema.parse(config).WEATHER_DEFAULT_UNITS;
  }

  override getTools(ctx: PluginContext): PluginTool[] {
    return [
      buildCurrentWeatherTool(this.units(ctx.config), this.lastBySession),
    ];
  }

  override getRequestTools(rtCtx: RuntimeContext): PluginTool[] {
    return [buildForecastTool(this.units(rtCtx.config), this.lastBySession)];
  }

  override getSubAgents(ctx: PluginContext): PluginSubAgent[] {
    return [
      buildWeatherPlannerSubAgent(this.units(ctx.config), this.lastBySession),
    ];
  }

  override getMiddlewares(ctx: PluginContext): AgentMiddleware[] {
    return [buildWeatherMiddleware(ctx)];
  }

  override getRoutes(ctx: PluginContext): PluginRoute[] {
    const units = this.units(ctx.config);
    return [
      {
        method: 'GET',
        path: '/weather/now',
        handler: async (request) => {
          const city = new URL(request.url).searchParams.get('city');
          const body = await weatherNow(city, units);
          return Response.json(body, { status: body.ok ? 200 : 400 });
        },
      },
    ];
  }

  override getAuthExcludedRoutes(): AuthExcludedRoute[] {
    // `/weather/now` is a public lookup — Open-Meteo doesn't need user auth.
    return [{ path: 'weather/now', method: 'GET' }];
  }

  override getSharedState(): Record<
    string,
    (state: unknown, runCtx: RuntimeContext) => unknown
  > {
    return {
      lastWeatherQuery: (_state, runCtx) =>
        this.lastBySession.get(runCtx.session.id),
    };
  }
}

/** `GET /weather/now?city=X` body — same shape as the Node controller's. */
export async function weatherNow(
  city: string | null,
  units: Units,
): Promise<WeatherNowResponse> {
  if (!city || city.trim().length === 0) {
    return { ok: false, error: 'Missing required query param: city' };
  }
  try {
    const result = await getCurrentWeather(city, units);
    if (!result) {
      return { ok: false, error: `Could not find weather for "${city}".` };
    }
    return {
      ok: true,
      city: result.city,
      temp_c: result.temp,
      units: result.units,
      conditions: result.conditions,
      latitude: result.latitude,
      longitude: result.longitude,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Weather lookup failed.',
    };
  }
}
