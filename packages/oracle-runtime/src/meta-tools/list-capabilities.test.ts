import { describe, expect, it } from 'vitest';
import { ManifestRegistry } from '../registries/manifest-registry.js';
import {
  makeManifest,
  makePlugin,
  makeRuntimeContext,
} from '../registries/test-fixtures.js';
import { buildListCapabilitiesTool } from './list-capabilities.js';

interface Listing {
  name: string;
  summary: string;
  visibility: 'always' | 'on-demand' | 'silent';
  loaded: boolean;
  category?: string;
  tags: string[];
}

function newRegistry(): ManifestRegistry {
  const reg = new ManifestRegistry();
  reg.register(
    makePlugin({
      name: 'memory',
      manifest: makeManifest({
        title: 'Memory',
        summary: 'Persistent memory.',
        visibility: 'always',
        tags: ['memory'],
        category: 'memory',
      }),
    }),
  );
  reg.register(
    makePlugin({
      name: 'composio',
      manifest: makeManifest({
        title: 'Composio',
        summary: 'External SaaS actions.',
        visibility: 'on-demand',
        tags: ['integration'],
        category: 'integration',
      }),
    }),
  );
  reg.register(
    makePlugin({
      name: 'langfuse',
      manifest: makeManifest({
        title: 'Langfuse',
        summary: 'Observability.',
        visibility: 'silent',
        tags: ['observability'],
        category: 'observability',
      }),
    }),
  );
  return reg;
}

describe('list_capabilities', () => {
  it('declares its name and schema', () => {
    const tool = buildListCapabilitiesTool(new ManifestRegistry());
    expect(tool.name).toBe('list_capabilities');
  });

  it('returns always + on-demand by default; excludes silent', async () => {
    const tool = buildListCapabilitiesTool(newRegistry());
    const out = (await tool.handler({}, makeRuntimeContext())) as Listing[];
    const names = out.map((e) => e.name).sort();
    expect(names).toEqual(['composio', 'memory']);
  });

  it('includes silent plugins when includeSilent is true', async () => {
    const tool = buildListCapabilitiesTool(newRegistry());
    const out = (await tool.handler(
      { includeSilent: true },
      makeRuntimeContext(),
    )) as Listing[];
    const names = out.map((e) => e.name).sort();
    expect(names).toEqual(['composio', 'langfuse', 'memory']);
  });

  it('excludes on-demand plugins when includeOnDemand is false', async () => {
    const tool = buildListCapabilitiesTool(newRegistry());
    const out = (await tool.handler(
      { includeOnDemand: false },
      makeRuntimeContext(),
    )) as Listing[];
    expect(out.map((e) => e.name)).toEqual(['memory']);
  });

  it('marks always-visible plugins as loaded regardless of state', async () => {
    const tool = buildListCapabilitiesTool(newRegistry());
    const out = (await tool.handler(
      {},
      makeRuntimeContext({ loadedPlugins: new Set<string>() }),
    )) as Listing[];
    const memory = out.find((e) => e.name === 'memory');
    expect(memory?.loaded).toBe(true);
  });

  it('marks an on-demand plugin loaded only when state.loadedPlugins includes it', async () => {
    const tool = buildListCapabilitiesTool(newRegistry());

    const before = (await tool.handler(
      {},
      makeRuntimeContext({ loadedPlugins: new Set<string>() }),
    )) as Listing[];
    expect(before.find((e) => e.name === 'composio')?.loaded).toBe(false);

    const after = (await tool.handler(
      {},
      makeRuntimeContext({ loadedPlugins: new Set(['composio']) }),
    )) as Listing[];
    expect(after.find((e) => e.name === 'composio')?.loaded).toBe(true);
  });

  it('emits the manifest fields needed by the agent (summary, tags, category)', async () => {
    const tool = buildListCapabilitiesTool(newRegistry());
    const out = (await tool.handler({}, makeRuntimeContext())) as Listing[];
    const composio = out.find((e) => e.name === 'composio');
    expect(composio?.summary).toBe('External SaaS actions.');
    expect(composio?.tags).toEqual(['integration']);
    expect(composio?.category).toBe('integration');
  });
});
