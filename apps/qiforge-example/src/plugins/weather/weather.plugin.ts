import {
  type AgentMiddleware,
  type AuthExcludedRoute,
  OraclePlugin,
  type PluginContext,
  type PluginManifest,
  type PluginSubAgent,
  type PluginTool,
  type RuntimeContext,
  z,
} from '@ixo/oracle-runtime';
import { type DynamicModule, RequestMethod } from '@nestjs/common';
import type { Units } from './weather-client.js';
import { buildWeatherMiddleware } from './weather-middleware.js';
import { buildWeatherPlannerSubAgent } from './weather-sub-agent.js';
import {
  buildCurrentWeatherTool,
  buildForecastTool,
  type LastQueryStore,
  type LastWeatherQuery,
} from './weather-tools.js';
import { WeatherHttpModule } from './weather.module.js';

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

/**
 * Weather plugin — exercises every documented `OraclePlugin` hook:
 *  • `getTools`                 → `get_current_weather` (boot-time, uses config)
 *  • `getRequestTools`          → `get_weather_forecast` (reads `rtCtx.user.timezone`)
 *  • `getSubAgents`             → Weather Planner Agent (forecast → outfit chain)
 *  • `getMiddlewares`           → logs before/after every model call w/ elapsed ms
 *  • `getNestModules`           → `GET /weather/now?city=X` (Open-Meteo via REST)
 *  • `getAuthExcludedRoutes`    → opts `/weather/now` out of `AuthHeaderMiddleware`
 *  • `getSharedState`           → `lastWeatherQuery` accessor for other plugins
 *  • `configSchema`             → optional `WEATHER_DEFAULT_UNITS` (celsius|fahrenheit)
 *  • `autoDetect`               → always-on (no env gate)
 *  • `manifest.visibility`      → `on-demand` so `load_capability` is testable
 */
export class WeatherPlugin extends OraclePlugin {
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

  override getNestModules(ctx: PluginContext): DynamicModule[] {
    const units = this.units(ctx.config);
    return [WeatherHttpModule.register(units)];
  }

  override getAuthExcludedRoutes(): AuthExcludedRoute[] {
    // `/weather/now` is a public lookup — Open-Meteo doesn't need user auth.
    // Opting out lets curl hit it without a UCAN header.
    return [{ path: 'weather/now', method: RequestMethod.GET }];
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
