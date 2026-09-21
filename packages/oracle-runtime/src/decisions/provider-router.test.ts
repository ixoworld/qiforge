import type { DecisionAdapter } from '@ixo/common';
import { describe, expect, it } from 'vitest';
import { DecisionProviderRegistry } from './provider-registry.js';
import { DecisionProviderRouter } from './provider-router.js';

function adapter(provider: string): DecisionAdapter {
  return {
    provider,
    model: `${provider}-model`,
    async evaluate() {
      return { answers: {} };
    },
  };
}

describe('DecisionProviderRouter', () => {
  it('selects caller override, Decision route, then default in that order', () => {
    const registry = new DecisionProviderRegistry([
      { id: 'default', adapter: adapter('default') },
      { id: 'route', adapter: adapter('route') },
      { id: 'override', adapter: adapter('override') },
    ]);
    const router = new DecisionProviderRouter(registry, {
      defaultProviderId: 'default',
      routes: { 'commerce.route': 'route' },
    });

    expect(router.resolve('commerce.route')?.provider.id).toBe('route');
    expect(router.resolve('commerce.route')?.selectedBy).toBe('decision-route');
    expect(router.resolve('other')?.provider.id).toBe('default');
    expect(router.resolve('other')?.selectedBy).toBe('default');
    expect(router.resolve('commerce.route', 'override')?.provider.id).toBe(
      'override',
    );
    expect(router.resolve('commerce.route', 'override')?.selectedBy).toBe(
      'caller-override',
    );
  });

  it('uses the sole registered provider for legacy-compatible configuration', () => {
    const router = new DecisionProviderRouter(
      new DecisionProviderRegistry([
        { id: 'cloudflare-jev', adapter: adapter('cloudflare') },
      ]),
    );

    expect(router.resolve('any.decision')?.provider.id).toBe('cloudflare-jev');
    expect(router.resolve('any.decision')?.selectedBy).toBe('default');
  });

  it('does not pick an arbitrary provider when several are unrouted', () => {
    const router = new DecisionProviderRouter(
      new DecisionProviderRegistry([
        { id: 'a', adapter: adapter('a') },
        { id: 'b', adapter: adapter('b') },
      ]),
    );

    expect(router.resolve('unrouted')).toBeUndefined();
  });

  it('fails construction when policy references an unknown provider', () => {
    const registry = new DecisionProviderRegistry([
      { id: 'a', adapter: adapter('a') },
    ]);

    expect(
      () =>
        new DecisionProviderRouter(registry, {
          defaultProviderId: 'missing',
        }),
    ).toThrow(/not registered/);
  });
});
