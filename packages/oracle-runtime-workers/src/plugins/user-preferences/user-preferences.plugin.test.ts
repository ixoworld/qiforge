/**
 * User Preferences plugin — the store over a fake room-state gateway (incl.
 * a payload written by the REAL Node encoder), the merge/`updatedAt`
 * semantics, cache invalidation on write, the tool's error contract, and the
 * `GET /user-preferences` route.
 */
import { describe, expect, it } from 'vitest';
import { makeBuildCtx, makeRuntimeContext } from '../../core/test-fixtures';
import type { OracleWorkerEnv } from '../../do/contracts';
import {
  decodeRoomStateContent,
  ROOM_STATE_EVENT_TYPE,
} from '../../matrix/room-state-codec';
import { USER_PREFS_STATE_KEY } from './schema';
import {
  UserPreferencesStore,
  type RoomStateAccess,
} from './user-preferences-store';
import { SET_USER_PREFERENCES_TOOL_NAME } from './user-preferences-tool';
import {
  UserPreferencesPlugin,
  type PreferencesGateway,
} from './user-preferences.plugin';

// superjson → deflateSync → base64 of the record below, produced by Node's
// `@ixo/matrix` MatrixStateManager (the Node runtime's writer).
const NODE_WRITTEN = {
  userName: 'Zed',
  language: 'en',
  tone: 'concise and dry',
  formality: 'casual',
  customInstructions: 'Keep replies under three sentences.',
  updatedAt: '2026-09-01T10:00:00.000Z',
};
const NODE_FIXTURE =
  'eJwViTELgzAUBv9K+OYo0aHQbB1LoVMnt5C8Wou+SN7LINL/XgI3HHcnvpIZ/kQVKs+wETwmSrBYA881zC0Qw0IzN4+Z4yJkAieTygGLdy5bWBc92g1SwwqLWEXzdmfRUqMumQUeD6LdFNrXhcRUTlSMfgqREWIljiQ9LOqeglK6KTxGN146d+3c8Bqcd43eOTfh9/sDLEo9Fw==';

class FakeRoomState implements RoomStateAccess {
  readonly events = new Map<string, string>();

  reads = 0;

  writes = 0;

  private key(roomId: string, type: string, stateKey?: string): string {
    return `${roomId}|${type}|${stateKey ?? ''}`;
  }

  seed(roomId: string, stateKey: string, content: unknown): void {
    this.events.set(
      this.key(roomId, ROOM_STATE_EVENT_TYPE, stateKey),
      JSON.stringify(content),
    );
  }

  async getRoomStateEvent(
    roomId: string,
    type: string,
    stateKey?: string,
  ): Promise<string | null> {
    this.reads += 1;
    return this.events.get(this.key(roomId, type, stateKey)) ?? null;
  }

  async sendStateEvent(
    roomId: string,
    type: string,
    content: string,
    stateKey?: string,
  ): Promise<string> {
    this.writes += 1;
    this.events.set(this.key(roomId, type, stateKey), content);
    return `$evt${this.writes}`;
  }

  async stored(roomId: string): Promise<unknown> {
    const raw = this.events.get(
      this.key(roomId, ROOM_STATE_EVENT_TYPE, USER_PREFS_STATE_KEY),
    );
    return raw ? decodeRoomStateContent(JSON.parse(raw) as unknown) : null;
  }
}

const ROOM = '!room:example.org';

