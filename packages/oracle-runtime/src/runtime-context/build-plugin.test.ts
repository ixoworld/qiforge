import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../plugin-api/types.js';
import { buildPluginContext } from './build-plugin.js';

const noopLogger: Logger = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

describe('buildPluginContext', () => {
  it('returns the five PluginContext fields', () => {
    const ctx = buildPluginContext({
      config: { FOO: 'bar' },
      identity: {
        name: 'TestOracle',
        org: 'Acme',
        description: 'a test oracle',
        entityDid: 'did:ixo:test',
      },
      availablePlugins: new Set(['memory', 'portal']),
      logger: noopLogger,
      pluginName: 'memory',
    });

    expect(ctx.config).toEqual({ FOO: 'bar' });
    expect(ctx.identity.name).toBe('TestOracle');
    expect(ctx.identity.entityDid).toBe('did:ixo:test');
    expect(ctx.availablePlugins.has('portal')).toBe(true);
    expect(ctx.availablePlugins.has('unknown')).toBe(false);
    expect(typeof ctx.logger.log).toBe('function');
  });

  it('uses logger.child when available, with the plugin name binding', () => {
    const childLogger: Logger = { ...noopLogger };
    const child = vi.fn(() => childLogger);
    const baseLogger: Logger = { ...noopLogger, child };

    const ctx = buildPluginContext({
      config: {},
      identity: {
        name: 'TestOracle',
        org: 'Acme',
        description: 'desc',
        entityDid: 'did:ixo:test',
      },
      availablePlugins: new Set(),
      logger: baseLogger,
      pluginName: 'memory',
    });

    expect(child).toHaveBeenCalledWith({ plugin: 'memory' });
    expect(ctx.logger).toBe(childLogger);
  });

  it('falls back to the same logger when child is not implemented', () => {
    const ctx = buildPluginContext({
      config: {},
      identity: {
        name: 'TestOracle',
        org: 'Acme',
        description: 'desc',
        entityDid: 'did:ixo:test',
      },
      availablePlugins: new Set(),
      logger: noopLogger,
      pluginName: 'memory',
    });

    expect(ctx.logger).toBe(noopLogger);
  });
});
