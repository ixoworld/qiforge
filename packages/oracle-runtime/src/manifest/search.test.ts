import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '../plugin-api/types.js';
import { buildSearchIndex, type SearchEntry } from './search.js';

function manifest(
  overrides: Partial<PluginManifest> & Pick<PluginManifest, 'summary'>,
): PluginManifest {
  return {
    title: overrides.title ?? 'Plugin',
    summary: overrides.summary,
    whenToUse: overrides.whenToUse ?? ['When the user asks.'],
    visibility: overrides.visibility ?? 'on-demand',
    ...overrides,
  };
}

const climateEntry: SearchEntry = {
  pluginName: 'climate',
  manifest: manifest({
    summary: 'Facility emissions and carbon footprint analysis.',
    whenToUse: [
      'User asks about carbon emissions for a facility.',
      'User wants greenhouse gas reporting.',
    ],
    tags: ['climate', 'emissions', 'carbon'],
    visibility: 'on-demand',
  }),
};

const slackEntry: SearchEntry = {
  pluginName: 'slack',
  manifest: manifest({
    summary: 'Send messages to Slack channels and DMs.',
    whenToUse: [
      'User wants to send a notification to slack.',
      'User asks to post an update in a slack channel.',
    ],
    tags: ['slack', 'messaging', 'notifications'],
    visibility: 'on-demand',
  }),
};

const memoryEntry: SearchEntry = {
  pluginName: 'memory',
  manifest: manifest({
    summary: 'Persistent memory for users and conversations.',
    whenToUse: ['Recall something the user mentioned earlier.'],
    tags: ['memory', 'recall'],
    visibility: 'always',
  }),
};

const auditEntry: SearchEntry = {
  pluginName: 'audit',
  manifest: manifest({
    summary: 'Internal slack auditing middleware.',
    whenToUse: ['Audit slack messages internally.'],
    tags: ['slack', 'audit'],
    visibility: 'silent',
  }),
};

describe('buildSearchIndex', () => {
  it('builds without error and returns a queryable index', () => {
    const index = buildSearchIndex([climateEntry, slackEntry, memoryEntry]);
    expect(typeof index.query).toBe('function');
  });

  it('ranks the climate plugin first for an emissions query', () => {
    const index = buildSearchIndex([climateEntry, slackEntry, memoryEntry]);
    const results = index.query('emissions');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.name).toBe('climate');
    expect(results[0]?.summary).toContain('emissions');
    expect(results[0]?.matchReason).toContain('emissions');
  });

  it('ranks the slack plugin first for "send to slack"', () => {
    const index = buildSearchIndex([climateEntry, slackEntry, memoryEntry]);
    const results = index.query('send to slack');
    expect(results[0]?.name).toBe('slack');
  });

  it('excludes silent plugins from the index', () => {
    const index = buildSearchIndex([slackEntry, auditEntry]);
    const results = index.query('audit');
    expect(results.every((r) => r.name !== 'audit')).toBe(true);
  });

  it('honors the limit argument', () => {
    const index = buildSearchIndex([climateEntry, slackEntry, memoryEntry]);
    const results = index.query('user', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('returns an empty array for an unmatched query', () => {
    const index = buildSearchIndex([climateEntry, slackEntry]);
    const results = index.query('zzzunmatched');
    expect(results).toEqual([]);
  });
});
