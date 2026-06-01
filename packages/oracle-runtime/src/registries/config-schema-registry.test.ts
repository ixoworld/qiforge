import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigSchemaRegistry } from './config-schema-registry.js';
import { makePlugin } from './test-fixtures.js';

describe('ConfigSchemaRegistry', () => {
  it('starts empty and skips plugins without a configSchema', () => {
    const reg = new ConfigSchemaRegistry();
    expect(reg.collect()).toEqual([]);
    reg.register(makePlugin({ name: 'no-config' }));
    expect(reg.collect()).toEqual([]);
  });

  it('records each registered plugin with its name and schema, in registration order', () => {
    const reg = new ConfigSchemaRegistry();
    const climateSchema = z.object({ CLIMATE_API_KEY: z.string() });
    const slackSchema = z.object({ SLACK_BOT_TOKEN: z.string() });
    reg.register(makePlugin({ name: 'climate', configSchema: climateSchema }));
    reg.register(makePlugin({ name: 'slack', configSchema: slackSchema }));

    expect(reg.collect()).toEqual([
      { pluginName: 'climate', schema: climateSchema },
      { pluginName: 'slack', schema: slackSchema },
    ]);
  });
});
