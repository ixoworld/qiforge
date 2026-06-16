import { describe, expect, it } from 'vitest';
import { Command } from '@langchain/langgraph';
import { type ToolMessage } from '@langchain/core/messages';
import { ManifestRegistry } from '../registries/manifest-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import {
  makeBuildCtx,
  makeManifest,
  makePlugin,
  makeRuntimeContext,
  makeTool,
} from '../registries/test-fixtures.js';
import type { PluginManifest } from '../plugin-api/types.js';
import { buildLoadCapabilityTool } from './load-capability.js';
import { acquireToolLock } from '../utils/tool-lock.js';

interface LoadResult extends PluginManifest {
  alreadyAvailable: boolean;
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
      whenToUse: ['Use to send emails or create Trello cards'],
      examples: [{ user: 'Send an email', tool: 'composio_send_email' }],
    }),
    getTools: () => [
      makeTool('composio_send_email', { description: 'Send an email.' }),
      makeTool('composio_create_card', {
        description: 'Create a Trello card.',
      }),
    ],
  });
  const memory = makePlugin({
    name: 'memory',
    manifest: makeManifest({
      title: 'Memory',
      summary: 'Persistent memory.',
      visibility: 'always',
    }),
    getTools: () => [
      makeTool('search_memory', { description: 'Search memory.' }),
    ],
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
    const loadTool = buildLoadCapabilityTool(manifests, tools);
    expect(loadTool.name).toBe('load_capability');
    expect(loadTool.description).toMatch(/load/i);
  });

  it('returns a Command updating loadedPlugins for an unloaded on-demand plugin', async () => {
    const { manifests, tools } = await buildRegistries();
    const loadTool = buildLoadCapabilityTool(manifests, tools);

    const result = await loadTool.handler(
      { names: ['composio'] },
      makeRuntimeContext({ loadedPlugins: new Set<string>() }),
    );

    expect(result).toBeInstanceOf(Command);
    const update = (result as Command).update as { loadedPlugins: string[] };
    expect(update.loadedPlugins).toEqual(['composio']);
  });

  it('emits a ToolMessage with the full manifest detail when toolCallId is available', async () => {
    const { manifests, tools } = await buildRegistries();
    const loadTool = buildLoadCapabilityTool(manifests, tools);

    const result = await loadTool.handler(
      { names: ['composio'] },
      makeRuntimeContext({
        loadedPlugins: new Set<string>(),
        toolCallId: 'call-123',
      }),
    );

    expect(result).toBeInstanceOf(Command);
    const update = (result as Command).update as {
      loadedPlugins: string[];
      messages: ToolMessage[];
    };
    expect(update.loadedPlugins).toEqual(['composio']);
    expect(update.messages).toHaveLength(1);
    const message = update.messages[0]!;
    expect(message.tool_call_id).toBe('call-123');
    const payload = JSON.parse(String(message.content)) as LoadResult[];
    expect(payload).toHaveLength(1);
    expect(payload[0]!.alreadyAvailable).toBe(false);
    expect(payload[0]!.title).toBe('Composio');
    expect(payload[0]!.whenToUse).toEqual([
      'Use to send emails or create Trello cards',
    ]);
    expect(payload[0]!.tools.map((t) => t.name).sort()).toEqual([
      'composio_create_card',
      'composio_send_email',
    ]);
  });

  it('batches multiple capabilities into a single Command', async () => {
    const { manifests, tools } = await buildRegistries();
    const loadTool = buildLoadCapabilityTool(manifests, tools);

    // Register a second on-demand plugin to batch with composio
    const analytics = makePlugin({
      name: 'analytics',
      manifest: makeManifest({
        title: 'Analytics',
        summary: 'Usage analytics.',
        visibility: 'on-demand',
        whenToUse: ['Track events'],
      }),
      getTools: () => [
        makeTool('track_event', { description: 'Track an event.' }),
      ],
    });
    manifests.register(analytics);
    tools.register(analytics);
    await tools.collect(makeBuildCtx());

    const result = await loadTool.handler(
      { names: ['composio', 'analytics'] },
      makeRuntimeContext({
        loadedPlugins: new Set<string>(),
        toolCallId: 'call-batch',
      }),
    );

    expect(result).toBeInstanceOf(Command);
    const update = (result as Command).update as {
      loadedPlugins: string[];
      messages: ToolMessage[];
    };
    expect(update.loadedPlugins.sort()).toEqual(['analytics', 'composio']);
    const payload = JSON.parse(
      String(update.messages[0]!.content),
    ) as LoadResult[];
    expect(payload).toHaveLength(2);
    expect(payload.map((r) => r.title).sort()).toEqual([
      'Analytics',
      'Composio',
    ]);
    expect(payload.every((r) => !r.alreadyAvailable)).toBe(true);
  });

  it('returns alreadyAvailable + full detail when the plugin is already in loadedPlugins', async () => {
    const { manifests, tools } = await buildRegistries();
    const loadTool = buildLoadCapabilityTool(manifests, tools);

    const result = (await loadTool.handler(
      { names: ['composio'] },
      makeRuntimeContext({ loadedPlugins: new Set(['composio']) }),
    )) as LoadResult[];

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]!.alreadyAvailable).toBe(true);
    expect(result[0]!.title).toBe('Composio');
    expect(result[0]!.tools.map((t) => t.name).sort()).toEqual([
      'composio_create_card',
      'composio_send_email',
    ]);
  });

  it('returns alreadyAvailable + full detail when the plugin has visibility "always"', async () => {
    const { manifests, tools } = await buildRegistries();
    const loadTool = buildLoadCapabilityTool(manifests, tools);

    const result = (await loadTool.handler(
      { names: ['memory'] },
      makeRuntimeContext({ loadedPlugins: new Set<string>() }),
    )) as LoadResult[];

    expect(Array.isArray(result)).toBe(true);
    expect(result[0]!.alreadyAvailable).toBe(true);
    expect(result[0]!.title).toBe('Memory');
    expect(result[0]!.tools.map((t) => t.name)).toEqual(['search_memory']);
  });

  it('mixes new and already-available in one call — only new ones appear in loadedPlugins', async () => {
    const { manifests, tools } = await buildRegistries();
    const loadTool = buildLoadCapabilityTool(manifests, tools);

    // memory is always-visible (alreadyAvailable), composio is new
    const result = await loadTool.handler(
      { names: ['composio', 'memory'] },
      makeRuntimeContext({ loadedPlugins: new Set<string>() }),
    );

    expect(result).toBeInstanceOf(Command);
    const update = (result as Command).update as { loadedPlugins: string[] };
    expect(update.loadedPlugins).toEqual(['composio']);
  });

  it('throws when a plugin name is unknown', async () => {
    const { manifests, tools } = await buildRegistries();
    const loadTool = buildLoadCapabilityTool(manifests, tools);

    await expect(
      loadTool.handler({ names: ['nope'] }, makeRuntimeContext()),
    ).rejects.toThrow(/list_capabilities/);
  });

  it('throws when a plugin is silent', async () => {
    const { manifests, tools } = await buildRegistries();
    const loadTool = buildLoadCapabilityTool(manifests, tools);

    await expect(
      loadTool.handler({ names: ['tracing'] }, makeRuntimeContext()),
    ).rejects.toThrow(/internal|silent|list_capabilities/i);
  });

  it('returns alreadyAvailable on a second call when state already shows it loaded', async () => {
    const { manifests, tools } = await buildRegistries();
    const loadTool = buildLoadCapabilityTool(manifests, tools);

    // First call: not yet in state
    const first = await loadTool.handler(
      { names: ['composio'] },
      makeRuntimeContext({ loadedPlugins: new Set<string>() }),
    );
    expect(first).toBeInstanceOf(Command);

    // Second call: simulating the next turn after the reducer applied
    const second = (await loadTool.handler(
      { names: ['composio'] },
      makeRuntimeContext({ loadedPlugins: new Set(['composio']) }),
    )) as LoadResult[];
    expect(second[0]!.alreadyAvailable).toBe(true);
  });

  it('throws if a concurrent call for the same session is already in progress', async () => {
    const { manifests, tools } = await buildRegistries();
    const loadTool = buildLoadCapabilityTool(manifests, tools);
    const ctx = makeRuntimeContext({ loadedPlugins: new Set<string>() });

    const release = acquireToolLock(`${ctx.session.id}:load_capability`);
    try {
      await expect(
        loadTool.handler({ names: ['composio'] }, ctx),
      ).rejects.toThrow(/in progress/i);
    } finally {
      release();
    }
  });
});
