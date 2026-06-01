import { describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '../../plugin-api/types.js';
import { createCapabilityGateMiddleware } from './capability-gate-middleware.js';

type Visibility = NonNullable<PluginManifest['visibility']>;

function setup(opts?: {
  loadedPlugins?: string[];
  tools?: Array<{ name: string }>;
  pluginByToolName?: Map<string, string>;
  visibilityByToolName?: Map<string, Visibility>;
}) {
  const pluginByToolName =
    opts?.pluginByToolName ??
    new Map<string, string>([
      ['always_tool', 'always_plugin'],
      ['silent_tool', 'silent_plugin'],
      ['on_demand_tool', 'on_demand_plugin'],
      ['call_portal_agent', 'portal'],
    ]);
  const visibilityByToolName =
    opts?.visibilityByToolName ??
    new Map<string, Visibility>([
      ['always_tool', 'always'],
      ['silent_tool', 'silent'],
      ['on_demand_tool', 'on-demand'],
      ['call_portal_agent', 'on-demand'],
    ]);
  const mw = createCapabilityGateMiddleware({
    pluginByToolName,
    visibilityByToolName,
  });
  const wrap = mw.wrapModelCall;
  if (!wrap) throw new Error('wrapModelCall missing');

  const handler = vi.fn().mockResolvedValue({ ok: true });

  const tools = opts?.tools ?? [
    { name: 'list_capabilities' },
    { name: 'load_capability' },
    { name: 'always_tool' },
    { name: 'silent_tool' },
    { name: 'on_demand_tool' },
    { name: 'call_portal_agent' },
  ];

  return {
    wrap,
    handler,
    invoke: () =>
      wrap(
        {
          state: { loadedPlugins: opts?.loadedPlugins ?? [] },
          tools,
        } as never,
        handler as never,
      ),
  };
}

function passedToolNames(handler: ReturnType<typeof vi.fn>): string[] {
  const call = handler.mock.calls[0][0] as { tools: Array<{ name: string }> };
  return call.tools.map((t) => t.name);
}

describe('createCapabilityGateMiddleware', () => {
  it('passes meta-tools / ad-hoc tools through unchanged', async () => {
    const { handler, invoke } = setup();
    await invoke();
    const names = passedToolNames(handler);
    expect(names).toContain('list_capabilities');
    expect(names).toContain('load_capability');
  });

  it('always exposes `always` and `silent` visibility tools', async () => {
    const { handler, invoke } = setup({ loadedPlugins: [] });
    await invoke();
    const names = passedToolNames(handler);
    expect(names).toContain('always_tool');
    expect(names).toContain('silent_tool');
  });

  it('hides on-demand tools whose plugin is not in loadedPlugins', async () => {
    const { handler, invoke } = setup({ loadedPlugins: [] });
    await invoke();
    const names = passedToolNames(handler);
    expect(names).not.toContain('on_demand_tool');
    expect(names).not.toContain('call_portal_agent');
  });

  it('exposes on-demand tools after their plugin is loaded', async () => {
    const { handler, invoke } = setup({
      loadedPlugins: ['on_demand_plugin'],
    });
    await invoke();
    const names = passedToolNames(handler);
    expect(names).toContain('on_demand_tool');
    expect(names).not.toContain('call_portal_agent');
  });

  it('exposes on-demand sub-agents after their plugin is loaded', async () => {
    const { handler, invoke } = setup({
      loadedPlugins: ['portal'],
    });
    await invoke();
    const names = passedToolNames(handler);
    expect(names).toContain('call_portal_agent');
  });

  it('honours per-tool visibility overrides via visibilityByToolName', async () => {
    // A tool whose plugin is on-demand at the manifest level, but the tool
    // itself is overridden to `always` — should always be exposed.
    const pluginByToolName = new Map<string, string>([
      ['eager_override', 'on_demand_plugin'],
    ]);
    const visibilityByToolName = new Map<string, Visibility>([
      ['eager_override', 'always'],
    ]);
    const { handler, invoke } = setup({
      tools: [{ name: 'eager_override' }],
      pluginByToolName,
      visibilityByToolName,
      loadedPlugins: [],
    });
    await invoke();
    expect(passedToolNames(handler)).toEqual(['eager_override']);
  });

  it('defaults to on-demand for tools missing a visibility entry', async () => {
    const pluginByToolName = new Map<string, string>([['x_tool', 'x_plugin']]);
    const visibilityByToolName = new Map<string, Visibility>(); // empty → fall back to 'on-demand'
    const { handler, invoke } = setup({
      tools: [{ name: 'x_tool' }],
      pluginByToolName,
      visibilityByToolName,
      loadedPlugins: [],
    });
    await invoke();
    expect(passedToolNames(handler)).toEqual([]);
  });

  it('treats undefined loadedPlugins like an empty set', async () => {
    const pluginByToolName = new Map<string, string>([
      ['on_demand_tool', 'on_demand_plugin'],
    ]);
    const visibilityByToolName = new Map<string, Visibility>([
      ['on_demand_tool', 'on-demand'],
    ]);
    const mw = createCapabilityGateMiddleware({
      pluginByToolName,
      visibilityByToolName,
    });
    const wrap = mw.wrapModelCall;
    if (!wrap) throw new Error('wrapModelCall missing');
    const handler = vi.fn().mockResolvedValue({ ok: true });

    await wrap(
      { state: {}, tools: [{ name: 'on_demand_tool' }] } as never,
      handler as never,
    );
    expect(passedToolNames(handler)).toEqual([]);
  });
});
