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
  makeRunConfig,
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
  unavailable?: { missing: { resource: string; action: string }[] };
}

interface LoadResult extends PluginManifest {
  alreadyAvailable: boolean;
  tools: { name: string; description: string }[];
  refused?: {
    missing: { resource: string; action: string }[];
    reason: string;
  };
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

  it('returns the result array as JSON text when everything was already available', async () => {
    const { manifests, tools } = await buildRegistries();
    const load = buildLoadCapabilityTool(manifests, tools);
    const result = await load.handler(
      { names: ['weather'] },
      makeRuntimeContext({ loadedPlugins: new Set(['weather']) }),
    );
    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result as string) as LoadResult[];
    expect(parsed[0]?.alreadyAvailable).toBe(true);
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

describe("plugins the user's authorization does not cover", () => {
  const REQUIRES = [{ resource: 'ixo:filesystem', action: 'fs/read' }];

  async function registries() {
    const manifests = new ManifestRegistry();
    const tools = new ToolRegistry();
    const files = makePlugin({
      name: 'files',
      manifest: makeManifest({
        title: 'Files',
        summary: 'Personal files.',
        visibility: 'on-demand',
        requires: REQUIRES,
      }),
      getTools: () => [makeTool('read_file')],
    });
    const weather = makePlugin({
      name: 'weather',
      manifest: makeManifest({ title: 'Weather', visibility: 'on-demand' }),
      getTools: () => [makeTool('get_current_weather')],
    });
    for (const p of [files, weather]) {
      manifests.register(p);
      tools.register(p);
    }
    await tools.collect(makeBuildCtx());
    return { manifests, tools };
  }

  /** A turn whose delegation grants exactly `capabilities`. */
  function grantedContext(
    capabilities: { resource: string; action: string }[],
    loadedPlugins: string[] = [],
  ) {
    const run = makeRunConfig();
    return makeRuntimeContext(
      { loadedPlugins: new Set(loadedPlugins), toolCallId: 'call-1' },
      {
        runConfig: {
          context: {
            ...run.context,
            user: {
              ...run.context.user,
              ucanDelegation: { raw: 'delegation', capabilities },
            },
          },
        },
      },
    );
  }

  it('load_capability refuses the plugin, names what is missing, and still loads the rest of the batch', async () => {
    const { manifests, tools } = await registries();
    const load = buildLoadCapabilityTool(manifests, tools);
    const result = await load.handler(
      { names: ['files', 'weather'] },
      grantedContext([{ resource: 'ixo:oracle', action: '*' }]),
    );
    expect(result).toBeInstanceOf(Command);
    const update = (result as Command).update as {
      loadedPlugins: string[];
      messages: ToolMessage[];
    };
    expect(update.loadedPlugins).toEqual(['weather']);
    const [files, weather] = JSON.parse(
      String(update.messages[0]?.content),
    ) as LoadResult[];
    expect(files).toMatchObject({
      title: 'Files',
      alreadyAvailable: false,
      tools: [],
      refused: { missing: REQUIRES },
    });
    expect(files?.refused?.reason).toContain('`fs/read` on `ixo:filesystem`');
    expect(weather?.refused).toBeUndefined();
    expect(weather?.tools.map((t) => t.name)).toEqual(['get_current_weather']);
  });

  it('load_capability refuses without a state update when nothing else was asked for', async () => {
    const { manifests, tools } = await registries();
    const load = buildLoadCapabilityTool(manifests, tools);
    const result = await load.handler({ names: ['files'] }, grantedContext([]));
    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result as string) as LoadResult[];
    expect(parsed[0]?.refused?.missing).toEqual(REQUIRES);
  });

  it('load_capability loads the plugin once the delegation grants it, directly or through a parent grant', async () => {
    const { manifests, tools } = await registries();
    const load = buildLoadCapabilityTool(manifests, tools);
    for (const grant of [
      { resource: 'ixo:filesystem', action: 'fs/read' },
      { resource: 'ixo:filesystem', action: 'fs/*' },
      { resource: 'ixo:filesystem', action: '*' },
      { resource: '*', action: '*' },
    ]) {
      const result = await load.handler(
        { names: ['files'] },
        grantedContext([grant]),
      );
      expect(result).toBeInstanceOf(Command);
      expect(
        ((result as Command).update as { loadedPlugins: string[] })
          .loadedPlugins,
      ).toEqual(['files']);
    }
  });

  it('a narrower grant does not stand in for the resource the plugin requires', async () => {
    const { manifests, tools } = await registries();
    const load = buildLoadCapabilityTool(manifests, tools);
    const result = await load.handler(
      { names: ['files'] },
      grantedContext([
        { resource: 'ixo:filesystem/.oracles', action: 'fs/read' },
        { resource: 'ixo:filesystem', action: 'fs/write' },
      ]),
    );
    const parsed = JSON.parse(result as string) as LoadResult[];
    expect(parsed[0]?.refused?.missing).toEqual(REQUIRES);
  });

  it('list_capabilities marks the plugin unavailable and not loaded, even if an earlier turn loaded it', async () => {
    const { manifests } = await registries();
    const list = buildListCapabilitiesTool(manifests);
    const out = JSON.parse(
      (await list.handler(
        {},
        grantedContext([], ['files', 'weather']),
      )) as string,
    ) as Listing[];
    expect(out.find((e) => e.name === 'files')).toMatchObject({
      loaded: false,
      unavailable: { missing: REQUIRES },
    });
    const weather = out.find((e) => e.name === 'weather');
    expect(weather?.loaded).toBe(true);
    expect(weather?.unavailable).toBeUndefined();

    const granted = JSON.parse(
      (await list.handler(
        {},
        grantedContext(
          [{ resource: 'ixo:filesystem', action: '*' }],
          ['files'],
        ),
      )) as string,
    ) as Listing[];
    const files = granted.find((e) => e.name === 'files');
    expect(files?.loaded).toBe(true);
    expect(files?.unavailable).toBeUndefined();
  });
});
