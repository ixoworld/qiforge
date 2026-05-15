import {
  Controller,
  type DynamicModule,
  Get,
  Inject,
  Module,
  Query,
} from '@nestjs/common';
import { getCurrentWeather, type Units } from './weather-client.js';

export const WEATHER_DEFAULT_UNITS = 'WEATHER_DEFAULT_UNITS';

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
 * `GET /weather/now?city=X`. Public route — the plugin opts this path out of
 * `AuthHeaderMiddleware` via `getAuthExcludedRoutes()` in `weather.plugin.ts`.
 */
@Controller('weather')
export class WeatherController {
  constructor(@Inject(WEATHER_DEFAULT_UNITS) private readonly units: Units) {}

  @Get('now')
  async now(@Query('city') city?: string): Promise<WeatherNowResponse> {
    if (!city || city.trim().length === 0) {
      return { ok: false, error: 'Missing required query param: city' };
    }
    try {
      const result = await getCurrentWeather(city, this.units);
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
}

@Module({})
export class WeatherHttpModule {
  static register(units: Units): DynamicModule {
    return {
      module: WeatherHttpModule,
      controllers: [WeatherController],
      providers: [{ provide: WEATHER_DEFAULT_UNITS, useValue: units }],
    };
  }
}
