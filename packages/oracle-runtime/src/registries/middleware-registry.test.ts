import { describe, expect, it } from 'vitest';
import { MiddlewareRegistry } from './middleware-registry.js';
import { makeBuildCtx, makeMiddleware, makePlugin } from './test-fixtures.js';

describe('MiddlewareRegistry', () => {
  it('collects middlewares in plugin registration order', () => {
    const m1 = makeMiddleware('m1');
    const m2 = makeMiddleware('m2');
    const m3 = makeMiddleware('m3');

    const reg = new MiddlewareRegistry();
    reg.register(
      makePlugin({ name: 'first', getMiddlewares: () => [m1, m2] }),
    );
    reg.register(makePlugin({ name: 'second', getMiddlewares: () => [m3] }));

    const collected = reg.collect(makeBuildCtx());
    expect(collected.map((c) => c.middleware)).toEqual([m1, m2, m3]);
    expect(collected.map((c) => c.pluginName)).toEqual([
      'first',
      'first',
      'second',
    ]);
  });

  it('forwards the supplied PluginContext to plugin getMiddlewares', () => {
    const reg = new MiddlewareRegistry();
    let received: unknown = null;
    reg.register(
      makePlugin({
        name: 'mw',
        getMiddlewares: (ctx) => {
          received = ctx.config;
          return [makeMiddleware('m1')];
        },
      }),
    );

    reg.collect(makeBuildCtx({ config: { OBSERVED: true } }));
    expect(received).toEqual({ OBSERVED: true });
  });

  it('handles plugins without getMiddlewares without erroring', () => {
    const reg = new MiddlewareRegistry();
    reg.register(makePlugin({ name: 'no-mw' }));
    expect(reg.collect(makeBuildCtx())).toEqual([]);
  });

  it('assertNoCollisions is a no-op (middlewares have no names)', () => {
    const reg = new MiddlewareRegistry();
    reg.register(
      makePlugin({
        name: 'a',
        getMiddlewares: () => [makeMiddleware('shared'), makeMiddleware('shared')],
      }),
    );
    reg.collect(makeBuildCtx());
    expect(() => reg.assertNoCollisions()).not.toThrow();
  });
});
