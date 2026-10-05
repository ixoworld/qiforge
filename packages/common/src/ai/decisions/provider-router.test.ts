import { describe, expect, it } from 'vitest';
import {
  AmbiguousDecisionProviderError,
  DecisionProviderNotFoundError,
  DecisionProviderRegistry,
  DecisionProviderRouter,
} from './provider-router.js';
import { DecisionProviderUnavailableError } from './runtime.js';
import type { DecisionAdapter } from './types.js';

function adapter(provider: string): DecisionAdapter {
  return {
    provider,
    model: `${provider}-model`,
    async evaluate() {
      return { answers: {} };
    },
  };
}

describe('DecisionProviderRegistry', () => {
  it('registers configured provider instances by stable id, in order', () => {
    const registry = new DecisionProviderRegistry([
      { id: 'cloudflare-jev', adapter: adapter('cloudflare') },
      { id: 'semif-local', adapter: adapter('semif') },
    ]);

    expect(registry.size).toBe(2);
    expect(registry.require('semif-local').adapter.provider).toBe('semif');
    expect(registry.list().map((entry) => entry.id)).toEqual([
      'cloudflare-jev',
      'semif-local',
    ]);
  });

  it('trims ids and rejects duplicate and empty ones', () => {
    const registry = new DecisionProviderRegistry([
      { id: ' provider-a ', adapter: adapter('a') },
    ]);

    expect(registry.get('provider-a')?.id).toBe('provider-a');
    expect(() =>
      registry.register({ id: 'provider-a', adapter: adapter('b') }),
    ).toThrow(/already registered/);
    expect(() =>
      registry.register({ id: '   ', adapter: adapter('b') }),
    ).toThrow(/non-empty/);
  });

  it('throws a typed error naming the configured ids for an unknown provider', () => {
    const registry = new DecisionProviderRegistry([
      { id: 'provider-a', adapter: adapter('a') },
    ]);

    expect(() => registry.require('missing')).toThrow(
      DecisionProviderNotFoundError,
    );
    expect(() => registry.require('missing')).toThrow(/provider-a/);
    expect(() => new DecisionProviderRegistry().require('missing')).toThrow(
      /no providers are configured/,
    );
  });
});

describe('DecisionProviderRouter', () => {
  const registry = () =>
    new DecisionProviderRegistry([
      { id: 'default', adapter: adapter('default') },
      { id: 'route', adapter: adapter('route') },
      { id: 'override', adapter: adapter('override') },
    ]);

  it('selects caller override, then Decision route, then default', () => {
    const router = new DecisionProviderRouter(registry(), {
      defaultProviderId: 'default',
      routes: { 'commerce.route': 'route' },
    });

    expect(router.resolve('commerce.route')).toMatchObject({
      provider: { id: 'route' },
      selectedBy: 'decision-route',
    });
    expect(router.resolve('other')).toMatchObject({
      provider: { id: 'default' },
      selectedBy: 'default',
    });
    expect(router.resolve('commerce.route', 'override')).toMatchObject({
      provider: { id: 'override' },
      selectedBy: 'caller-override',
    });
  });

  it('routes by exact Decision name only', () => {
    const router = new DecisionProviderRouter(registry(), {
      defaultProviderId: 'default',
      routes: { 'commerce.route': 'route' },
    });

    expect(router.resolve('commerce.route.v2')?.provider.id).toBe('default');
    expect(router.resolve('commerce')?.provider.id).toBe('default');
  });

  it('does not treat inherited Object properties as routes', () => {
    const router = new DecisionProviderRouter(registry(), {
      defaultProviderId: 'default',
      routes: { other: 'route' },
    });

    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(router.resolve(name)).toMatchObject({
        provider: { id: 'default' },
        selectedBy: 'default',
      });
    }
  });

  it('uses the sole registered provider when no policy names one', () => {
    const router = new DecisionProviderRouter(
      new DecisionProviderRegistry([
        { id: 'cloudflare-jev', adapter: adapter('cloudflare') },
      ]),
    );

    expect(router.resolve('any.decision')).toMatchObject({
      provider: { id: 'cloudflare-jev' },
      selectedBy: 'sole-provider',
    });
  });

  it('refuses to pick by registration order when several providers are unrouted', () => {
    const router = new DecisionProviderRouter(
      new DecisionProviderRegistry([
        { id: 'a', adapter: adapter('a') },
        { id: 'b', adapter: adapter('b') },
      ]),
      { routes: { routed: 'b' } },
    );

    expect(router.resolve('routed')?.provider.id).toBe('b');
    expect(() => router.resolve('unrouted')).toThrow(
      AmbiguousDecisionProviderError,
    );
    // Callers that already fail open on an unconfigured provider treat an
    // ambiguous configuration the same way.
    expect(() => router.resolve('unrouted')).toThrow(
      DecisionProviderUnavailableError,
    );
    expect(() => router.resolve('unrouted')).toThrow(/"unrouted".*a, b/);
  });

  it('resolves nothing when no provider is registered', () => {
    const router = new DecisionProviderRouter(new DecisionProviderRegistry());

    expect(router.resolve('any.decision')).toBeUndefined();
    expect(() => router.resolve('any.decision', 'missing')).toThrow(
      DecisionProviderNotFoundError,
    );
  });

  it('rejects an unknown caller override instead of falling back', () => {
    const router = new DecisionProviderRouter(registry(), {
      defaultProviderId: 'default',
    });

    expect(() => router.resolve('other', 'missing')).toThrow(
      DecisionProviderNotFoundError,
    );
  });

  it('fails construction when the policy references an unknown provider', () => {
    expect(
      () =>
        new DecisionProviderRouter(registry(), {
          defaultProviderId: 'missing',
        }),
    ).toThrow(DecisionProviderNotFoundError);
    expect(
      () =>
        new DecisionProviderRouter(registry(), {
          routes: { 'commerce.route': 'missing' },
        }),
    ).toThrow(/"missing" is not registered/);
  });
});
