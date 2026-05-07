import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../plugin-api/types.js';
import { makePlugin } from '../registries/test-fixtures.js';
import { resolvePlugins, topoSort } from './plugin-loader.js';

const silentLogger = (): Logger & {
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const slackLike = (env: NodeJS.ProcessEnv) =>
  Boolean(env.SLACK_BOT_OAUTH_TOKEN);
const tasksLike = (env: NodeJS.ProcessEnv) => Boolean(env.REDIS_URL);
const creditsLike = (env: NodeJS.ProcessEnv) => env.DISABLE_CREDITS !== 'true';

describe('resolvePlugins — feature toggles', () => {
  it('excludes a plugin when its feature is set to false', () => {
    const slack = makePlugin({
      name: 'slack',
      autoDetect: slackLike,
      autoDetectHint: 'SLACK_BOT_OAUTH_TOKEN',
    });
    const result = resolvePlugins({
      bundled: [slack],
      features: { slack: false },
      env: {},
    });
    expect(result.loaded).toEqual([]);
    expect(result.excluded).toEqual([
      {
        plugin: 'slack',
        reason: 'feature flag set to false',
        cause: 'feature_false',
      },
    ]);
  });

  it('throws when a feature is set to true but autoDetect fails', () => {
    const slack = makePlugin({
      name: 'slack',
      autoDetect: slackLike,
      autoDetectHint: 'SLACK_BOT_OAUTH_TOKEN',
    });
    expect(() =>
      resolvePlugins({
        bundled: [slack],
        features: { slack: true },
        env: {},
      }),
    ).toThrow(/boot\.plugin\.env_missing.*slack.*SLACK_BOT_OAUTH_TOKEN/);
  });

  it("loads a plugin under 'auto' when autoDetect passes", () => {
    const slack = makePlugin({
      name: 'slack',
      autoDetect: slackLike,
    });
    const result = resolvePlugins({
      bundled: [slack],
      features: { slack: 'auto' },
      env: { SLACK_BOT_OAUTH_TOKEN: 'xoxb-test' },
    });
    expect(result.loaded.map((p) => p.name)).toEqual(['slack']);
  });

  it("excludes a plugin under 'auto' when autoDetect fails, with cause=auto_detect_missing", () => {
    const slack = makePlugin({
      name: 'slack',
      autoDetect: slackLike,
      autoDetectHint: 'SLACK_BOT_OAUTH_TOKEN',
    });
    const result = resolvePlugins({
      bundled: [slack],
      features: { slack: 'auto' },
      env: {},
    });
    expect(result.loaded).toEqual([]);
    expect(result.excluded[0]).toMatchObject({
      plugin: 'slack',
      cause: 'auto_detect_missing',
    });
  });

  it('loads on-by-default plugins (no autoDetect, no toggle)', () => {
    const memory = makePlugin({ name: 'memory' });
    const result = resolvePlugins({ bundled: [memory], env: {} });
    expect(result.loaded.map((p) => p.name)).toEqual(['memory']);
  });

  it('treats undefined toggle as auto for plugins with autoDetect', () => {
    const tasks = makePlugin({ name: 'tasks', autoDetect: tasksLike });
    const result = resolvePlugins({
      bundled: [tasks],
      env: { REDIS_URL: 'redis://localhost' },
    });
    expect(result.loaded.map((p) => p.name)).toEqual(['tasks']);
  });

  it('excludes a default-auto plugin when autoDetect fails', () => {
    const tasks = makePlugin({
      name: 'tasks',
      autoDetect: tasksLike,
      autoDetectHint: 'REDIS_URL',
    });
    const result = resolvePlugins({ bundled: [tasks], env: {} });
    expect(result.loaded).toEqual([]);
    expect(result.excluded[0]?.cause).toBe('auto_detect_missing');
  });

  it('honors inverted autoDetect (e.g. credits / DISABLE_CREDITS)', () => {
    const credits = makePlugin({
      name: 'credits',
      autoDetect: creditsLike,
      autoDetectHint: 'DISABLE_CREDITS!=true',
    });
    expect(
      resolvePlugins({ bundled: [credits], env: { DISABLE_CREDITS: 'true' } })
        .loaded,
    ).toEqual([]);
    expect(
      resolvePlugins({ bundled: [credits], env: {} }).loaded.map((p) => p.name),
    ).toEqual(['credits']);
  });
});

describe('resolvePlugins — user plugins', () => {
  it('always loads user plugins regardless of feature toggles', () => {
    const userClimate = makePlugin({ name: 'climate' });
    const result = resolvePlugins({
      bundled: [],
      userPlugins: [userClimate],
      features: { climate: false },
      env: {},
    });
    expect(result.loaded.map((p) => p.name)).toEqual(['climate']);
  });
});

describe('resolvePlugins — hard-dep cascade', () => {
  it('cascades a plugin off when its hard dep was explicitly disabled', () => {
    const credits = makePlugin({ name: 'credits' });
    const claim = makePlugin({
      name: 'claim-processing',
      dependsOn: ['credits'],
    });

    const logger = silentLogger();
    const result = resolvePlugins({
      bundled: [credits, claim],
      features: { credits: false },
      env: {},
      logger,
    });

    expect(result.loaded).toEqual([]);
    const cascade = result.excluded.find(
      (e) => e.plugin === 'claim-processing',
    );
    expect(cascade).toMatchObject({
      cause: 'cascaded',
      reason: expect.stringContaining('cascaded off via credits'),
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('cascades when an autoDetect dep was not configured', () => {
    const tasks = makePlugin({
      name: 'tasks',
      autoDetect: tasksLike,
      autoDetectHint: 'REDIS_URL',
    });
    const dependent = makePlugin({
      name: 'tasks-consumer',
      dependsOn: ['tasks'],
    });
    const result = resolvePlugins({
      bundled: [tasks, dependent],
      env: {},
    });
    expect(result.loaded).toEqual([]);
    const cascade = result.excluded.find((e) => e.plugin === 'tasks-consumer');
    expect(cascade?.cause).toBe('cascaded');
  });

  it('cascades transitively (A→B→C all off when C is)', () => {
    const c = makePlugin({ name: 'c' });
    const b = makePlugin({ name: 'b', dependsOn: ['c'] });
    const a = makePlugin({ name: 'a', dependsOn: ['b'] });

    const result = resolvePlugins({
      bundled: [a, b, c],
      features: { c: false },
      env: {},
    });
    expect(result.loaded).toEqual([]);
    expect(result.excluded.map((e) => e.plugin).sort()).toEqual(['a', 'b', 'c']);
    expect(result.excluded.find((e) => e.plugin === 'b')?.cause).toBe(
      'cascaded',
    );
    expect(result.excluded.find((e) => e.plugin === 'a')?.cause).toBe(
      'cascaded',
    );
  });
});

describe('resolvePlugins — topo sort', () => {
  it('orders plugins by their dependsOn edges', () => {
    const sandbox = makePlugin({ name: 'sandbox' });
    const skills = makePlugin({ name: 'skills', dependsOn: ['sandbox'] });
    const result = resolvePlugins({ bundled: [skills, sandbox], env: {} });
    expect(result.loaded.map((p) => p.name)).toEqual(['sandbox', 'skills']);
  });

  it('throws on cycles naming both plugins', () => {
    const a = makePlugin({ name: 'plug-a', dependsOn: ['plug-b'] });
    const b = makePlugin({ name: 'plug-b', dependsOn: ['plug-a'] });
    expect(() => topoSort([a, b])).toThrow(/boot\.plugin\.cycle/);
    expect(() => topoSort([a, b])).toThrow(/plug-a/);
    expect(() => topoSort([a, b])).toThrow(/plug-b/);
  });

  it('topoSort throws on missing hard dep with a precise message', () => {
    const skills = makePlugin({ name: 'skills', dependsOn: ['sandbox'] });
    expect(() => topoSort([skills])).toThrow(
      /boot\.plugin\.dep_missing.*skills.*sandbox/,
    );
  });
});

describe('resolvePlugins — soft-dep gaps', () => {
  it('logs and reports a soft-dep that is not loaded', () => {
    const tasks = makePlugin({
      name: 'tasks',
      autoDetect: tasksLike,
      softDependsOn: ['memory'],
    });
    const logger = silentLogger();
    const result = resolvePlugins({
      bundled: [tasks],
      env: { REDIS_URL: 'redis://localhost' },
      logger,
    });
    expect(result.softDepGaps).toEqual([
      { plugin: 'tasks', missing: 'memory' },
    ]);
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(String(logger.log.mock.calls[0]?.[0])).toContain(
      'boot.plugin.soft_dep_missing',
    );
  });

  it('does not report a soft-dep that is loaded', () => {
    const memory = makePlugin({ name: 'memory' });
    const tasks = makePlugin({
      name: 'tasks',
      autoDetect: tasksLike,
      softDependsOn: ['memory'],
    });
    const logger = silentLogger();
    const result = resolvePlugins({
      bundled: [memory, tasks],
      env: { REDIS_URL: 'redis://localhost' },
      logger,
    });
    expect(result.softDepGaps).toEqual([]);
    expect(logger.log).not.toHaveBeenCalled();
  });
});
