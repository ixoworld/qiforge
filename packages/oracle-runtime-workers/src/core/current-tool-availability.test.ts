import { describe, expect, it, vi } from 'vitest';
import { createCapabilityGateMiddleware } from './middlewares/capability-gate';
import {
  buildListCapabilitiesTool,
  buildLoadCapabilityTool,
} from './meta-tools';
import { ManifestRegistry, turnToolSummaries } from './registries';
import {
  makeManifest,
  makePlugin,
  makeRuntimeContext,
  makeTool,
} from './test-fixtures';

describe('current tool availability', () => {
  it('hides revoked tools from list, load, model and execution through one callback', async () => {
    const current = new Set(['ixo_account_get', 'ixo_credits_get']);
    const availability = async (pluginName: string) =>
      pluginName === 'ixo-tools' ? new Set(current) : undefined;
    const manifests = new ManifestRegistry();
    manifests.register(
      makePlugin({
        name: 'ixo-tools',
        manifest: makeManifest({ visibility: 'on-demand' }),
      }),
    );
    const access = {
      withheldToolNames: new Set<string>(),
      hiddenPlugins: new Set<string>(),
      currentToolAvailability: availability,
    };
    const toolSource = turnToolSummaries([
      { pluginName: 'ixo-tools', tool: makeTool('ixo_account_get') },
      { pluginName: 'ixo-tools', tool: makeTool('ixo_credits_get') },
    ]);
    const list = buildListCapabilitiesTool(manifests, access);
    const load = buildLoadCapabilityTool(manifests, toolSource, access);
    const ctx = makeRuntimeContext({ loadedPlugins: new Set(['ixo-tools']) });
    expect(JSON.parse((await list.handler({}, ctx)) as string)).toHaveLength(1);
    current.delete('ixo_credits_get');
    const loaded = JSON.parse(
      (await load.handler({ names: ['ixo-tools'] }, ctx)) as string,
    );
    expect(loaded[0].tools.map((tool: { name: string }) => tool.name)).toEqual([
      'ixo_account_get',
    ]);

    const gate = createCapabilityGateMiddleware({
      pluginByToolName: new Map([
        ['ixo_account_get', 'ixo-tools'],
        ['ixo_credits_get', 'ixo-tools'],
      ]),
      visibilityByToolName: new Map([
        ['ixo_account_get', 'on-demand'],
        ['ixo_credits_get', 'on-demand'],
      ]),
      currentToolAvailability: availability,
    });
    if (!gate.wrapModelCall || !gate.wrapToolCall)
      throw new Error('gate hooks missing');
    const modelHandler = vi.fn().mockResolvedValue({ ok: true });
    await gate.wrapModelCall(
      {
        state: { loadedPlugins: ['ixo-tools'] },
        tools: [{ name: 'ixo_account_get' }, { name: 'ixo_credits_get' }],
      } as never,
      modelHandler as never,
    );
    expect(
      modelHandler.mock.calls[0]?.[0].tools.map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(['ixo_account_get']);
    const callHandler = vi.fn().mockResolvedValue('ran');
    const refusal = await gate.wrapToolCall(
      {
        toolCall: { name: 'ixo_credits_get', args: {}, id: 'tc-1' },
        tool: { name: 'ixo_credits_get' },
        state: { messages: [], loadedPlugins: ['ixo-tools'] },
        runtime: {},
      } as never,
      callHandler as never,
    );
    expect(callHandler).not.toHaveBeenCalled();
    expect(refusal).toMatchObject({ status: 'error' });

    current.clear();
    expect(JSON.parse((await list.handler({}, ctx)) as string)).toEqual([]);
    await expect(load.handler({ names: ['ixo-tools'] }, ctx)).rejects.toThrow(
      'does not exist',
    );
  });

  it('treats callback failure as unavailable', async () => {
    const gate = createCapabilityGateMiddleware({
      pluginByToolName: new Map([['ixo_account_get', 'ixo-tools']]),
      visibilityByToolName: new Map([['ixo_account_get', 'always']]),
      currentToolAvailability: async () => {
        throw new Error('source unavailable');
      },
    });
    if (!gate.wrapModelCall) throw new Error('model gate missing');
    const handler = vi.fn().mockResolvedValue({ ok: true });
    await gate.wrapModelCall(
      {
        state: { loadedPlugins: [] },
        tools: [{ name: 'ixo_account_get' }],
      } as never,
      handler as never,
    );
    expect(handler.mock.calls[0]?.[0].tools).toEqual([]);
  });
});
