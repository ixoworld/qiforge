import { Command } from '@langchain/langgraph';
import type { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '../plugin-api/types';
import {
  buildListCapabilitiesTool,
  buildLoadCapabilityTool,
  buildMetaTools,
  type MetaToolAccess,
} from './meta-tools';
import {
  ManifestRegistry,
  ToolRegistry,
  turnToolSummaries,
} from './registries';
import {
  makeBuildCtx,
  makeManifest,
  makePlugin,
  makeRunConfig,
  makeRuntimeContext,
  makeTool,
} from './test-fixtures';
import { resolveTurnToolAccess } from './tool-access';
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

/** A turn whose tool planes withhold nothing. */
const OPEN: MetaToolAccess = {
  withheldToolNames: new Set(),
  hiddenPlugins: new Set(),
};

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
      buildMetaTools({
        manifestRegistry: manifests,
        toolRegistry: tools,
        toolAccess: OPEN,
      }).map((t) => t.name),
    ).toEqual(['load_capability', 'list_capabilities']);
  });
});

describe('list_capabilities', () => {
  it('lists always + on-demand (not silent) as JSON with loaded flags', async () => {
    const { manifests } = await buildRegistries();
    const tool = buildListCapabilitiesTool(manifests, OPEN);

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
    const load = buildLoadCapabilityTool(manifests, tools, OPEN);

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
    const load = buildLoadCapabilityTool(manifests, tools, OPEN);
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
    const load = buildLoadCapabilityTool(manifests, tools, OPEN);
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

  it('load_capability refuses the plugin, names what is missing, and still loads the rest of the batch', async () => {
    const { manifests, tools } = await registries();
    const load = buildLoadCapabilityTool(manifests, tools, OPEN);
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
    const load = buildLoadCapabilityTool(manifests, tools, OPEN);
    const result = await load.handler({ names: ['files'] }, grantedContext([]));
    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result as string) as LoadResult[];
    expect(parsed[0]?.refused?.missing).toEqual(REQUIRES);
  });

  it('load_capability loads the plugin once the delegation grants it, directly or through a parent grant', async () => {
    const { manifests, tools } = await registries();
    const load = buildLoadCapabilityTool(manifests, tools, OPEN);
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
    const load = buildLoadCapabilityTool(manifests, tools, OPEN);
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
    const list = buildListCapabilitiesTool(manifests, OPEN);
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

describe('admin-plane tools', () => {
  const admin = (plugin: string, tool: string) => ({
    resource: `ixo:qiforge:admin-tool/${plugin}/${tool}`,
    action: 'admin-tool/invoke',
  });

  async function setup() {
    const manifests = new ManifestRegistry();
    const tools = new ToolRegistry();
    const authority = makePlugin({
      name: 'authority',
      manifest: makeManifest({
        title: 'Authority',
        visibility: 'on-demand',
        examples: [{ user: 'Grant Bob access', tool: 'grant_authority' }],
      }),
      getTools: () => [makeTool('grant_authority', { plane: 'admin' })],
    });
    const keys = makePlugin({
      name: 'keys',
      manifest: makeManifest({
        title: 'Keys',
        visibility: 'on-demand',
        examples: [
          { user: 'Rotate my key', tool: 'rotate_key' },
          { user: 'Which keys do I have?', tool: 'list_keys' },
        ],
      }),
      getTools: () => [
        makeTool('list_keys'),
        makeTool('rotate_key', { plane: 'admin' }),
      ],
    });
    for (const p of [authority, keys]) {
      manifests.register(p);
      tools.register(p);
    }
    const collected = await tools.collect(makeBuildCtx());
    return { manifests, tools, collected };
  }

  /** The turn's context and the access `createMainAgent` derives from its delegation. */
  function turn(
    collected: Awaited<ReturnType<typeof setup>>['collected'],
    capabilities: { resource: string; action: string }[],
  ) {
    const ctx = grantedContext(capabilities);
    const access = resolveTurnToolAccess({
      tools: collected,
      subAgents: [],
      buildCtx: makeBuildCtx(),
      has: ctx.ucan.hasCapability,
      logger: ctx.logger,
    });
    return { ctx, access };
  }

  it('list_capabilities hides a plugin whose tools are all ungranted admin tools, never as unavailable', async () => {
    const { manifests, collected } = await setup();
    const { ctx, access } = turn(collected, []);
    const out = JSON.parse(
      (await buildListCapabilitiesTool(manifests, access).handler(
        {},
        ctx,
      )) as string,
    ) as Listing[];
    expect(out.map((e) => e.name)).toEqual(['keys']);
    expect(out[0]?.unavailable).toBeUndefined();

    const granted = turn(collected, [admin('authority', 'grant_authority')]);
    const listed = JSON.parse(
      (await buildListCapabilitiesTool(manifests, granted.access).handler(
        {},
        granted.ctx,
      )) as string,
    ) as Listing[];
    expect(listed.map((e) => e.name).sort()).toEqual(['authority', 'keys']);
  });

  it('load_capability refuses a hidden plugin as unknown and loads nothing', async () => {
    const { manifests, tools, collected } = await setup();
    const { ctx, access } = turn(collected, []);
    await expect(
      buildLoadCapabilityTool(manifests, tools, access).handler(
        { names: ['keys', 'authority'] },
        ctx,
      ),
    ).rejects.toThrow('Capability "authority" does not exist');
  });

  it('load_capability loads a mixed plugin with only the granted descriptors and examples', async () => {
    const { manifests, tools, collected } = await setup();
    const denied = turn(collected, []);
    const result = await buildLoadCapabilityTool(
      manifests,
      tools,
      denied.access,
    ).handler({ names: ['keys'] }, denied.ctx);
    const update = (result as Command).update as {
      loadedPlugins: string[];
      messages: ToolMessage[];
    };
    expect(update.loadedPlugins).toEqual(['keys']);
    const [keys] = JSON.parse(
      String(update.messages[0]?.content),
    ) as LoadResult[];
    expect(keys?.tools.map((t) => t.name)).toEqual(['list_keys']);
    expect(keys?.examples?.map((e) => e.tool)).toEqual(['list_keys']);

    // A grant on the plugin's admin root covers its admin tools.
    const granted = turn(collected, [
      { resource: 'ixo:qiforge:admin-tool/keys', action: 'admin-tool/invoke' },
    ]);
    const loaded = await buildLoadCapabilityTool(
      manifests,
      tools,
      granted.access,
    ).handler({ names: ['keys'] }, granted.ctx);
    const [all] = JSON.parse(
      String(
        ((loaded as Command).update as { messages: ToolMessage[] }).messages[0]
          ?.content,
      ),
    ) as LoadResult[];
    expect(all?.tools.map((t) => t.name)).toEqual(['list_keys', 'rotate_key']);
  });

  it('a refused plugin never shows an example naming a withheld tool either', async () => {
    const manifests = new ManifestRegistry();
    const tools = new ToolRegistry();
    const files = makePlugin({
      name: 'files',
      manifest: makeManifest({
        title: 'Files',
        visibility: 'on-demand',
        requires: [{ resource: 'ixo:filesystem', action: 'fs/read' }],
        examples: [
          { user: 'Purge my files', tool: 'purge_files', args: { all: true } },
          { user: 'Read my notes', tool: 'read_file' },
        ],
      }),
      getTools: () => [
        makeTool('read_file'),
        makeTool('purge_files', { plane: 'admin' }),
      ],
    });
    manifests.register(files);
    tools.register(files);
    const collected = await tools.collect(makeBuildCtx());
    const { ctx, access } = turn(collected, []);
    expect(access.withheldToolNames).toEqual(new Set(['purge_files']));
    const result = await buildLoadCapabilityTool(
      manifests,
      tools,
      access,
    ).handler({ names: ['files'] }, ctx);
    const [refused] = JSON.parse(result as string) as LoadResult[];
    expect(refused?.refused).toBeDefined();
    expect(refused?.examples?.map((e) => e.tool)).toEqual(['read_file']);
    expect(String(result)).not.toContain('purge_files');
  });
});

describe("load_capability — the turn's own tools", () => {
  it('lists the tools of the turn it was built for, request-time ones included, and nothing from another turn', async () => {
    const manifests = new ManifestRegistry();
    const registry = new ToolRegistry();
    const dyn = makePlugin({
      name: 'dyn',
      manifest: makeManifest({ title: 'Dynamic', visibility: 'on-demand' }),
      getTools: () => [makeTool('dyn_base')],
      getRequestTools: (rtCtx) => [makeTool(`dyn_for_${rtCtx.session.id}`)],
    });
    manifests.register(dyn);
    registry.register(dyn);
    const turnFor = async (session: string) => {
      const run = makeRunConfig();
      const ctx = makeRuntimeContext(
        { loadedPlugins: new Set<string>(), toolCallId: 'call-1' },
        {
          runConfig: {
            context: {
              ...run.context,
              session: { ...run.context.session, id: session },
            },
          },
        },
      );
      const collected = await registry.collect(makeBuildCtx(), ctx);
      return { ctx, source: turnToolSummaries(collected) };
    };
    const a = await turnFor('a');
    const b = await turnFor('b');
    const listed = async (turnState: Awaited<ReturnType<typeof turnFor>>) => {
      const result = await buildLoadCapabilityTool(
        manifests,
        turnState.source,
        OPEN,
      ).handler({ names: ['dyn'] }, turnState.ctx);
      const update = (result as Command).update as { messages: ToolMessage[] };
      const [entry] = JSON.parse(
        String(update.messages[0]?.content),
      ) as LoadResult[];
      return entry?.tools.map((t) => t.name);
    };
    expect(await listed(a)).toEqual(['dyn_base', 'dyn_for_a']);
    expect(await listed(b)).toEqual(['dyn_base', 'dyn_for_b']);
    // The shared registry keeps no request-time tool of either turn.
    expect(registry.toolSummariesForPlugin('dyn').map((t) => t.name)).toEqual([
      'dyn_base',
    ]);
  });
});

describe('load_capability — operating guides', () => {
  async function setup() {
    const manifests = new ManifestRegistry();
    const tools = new ToolRegistry();
    const guided = makePlugin({
      name: 'guided',
      manifest: makeManifest({ title: 'Guided', visibility: 'on-demand' }),
      operatingGuide: '  ### Guided mode\n\nConfirm before building.\n',
      getTools: () => [makeTool('guided_run')],
    });
    const locked = makePlugin({
      name: 'locked',
      manifest: makeManifest({
        title: 'Locked',
        visibility: 'on-demand',
        requires: [{ resource: 'ixo:filesystem', action: 'fs/read' }],
      }),
      operatingGuide: '### Locked mode',
      getTools: () => [makeTool('locked_run')],
    });
    const plain = makePlugin({
      name: 'plain',
      manifest: makeManifest({ title: 'Plain', visibility: 'on-demand' }),
      getTools: () => [makeTool('plain_run')],
    });
    for (const p of [guided, locked, plain]) {
      manifests.register(p);
      tools.register(p);
    }
    await tools.collect(makeBuildCtx());
    return (access: MetaToolAccess = OPEN) =>
      buildLoadCapabilityTool(manifests, tools, access);
  }

  /** The `operatingGuide` of each entry a `load_capability` result names. */
  function guidesOf(result: unknown): Array<string | undefined> {
    const text =
      result instanceof Command
        ? String(
            (result.update as { messages: ToolMessage[] }).messages[0]?.content,
          )
        : String(result);
    return (JSON.parse(text) as Array<{ operatingGuide?: string }>).map(
      (entry) => entry.operatingGuide,
    );
  }

  it('returns the guide of a plugin the router only preloaded this turn', async () => {
    const load = (await setup())({
      ...OPEN,
      preloadedOnly: new Set(['guided']),
    });
    // Preloaded: available to the turn, but its guide is not in the prompt.
    const result = await load.handler(
      { names: ['guided'] },
      grantedContext([], ['guided']),
    );
    expect(guidesOf(result)).toEqual([
      '### Guided mode\n\nConfirm before building.',
    ]);
  });

  it('returns a guide once per turn, however often the plugin is loaded', async () => {
    const load = (await setup())();
    const first = await load.handler({ names: ['guided'] }, grantedContext([]));
    expect(guidesOf(first)[0]).toBeDefined();
    // The same turn: the build-time context does not see the first load yet.
    const second = await load.handler(
      { names: ['guided'] },
      grantedContext([]),
    );
    expect(guidesOf(second)).toEqual([undefined]);
  });

  it('returns the guide of a plugin it loads, and only then', async () => {
    const load = (await setup())();
    const result = await load.handler(
      { names: ['guided', 'locked', 'plain'] },
      grantedContext([]),
    );
    const update = (result as Command).update as { messages: ToolMessage[] };
    const [guided, locked, plain] = JSON.parse(
      String(update.messages[0]?.content),
    ) as Array<LoadResult & { operatingGuide?: string }>;
    expect(guided?.operatingGuide).toBe(
      '### Guided mode\n\nConfirm before building.',
    );
    // Refused: not loaded, no guide.
    expect(locked?.refused).toBeDefined();
    expect(locked).not.toHaveProperty('operatingGuide');
    // No guide: the result is exactly as before.
    expect(plain).not.toHaveProperty('operatingGuide');
    // Already loaded on the thread: the guide is in the system prompt already.
    const again = JSON.parse(
      (await (
        await setup()
      )().handler(
        { names: ['guided'] },
        grantedContext([], ['guided']),
      )) as string,
    ) as Array<{ operatingGuide?: string }>;
    expect(again[0]).not.toHaveProperty('operatingGuide');
  });

  it('list_capabilities never carries a guide', async () => {
    const manifests = new ManifestRegistry();
    manifests.register(
      makePlugin({
        name: 'guided',
        manifest: makeManifest({ title: 'Guided', visibility: 'on-demand' }),
        operatingGuide: '### Guided mode',
      }),
    );
    const out = String(
      await buildListCapabilitiesTool(manifests, OPEN).handler(
        {},
        makeRuntimeContext({ loadedPlugins: new Set(['guided']) }),
      ),
    );
    expect(out).not.toContain('Guided mode');
  });
});
