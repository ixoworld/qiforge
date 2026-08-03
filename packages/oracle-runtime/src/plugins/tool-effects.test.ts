/**
 * @fileoverview Guards the bundled effect table against drift.
 *
 * A table keyed by tool name only works while it matches the tools. The cost
 * of it silently not matching is a tool nobody classified — refused under
 * strict enforcement, or worse, treated as a `read` under permissive when it
 * writes. These tests make that a test failure rather than something found in
 * production.
 */
import { describe, expect, it } from 'vitest';
import { RIGHTS_ACTION_TYPES } from '../constitution/schema.js';
import { buildMetaTools } from '../meta-tools/index.js';
import { ManifestRegistry, ToolRegistry } from '../registries/index.js';
import { makeBuildCtx } from '../registries/test-fixtures.js';
import { BUNDLED_PLUGINS } from './index.js';
import { BUNDLED_TOOL_EFFECTS, resolveToolEffect } from './tool-effects.js';

/**
 * Every statically-declared bundled tool.
 *
 * Boot-time only, and that boundary is the point. `getRequestTools` returns
 * tools discovered from upstream MCP servers at request time — their names
 * come from the server, not from this repository, so no static table can
 * enumerate them. See the request-time describe block below.
 */
async function bundledTools() {
  const registry = new ToolRegistry();
  for (const plugin of BUNDLED_PLUGINS) registry.register(plugin);
  return registry.collectBoot(makeBuildCtx());
}

describe('every statically-declared bundled tool says what it does', () => {
  it('leaves no bundled tool unclassified', async () => {
    const collected = await bundledTools();
    const unclassified = collected
      .filter(({ tool }) => !resolveToolEffect(tool))
      .map(({ pluginName, tool }) => `${pluginName}:${tool.name}`);

    // If this fails, a tool was added without saying what it does. Add an
    // entry to `tool-effects.ts` (or an `effect` on the tool itself) rather
    // than relaxing the assertion — under strict enforcement an unclassified
    // tool is refused, so the gap is not cosmetic.
    expect(unclassified).toEqual([]);
  });

  it('leaves no meta-tool unclassified', () => {
    const metaTools = buildMetaTools({
      manifestRegistry: new ManifestRegistry(),
      toolRegistry: new ToolRegistry(),
    });
    for (const tool of metaTools) {
      expect(BUNDLED_TOOL_EFFECTS.has(tool.name)).toBe(true);
    }
  });
});

describe('the table is well formed', () => {
  it('uses only action classes the format defines', () => {
    for (const [name, effect] of BUNDLED_TOOL_EFFECTS) {
      expect(
        RIGHTS_ACTION_TYPES.includes(effect.type),
        `${name} declares an unknown action class: ${effect.type}`,
      ).toBe(true);
    }
  });

  it('names an object for every entry', () => {
    // An action nobody can name is an action nobody can bound: without an
    // object the gate falls back to a synthetic identifier that matches no
    // grant, which silently refuses anything effectful.
    for (const [name, effect] of BUNDLED_TOOL_EFFECTS) {
      expect(effect.object, `${name} names no object`).toBeDefined();
    }
  });

  it('declares an operation for every entry', () => {
    for (const [name, effect] of BUNDLED_TOOL_EFFECTS) {
      expect(
        effect.action.length,
        `${name} has an empty action`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('a tool’s own declaration wins over the table', () => {
  // The table is a convenience for the bundled set. A fork's plugin, or a
  // bundled tool that later grows a declaration beside itself, must not be
  // overridden by it.
  it('prefers the tool’s effect', () => {
    const own = { type: 'delete' as const, action: 'vfs_delete_forever' };
    expect(
      resolveToolEffect({
        name: 'vfs_read',
        description: 'x',
        handler: async () => '',
        effect: own,
      }),
    ).toBe(own);
  });

  it('falls back to the table when the tool declares nothing', () => {
    const resolved = resolveToolEffect({
      name: 'vfs_read',
      description: 'x',
      handler: async () => '',
    });
    expect(resolved?.type).toBe('read');
  });

  it('returns nothing for a tool no one has classified', () => {
    expect(
      resolveToolEffect({
        name: 'not_a_real_tool',
        description: 'x',
        handler: async () => '',
      }),
    ).toBeUndefined();
  });
});

describe('the classifications that decide real authority', () => {
  const effectOf = (name: string) => BUNDLED_TOOL_EFFECTS.get(name);

  // Publishing a file changes who may read it. Filed as `write`, a plain
  // filesystem write grant would authorise publishing to the world.
  it('treats publishing a file as governance, not a write', () => {
    expect(effectOf('vfs_share')?.type).toBe('govern');
    expect(effectOf('vfs_write')?.type).toBe('write');
  });

  // Minting an invocation delegates authority to a service.
  it('treats minting a capability as governance', () => {
    expect(effectOf('mint_invocation')?.type).toBe('govern');
  });

  it('separates deleting from writing', () => {
    expect(effectOf('vfs_delete')?.type).toBe('delete');
    expect(effectOf('delete_block')?.type).toBe('delete');
  });

  // The one editor tool that reaches outside the document.
  it('treats running an action block as execution', () => {
    expect(effectOf('execute_action')?.type).toBe('execute');
    expect(effectOf('edit_block')?.type).toBe('write');
  });

  it('treats recording a decision as an evaluation', () => {
    expect(effectOf('resolve_task_approval')?.type).toBe('evaluate');
  });

  // Discovery exposes tools to the model; it authorises none of them, because
  // each is gated on its own call.
  it('treats capability discovery as a read', () => {
    expect(effectOf('load_capability')?.type).toBe('read');
    expect(effectOf('list_capabilities')?.type).toBe('read');
  });

  it('classifies validation as a read, since it changes nothing', () => {
    expect(effectOf('validate_survey_answers')?.type).toBe('read');
    expect(effectOf('validate_flow')?.type).toBe('read');
  });
});

// The limit of this approach, stated as a test so it cannot be forgotten.
describe('tools discovered at request time are not covered', () => {
  // MCP-backed plugins (memory, composio, sandbox) list their tools from an
  // upstream server per request. The names are not knowable here, so the
  // table cannot classify them and the gate has nothing to go on: permissive
  // treats them as `read`, strict refuses them.
  //
  // Fixing that means each MCP-backed plugin declaring an effect for the
  // tools it proxies — a per-plugin decision about what that server is
  // allowed to do on the entity's behalf, which is exactly the decision that
  // should not be inferred from a tool name an upstream service chose.
  it('is a known gap, not an oversight', () => {
    const mcpBacked = BUNDLED_PLUGINS.filter((p) => p.getRequestTools);
    expect(mcpBacked.length).toBeGreaterThan(0);
    for (const plugin of mcpBacked) {
      // No entry in the table is keyed to a plugin rather than a tool, so
      // there is nothing here that could be mistaken for covering them.
      expect(BUNDLED_TOOL_EFFECTS.has(plugin.name)).toBe(false);
    }
  });
});
