import { describe, expect, it } from 'vitest';
import { ManifestRegistry } from './manifest-registry.js';
import { SubAgentRegistry } from './subagent-registry.js';
import {
  makeBuildCtx,
  makeManifest,
  makePlugin,
  makeTool,
} from './test-fixtures.js';
import { ToolRegistry } from './tool-registry.js';

/** Empty sub-agent registry — these tests only exercise tool-based validation. */
const emptySubAgents = (): SubAgentRegistry => new SubAgentRegistry();

describe('ManifestRegistry', () => {
  it('collects manifests in registration order with plugin attribution', () => {
    const reg = new ManifestRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        manifest: makeManifest({ title: 'Memory' }),
      }),
    );
    reg.register(
      makePlugin({
        name: 'portal',
        manifest: makeManifest({ title: 'Portal' }),
      }),
    );

    const collected = reg.collect();
    expect(collected.map((m) => m.pluginName)).toEqual(['memory', 'portal']);
    expect(collected.map((m) => m.manifest.title)).toEqual([
      'Memory',
      'Portal',
    ]);
  });

  it('validateAgainstTools returns no errors when every example tool is registered by the same plugin', async () => {
    const tools = new ToolRegistry();
    tools.register(
      makePlugin({
        name: 'climate',
        getTools: () => [
          makeTool('get_emissions'),
          makeTool('compare_emissions'),
        ],
      }),
    );
    await tools.collect(makeBuildCtx());

    const manifests = new ManifestRegistry();
    manifests.register(
      makePlugin({
        name: 'climate',
        manifest: makeManifest({
          examples: [
            { user: 'q1', tool: 'get_emissions' },
            { user: 'q2', tool: 'compare_emissions' },
          ],
        }),
      }),
    );

    expect(manifests.validateAgainstTools(tools, emptySubAgents()).errors).toEqual([]);
  });

  it('validateAgainstTools reports plugin + missing tool when an example references a non-existent tool', async () => {
    const tools = new ToolRegistry();
    tools.register(
      makePlugin({
        name: 'climate',
        getTools: () => [makeTool('get_emissions')],
      }),
    );
    await tools.collect(makeBuildCtx());

    const manifests = new ManifestRegistry();
    manifests.register(
      makePlugin({
        name: 'climate',
        manifest: makeManifest({
          examples: [
            { user: 'q1', tool: 'get_emissions' },
            { user: 'q2', tool: 'mystery_tool' },
          ],
        }),
      }),
    );

    const result = manifests.validateAgainstTools(tools, emptySubAgents());
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('mystery_tool');
    expect(result.errors[0]).toContain('[climate]');
    expect(result.errors[0]).toContain('examples[1].tool');
  });

  it('validateAgainstTools scopes the tool list per plugin (one plugin cannot see another plugin tools)', async () => {
    const tools = new ToolRegistry();
    tools.register(
      makePlugin({
        name: 'climate',
        getTools: () => [makeTool('get_emissions')],
      }),
    );
    tools.register(
      makePlugin({
        name: 'portal',
        getTools: () => [makeTool('open_url')],
      }),
    );
    await tools.collect(makeBuildCtx());

    const manifests = new ManifestRegistry();
    // climate's manifest references a tool owned by portal — must error.
    manifests.register(
      makePlugin({
        name: 'climate',
        manifest: makeManifest({
          examples: [{ user: 'q', tool: 'open_url' }],
        }),
      }),
    );

    const result = manifests.validateAgainstTools(tools, emptySubAgents());
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('[climate]');
    expect(result.errors[0]).toContain('open_url');
  });

  it('assertNoCollisions is a no-op (manifest titles can collide)', () => {
    const reg = new ManifestRegistry();
    reg.register(
      makePlugin({
        name: 'a',
        manifest: makeManifest({ title: 'Same Title' }),
      }),
    );
    reg.register(
      makePlugin({
        name: 'b',
        manifest: makeManifest({ title: 'Same Title' }),
      }),
    );
    expect(() => reg.assertNoCollisions()).not.toThrow();
  });
});
