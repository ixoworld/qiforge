import { Command } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { tool as pluginTool } from '../plugin-api/tool-helper';
import { createNoopAmbient } from './runtime-context';
import { makeRunConfig } from './test-fixtures';
import { wrapPluginTool } from './wrap-plugin-tool';
import { z } from 'zod';

const fallbackContext = {
  user: {
    did: 'did:ixo:u',
    timezone: 'UTC',
    currentTime: '2026-09-14T10:00:00Z',
  },
  session: { id: 'sess' },
} as never;

const bigTool = pluginTool(
  async (args) => 'X'.repeat((args as { n: number }).n),
  {
    name: 'big',
    description: 'returns n chars',
    schema: z.object({ n: z.number() }),
  },
);
const objectTool = pluginTool(
  async () => ({
    rows: Array.from({ length: 300 }, (_, i) => ({ i, text: 'y'.repeat(20) })),
  }),
  { name: 'rows', description: 'returns an object', schema: z.object({}) },
);
const commandTool = pluginTool(
  async () => new Command({ update: { loadedPlugins: ['weather'] } }),
  { name: 'cmd', description: 'returns a graph command', schema: z.object({}) },
);

describe('wrapPluginTool result cap', () => {
  const store = {
    put: vi
      .fn()
      .mockResolvedValue({ id: 'c'.repeat(64), size: 1, tier: 'sqlite' }),
  };
  const resultCap = {
    capChars: 2_000,
    sessionId: 'sess',
    store,
    exempt: new Set(['read_result']),
  };
  const wrap = (t: ReturnType<typeof pluginTool>) =>
    wrapPluginTool(t, {
      ambient: createNoopAmbient(),
      state: { messages: [] },
      fallbackContext,
      resultCap,
    });

  it('leaves small results alone and caps large string results at the boundary', async () => {
    const small = await wrap(bigTool).invoke({ n: 100 }, {
      context: fallbackContext,
    } as never);
    expect(small).toBe('X'.repeat(100));
    const large = String(
      await wrap(bigTool).invoke({ n: 10_000 }, {
        context: fallbackContext,
      } as never),
    );
    expect(large.length).toBeLessThanOrEqual(2_200);
    expect(large).toContain('[Result truncated: showing the first');
    expect(large).toContain(`saved as ${'c'.repeat(64)}`);
    expect(store.put).toHaveBeenCalledWith({
      sessionId: 'sess',
      toolName: 'big',
      content: 'X'.repeat(10_000),
    });
  });

  it('caps object results by their JSON text', async () => {
    const out = String(
      await wrap(objectTool).invoke({}, { context: fallbackContext } as never),
    );
    expect(out).toContain('[Result truncated');
    expect(out.startsWith('{"rows":[{"i":0')).toBe(true);
  });

  it('never touches a graph command', async () => {
    const out = await wrap(commandTool).invoke({}, {
      context: fallbackContext,
    } as never);
    expect(out).toBeInstanceOf(Command);
  });

  it('is a no-op without a cap', async () => {
    const plain = wrapPluginTool(bigTool, {
      ambient: createNoopAmbient(),
      state: { messages: [] },
      fallbackContext,
    });
    expect(
      String(
        await plain.invoke({ n: 10_000 }, {
          context: fallbackContext,
        } as never),
      ),
    ).toHaveLength(10_000);
  });
});

describe('wrapPluginTool admin plane', () => {
  /** The request context of a turn whose delegation grants `capabilities`. */
  const contextGranting = (
    capabilities: { resource: string; action: string }[],
  ) => {
    const run = makeRunConfig();
    return {
      ...run.context,
      user: {
        ...run.context.user,
        ucanDelegation: { raw: 'delegation', capabilities },
      },
    };
  };
  const adminTool = (handler: () => Promise<unknown>) =>
    pluginTool(handler, {
      name: 'rotate_key',
      description: 'rotates the signing key',
      schema: z.object({}),
      plane: 'admin',
    });

  it('refuses to run an admin tool the delegation does not grant, even when a host bound it', async () => {
    const handler = vi.fn(async () => 'rotated');
    // Bound directly, past the turn's filtering and the gate.
    const bound = wrapPluginTool(adminTool(handler), {
      ambient: createNoopAmbient(),
      state: { messages: [] },
      pluginName: 'keys',
      fallbackContext: contextGranting([
        {
          resource: 'ixo:qiforge:admin-tool/keys/rotate_key_all',
          action: 'admin-tool/invoke',
        },
      ]),
    });
    await expect(bound.invoke({})).rejects.toThrow(
      'Missing required capability: admin-tool/invoke on ixo:qiforge:admin-tool/keys/rotate_key',
    );
    expect(handler).not.toHaveBeenCalled();

    const granted = wrapPluginTool(adminTool(handler), {
      ambient: createNoopAmbient(),
      state: { messages: [] },
      pluginName: 'keys',
      fallbackContext: contextGranting([
        {
          resource: 'ixo:qiforge:admin-tool/keys',
          action: 'admin-tool/invoke',
        },
      ]),
    });
    expect(await granted.invoke({})).toBe('rotated');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('will not wrap an admin tool without the plugin that names its capability', () => {
    expect(() =>
      wrapPluginTool(
        adminTool(async () => 'rotated'),
        {
          ambient: createNoopAmbient(),
          state: { messages: [] },
          fallbackContext: contextGranting([{ resource: '*', action: '*' }]),
        },
      ),
    ).toThrow(/needs `pluginName`/);
  });
});
