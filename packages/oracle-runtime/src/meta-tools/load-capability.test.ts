import { describe, expect, it } from 'vitest';
import { Command } from '@langchain/langgraph';
import { ManifestRegistry } from '../registries/manifest-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import {
  makeBuildCtx,
  makeManifest,
  makePlugin,
  makeRuntimeContext,
  makeTool,
} from '../registries/test-fixtures.js';
import { buildLoadCapabilityTool } from './load-capability.js';

interface LoadResult {
  alreadyAvailable?: boolean;
  loaded?: boolean;
  tools: { name: string; description: string }[];
}

async function buildRegistries(): Promise<{
  manifests: ManifestRegistry;
  tools: ToolRegistry;
}> {
  const manifests = new ManifestRegistry();
  const tools = new ToolRegistry();

  const composio = makePlugin({
    name: 'composio',
    manifest: makeManifest({
      title: 'Composio',
      summary: 'External SaaS actions.',
      visibility: 'on-demand',
    }),
    getTools: () => [
      makeTool('composio_send_email', { description: 'Send an email.' }),
      makeTool('composio_create_card', { description: 'Create a Trello card.' }),
    ],
  });
  const memory = makePlugin({
    name: 'memory',
    manifest: makeManifest({
      title: 'Memory',
      summary: 'Persistent memory.',
      visibility: 'always',
    }),
    getTools: () => [makeTool('search_memory', { description: 'Search memory.' })],
  });
  const tracing = makePlugin({
    name: 'tracing',
    manifest: makeManifest({
      title: 'Tracing',
      summary: 'Observability — runs as middleware.',
      visibility: 'silent',
    }),
  });

  manifests.register(composio);
  manifests.register(memory);
  manifests.register(tracing);

  tools.register(composio);
  tools.register(memory);
  tools.register(tracing);
  await tools.collect(makeBuildCtx());

  return { manifests, tools };
}

describe('load_capability', () => {
  it('declares its name and schema', async () => {
    const { manifests, tools } = await buildRegistries();
    const tool = buildLoadCapabilityTool(manifests, tools);
    expect(tool.name).toBe('load_capability');
    expect(tool.description).toMatch(/load/i);
  });

  it('returns a Command updating loadedPlugins for an unloaded on-demand plugin', async () => {
    const { manifests, tools } = await buildRegistries();
    const tool = buildLoadCapabilityTool(manifests, tools);

    const result = await tool.handler(
      { name: 'composio' },
      makeRuntimeContext({ loadedPlugins: new Set<string>() }),
    );

    expect(result).toBeInstanceOf(Command);
    const update = (result as Command).update as { loadedPlugins: string[] };
    expect(update.loadedPlugins).toEqual(['composio']);
  });

  it('returns alreadyAvailable when the plugin is already in loadedPlugins', async () => {
    const { manifests, tools } = await buildRegistries();
    const tool = buildLoadCapabilityTool(manifests, tools);

    const result = (await tool.handler(
      { name: 'composio' },
      makeRuntimeContext({ loadedPlugins: new Set(['composio']) }),
    )) as LoadResult;

    expect(result.alreadyAvailable).toBe(true);
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      'composio_create_card',
      'composio_send_email',
    ]);
  });

  it('returns alreadyAvailable when the plugin has visibility "always"', async () => {
    const { manifests, tools } = await buildRegistries();
    const tool = buildLoadCapabilityTool(manifests, tools);

    const result = (await tool.handler(
      { name: 'memory' },
      makeRuntimeContext({ loadedPlugins: new Set<string>() }),
    )) as LoadResult;

    expect(result.alreadyAvailable).toBe(true);
    expect(result.tools.map((t) => t.name)).toEqual(['search_memory']);
  });

  it('throws when the plugin name is unknown', async () => {
    const { manifests, tools } = await buildRegistries();
    const tool = buildLoadCapabilityTool(manifests, tools);

    await expect(
      tool.handler({ name: 'nope' }, makeRuntimeContext()),
    ).rejects.toThrow(/find_capability/);
  });

  it('throws when the plugin is silent', async () => {
    const { manifests, tools } = await buildRegistries();
    const tool = buildLoadCapabilityTool(manifests, tools);

    await expect(
      tool.handler({ name: 'tracing' }, makeRuntimeContext()),
    ).rejects.toThrow(/internal|silent|find_capability/i);
  });

  it('returns alreadyAvailable on a second call when state already shows it loaded', async () => {
    const { manifests, tools } = await buildRegistries();
    const tool = buildLoadCapabilityTool(manifests, tools);

    // First call: state has not yet been updated by the reducer.
    const first = await tool.handler(
      { name: 'composio' },
      makeRuntimeContext({ loadedPlugins: new Set<string>() }),
    );
    expect(first).toBeInstanceOf(Command);

    // Second call: simulating the next turn after the reducer applied.
    const second = (await tool.handler(
      { name: 'composio' },
      makeRuntimeContext({ loadedPlugins: new Set(['composio']) }),
    )) as LoadResult;
    expect(second.alreadyAvailable).toBe(true);
  });
});
