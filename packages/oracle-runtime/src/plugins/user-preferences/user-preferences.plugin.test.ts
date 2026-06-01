import { describe, expect, it, vi } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import { createTestRuntime } from '../../testing/create-test-runtime.js';
import {
  makeBuildCtx,
  makeRuntimeContext,
} from '../../registries/test-fixtures.js';
import type { RuntimeContext } from '../../plugin-api/types.js';
import {
  UserPreferencesSchema,
  type UserPreferences,
} from './service/user-preferences.service.js';
import {
  UserPreferencesPlugin,
  type UserPreferencesPluginService,
} from './user-preferences.plugin.js';

/** Defensive parse — JSON.parse returns `any`, the schema gives us a typed result. */
function parsePrefsPayload(payload: string): UserPreferences {
  return UserPreferencesSchema.parse(JSON.parse(payload));
}

/** Strongly-typed `set` mock matching `UserPreferencesPluginService['set']`. */
function makeSetMock(
  impl: UserPreferencesPluginService['set'] = async (_roomId, partial) =>
    UserPreferencesSchema.parse({
      ...partial,
      updatedAt: '2026-05-11T00:00:00.000Z',
    }),
) {
  return vi.fn<UserPreferencesPluginService['set']>(impl);
}

function makeServiceStub(
  overrides: Partial<UserPreferencesPluginService> = {},
): UserPreferencesPluginService {
  return {
    get: vi.fn(async () => undefined),
    set: makeSetMock(),
    ...overrides,
  };
}

describe('UserPreferencesPlugin', () => {
  it('has the expected name, version, and manifest shape', () => {
    const plugin = new UserPreferencesPlugin(makeServiceStub());
    expect(plugin.name).toBe('user-preferences');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('User Preferences');
    expect(plugin.manifest.visibility).toBe('always');
    expect(plugin.manifest.stability).toBe('stable');
    expect(plugin.manifest.category).toBe('core');
    expect(plugin.manifest.whenToUse.length).toBeGreaterThan(0);
  });

  it('manifest passes validateManifest', () => {
    const plugin = new UserPreferencesPlugin(makeServiceStub());
    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  describe('getTools', () => {
    it('returns the set_user_preferences tool', () => {
      const plugin = new UserPreferencesPlugin(makeServiceStub());
      const tools = plugin.getTools(makeBuildCtx());
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('set_user_preferences');
      // Description must include the literal "call me Yousef" hook the agent recognises.
      expect(tools[0]?.description).toContain('call me Yousef');
    });

    it('merges partial updates with existing preferences via service.set, preserving prior fields', async () => {
      const existing: UserPreferences = {
        agentName: 'Companion',
        language: 'en',
        formality: 'casual',
      };
      const set = makeSetMock(async (_roomId, partial) =>
        UserPreferencesSchema.parse({
          ...existing,
          ...partial,
          updatedAt: '2026-05-11T00:00:00.000Z',
        }),
      );
      const plugin = new UserPreferencesPlugin(makeServiceStub({ set }));
      const [tool] = plugin.getTools(makeBuildCtx());
      if (!tool) throw new Error('tool missing');

      const ctx = makeRuntimeContext({
        session: {
          id: 'session-1',
          client: 'matrix',
          requestId: 'req-1',
          roomId: '!room:ixo.world',
        },
      });
      const result = await tool.handler({ userName: 'Yousef' }, ctx);

      expect(set).toHaveBeenCalledWith('!room:ixo.world', {
        userName: 'Yousef',
      });
      if (typeof result !== 'string') {
        throw new Error('expected tool to return a string');
      }
      const payload = result.replace(/^Updated\. New preferences: /, '');
      const parsed = parsePrefsPayload(payload);
      expect(parsed.userName).toBe('Yousef');
      expect(parsed.agentName).toBe('Companion');
      expect(parsed.language).toBe('en');
      expect(parsed.formality).toBe('casual');
    });

    it('rejects an invalid formality value before calling the service', async () => {
      const set = makeSetMock();
      const plugin = new UserPreferencesPlugin(makeServiceStub({ set }));
      const [tool] = plugin.getTools(makeBuildCtx());
      if (!tool) throw new Error('tool missing');

      const ctx = makeRuntimeContext({
        session: {
          id: 's',
          client: 'matrix',
          requestId: 'r',
          roomId: '!room:ixo.world',
        },
      });

      await expect(
        tool.handler({ formality: 'very casual' }, ctx),
      ).rejects.toBeDefined();
      expect(set).not.toHaveBeenCalled();
    });

    it('returns a descriptive error string when ctx.session.roomId is missing', async () => {
      const set = makeSetMock();
      const plugin = new UserPreferencesPlugin(makeServiceStub({ set }));
      const [tool] = plugin.getTools(makeBuildCtx());
      if (!tool) throw new Error('tool missing');

      const ctx: RuntimeContext = makeRuntimeContext(); // no roomId
      const result = await tool.handler({ userName: 'Yousef' }, ctx);

      expect(set).not.toHaveBeenCalled();
      expect(result).toMatch(/no active room/i);
    });
  });

  it('loads via createTestRuntime and registers set_user_preferences with the agent', async () => {
    const rt = await createTestRuntime({
      plugins: [new UserPreferencesPlugin(makeServiceStub())],
    });

    rt.assertNoCollisions();
    rt.assertManifestValid();
    const listing = rt
      .listCapabilities()
      .find((c) => c.name === 'user-preferences');
    expect(listing?.visibility).toBe('always');
    expect(rt.listTools('user-preferences').map((t) => t.name)).toEqual([
      'set_user_preferences',
    ]);
    await rt.close();
  });
});
