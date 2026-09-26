import { describe, expect, it, vi } from 'vitest';
import { admitRequest, admissionMetadata } from './request-admission';
import { makePlugin, makeBuildCtx, makeRunConfig } from './test-fixtures';
import { buildRuntimeContext, createNoopAmbient } from './runtime-context';
import { MiddlewareRegistry } from './registries';
import type { RequestAdmissionContext } from '../plugin-api/request-admission';

function context(did: string): RequestAdmissionContext {
  return {
    config: {},
    user: { did, matrixUserId: '', ucanDelegation: { raw: '' } },
    session: { id: did, requestId: did, client: 'portal' },
    message: '/status',
    signal: new AbortController().signal,
  };
}

describe('request admission', () => {
  it('isolates concurrent users and stops after the first handler', async () => {
    const fallback = vi.fn(() => ({ kind: 'pass' as const }));
    const plugins = [
      makePlugin({
        name: 'read',
        getRequestAdmission: async (ctx) => ({
          kind: 'handled',
          text: ctx.user.did,
          title: 'Status',
        }),
      }),
      makePlugin({ name: 'fallback', getRequestAdmission: fallback }),
    ];
    const results = await Promise.all(
      ['alice', 'bob'].map((did) => admitRequest(plugins, context(did))),
    );
    expect(results).toEqual([
      { kind: 'handled', text: 'alice', title: 'Status' },
      { kind: 'handled', text: 'bob', title: 'Status' },
    ]);
    expect(fallback).not.toHaveBeenCalled();
  });
  it('does not turn a denied read into agent fallback', async () => {
    await expect(
      admitRequest(
        [
          makePlugin({
            name: 'read',
            getRequestAdmission: () => {
              throw new Error('denied');
            },
          }),
        ],
        context('alice'),
      ),
    ).rejects.toThrow('denied');
  });
  it('rejects late success after cancellation', async () => {
    const abort = new AbortController();
    await expect(
      admitRequest(
        [
          makePlugin({
            name: 'read',
            getRequestAdmission: () => {
              abort.abort(new Error('cancelled'));
              return { kind: 'handled', text: 'Status', title: 'Status' };
            },
          }),
        ],
        { ...context('alice'), signal: abort.signal },
      ),
    ).rejects.toThrow('cancelled');
  });
  it('bounds and validates optional metadata', () => {
    expect(admissionMetadata('{"flowId":"a"}')).toEqual({ flowId: 'a' });
    expect(admissionMetadata('[]')).toBeUndefined();
    expect(admissionMetadata('x'.repeat(16385))).toBeUndefined();
  });
  it('collects request middleware freshly without changing the boot cache', async () => {
    const registry = new MiddlewareRegistry();
    const hook = vi.fn(() => []);
    registry.register(
      makePlugin({ name: 'read', getRequestMiddlewares: hook }),
    );
    const first = buildRuntimeContext(makeRunConfig(), createNoopAmbient(), {
      messages: [],
      loadedPlugins: new Set(),
    });
    const second = buildRuntimeContext(makeRunConfig(), createNoopAmbient(), {
      messages: [],
      loadedPlugins: new Set(),
    });
    registry.collect(makeBuildCtx());
    await registry.collectRequest(first);
    await registry.collectRequest(second);
    expect(hook.mock.calls).toEqual([[first], [second]]);
  });
});
