import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import { isUserInRoom } from '../../matrix/room-membership.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { CONTENT_TOOL_NAMES } from './content-tools.js';
import { EDITOR_AGENT_TOOL_NAME } from './editor-agent.js';
import { EditorPlugin } from './editor.plugin.js';

// Every room the editor touches is behind a membership check. The real check
// hits Matrix; here the precondition is modelled directly — default to "the
// user is a member" and override per test to exercise the denial paths.
vi.mock('../../matrix/room-membership.js', () => ({
  isUserInRoom: vi.fn().mockResolvedValue(true),
  invalidateRoomMembership: vi.fn(),
}));

// Avoid the ~2.7s matrix-js-sdk module load. The editor only needs a
// MatrixClient shape at build time — it never hits the wire in these tests.
vi.mock('matrix-js-sdk', () => ({
  createClient: vi.fn(() => ({
    getUserId: vi.fn(() => '@oracle:matrix.test.ixo.world'),
    getStateEvent: vi.fn().mockResolvedValue(null),
    sendStateEvent: vi.fn().mockResolvedValue({ event_id: '$mock' }),
    sendEvent: vi.fn().mockResolvedValue({ event_id: '$mock' }),
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
  })),
  ClientEvent: { Sync: 'sync' },
  Filter: vi.fn(),
  SyncState: { Prepared: 'PREPARED', Syncing: 'SYNCING', ERROR: 'ERROR' },
}));

const MATRIX_CONFIG = {
  MATRIX_BASE_URL: 'https://matrix.test.ixo.world',
  MATRIX_ORACLE_ADMIN_USER_ID: '@oracle:matrix.test.ixo.world',
  MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: 'oracle-admin-token',
};

const ROOM_ID = '!page:matrix.test.ixo.world';
const SPACE_ID = '!space:matrix.test.ixo.world';

function contextWith(
  state: Record<string, unknown>,
  config: Record<string, unknown> = MATRIX_CONFIG,
) {
  return makeRuntimeContext({
    config,
    history: {
      messages: [],
      recent: () => [],
      userContext: {},
      state: { messages: [], ...state },
    },
  });
}

beforeEach(() => {
  // Reset call history too, not just the return value: tests assert on
  // whether the guard was consulted, and calls from earlier tests would leak.
  vi.mocked(isUserInRoom).mockClear().mockResolvedValue(true);
});

