import { Command } from '@langchain/langgraph';
import type { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '../plugin-api/types';
import {
  buildListCapabilitiesTool,
  buildLoadCapabilityTool,
  buildMetaTools,
} from './meta-tools';
import { ManifestRegistry, ToolRegistry } from './registries';
import {
  makeBuildCtx,
  makeManifest,
  makePlugin,
  makeRuntimeContext,
  makeTool,
} from './test-fixtures';
import { acquireToolLock } from './utils';

interface Listing {
  name: string;
  visibility: string;
  loaded: boolean;
  tags: string[];
  category?: string;
}

interface LoadResult extends PluginManifest {
  alreadyAvailable: boolean;
  tools: { name: string; description: string }[];
}

async function buildRegistries() {
  const manifests = new ManifestRegistry();
  const tools = new ToolRegistry();
  const weather = makePlugin({
    name: 'weather',
    manifest: makeManifest({
      title: 'Weather',
      summary: 'Forecasts.',
      visibility: 'on-demand',
      tags: ['weather'],
      category: 'data',
    }),
    getTools: () => [
      makeTool('get_current_weather', { description: 'Current weather.' }),
      makeTool('get_weather_forecast', { description: 'Forecast.' }),
    ],
  });
  const memory = makePlugin({
    name: 'memory',
    manifest: makeManifest({
      title: 'Memory',
      summary: 'Recall.',
      visibility: 'always',
    }),
    getTools: () => [makeTool('search_memory')],
  });
  const tracing = makePlugin({
    name: 'tracing',
    manifest: makeManifest({
      title: 'Tracing',
      summary: 'Silent.',
      visibility: 'silent',
    }),
  });
  for (const p of [weather, memory, tracing]) {
    manifests.register(p);
    tools.register(p);
  }
  await tools.collect(makeBuildCtx());
  return { manifests, tools };
}

describe('buildMetaTools', () => {
  it('returns load_capability then list_capabilities', async () => {
    const { manifests, tools } = await buildRegistries();
    expect(
      buildMetaTools({ manifestRegistry: manifests, toolRegistry: tools }).map(
        (t) => t.name,
      ),
    ).toEqual(['load_capability', 'list_capabilities']);
  });
});

describe('list_capabilities', () => {
  it('lists always + on-demand (not silent) as JSON with loaded flags', async () => {
    const { manifests } = await buildRegistries();
    const tool = buildListCapabilitiesTool(manifests);

    const raw = await tool.handler(
      {},
      makeRuntimeContext({ loadedPlugins: new Set<string>() }),
    );
    const out = JSON.parse(raw as string) as Listing[];
    expect(out.map((e) => e.name).sort()).toEqual(['memory', 'weather']);
    expect(out.find((e) => e.name === 'memory')?.loaded).toBe(true);
    expect(out.find((e) => e.name === 'weather')).toMatchObject({
      loaded: false,
      tags: ['weather'],
      category: 'data',
    });

    const after = JSON.parse(
      (await tool.handler(
        { includeSilent: true, includeOnDemand: true },
        makeRuntimeContext({ loadedPlugins: new Set(['weather']) }),
      )) as string,
    ) as Listing[];
    expect(after.map((e) => e.name).sort()).toEqual([
      'memory',
      'tracing',
      'weather',
    ]);
    expect(after.find((e) => e.name === 'weather')?.loaded).toBe(true);
  });
});

describe('load_capability', () => {
  it('returns a Command with loadedPlugins + a ToolMessage carrying the manifest and tools', async () => {
    const { manifests, tools } = await buildRegistries();
    const load = buildLoadCapabilityTool(manifests, tools);

    const result = await load.handler(
      { names: ['weather', 'memory'] },
      makeRuntimeContext({
        loadedPlugins: new Set<string>(),
        toolCallId: 'call-1',
      }),
    );
    expect(result).toBeInstanceOf(Command);
    const update = (result as Command).update as {
      loadedPlugins: string[];
      messages: ToolMessage[];
    };
    // memory is always-visible so it is not (re)loaded; weather is new.
    expect(update.loadedPlugins).toEqual(['weather']);
    expect(update.messages[0]?.tool_call_id).toBe('call-1');
    const payload = JSON.parse(
      String(update.messages[0]?.content),
    ) as LoadResult[];
    expect(payload.map((p) => `${p.title}:${p.alreadyAvailable}`)).toEqual([
      'Weather:false',
      'Memory:true',
    ]);
    expect(payload[0]?.tools.map((t) => t.name)).toEqual([
      'get_current_weather',
      'get_weather_forecast',
    ]);
  });

  it('returns the plain result array when everything was already available', async () => {
    const { manifests, tools } = await buildRegistries();
    const load = buildLoadCapabilityTool(manifests, tools);
    const result = (await load.handler(
      { names: ['weather'] },
      makeRuntimeContext({ loadedPlugins: new Set(['weather']) }),
    )) as LoadResult[];
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]?.alreadyAvailable).toBe(true);
  });

  it('rejects unknown and silent capabilities, and concurrent calls per session', async () => {
    const { manifests, tools } = await buildRegistries();
    const load = buildLoadCapabilityTool(manifests, tools);
    await expect(
      load.handler({ names: ['nope'] }, makeRuntimeContext()),
    ).rejects.toThrow(/list_capabilities/);
    await expect(
      load.handler({ names: ['tracing'] }, makeRuntimeContext()),
    ).rejects.toThrow(/internal/);

    const ctx = makeRuntimeContext();
    const release = acquireToolLock(`${ctx.session.id}:load_capability`);
    try {
      await expect(load.handler({ names: ['weather'] }, ctx)).rejects.toThrow(
        /in progress/i,
      );
    } finally {
      release();
    }
  });
});
