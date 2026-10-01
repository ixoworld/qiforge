import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { baseEnvSchema, composeEnvSchema, validateEnv } from './env';
import { makeEnv, makePlugin } from './test-fixtures';

describe('composeEnvSchema', () => {
  it('attributes base keys to core and plugin keys to their plugin', () => {
    const weather = makePlugin({
      name: 'weather',
      configSchema: z.object({ WEATHER_DEFAULT_UNITS: z.string() }),
    });
    const { pluginOwnership } = composeEnvSchema([weather], baseEnvSchema);
    expect(pluginOwnership.get('ORACLE_NAME')).toBe('core');
    expect(pluginOwnership.get('WEATHER_DEFAULT_UNITS')).toBe('weather');
  });

  it('lets the later plugin win a key collision and warns naming both', () => {
    const warn = vi.fn();
    const first = makePlugin({
      name: 'first',
      configSchema: z.object({ SHARED_KEY: z.string() }),
    });
    const second = makePlugin({
      name: 'second',
      configSchema: z.object({ SHARED_KEY: z.coerce.number() }),
    });
    const { schema, pluginOwnership } = composeEnvSchema(
      [first, second],
      undefined,
      { log: vi.fn(), warn, error: vi.fn() },
    );
    expect(pluginOwnership.get('SHARED_KEY')).toBe('second');
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/'first' and 'second'; 'second' wins/),
    );
    expect(schema.parse({ SHARED_KEY: '42' })).toEqual({ SHARED_KEY: 42 });
  });
});

describe('validateEnv', () => {
  it('parses the Worker env object, applies defaults and strips bindings', () => {
    const { schema, pluginOwnership } = composeEnvSchema([], baseEnvSchema);
    const result = validateEnv(schema, makeEnv(), pluginOwnership);
    expect(result.valid).toBe(true);
    expect(result.config.MAIN_REASONING_EFFORT).toBe('medium');
    expect(result.config.UCAN_AUTH_MAX_TTL_SECONDS).toBe(900);
    expect(result.config.TURN_RECURSION_LIMIT).toBe(600);
    expect(result.config.OWNER_STORE).toBeUndefined();
    expect(result.config.CORS_ORIGIN).toBe('*');
    // Durable Object namespaces never leak into plugin-visible config.
    expect(result.config).not.toHaveProperty('USER_ORACLE');
    expect(result.config).not.toHaveProperty('MATRIX_GATEWAY');
  });

  it('coerces numeric strings the way Worker vars arrive', () => {
    const { schema, pluginOwnership } = composeEnvSchema([], baseEnvSchema);
    const result = validateEnv(
      schema,
      makeEnv({
        UCAN_AUTH_MAX_TTL_SECONDS: '120',
        TURN_RECURSION_LIMIT: '350',
      }),
      pluginOwnership,
    );
    expect(result.valid).toBe(true);
    expect(result.config.UCAN_AUTH_MAX_TTL_SECONDS).toBe(120);
    expect(result.config.TURN_RECURSION_LIMIT).toBe(350);
  });

  it('rejects a turn recursion limit below 1 and attributes it to core', () => {
    const { schema, pluginOwnership } = composeEnvSchema([], baseEnvSchema);
    const result = validateEnv(
      schema,
      makeEnv({ TURN_RECURSION_LIMIT: '0' }),
      pluginOwnership,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plugin: 'core',
          field: 'TURN_RECURSION_LIMIT',
        }),
      ]),
    );
  });

  it('attributes each failing field to its owner', () => {
    const weather = makePlugin({
      name: 'weather',
      configSchema: z.object({
        WEATHER_DEFAULT_UNITS: z.enum(['celsius', 'fahrenheit']),
      }),
    });
    const { schema, pluginOwnership } = composeEnvSchema(
      [weather],
      baseEnvSchema,
    );
    const env = makeEnv({ WEATHER_DEFAULT_UNITS: 'kelvin' });
    delete env.OPEN_ROUTER_API_KEY;

    const result = validateEnv(schema, env, pluginOwnership);
    expect(result.valid).toBe(false);
    expect(result.config).toEqual({});
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plugin: 'core',
          field: 'OPEN_ROUTER_API_KEY',
        }),
        expect.objectContaining({
          plugin: 'weather',
          field: 'WEATHER_DEFAULT_UNITS',
        }),
      ]),
    );
  });
});