describe('EditorPlugin', () => {
  it('has the expected identity, manifest, and config schema', () => {
    const plugin = new EditorPlugin();
    expect(plugin.name).toBe('editor');
    expect(plugin.name).toBe(EditorPlugin.NAME);
    expect(plugin.manifest.title).toBe('Documents');
    expect(plugin.manifest.visibility).toBe('on-demand');
    expect(plugin.manifest.stability).toBe('stable');
    expect(plugin.manifest.category).toBe('data');
    expect(plugin.manifest.whenToUse.length).toBeGreaterThan(0);

    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);

    // The editor exposes no public configSchema — the Matrix env vars it needs
    // are owned by the core base env schema.
    expect(plugin.configSchema).toBeUndefined();
  });

  it('binds the standalone tool even when no document and no space are in scope', async () => {
    // Regression: tools are resolved once per request, so a room the agent
    // creates mid-turn (`create_page_room`) is never in state. Gating the
    // standalone tool on `spaceId` meant the agent could create a page in the
    // workspace chat and then have nothing to write into it.
    const plugin = new EditorPlugin();
    const ctx = contextWith({});

    const tools = await plugin.getRequestTools(ctx);
    expect(tools.map((t) => t.name)).toEqual([EDITOR_AGENT_TOOL_NAME]);
  });

  it('targets the open document by default when no room_id is passed', async () => {
    // One tool for every case: with a document open it must still be the same
    // `call_editor_agent`, and a call that omits `room_id` must resolve to the
    // open document. The membership refusal is the cheapest observable proof
    // of which room was targeted — it names the room without needing an LLM.
    vi.mocked(isUserInRoom).mockResolvedValue(false);
    const plugin = new EditorPlugin();
    const ctx = contextWith({ editorRoomId: ROOM_ID });

    const tools = await plugin.getRequestTools(ctx);
    expect(tools.map((t) => t.name)).toEqual([EDITOR_AGENT_TOOL_NAME]);

    const raw = await tools[0]?.handler({ task: 'read it' }, ctx);
    expect(JSON.parse(String(raw))).toMatchObject({
      ok: false,
      code: 'not_a_member',
      roomId: ROOM_ID,
    });
  });

  it('lets an explicit room_id override the open document', async () => {
    // The case that motivated the single tool: a page created mid-turn while
    // another document is open. The explicit id must win over state.
    vi.mocked(isUserInRoom).mockResolvedValue(false);
    const plugin = new EditorPlugin();
    const ctx = contextWith({ editorRoomId: ROOM_ID });
    const other = '!just-created:matrix.test.ixo.world';

    const [tool] = await plugin.getRequestTools(ctx);
    const raw = await tool?.handler({ room_id: other, task: 'write it' }, ctx);
    expect(JSON.parse(String(raw))).toMatchObject({
      ok: false,
      code: 'not_a_member',
      roomId: other,
    });
  });

  it('never contributes flow, execution, or page-lifecycle tools', () => {
    // The inner agent binds exactly the content tools; nothing else exists.
    const names: readonly string[] = CONTENT_TOOL_NAMES;

    for (const removed of [
      'mint_invocation',
      'execute_action',
      'create_page',
      'update_page',
      'read_page',
      'read_survey',
      'fill_survey_answers',
      'validate_survey_answers',
      'read_flow_status',
      'read_flow_context',
      'read_block_history',
      'read_permissions',
      'apply_sandbox_output_to_block',
    ]) {
      expect(names).not.toContain(removed);
    }
  });

  it('binds the standalone call_editor_agent tool when only a space is in scope', async () => {
    const plugin = new EditorPlugin();
    const ctx = contextWith({ spaceId: SPACE_ID });

    const tools = await plugin.getRequestTools(ctx);
    expect(tools.map((tool) => tool.name)).toEqual(['call_editor_agent']);
  });

  it('binds the standalone tool regardless of space membership — the guard is per call', async () => {
    // Space membership never implied rights over a document, and the room the
    // agent names need not live in that space. Access is enforced inside the
    // tool by `isUserInRoom(room_id, user)`, covered by the `not_a_member`
    // test below.
    vi.mocked(isUserInRoom).mockResolvedValue(false);
    const plugin = new EditorPlugin();

    const tools = await plugin.getRequestTools(
      contextWith({ spaceId: SPACE_ID }),
    );
    expect(tools.map((t) => t.name)).toEqual([EDITOR_AGENT_TOOL_NAME]);
  });

  it('binds the same single tool when a document is already open', async () => {
    // There is no separate room-bound sub-agent any more, so nothing to
    // suppress: the one tool serves the open document and any other room.
    const plugin = new EditorPlugin();
    const tools = await plugin.getRequestTools(
      contextWith({ editorRoomId: ROOM_ID, spaceId: SPACE_ID }),
    );
    expect(tools.map((t) => t.name)).toEqual([EDITOR_AGENT_TOOL_NAME]);
  });

  it('binds nothing when the Matrix admin config is invalid', async () => {
    const plugin = new EditorPlugin();
    const ctx = contextWith(
      { editorRoomId: ROOM_ID },
      {
        ...MATRIX_CONFIG,
        MATRIX_ORACLE_ADMIN_ACCESS_TOKEN: '',
      },
    );
    // The schema rejects an empty token; the plugin logs and degrades rather
    // than crashing the graph build.
    expect(await plugin.getRequestTools(ctx)).toEqual([]);
  });

  it('is registered in the bundled plugins set under the name "editor"', async () => {
    // Importing `../index.js` cascades into every bundled plugin's module
    // graph; cold-loading those declarations can take several seconds.
    const { BUNDLED_PLUGINS, editorPlugin } = await import('../index.js');
    expect(editorPlugin.name).toBe('editor');
    expect(editorPlugin).toBeInstanceOf(EditorPlugin);
    expect(BUNDLED_PLUGINS.some((p) => p.name === 'editor')).toBe(true);
  }, 15_000);
});

