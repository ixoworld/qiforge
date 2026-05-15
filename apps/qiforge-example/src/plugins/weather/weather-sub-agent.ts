import {
  type PluginSubAgent,
  type PluginTool,
  tool,
  z,
} from '@ixo/oracle-runtime';
import type { Units } from './weather-client.js';
import { buildForecastTool, type LastQueryStore } from './weather-tools.js';

function buildRecommendOutfitTool(): PluginTool {
  return tool(
    async (rawArgs) => {
      const { temp_c, conditions } = z
        .object({ temp_c: z.number(), conditions: z.string() })
        .parse(rawArgs);
      const wet = ['rain', 'showers', 'thunderstorm', 'snow'].some((k) =>
        conditions.toLowerCase().includes(k),
      );
      let layer: string;
      if (temp_c >= 25) layer = 'a t-shirt and shorts';
      else if (temp_c >= 18) layer = 'a t-shirt';
      else if (temp_c >= 10) layer = 'a light jacket';
      else if (temp_c >= 0) layer = 'a warm coat and a scarf';
      else layer = 'a heavy winter coat, gloves, and a hat';
      return `Wear ${layer}${wet ? ' and bring an umbrella' : ''}.`;
    },
    {
      name: 'recommend_outfit',
      description:
        'Given a temperature in Celsius and short conditions string, return a one-line outfit suggestion.',
      schema: z.object({
        temp_c: z.number().describe('Temperature in Celsius.'),
        conditions: z.string().describe('e.g. "rain", "clear", "snow".'),
      }),
    },
  );
}

const PROMPT = [
  'You are the Weather Planner Agent. You decide whether the user needs a',
  'jacket / umbrella / etc. for a place and time.',
  '',
  'Workflow:',
  '1. Call get_weather_forecast with the city (and days if specified).',
  '2. Pick the most relevant day. If temperatures are Fahrenheit, convert to',
  '   Celsius: c = (f - 32) * 5/9.',
  '3. Call recommend_outfit with that day\'s max temp (Celsius) and conditions.',
  '4. Reply with ONE sentence combining the forecast and the outfit advice,',
  '   e.g. "Berlin tomorrow: 14°C with rain — wear a light jacket and bring an umbrella."',
  '',
  'Rules: ALWAYS call the tools. Never invent forecasts. If a tool returns an',
  'error string, return it verbatim.',
].join('\n');

export function buildWeatherPlannerSubAgent(
  defaultUnits: Units,
  store: LastQueryStore,
): PluginSubAgent {
  return {
    name: 'weather_planner_agent',
    description:
      'Combines a forecast lookup with an outfit recommendation. Use for "should I bring a jacket to X tomorrow?" / "what should I wear in Y?".',
    systemPrompt: PROMPT,
    tools: [buildForecastTool(defaultUnits, store), buildRecommendOutfitTool()],
    model: 'subagent',
    forwardTools: true,
  };
}
