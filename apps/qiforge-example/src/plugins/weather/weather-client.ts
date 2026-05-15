import { z } from '@ixo/oracle-runtime';

/** Open-Meteo HTTP helpers. No API key, no SDK — `fetch` + Zod. */

export type Units = 'celsius' | 'fahrenheit';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const geoSchema = z.object({
  results: z
    .array(
      z.object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string(),
        country: z.string().optional(),
      }),
    )
    .optional(),
});

const currentSchema = z.object({
  current_weather: z.object({
    temperature: z.number(),
    windspeed: z.number(),
    weathercode: z.number(),
  }),
});

const forecastSchema = z.object({
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
    weathercode: z.array(z.number()),
  }),
});

/** Common Open-Meteo weathercodes → human label. */
export function describeWeatherCode(code: number): string {
  if (code === 0) return 'clear';
  if (code >= 1 && code <= 3) return 'partly cloudy';
  if (code >= 45 && code <= 48) return 'fog';
  if (code >= 51 && code <= 67) return 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'showers';
  if (code >= 95 && code <= 99) return 'thunderstorm';
  return 'unknown';
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status} ${resp.statusText}`);
  return resp.json();
}

async function geocode(city: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ name: city, count: '1' });
  const data = await fetchJson(`${GEOCODE_URL}?${params}`, signal);
  return geoSchema.parse(data).results?.[0] ?? null;
}

export async function getCurrentWeather(
  city: string,
  units: Units,
  signal?: AbortSignal,
) {
  const loc = await geocode(city, signal);
  if (!loc) return null;
  const params = new URLSearchParams({
    latitude: String(loc.latitude),
    longitude: String(loc.longitude),
    current_weather: 'true',
    timezone: 'auto',
    temperature_unit: units,
  });
  const data = await fetchJson(`${FORECAST_URL}?${params}`, signal);
  const parsed = currentSchema.parse(data);
  return {
    city: loc.name,
    country: loc.country,
    latitude: loc.latitude,
    longitude: loc.longitude,
    temp: parsed.current_weather.temperature,
    windKmh: parsed.current_weather.windspeed,
    conditions: describeWeatherCode(parsed.current_weather.weathercode),
    units,
  };
}

export async function getForecast(
  city: string,
  days: number,
  units: Units,
  timezone: string,
  signal?: AbortSignal,
) {
  const cappedDays = Math.max(1, Math.min(7, Math.floor(days)));
  const loc = await geocode(city, signal);
  if (!loc) return null;
  const params = new URLSearchParams({
    latitude: String(loc.latitude),
    longitude: String(loc.longitude),
    daily: 'temperature_2m_max,temperature_2m_min,weathercode',
    forecast_days: String(cappedDays),
    timezone,
    temperature_unit: units,
  });
  const data = await fetchJson(`${FORECAST_URL}?${params}`, signal);
  const parsed = forecastSchema.parse(data);
  return {
    city: loc.name,
    country: loc.country,
    latitude: loc.latitude,
    longitude: loc.longitude,
    units,
    timezone,
    days: parsed.daily.time.map((date, i) => ({
      date,
      tempMax: parsed.daily.temperature_2m_max[i] ?? Number.NaN,
      tempMin: parsed.daily.temperature_2m_min[i] ?? Number.NaN,
      conditions: describeWeatherCode(parsed.daily.weathercode[i] ?? -1),
    })),
  };
}
