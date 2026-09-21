import type { DecisionAdapter } from '@ixo/common';
import { describe, expect, it } from 'vitest';
import {
  DecisionProviderNotFoundError,
  DecisionProviderRegistry,
} from './provider-registry.js';

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
  it('registers configured provider instances by stable id', () => {
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

  it('rejects duplicate and empty provider ids', () => {
    const registry = new DecisionProviderRegistry([
      { id: 'provider-a', adapter: adapter('a') },
    ]);

    expect(() =>
      registry.register({ id: 'provider-a', adapter: adapter('b') }),
    ).toThrow(/already registered/);
    expect(() =>
      registry.register({ id: '   ', adapter: adapter('b') }),
    ).toThrow(/non-empty/);
  });

  it('throws a typed error for unknown providers without request data', () => {
    const registry = new DecisionProviderRegistry([
      { id: 'provider-a', adapter: adapter('a') },
    ]);

    expect(() => registry.require('missing')).toThrow(
      DecisionProviderNotFoundError,
    );
    expect(() => registry.require('missing')).toThrow(/provider-a/);
  });
});
