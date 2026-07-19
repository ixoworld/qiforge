import { describe, expect, it } from 'vitest';
import {
  createEnvCredentialBroker,
  UnknownCredentialRefError,
} from './credential-broker.js';
import { buildGatewayTransport } from './model-adapters.js';
import {
  buildModelPolicy,
  ModelPolicyError,
  parseModelPolicyEnv,
} from './model-policy.js';

const BASE = {
  defaultProvider: 'openrouter',
  roles: {
    main: { model: 'model-a', credentialRef: 'openrouter-default' },
    subagent: { model: 'model-b' },
  },
};

describe('buildModelPolicy', () => {
  it('layers later inputs over earlier ones per role', () => {
    const policy = buildModelPolicy([
      BASE,
      { roles: { main: { model: 'model-override' } } },
    ]);
    expect(policy.targetFor('main').model).toBe('model-override');
    expect(policy.targetFor('subagent').model).toBe('model-b');
  });

  it('throws on unknown roles instead of silently downgrading', () => {
    const policy = buildModelPolicy([BASE]);
    expect(() => policy.targetFor('mystery-role')).toThrow(ModelPolicyError);
    expect(() => policy.targetFor('mystery-role')).toThrow(/not declared/);
  });

  it('rejects out-of-constraint model selections', () => {
    const policy = buildModelPolicy([
      { ...BASE, constraints: { allowedModels: ['model-a', 'model-b'] } },
    ]);
    expect(() =>
      policy.assertWithinConstraints('openrouter', 'gpt-anything'),
    ).toThrow(/allowed set/);
    expect(() =>
      policy.assertWithinConstraints('unlisted-provider', 'model-a'),
    ).toThrow(/allowed set/);
  });

  it('keeps fallbacks off unless declared, and validates declared ones against constraints', () => {
    const noFallbacks = buildModelPolicy([BASE]);
    expect(noFallbacks.targetFor('main').fallbacks).toEqual([]);

    const withBadFallback = buildModelPolicy([
      {
        ...BASE,
        constraints: { allowedModels: ['model-a', 'model-b'] },
        fallbacks: {
          main: [
            { model: 'off-menu-model', disclosure: { reason: 'testing' } },
          ],
        },
      },
    ]);
    expect(() => withBadFallback.targetFor('main')).toThrow(/allowed set/);
  });

  it('parses MODEL_POLICY_JSON and rejects malformed shapes loudly', () => {
    expect(parseModelPolicyEnv(undefined)).toBeUndefined();
    expect(parseModelPolicyEnv('')).toBeUndefined();
    expect(parseModelPolicyEnv(JSON.stringify(BASE))?.roles?.main?.model).toBe(
      'model-a',
    );
    expect(() => parseModelPolicyEnv('{"roles": 42}')).toThrow();
  });
});

describe('credential broker', () => {
  it('resolves registered refs from env and rejects unknown refs', () => {
    const broker = createEnvCredentialBroker(
      { 'openrouter-default': 'OPEN_ROUTER_API_KEY' },
      { OPEN_ROUTER_API_KEY: 'sk-test' },
    );
    expect(broker.resolve('openrouter-default')).toBe('sk-test');
    expect(() => broker.resolve('made-up-ref')).toThrow(
      UnknownCredentialRefError,
    );
  });

  it('names the missing env var when a ref is registered but unset', () => {
    const broker = createEnvCredentialBroker(
      { 'nebius-default': 'NEBIUS_API_KEY' },
      {},
    );
    expect(() => broker.resolve('nebius-default')).toThrow(/NEBIUS_API_KEY/);
  });
});

describe('AI Gateway transport', () => {
  const gateway = {
    accountId: 'acct',
    gatewayId: 'gw',
    mode: 'pooled' as const,
    urlStyle: 'compat' as const,
    authTokenRef: 'cf-aig-token',
  };

  it('builds the unified compat endpoint with provider-namespaced model ids', () => {
    const t = buildGatewayTransport(gateway, 'openrouter', 'model-a', 'tok');
    expect(t.baseURL).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/gw/compat',
    );
    expect(t.model).toBe('openrouter/model-a');
    expect(t.headers['cf-aig-authorization']).toBe('Bearer tok');
  });

  it('builds provider-style endpoints with raw model ids', () => {
    const t = buildGatewayTransport(
      { ...gateway, urlStyle: 'provider' },
      'openai',
      'gpt-x',
      'tok2',
    );
    expect(t.baseURL).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/gw/openai',
    );
    expect(t.model).toBe('gpt-x');
    expect(t.headers['cf-aig-authorization']).toBe('Bearer tok2');
  });
});
