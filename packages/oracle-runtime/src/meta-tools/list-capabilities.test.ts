import { describe, expect, it } from 'vitest';
import { ManifestRegistry } from '../registries/manifest-registry.js';
import {
  makeManifest,
  makePlugin,
  makeRuntimeContext,
} from '../registries/test-fixtures.js';
import type { PluginTool, RuntimeContext } from '../plugin-api/types.js';
import { buildListCapabilitiesTool } from './list-capabilities.js';

interface Listing {
  name: string;
  summary: string;
  visibility: 'always' | 'on-demand' | 'silent';
  loaded: boolean;
  category?: string;
  tags: string[];
}

/** The tool returns a JSON string; this helper parses it. */
async function invokeList(
  tool: PluginTool,
  args: Parameters<PluginTool['handler']>[0],
  ctx: RuntimeContext = makeRuntimeContext(),
): Promise<Listing[]> {
  const raw = (await tool.handler(args, ctx)) as string;
  return JSON.parse(raw) as Listing[];
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
      name: 'tracing',
      manifest: makeManifest({
        title: 'Tracing',
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

  it('returns a JSON-stringified payload', async () => {
    const tool = buildListCapabilitiesTool(newRegistry());
    const raw = await tool.handler({}, makeRuntimeContext());
    expect(typeof raw).toBe('string');
    expect(() => JSON.parse(raw as string)).not.toThrow();
  });

  it('returns always + on-demand by default; excludes silent', async () => {
    const tool = buildListCapabilitiesTool(newRegistry());
    const out = await invokeList(tool, {});
    const names = out.map((e) => e.name).sort();
    expect(names).toEqual(['composio', 'memory']);
  });

  it('includes silent plugins when includeSilent is true', async () => {
    const tool = buildListCapabilitiesTool(newRegistry());
    const out = await invokeList(tool, { includeSilent: true });
    const names = out.map((e) => e.name).sort();
    expect(names).toEqual(['composio', 'memory', 'tracing']);
  });

  it('excludes on-demand plugins when includeOnDemand is false', async () => {
    const tool = buildListCapabilitiesTool(newRegistry());
    const out = await invokeList(tool, { includeOnDemand: false });
    expect(out.map((e) => e.name)).toEqual(['memory']);
  });

  it('marks always-visible plugins as loaded regardless of state', async () => {
    const tool = buildListCapabilitiesTool(newRegistry());
    const out = await invokeList(
      tool,
      {},
      makeRuntimeContext({ loadedPlugins: new Set<string>() }),
    );
    const memory = out.find((e) => e.name === 'memory');
    expect(memory?.loaded).toBe(true);
  });

  it('marks an on-demand plugin loaded only when state.loadedPlugins includes it', async () => {
    const tool = buildListCapabilitiesTool(newRegistry());

    const before = await invokeList(
      tool,
      {},
      makeRuntimeContext({ loadedPlugins: new Set<string>() }),
    );
    expect(before.find((e) => e.name === 'composio')?.loaded).toBe(false);

    const after = await invokeList(
      tool,
      {},
      makeRuntimeContext({ loadedPlugins: new Set(['composio']) }),
    );
    expect(after.find((e) => e.name === 'composio')?.loaded).toBe(true);
  });

  it('emits the manifest fields needed by the agent (summary, tags, category)', async () => {
    const tool = buildListCapabilitiesTool(newRegistry());
    const out = await invokeList(tool, {});
    const composio = out.find((e) => e.name === 'composio');
    expect(composio?.summary).toBe('External SaaS actions.');
    expect(composio?.tags).toEqual(['integration']);
    expect(composio?.category).toBe('integration');
  });
});
