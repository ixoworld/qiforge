import {
  type PluginTool,
  type RuntimeContext,
  tool,
  z,
} from '@ixo/oracle-runtime';
import {
  getCurrentWeather,
  getForecast,
  type Units,
} from './weather-client.js';

export interface LastWeatherQuery {
  city: string;
  latitude: number;
  longitude: number;
  queriedAt: string;
}
export type LastQueryStore = Map<string, LastWeatherQuery>;

const recordLast = (
  store: LastQueryStore,
  sessionId: string,
  result: { city: string; latitude: number; longitude: number },
): void => {
  store.set(sessionId, { ...result, queriedAt: new Date().toISOString() });
};

/** Boot-time tool — reads default units from plugin config. */
export function buildCurrentWeatherTool(
  defaultUnits: Units,
  store: LastQueryStore,
): PluginTool {
  return tool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { city } = z.object({ city: z.string().min(1) }).parse(rawArgs);
      const result = await getCurrentWeather(city, defaultUnits, ctx.abortSignal);
      if (!result) {
        return `Could not find weather for "${city}". Try a more specific city name.`;
      }
      recordLast(store, ctx.session.id, result);
      return JSON.stringify(result);
    },
    {
      name: 'get_current_weather',
      description:
        'Get the current weather for a city. Returns temperature, wind speed (km/h), conditions, and coordinates.',
      schema: z.object({
        city: z.string().min(1).describe('City name, e.g. "Berlin".'),
      }),
    },
  );
}

/** Per-request tool — reads the user's timezone off `rtCtx`. */
export function buildForecastTool(
  defaultUnits: Units,
  store: LastQueryStore,
): PluginTool {
  return tool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { city, days } = z
        .object({
          city: z.string().min(1),
          days: z.number().int().min(1).max(7).optional(),
        })
        .parse(rawArgs);
      const tz =
        ctx.user.timezone && ctx.user.timezone.length > 0
          ? ctx.user.timezone
          : 'auto';
      const result = await getForecast(
        city,
        days ?? 3,
        defaultUnits,
        tz,
        ctx.abortSignal,
      );
      if (!result) {
        return `Could not find a forecast for "${city}". Try a more specific city name.`;
      }
      recordLast(store, ctx.session.id, result);
      return JSON.stringify(result);
    },
    {
      name: 'get_weather_forecast',
      description:
        'Get a daily weather forecast for a city (up to 7 days). Returns max/min temp + conditions per day. Uses the user timezone when available, else auto-detects.',
      schema: z.object({
        city: z.string().min(1).describe('City name.'),
        days: z
          .number()
          .int()
          .min(1)
          .max(7)
          .optional()
          .describe('Forecast horizon in days (1-7). Defaults to 3.'),
      }),
    },
  );
}
