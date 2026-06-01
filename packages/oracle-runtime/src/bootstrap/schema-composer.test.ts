import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Logger } from '../plugin-api/types.js';
import { makePlugin } from '../registries/test-fixtures.js';
import { composeEnvSchema, validateEnv } from './schema-composer.js';

const silentLogger = (): Logger & { warn: ReturnType<typeof vi.fn> } => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('composeEnvSchema', () => {
  it('returns an empty object when no plugins contribute schemas', () => {
    const { schema, pluginOwnership } = composeEnvSchema([]);
    expect(Object.keys(schema.shape)).toEqual([]);
    expect(pluginOwnership.size).toBe(0);
  });

  it('merges two plugins with disjoint configSchemas', () => {
    const memory = makePlugin({
      name: 'memory',
      configSchema: z.object({ MEMORY_MCP_URL: z.string() }),
    });
    const slack = makePlugin({
      name: 'slack',
      configSchema: z.object({ SLACK_BOT_OAUTH_TOKEN: z.string() }),
    });
    const { schema, pluginOwnership } = composeEnvSchema([memory, slack]);
    expect(Object.keys(schema.shape).sort()).toEqual([
      'MEMORY_MCP_URL',
      'SLACK_BOT_OAUTH_TOKEN',
    ]);
    expect(pluginOwnership.get('MEMORY_MCP_URL')).toBe('memory');
    expect(pluginOwnership.get('SLACK_BOT_OAUTH_TOKEN')).toBe('slack');
  });

  it('on overlap: later plugin wins, warning names both plugins', () => {
    const first = makePlugin({
      name: 'first',
      configSchema: z.object({ SHARED: z.string() }),
    });
    const second = makePlugin({
      name: 'second',
      configSchema: z.object({ SHARED: z.coerce.number() }),
    });
    const logger = silentLogger();
    const { schema, pluginOwnership } = composeEnvSchema(
      [first, second],
      undefined,
      logger,
    );
    expect(pluginOwnership.get('SHARED')).toBe('second');
    expect(schema.parse({ SHARED: '42' })).toEqual({ SHARED: 42 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('first');
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('second');
  });

  it('attributes baseSchema fields to "core"', () => {
    const base = z.object({ NODE_ENV: z.string() });
    const memory = makePlugin({
      name: 'memory',
      configSchema: z.object({ MEMORY_MCP_URL: z.string() }),
    });
    const { pluginOwnership } = composeEnvSchema([memory], base);
    expect(pluginOwnership.get('NODE_ENV')).toBe('core');
    expect(pluginOwnership.get('MEMORY_MCP_URL')).toBe('memory');
  });
});

describe('validateEnv', () => {
  it('returns parsed config on success', () => {
    const memory = makePlugin({
      name: 'memory',
      configSchema: z.object({ MEMORY_MCP_URL: z.string() }),
    });
    const { schema, pluginOwnership } = composeEnvSchema([memory]);
    const result = validateEnv(
      schema,
      { MEMORY_MCP_URL: 'https://memory.test' },
      pluginOwnership,
    );
    expect(result.valid).toBe(true);
    expect(result.config).toEqual({ MEMORY_MCP_URL: 'https://memory.test' });
    expect(result.errors).toEqual([]);
  });

  it('attributes a missing env var to its owning plugin', () => {
    const memory = makePlugin({
      name: 'memory',
      configSchema: z.object({ MEMORY_MCP_URL: z.string() }),
    });
    const { schema, pluginOwnership } = composeEnvSchema([memory]);
    const result = validateEnv(schema, {}, pluginOwnership);
    expect(result.valid).toBe(false);
    expect(result.config).toEqual({});
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0]!;
    expect(err.plugin).toBe('memory');
    expect(err.field).toBe('MEMORY_MCP_URL');
    expect(err.message).toMatch(/.+/);
  });

  it('attributes errors across multiple plugins', () => {
    const memory = makePlugin({
      name: 'memory',
      configSchema: z.object({ MEMORY_MCP_URL: z.string() }),
    });
    const slack = makePlugin({
      name: 'slack',
      configSchema: z.object({ SLACK_BOT_OAUTH_TOKEN: z.string() }),
    });
    const { schema, pluginOwnership } = composeEnvSchema([memory, slack]);
    const result = validateEnv(schema, {}, pluginOwnership);
    expect(result.valid).toBe(false);
    const ownerSet = new Set(result.errors.map((e) => e.plugin));
    expect(ownerSet).toEqual(new Set(['memory', 'slack']));
  });
});
