/**
 * Plugin surface + access guard, in the Workers pool.
 *
 * No module mocking: on Workers the membership guard reads room state through
 * `ctx.matrix` (the gateway adapter), so tests inject a fake adapter through
 * the runtime-context fixture instead of patching module internals. Nothing
 * here reaches the network — the guard refuses before any Matrix client is
 * built.
 */
import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../core/manifest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { MatrixAdapter } from '../../core/runtime-context';
import type { RoomStateSnapshot } from '../../plugin-api/types';
import { EDITOR_AGENT_TOOL_NAME } from './editor-agent';
import { EditorPlugin } from './editor.plugin';
import { isUserInRoom } from './room-membership';

const MATRIX_CONFIG = {
  MATRIX_BASE_URL: 'https://mx.test.example',
  MATRIX_ORACLE_ADMIN_USER_ID: '@oracle:test.example',
};
const BOT_CREDENTIALS = {
  baseUrl: 'https://mx.test.example',
  userId: '@oracle:test.example',
  accessToken: 'syt_test_token',
  deviceId: 'EDITORDEV1',
};

/** Matrix adapter whose room state is a fixed member list; everything else throws. */
function matrixWithMembers(roomId: string, joined: string[]): MatrixAdapter {
  const state: RoomStateSnapshot = {
    roomId,
    state: joined.map((userId) => ({
      type: 'm.room.member',
      state_key: userId,
      content: { membership: 'join' },
      sender: userId,
      event_id: `$${userId}`,
    })),
  };
  return {
    postToRoom: () => Promise.reject(new Error('unexpected postToRoom')),
    postEvent: () => Promise.reject(new Error('unexpected postEvent')),
    getRoomState: (requested) =>
      requested === roomId
        ? Promise.resolve(state)
        : Promise.reject(new Error(`unknown room ${requested}`)),
    getEventById: () => Promise.reject(new Error('unexpected getEventById')),
    botCredentials: () => Promise.resolve(BOT_CREDENTIALS),
  };
}

describe('EditorPlugin', () => {
  it('has the expected identity and a valid manifest', () => {
    const plugin = new EditorPlugin();
    expect(plugin.name).toBe('editor');
    expect(plugin.manifest.title).toBe('Documents');
    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('contributes exactly the call_editor_agent tool when Matrix is configured', async () => {
    const ctx = makeRuntimeContext(undefined, {
      ambient: { config: { ...MATRIX_CONFIG } },
    });
    ctx.matrix.botCredentials = () => Promise.resolve(BOT_CREDENTIALS);
    const tools = await new EditorPlugin().getRequestTools(ctx);
    expect(tools.map((t) => t.name)).toEqual([EDITOR_AGENT_TOOL_NAME]);
  });

  it('contributes no tools when the gateway cannot hand out bot credentials', async () => {
    // The editor's polling client needs a device token from the gateway; if
    // that fails the plugin degrades to zero tools instead of failing the
    // request build.
    const ctx = makeRuntimeContext(undefined, {
      ambient: { config: { ...MATRIX_CONFIG } },
    });
    ctx.matrix.botCredentials = () =>
      Promise.reject(new Error('gateway unavailable'));
    expect(await new EditorPlugin().getRequestTools(ctx)).toEqual([]);
  });
});

describe('room membership guard (fail closed)', () => {
  it('accepts a joined member and refuses a non-member', async () => {
    const roomId = '!members-a:test.example';
    const ctx = { matrix: matrixWithMembers(roomId, ['@alice:test.example']) };
    expect(await isUserInRoom(ctx, roomId, '@alice:test.example')).toBe(true);
    expect(await isUserInRoom(ctx, roomId, '@mallory:test.example')).toBe(
      false,
    );
  });

  it('refuses when the state lookup fails', async () => {
    const ctx = {
      matrix: matrixWithMembers('!members-b:test.example', []),
    };
    // Unknown room → the fake adapter rejects → the guard must deny, not throw.
    expect(
      await isUserInRoom(ctx, '!other:test.example', '@alice:test.example'),
    ).toBe(false);
  });

  it('refuses a missing user id without touching Matrix', async () => {
    const ctx = {
      matrix: {
        postToRoom: () => Promise.reject(new Error('unexpected')),
        postEvent: () => Promise.reject(new Error('unexpected')),
        getRoomState: () => Promise.reject(new Error('must not be called')),
        getEventById: () => Promise.reject(new Error('unexpected')),
        botCredentials: () => Promise.reject(new Error('unexpected')),
      } satisfies MatrixAdapter,
    };
    expect(await isUserInRoom(ctx, '!members-c:test.example', undefined)).toBe(
      false,
    );
  });
});

describe('call_editor_agent access refusals', () => {
  async function buildTool(matrix: MatrixAdapter, editorRoomId?: string) {
    const ctx = makeRuntimeContext(undefined, {
      ambient: { config: { ...MATRIX_CONFIG }, matrix },
      state: {
        messages: [],
        ...(editorRoomId ? { editorRoomId } : {}),
      },
    });
    const tools = await new EditorPlugin().getRequestTools(ctx);
    const tool = tools[0];
    if (!tool) throw new Error('editor tool missing');
    return { tool, ctx };
  }

  it('returns no_document when no document is open and no room_id is given', async () => {
    const { tool, ctx } = await buildTool(
      matrixWithMembers('!unused:test.example', []),
    );
    const result = await tool.handler({ task: 'read the document' }, ctx);
    expect(JSON.parse(String(result))).toMatchObject({
      ok: false,
      code: 'no_document',
    });
  });

  it('returns not_a_member for a room the user is not joined to', async () => {
    const roomId = '!refusal:test.example';
    const { tool, ctx } = await buildTool(
      matrixWithMembers(roomId, []),
      roomId,
    );
    const result = await tool.handler({ task: 'read the document' }, ctx);
    expect(JSON.parse(String(result))).toMatchObject({
      ok: false,
      code: 'not_a_member',
      roomId,
    });
  });
});
