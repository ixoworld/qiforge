import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '../plugin-api/types.js';
import { renderTier1, type Tier1Entry } from './tier1-renderer.js';

function manifest(
  overrides: Partial<PluginManifest> & Pick<PluginManifest, 'summary'>,
): PluginManifest {
  return {
    title: overrides.title ?? 'Plugin',
    summary: overrides.summary,
    whenToUse: overrides.whenToUse ?? ['When the user asks.'],
    visibility: overrides.visibility ?? 'always',
    ...overrides,
  };
}

const memoryEntry: Tier1Entry = {
  pluginName: 'memory',
  manifest: manifest({
    summary: 'Persistent memory for users and conversations.',
    visibility: 'always',
  }),
};

const tasksEntry: Tier1Entry = {
  pluginName: 'tasks',
  manifest: manifest({
    summary: 'Create and manage tasks for users.',
    visibility: 'always',
  }),
};

const slackOnDemandEntry: Tier1Entry = {
  pluginName: 'slack',
  manifest: manifest({
    summary: 'Send messages to Slack channels.',
    visibility: 'on-demand',
  }),
};

const silentEntry: Tier1Entry = {
  pluginName: 'audit',
  manifest: manifest({
    summary: 'Internal audit middleware.',
    whenToUse: [],
    visibility: 'silent',
  }),
};

describe('renderTier1', () => {
  it('renders entries alphabetically with the bullet format', () => {
    const result = renderTier1({ manifests: [tasksEntry, memoryEntry] });
    expect(result.warnings).toEqual([]);
    expect(result.block).toContain('## Available Capabilities');
    expect(result.block).toContain('list_capabilities()');
    expect(result.block).toContain(
      '- **memory** — Persistent memory for users and conversations.',
    );
    expect(result.block).toContain(
      '- **tasks** — Create and manage tasks for users.',
    );
    const memoryIdx = result.block.indexOf('- **memory**');
    const tasksIdx = result.block.indexOf('- **tasks**');
    expect(memoryIdx).toBeLessThan(tasksIdx);
  });

  it('drops the discovery footer when the meta-tools are not bound', () => {
    // Matrix support mode binds no `list_capabilities` / `load_capability`, so
    // a block that ends by telling the model to call them teaches a loading
    // flow that cannot happen.
    const result = renderTier1({
      manifests: [memoryEntry],
      capabilityDiscovery: false,
    });

    expect(result.block).toContain('- **memory**');
    expect(result.block).not.toContain('list_capabilities()');
    expect(result.block).not.toContain('load_capability');
  });

  it('filters out on-demand and silent plugins', () => {
    const result = renderTier1({
      manifests: [memoryEntry, tasksEntry, slackOnDemandEntry, silentEntry],
    });
    expect(result.block).not.toContain('slack');
    expect(result.block).not.toContain('audit');
    expect(result.block).toContain('- **memory**');
    expect(result.block).toContain('- **tasks**');
  });

  it('returns an empty block when no always-visibility entries exist', () => {
    const result = renderTier1({
      manifests: [slackOnDemandEntry, silentEntry],
    });
    expect(result.block).toBe('');
    expect(result.tokens).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('warns when over the token budget but renders all entries anyway', () => {
    const entries: Tier1Entry[] = [
      memoryEntry,
      tasksEntry,
      {
        pluginName: 'zenith',
        manifest: manifest({
          summary: 'Final plugin in alphabetical order.',
          visibility: 'always',
        }),
      },
    ];
    const result = renderTier1({
      manifests: entries,
      tokenBudget: 50,
      estimateTokens: () => 100,
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('Tier-1 prompt is');
    expect(result.warnings[0]).toContain('budget 50');
    expect(result.block).toContain('- **memory**');
    expect(result.block).toContain('- **tasks**');
    expect(result.block).toContain('- **zenith**');
    expect(result.tokens).toBe(300);
  });

  it('counts tokens via the real tokenizer by default', () => {
    const result = renderTier1({ manifests: [memoryEntry, tasksEntry] });
    // Real cl100k_base counts on these two short lines should be 15-30 tokens.
    expect(result.tokens).toBeGreaterThan(10);
    expect(result.tokens).toBeLessThan(60);
  });

  it('honors a custom token budget', () => {
    const result = renderTier1({
      manifests: [memoryEntry, tasksEntry],
      tokenBudget: 1,
      estimateTokens: () => 5,
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('budget 1');
  });
});
