import { describe, expect, it, vi } from 'vitest';
import { resolvePlugins, topoSort } from './plugin-loader';
import { makePlugin } from './test-fixtures';

const env = { FOO_KEY: 'set' };

describe('resolvePlugins — toggles and autoDetect', () => {
  it('loads plugins without an autoDetect by default and honours feature=false', () => {
    const a = makePlugin({ name: 'a' });
    const b = makePlugin({ name: 'b' });
    const result = resolvePlugins({
      bundled: [a, b],
      features: { b: false },
      env,
    });
    expect(result.loaded.map((p) => p.name)).toEqual(['a']);
    expect(result.excluded).toEqual([
      {
        plugin: 'b',
        reason: 'feature flag set to false',
        cause: 'feature_false',
      },
    ]);
  });

  it('runs autoDetect against the Worker env bindings object', () => {
    const seen: unknown[] = [];
    const needsKey = makePlugin({
      name: 'needs-key',
      autoDetect: (e) => {
        seen.push(e);
        return typeof e.FOO_KEY === 'string';
      },
      autoDetectHint: 'FOO_KEY',
    });
    const needsOther = makePlugin({
      name: 'needs-other',
      autoDetect: (e) => typeof e.OTHER_KEY === 'string',
      autoDetectHint: 'OTHER_KEY',
    });

    const result = resolvePlugins({ bundled: [needsKey, needsOther], env });
    expect(seen[0]).toBe(env);
    expect(result.loaded.map((p) => p.name)).toEqual(['needs-key']);
    expect(result.excluded[0]).toMatchObject({
      plugin: 'needs-other',
      cause: 'auto_detect_missing',
      reason: expect.stringContaining('OTHER_KEY'),
    });
  });

  it('fails the boot when a plugin is forced on but its precondition fails', () => {
    const plugin = makePlugin({
      name: 'forced',
      autoDetect: () => false,
      autoDetectHint: 'MISSING_KEY',
    });
    expect(() =>
      resolvePlugins({ bundled: [plugin], features: { forced: true }, env }),
    ).toThrow(/boot\.plugin\.env_missing.*MISSING_KEY/);
  });

  it('always loads userPlugins regardless of toggles', () => {
    const user = makePlugin({ name: 'user', autoDetect: () => false });
    const result = resolvePlugins({
      bundled: [],
      userPlugins: [user],
      features: { user: false },
      env,
    });
    expect(result.loaded.map((p) => p.name)).toEqual(['user']);
  });
});

describe('resolvePlugins — cascade, topo order, soft deps', () => {
  it('cascades hard-dependants off transitively and logs each', () => {
    const warn = vi.fn();
    const base = makePlugin({ name: 'base', autoDetect: () => false });
    const mid = makePlugin({ name: 'mid', dependsOn: ['base'] });
    const top = makePlugin({ name: 'top', dependsOn: ['mid'] });
    const bystander = makePlugin({ name: 'bystander' });

    const result = resolvePlugins({
      bundled: [top, mid, base, bystander],
      env,
      logger: { log: vi.fn(), warn, error: vi.fn() },
    });

    expect(result.loaded.map((p) => p.name)).toEqual(['bystander']);
    expect(result.excluded.map((e) => `${e.plugin}:${e.cause}`)).toEqual([
      'base:auto_detect_missing',
      'mid:cascaded',
      'top:cascaded',
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('orders loaded plugins so dependencies come first', () => {
    const c = makePlugin({ name: 'c', dependsOn: ['b'] });
    const b = makePlugin({ name: 'b', dependsOn: ['a'] });
    const a = makePlugin({ name: 'a' });
    const result = resolvePlugins({ bundled: [c, b, a], env });
    expect(result.loaded.map((p) => p.name)).toEqual(['a', 'b', 'c']);
  });

  it('reports soft-dep gaps without excluding anything', () => {
    const log = vi.fn();
    const p = makePlugin({ name: 'p', softDependsOn: ['memory'] });
    const result = resolvePlugins({
      bundled: [p],
      env,
      logger: { log, warn: vi.fn(), error: vi.fn() },
    });
    expect(result.loaded.map((x) => x.name)).toEqual(['p']);
    expect(result.softDepGaps).toEqual([{ plugin: 'p', missing: 'memory' }]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('boot.plugin.soft_dep_missing'),
    );
  });

  it('fails when a hard dependency was never provided', () => {
    const p = makePlugin({ name: 'p', dependsOn: ['ghost'] });
    expect(() => resolvePlugins({ bundled: [p], env })).toThrow(
      /boot\.plugin\.dep_missing.*'p' requires 'ghost'/,
    );
  });
});

describe('topoSort', () => {
  it('detects cycles and names the path', () => {
    const a = makePlugin({ name: 'a', dependsOn: ['b'] });
    const b = makePlugin({ name: 'b', dependsOn: ['c'] });
    const c = makePlugin({ name: 'c', dependsOn: ['a'] });
    expect(() => topoSort([a, b, c])).toThrow(
      /boot\.plugin\.cycle.*a -> b -> c -> a/,
    );
  });
});
