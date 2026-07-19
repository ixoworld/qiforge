import { describe, expect, it } from 'vitest';
import { SharedStateRegistry } from './shared-state-registry.js';
import { makePlugin, makeRuntimeContext } from './test-fixtures.js';

describe('SharedStateRegistry', () => {
  it('collects accessors from a single plugin', () => {
    const reg = new SharedStateRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getSharedState: () => ({
          userProfile: (state: { userContext?: unknown }) => state.userContext,
        }),
      }),
    );

    const collected = reg.collect();
    expect(collected).toHaveLength(1);
    expect(collected[0]?.key).toBe('userProfile');
    expect(collected[0]?.pluginName).toBe('memory');
  });

  it('build() returns a record where each key invokes its accessor with state and runCtx', () => {
    const reg = new SharedStateRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getSharedState: () => ({
          userProfile: (state: { userContext?: { name: string } }) =>
            state.userContext,
          sessionId: (_state, runCtx) => runCtx.session.id,
        }),
      }),
    );
    reg.collect();

    const runCtx = makeRuntimeContext({
      session: {
        id: 'session-xyz',
        client: 'portal',
        requestId: 'req-1',
      },
    });
    const state = { userContext: { name: 'Alice' } };
    const accessors = reg.build(state, runCtx);

    expect(accessors.userProfile).toEqual({ name: 'Alice' });
    expect(accessors.sessionId).toBe('session-xyz');
  });

  it('throws on shared-state key collision, naming both plugins', () => {
    const reg = new SharedStateRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getSharedState: () => ({
          userProfile: () => ({ source: 'memory' }),
        }),
      }),
    );
    reg.register(
      makePlugin({
        name: 'cache',
        getSharedState: () => ({
          userProfile: () => ({ source: 'cache' }),
        }),
      }),
    );

    expect(() => reg.assertNoCollisions()).toThrow(/userProfile/);
    expect(() => reg.assertNoCollisions()).toThrow(/memory/);
    expect(() => reg.assertNoCollisions()).toThrow(/cache/);
  });

  it('passes when two plugins expose disjoint keys', () => {
    const reg = new SharedStateRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getSharedState: () => ({
          userProfile: () => ({ source: 'memory' }),
        }),
      }),
    );
    reg.register(
      makePlugin({
        name: 'editor',
        getSharedState: () => ({
          editorRoomId: () => '!room:example',
        }),
      }),
    );

    expect(() => reg.assertNoCollisions()).not.toThrow();
    const accessors = reg.build({}, makeRuntimeContext());
    expect(accessors.userProfile).toEqual({ source: 'memory' });
    expect(accessors.editorRoomId).toBe('!room:example');
  });

  it('skips plugins without getSharedState', () => {
    const reg = new SharedStateRegistry();
    reg.register(makePlugin({ name: 'no-shared' }));
    reg.register(
      makePlugin({
        name: 'memory',
        getSharedState: () => ({
          userProfile: () => ({}),
        }),
      }),
    );
    expect(reg.collect()).toHaveLength(1);
  });

  it('filters keys by producer-declared visibleTo per consuming plugin', () => {
    const reg = new SharedStateRegistry();
    reg.register(
      makePlugin({
        name: 'profile',
        getSharedState: () => ({
          userProfile: () => ({ name: 'A' }),
          publicFlag: () => true,
        }),
        sharedStateVisibility: { userProfile: ['memory'] },
      }),
    );

    const ctx = makeRuntimeContext();

    // Allow-listed consumer sees the restricted key…
    expect(Object.keys(reg.build({}, ctx, 'memory'))).toEqual([
      'userProfile',
      'publicFlag',
    ]);
    // …an unlisted consumer sees only the unrestricted key…
    expect(Object.keys(reg.build({}, ctx, 'weather'))).toEqual(['publicFlag']);
    // …the producer always sees its own keys…
    expect(Object.keys(reg.build({}, ctx, 'profile'))).toEqual([
      'userProfile',
      'publicFlag',
    ]);
    // …and runtime-internal readers (no consumer) see everything.
    expect(Object.keys(reg.build({}, ctx))).toEqual([
      'userProfile',
      'publicFlag',
    ]);
  });
});