describe('EditorPlugin: standalone tool', () => {
  it('takes an optional room id and a required task', async () => {
    const plugin = new EditorPlugin();
    const tools = await plugin.getRequestTools(
      contextWith({ spaceId: SPACE_ID }),
    );
    const standalone = tools.find((tool) => tool.name === 'call_editor_agent');
    expect(standalone).toBeDefined();

    expect(
      standalone?.schema.safeParse({
        room_id: ROOM_ID,
        task: 'Read this document and summarize it.',
      }).success,
    ).toBe(true);
    expect(
      standalone?.schema.safeParse({ room_id: 'not-a-room', task: 'x' })
        .success,
    ).toBe(false);
    // `room_id` is optional — omitted, the tool targets the open document.
    expect(standalone?.schema.safeParse({ task: 'x' }).success).toBe(true);
    expect(standalone?.schema.safeParse({}).success).toBe(false);
  });

  it('rejects a fabricated room id at the schema, before any Matrix round-trip', async () => {
    // Seen live: with no open document reported, the model filled the field
    // with `!,invalid:placeholder`. The old regex (`^!.+:.+$`) accepted it and
    // the membership guard then burned a homeserver call refusing it. A real
    // id never contains a comma or whitespace, so the schema can say no first
    // — and its message tells the model to omit the field instead.
    const plugin = new EditorPlugin();
    const [tool] = await plugin.getRequestTools(contextWith({}));

    for (const fake of [
      '!,invalid:placeholder',
      '!placeholder',
      '!room id:x',
    ]) {
      const parsed = tool?.schema.safeParse({ room_id: fake, task: 'read' });
      expect(parsed?.success).toBe(false);
    }
    // Real ids, including a port-qualified homeserver, still pass.
    for (const real of [ROOM_ID, '!abc:matrix.org:8448']) {
      expect(
        tool?.schema.safeParse({ room_id: real, task: 'read' }).success,
      ).toBe(true);
    }
    expect(isUserInRoom).not.toHaveBeenCalled();
  });

  it('returns no_document when nothing is open and no room_id is given', async () => {
    const plugin = new EditorPlugin();
    const ctx = contextWith({});
    const [tool] = await plugin.getRequestTools(ctx);

    const raw = await tool?.handler({ task: 'read it' }, ctx);
    expect(JSON.parse(String(raw))).toMatchObject({
      ok: false,
      code: 'no_document',
    });
    // Nothing to be a member of, so the membership guard was never consulted.
    expect(isUserInRoom).not.toHaveBeenCalled();
  });

  it('returns a typed not_a_member failure for a room the user is not in', async () => {
    const plugin = new EditorPlugin();
    const ctx = contextWith({ spaceId: SPACE_ID });
    const tools = await plugin.getRequestTools(ctx);
    const standalone = tools.find((tool) => tool.name === 'call_editor_agent');

    // Access is enforced per call, against the room actually named.
    vi.mocked(isUserInRoom).mockResolvedValue(false);
    const raw = await standalone?.handler(
      { room_id: '!someone-elses:matrix.test.ixo.world', task: 'read it' },
      ctx,
    );

    expect(typeof raw).toBe('string');
    const parsed: unknown = JSON.parse(String(raw));
    expect(parsed).toMatchObject({
      ok: false,
      code: 'not_a_member',
      roomId: '!someone-elses:matrix.test.ixo.world',
    });
  });
});