describe('UserPreferencesStore', () => {
  it('returns undefined for a room without preferences and caches the miss', async () => {
    const fake = new FakeRoomState();
    const store = new UserPreferencesStore(fake);
    await expect(store.get(ROOM)).resolves.toBeUndefined();
    await expect(store.get(ROOM)).resolves.toBeUndefined();
    expect(fake.reads).toBe(1);
  });

  it('reads preferences written by the Node runtime', async () => {
    const fake = new FakeRoomState();
    fake.seed(ROOM, USER_PREFS_STATE_KEY, { data: NODE_FIXTURE });
    const store = new UserPreferencesStore(fake);
    await expect(store.get(ROOM)).resolves.toEqual(NODE_WRITTEN);
  });

  it('merges partial updates, stamps updatedAt, writes the Node envelope, and invalidates the cache', async () => {
    const fake = new FakeRoomState();
    fake.seed(ROOM, USER_PREFS_STATE_KEY, { data: NODE_FIXTURE });
    let clock = Date.parse('2026-09-02T12:00:00.000Z');
    const store = new UserPreferencesStore(fake, { now: () => clock });

    // Warm the cache, then write.
    await store.get(ROOM);
    const merged = await store.set(ROOM, {
      agentName: 'Companion',
      tone: undefined, // ignored — never clears a field
    });
    expect(merged).toEqual({
      ...NODE_WRITTEN,
      agentName: 'Companion',
      updatedAt: '2026-09-02T12:00:00.000Z',
    });
    // Persisted in the compressed envelope (what Node reads), not plain JSON.
    const raw = JSON.parse(
      fake.events.get(
        `${ROOM}|${ROOM_STATE_EVENT_TYPE}|${USER_PREFS_STATE_KEY}`,
      )!,
    ) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(['data']);
    await expect(fake.stored(ROOM)).resolves.toEqual(merged);

    // The very next read sees the write (cache invalidated), within the TTL.
    clock += 1000;
    await expect(store.get(ROOM)).resolves.toEqual(merged);
  });

  it('treats an empty update as a no-op', async () => {
    const fake = new FakeRoomState();
    const store = new UserPreferencesStore(fake);
    await expect(store.set(ROOM, {})).resolves.toEqual({});
    await expect(store.set(ROOM, { tone: undefined })).resolves.toEqual({});
    expect(fake.writes).toBe(0);
  });

  it('rejects invalid values instead of persisting them', async () => {
    const fake = new FakeRoomState();
    const store = new UserPreferencesStore(fake);
    await expect(
      store.set(ROOM, { formality: 'shouty' as never }),
    ).rejects.toThrow();
    expect(fake.writes).toBe(0);
  });

  it('ignores an unreadable payload and a failing gateway (never throws)', async () => {
    const fake = new FakeRoomState();
    fake.seed(ROOM, USER_PREFS_STATE_KEY, { data: '!!garbage!!' });
    const warnings: string[] = [];
    const store = new UserPreferencesStore(fake, {
      logger: {
        log: () => undefined,
        warn: (m: string) => {
          warnings.push(m);
        },
        error: () => undefined,
      },
    });
    await expect(store.get(ROOM)).resolves.toBeUndefined();

    const failing: RoomStateAccess = {
      getRoomStateEvent: async () => {
        throw new Error('gateway down');
      },
      sendStateEvent: async () => '$x',
    };
    await expect(
      new UserPreferencesStore(failing, { logger: store['logger'] }).get(ROOM),
    ).resolves.toBeUndefined();
    expect(warnings.some((w) => /gateway down/.test(w))).toBe(true);
  });
});

describe('UserPreferencesPlugin', () => {
  const plugin = new UserPreferencesPlugin();

  it('exposes set_user_preferences as an always-visible core capability', () => {
    const tools = plugin.getTools(makeBuildCtx());
    expect(tools.map((t) => t.name)).toEqual([SET_USER_PREFERENCES_TOOL_NAME]);
    expect(plugin.manifest.visibility).toBe('always');
    expect(plugin.manifest.category).toBe('core');
  });

  it('the tool writes through ctx.preferences for the active room', async () => {
    const fake = new FakeRoomState();
    const store = new UserPreferencesStore(fake);
    const [setTool] = plugin.getTools(makeBuildCtx());
    const ctx = makeRuntimeContext({
      preferences: store,
      session: { id: 's1', client: 'portal', requestId: 'r1', roomId: ROOM },
    });
    const reply = await setTool!.handler(
      { userName: 'Zed', formality: 'casual' },
      ctx,
    );
    expect(String(reply)).toMatch(/^Updated\. New preferences:/);
    await expect(fake.stored(ROOM)).resolves.toMatchObject({
      userName: 'Zed',
      formality: 'casual',
    });
  });

  it('the tool reports (not throws) a missing room or host surface', async () => {
    const [setTool] = plugin.getTools(makeBuildCtx());
    const noRoom = makeRuntimeContext({
      preferences: new UserPreferencesStore(new FakeRoomState()),
      session: { id: 's1', client: 'portal', requestId: 'r1' },
    });
    await expect(setTool!.handler({ tone: 'terse' }, noRoom)).resolves.toBe(
      '[Error updating user preferences: no active room on this session]',
    );
    const noHost = makeRuntimeContext({
      session: { id: 's1', client: 'portal', requestId: 'r1', roomId: ROOM },
    });
    await expect(setTool!.handler({ tone: 'terse' }, noHost)).resolves.toBe(
      '[Error updating user preferences: preferences are not available on this host]',
    );
  });

  it("GET /user-preferences returns the caller's record, null without a room, 401 unauthenticated", async () => {
    const fake = new FakeRoomState();
    fake.seed(ROOM, USER_PREFS_STATE_KEY, { data: NODE_FIXTURE });
    const gateway: PreferencesGateway = Object.assign(fake, {
      resolveUserRoom: async (userDid: string) =>
        userDid === 'did:ixo:zed' ? { roomId: ROOM, alias: '#a:b' } : null,
    });
    const routed = new UserPreferencesPlugin({ gatewayFor: () => gateway });
    const [route] = routed.getRoutes(makeBuildCtx());
    expect(route).toMatchObject({ method: 'GET', path: '/user-preferences' });
    const env = {} as OracleWorkerEnv;
    const req = new Request('https://oracle.test/user-preferences');

    const found = await route!.handler(req, env, {
      auth: { userDid: 'did:ixo:zed' } as never,
    });
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toEqual(NODE_WRITTEN);

    const noRoom = await route!.handler(req, env, {
      auth: { userDid: 'did:ixo:stranger' } as never,
    });
    expect(noRoom.status).toBe(200);
    await expect(noRoom.json()).resolves.toBeNull();

    const anon = await route!.handler(req, env, { auth: null });
    expect(anon.status).toBe(401);
  });
});
