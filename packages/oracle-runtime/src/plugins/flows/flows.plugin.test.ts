import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateManifest } from '../../manifest/validator.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { FlowsPlugin } from './flows.plugin.js';
import type { PluginTool } from '../../plugin-api/types.js';

function toolNames(tools: PluginTool[]): string[] {
  return tools.map((t) => t.name).sort();
}

/** Top-level field names of a tool's input schema (Wave 2a schemas are flat objects). */
function schemaKeys(schema: PluginTool['schema']): string[] {
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
}

describe('FlowsPlugin', () => {
  it('has the expected identity and a valid manifest', () => {
    const plugin = new FlowsPlugin();
    expect(plugin.name).toBe('flows');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.manifest.title).toBe('Flows');
    expect(plugin.manifest.category).toBe('automation');
    expect(plugin.manifest.visibility).toBe('on-demand');
    expect(plugin.manifest.stability).toBe('beta');

    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('is registered in the bundled plugin set under the name "flows"', async () => {
    // Importing the plugin index pulls in the whole bundled graph, so allow headroom.
    const { BUNDLED_PLUGINS, flowsPlugin } = await import('../index.js');
    expect(flowsPlugin.name).toBe('flows');
    expect(BUNDLED_PLUGINS.some((p) => p.name === 'flows')).toBe(true);
  }, 30_000);

  it('contributes the discovery, inspect, authoring, settings, and form tools', () => {
    const plugin = new FlowsPlugin();
    const tools = plugin.getRequestTools(makeRuntimeContext());
    expect(toolNames(tools)).toEqual([
      'add_step',
      'connect_steps',
      'create_flow',
      'describe_action',
      'describe_form',
      'fill_form',
      'flow_status',
      'get_flow_template',
      'get_step',
      'list_actions',
      'list_referenceable_fields',
      'read_flow',
      'remove_step',
      'reorder_step',
      'set_step_assignment',
      'set_step_conditions',
      'set_step_confirmation',
      'set_step_inputs',
      'set_step_schedule',
      'update_flow_meta',
      'update_step',
      'validate_flow',
    ]);
  });
});

describe('FlowsPlugin: leak guard (§9)', () => {
  // Field names must never expose the editor's primitives. Prose is checked for
  // the unambiguous internal tokens only (block/can/with appear in plain English).
  const FORBIDDEN_FIELD = [
    'block',
    'blockid',
    'props',
    'ydoc',
    'roomid',
    'car',
    'cid',
    'delegation',
    'can',
    'with',
    'nb',
  ];
  const FORBIDDEN_PROSE = ['blockid', 'ydoc', 'roomid', 'delegation', 'cid'];

  it('no tool name, description, or field name leaks an editor primitive', () => {
    const tools = new FlowsPlugin().getRequestTools(makeRuntimeContext());
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const prose = `${tool.name} ${tool.description}`.toLowerCase();
      for (const token of FORBIDDEN_PROSE) {
        expect(prose, `${tool.name} prose leaks "${token}"`).not.toContain(
          token,
        );
      }
      for (const field of schemaKeys(tool.schema)) {
        expect(
          FORBIDDEN_FIELD,
          `${tool.name} field "${field}" is forbidden`,
        ).not.toContain(field.toLowerCase());
      }
    }
  });
});

describe('FlowsPlugin: discovery tools (no connection)', () => {
  it('list_actions returns the action catalog', async () => {
    const plugin = new FlowsPlugin();
    const ctx = makeRuntimeContext();
    const listActions = plugin
      .getRequestTools(ctx)
      .find((t) => t.name === 'list_actions');
    expect(listActions).toBeDefined();

    const result = await listActions!.handler({}, ctx);
    expect(result).toMatchObject({ actions: expect.any(Array) });
    const { actions } = result as { actions: Array<{ action: string }> };
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]).toHaveProperty('action');
  });

  it('describe_action returns a spec for a real action and errors on an unknown one', async () => {
    const plugin = new FlowsPlugin();
    const ctx = makeRuntimeContext();
    const tools = plugin.getRequestTools(ctx);
    const listActions = tools.find((t) => t.name === 'list_actions')!;
    const describe = tools.find((t) => t.name === 'describe_action')!;

    const { actions } = (await listActions.handler({}, ctx)) as {
      actions: Array<{ action: string }>;
    };
    const someAction = actions[0]!.action;

    const described = (await describe.handler({ action: someAction }, ctx)) as {
      action: string;
    };
    expect(described.action).toBe(someAction);

    const missing = await describe.handler(
      { action: 'definitely/not-real' },
      ctx,
    );
    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'unknown_action' },
    });
  });
});
