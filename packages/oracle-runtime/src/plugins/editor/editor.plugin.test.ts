import { describe, expect, it, vi } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { SandboxPlugin } from '../sandbox/index.js';
import { EditorPlugin } from './editor.plugin.js';

// Avoid the ~2.7s matrix-js-sdk module load in test runs. Editor tools only
// need a MatrixClient shape — never actually hit the wire — so a minimal
// stub satisfies every code path the tests exercise. `vi.mock` is hoisted.
vi.mock('matrix-js-sdk', () => ({
  createClient: vi.fn(() => ({
    getStateEvent: vi.fn().mockResolvedValue(null),
    sendStateEvent: vi.fn().mockResolvedValue({ event_id: '$mock' }),
    sendEvent: vi.fn().mockResolvedValue({ event_id: '$mock' }),
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
  })),
  ClientEvent: { Sync: 'sync' },
  Filter: vi.fn(),
  SyncState: { Prepared: 'PREPARED', Syncing: 'SYNCING', Error: 'ERROR' },
}));

const MATRIX_CONFIG = {
  MATRIX_BASE_URL: 'https://matrix.test.ixo.world',
  MATRIX_ORACLE_ADMIN_USER_ID: '@oracle:matrix.test.ixo.world',
  MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: 'oracle-admin-token',
};

describe('EditorPlugin', () => {
  it('has the expected identity, manifest, and config schema', () => {
    const plugin = new EditorPlugin();
    expect(plugin.name).toBe('editor');
    expect(plugin.name).toBe(EditorPlugin.NAME);
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('Editor');
    expect(plugin.manifest.visibility).toBe('always');
    expect(plugin.manifest.stability).toBe('stable');
    expect(plugin.manifest.category).toBe('data');
    expect(plugin.manifest.whenToUse.length).toBeGreaterThan(0);

    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);

    expect(plugin.configSchema).toBeDefined();
    expect(plugin.configSchema!.safeParse({}).success).toBe(false);
    expect(plugin.configSchema!.safeParse(MATRIX_CONFIG).success).toBe(true);
  });

  it('contributes no request tools or sub-agents when neither editorRoomId nor spaceId is set', async () => {
    const plugin = new EditorPlugin();
    const ctx = makeRuntimeContext({
      config: MATRIX_CONFIG,
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [] },
      },
    });

    expect(await plugin.getRequestTools(ctx)).toEqual([]);
    expect(await plugin.getRequestSubAgents(ctx)).toEqual([]);
  });

  it('contributes the standalone call_editor_agent tool when only spaceId is set', async () => {
    const plugin = new EditorPlugin();
    const ctx = makeRuntimeContext({
      config: MATRIX_CONFIG,
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [], spaceId: '!space:matrix.test.ixo.world' },
      },
    });

    const tools = await plugin.getRequestTools(ctx);
    expect(tools.map((t) => t.name)).toEqual(['call_editor_agent']);
    expect(await plugin.getRequestSubAgents(ctx)).toEqual([]);
  });

  it('contributes apply_sandbox_output_to_block when editorRoomId set AND sandbox plugin loaded AND sandbox URL configured', async () => {
    const plugin = new EditorPlugin();

    const baseState = {
      messages: [],
      editorRoomId: '!room:matrix.test.ixo.world',
      spaceId: '!space:matrix.test.ixo.world',
    };

    // Sandbox not in availablePlugins → apply_sandbox tool is absent
    const ctxNoSandbox = makeRuntimeContext({
      config: { ...MATRIX_CONFIG, SANDBOX_MCP_URL: 'https://sandbox.test.ixo' },
      availablePlugins: new Set<string>(),
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: baseState,
      },
    });
    expect((await plugin.getRequestTools(ctxNoSandbox)).map((t) => t.name)).toEqual(
      [],
    );

    // Sandbox available + URL configured → tool surfaces
    const ctxWithSandbox = makeRuntimeContext({
      config: { ...MATRIX_CONFIG, SANDBOX_MCP_URL: 'https://sandbox.test.ixo' },
      availablePlugins: new Set([SandboxPlugin.NAME]),
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: baseState,
      },
    });
    const tools = await plugin.getRequestTools(ctxWithSandbox);
    expect(tools.map((t) => t.name)).toEqual(['apply_sandbox_output_to_block']);
  });

  it('omits apply_sandbox_output_to_block when sandbox is loaded but SANDBOX_MCP_URL is missing', async () => {
    const plugin = new EditorPlugin();
    const ctx = makeRuntimeContext({
      config: MATRIX_CONFIG,
      availablePlugins: new Set([SandboxPlugin.NAME]),
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: {
          messages: [],
          editorRoomId: '!room:matrix.test.ixo.world',
        },
      },
    });
    expect((await plugin.getRequestTools(ctx)).map((t) => t.name)).toEqual([]);
  });

  it('returns an empty sub-agent list when the underlying build fails (auth missing)', async () => {
    const plugin = new EditorPlugin();
    // Force a build failure by stripping the Matrix admin token. The
    // EditorMatrixClient init throws on missing creds; the plugin should swallow
    // it and log rather than crashing the graph build.
    const brokenConfig = {
      ...MATRIX_CONFIG,
      MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: '',
    };
    const ctx = makeRuntimeContext({
      config: brokenConfig,
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: {
          messages: [],
          editorRoomId: '!room:matrix.test.ixo.world',
        },
      },
    });
    // configSchema.parse rejects empty string — getRequestSubAgents catches
    // and logs, returning an empty list.
    const subAgents = await plugin.getRequestSubAgents(ctx);
    expect(subAgents).toEqual([]);
  });

  it('is registered in the bundled plugins set under the name "editor"', async () => {
    // Importing `../index.js` cascades into every bundled plugin's module
    // graph, which pulls matrix-js-sdk; cold-loading those decls can take
    // several seconds. The default 5s vitest timeout is too tight.
    const { BUNDLED_PLUGINS, editorPlugin } = await import('../index.js');
    expect(editorPlugin.name).toBe('editor');
    expect(editorPlugin).toBeInstanceOf(EditorPlugin);
    expect(BUNDLED_PLUGINS.some((p) => p.name === 'editor')).toBe(true);
  }, 15_000);
});

describe('EditorPlugin: standalone tool schema', () => {
  it('builds a tool whose schema requires room_id and task', async () => {
    const plugin = new EditorPlugin();
    const ctx = makeRuntimeContext({
      config: MATRIX_CONFIG,
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [], spaceId: '!space:matrix.test.ixo.world' },
      },
    });

    const tools = await plugin.getRequestTools(ctx);
    const standalone = tools.find((t) => t.name === 'call_editor_agent');
    expect(standalone).toBeDefined();

    const goodArgs = standalone!.schema.safeParse({
      room_id: '!page:matrix.test.ixo.world',
      task: 'Read this page and summarize.',
    });
    expect(goodArgs.success).toBe(true);

    const badRoom = standalone!.schema.safeParse({
      room_id: 'not-a-matrix-id',
      task: 'do stuff',
    });
    expect(badRoom.success).toBe(false);
  });
});

