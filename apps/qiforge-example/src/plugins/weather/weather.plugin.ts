import {
  type AgentMiddleware,
  OraclePlugin,
  type PluginContext,
  type PluginManifest,
  type PluginSubAgent,
  type PluginTool,
  type RuntimeContext,
  z,
} from '@ixo/oracle-runtime';
import type { DynamicModule } from '@nestjs/common';
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
    'Look up current weather and short forecasts for any city, and get outfit recommendations. Powered by Open-Meteo (free, no API key).',
  whenToUse: [
    'User asks about weather/temperature/rain/snow in a specific place.',
    'User asks "what should I wear" or "should I bring a jacket/umbrella" for a city.',
    'User asks for a forecast (today, tomorrow, this week) for a place.',
  ],
  whenNotToUse: [
    'Historical climate data — Open-Meteo current/forecast endpoints only.',
    'Block-level micro-weather — geocoding resolves to a city centroid.',
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
        task: 'Decide whether the user needs a jacket in Berlin tomorrow. Fetch a 2-day forecast, pick tomorrow, recommend an outfit.',
      },
    },
  ],
  tags: ['weather', 'forecast', 'outfit', 'travel'],
  category: 'data',
  visibility: 'on-demand',
  stability: 'experimental',
};

/**
 * Weather plugin — exercises every documented `OraclePlugin` hook:
 *  • `getTools`            → `get_current_weather` (boot-time, uses config)
 *  • `getRequestTools`     → `get_weather_forecast` (reads `rtCtx.user.timezone`)
 *  • `getSubAgents`        → Weather Planner Agent (forecast → outfit chain)
 *  • `getMiddlewares`      → logs before/after every model call w/ elapsed ms
 *  • `getNestModules`      → `GET /weather/now?city=X` (Open-Meteo via REST)
 *  • `getSharedState`      → `lastWeatherQuery` accessor for other plugins
 *  • `configSchema`        → optional `WEATHER_DEFAULT_UNITS` (celsius|fahrenheit)
 *  • `autoDetect`          → always-on (no env gate)
 *  • `manifest.visibility` → `on-demand` so `load_capability` is testable
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
    return [buildCurrentWeatherTool(this.units(ctx.config), this.lastBySession)];
  }

  override getRequestTools(rtCtx: RuntimeContext): PluginTool[] {
    return [buildForecastTool(this.units(rtCtx.config), this.lastBySession)];
  }

  override getSubAgents(ctx: PluginContext): PluginSubAgent[] {
    return [buildWeatherPlannerSubAgent(this.units(ctx.config), this.lastBySession)];
  }

  override getMiddlewares(ctx: PluginContext): AgentMiddleware[] {
    return [buildWeatherMiddleware(ctx)];
  }

  override getNestModules(): DynamicModule[] {
    // Nest module construction happens before the merged Zod config is
    // available on a per-plugin DI token, so we read from process.env here
    // for the controller's static units. Safe — the value is bounded by
    // the same enum the Zod schema uses.
    const raw = process.env.WEATHER_DEFAULT_UNITS;
    const units: Units = raw === 'fahrenheit' ? 'fahrenheit' : 'celsius';
    return [WeatherHttpModule.register(units)];
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
