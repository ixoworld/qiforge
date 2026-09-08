import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateManifest } from '../../core/manifest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { FlowsPlugin } from './flows.plugin';
import type { PluginTool } from '../../plugin-api/types';
import {
  conditionSchema,
  dueSchema,
  flowStepSchema,
  hookSchema,
  onEventSchema,
} from './types';

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
    expect(plugin.manifest.title).toBe('Flow Builder');
    expect(plugin.manifest.category).toBe('automation');
    expect(plugin.manifest.visibility).toBe('on-demand');
    expect(plugin.manifest.stability).toBe('beta');

    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('contributes the discovery, inspect, authoring, settings, and form tools', async () => {
    const plugin = new FlowsPlugin();
    const tools = await plugin.getRequestTools(makeRuntimeContext());
    expect(toolNames(tools)).toEqual([
      'add_step',
      'check_link',
      'compatible_actions',
      'connect_steps',
      'create_template',
      'describe_action',
      'describe_form',
      'explain_step',
      'fill_form',
      'flow_status',
      'get_step',
      'list_actions',
      'list_referenceable_fields',
      'read_flow',
      'remove_step',
      'reorder_step',
      'requirements',
      'set_form_schema',
      'set_step_assignment',
      'set_step_conditions',
      'set_step_confirmation',
      'set_step_inputs',
      'set_step_schedule',
      'set_step_trigger',
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

  it('no tool name, description, or field name leaks an editor primitive', async () => {
    const tools = await new FlowsPlugin().getRequestTools(makeRuntimeContext());
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

  it('no FlowSpec building-block field name leaks an editor primitive', () => {
    // The nested FlowSpec the agent authors (steps, conditions, hooks, ...) must
    // also stay friendly — these are the field names under create_template/add_step.
    const buildingBlocks = [
      flowStepSchema,
      conditionSchema,
      hookSchema,
      dueSchema,
      onEventSchema,
    ];
    for (const schema of buildingBlocks) {
      for (const field of schemaKeys(schema)) {
        expect(
          FORBIDDEN_FIELD,
          `FlowSpec field "${field}" is forbidden`,
        ).not.toContain(field.toLowerCase());
      }
    }
  });
});

describe('FlowsPlugin: discovery tools (no connection)', () => {
  it('list_actions returns the action catalog', async () => {
    const plugin = new FlowsPlugin();
    const ctx = makeRuntimeContext();
    const listActions = (await plugin.getRequestTools(ctx)).find(
      (t) => t.name === 'list_actions',
    );
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
    const tools = await plugin.getRequestTools(ctx);
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

  it("surfaces an action's required inputs from the editor registry's inputSchema (single source of truth)", async () => {
    // qi/proposal.create is NOT in the plugin's metadata overlay — so any
    // required inputs it reports can only come from the editor's inputSchema.
    const plugin = new FlowsPlugin();
    const ctx = makeRuntimeContext();
    const describe = (await plugin.getRequestTools(ctx)).find(
      (t) => t.name === 'describe_action',
    )!;

    const described = (await describe.handler(
      { action: 'qi/proposal.create' },
      ctx,
    )) as {
      inputs: Array<{ name: string; required?: boolean }>;
      inputsDeclared: boolean;
    };

    expect(described.inputsDeclared).toBe(true);
    const required = described.inputs
      .filter((f) => f.required)
      .map((f) => f.name);
    // The editor's proposalCreate.ts declares these required via run() throws.
    expect(required).toEqual(
      expect.arrayContaining(['coreAddress', 'title', 'description']),
    );
  });
});
