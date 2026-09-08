import { describe, expect, it } from 'vitest';
import {
  BYO_DEFAULT_MODEL,
  BYO_PROVIDER_MODELS,
  BYO_PROVIDERS,
  BYO_SECRET_NAMES,
  buildByoModelListing,
  byoModelForRole,
  isByoModelId,
  parseByoModelId,
  parseChatGptOAuthTokens,
  providerForSecretName,
  toByoModelId,
} from './byo-catalog';

describe('byo model-id namespace', () => {
  it('round-trips provider/model through the byo: namespace', () => {
    const id = toByoModelId('openai', 'gpt-5.6-terra');
    expect(id).toBe('byo:openai/gpt-5.6-terra');
    expect(isByoModelId(id)).toBe(true);
    expect(parseByoModelId(id)).toEqual({
      provider: 'openai',
      modelId: 'gpt-5.6-terra',
    });
  });

  it('rejects unknown providers, unknown models and malformed ids', () => {
    expect(parseByoModelId('byo:mistral/some-model')).toBeNull();
    expect(parseByoModelId('byo:openai/not-in-catalog')).toBeNull();
    expect(parseByoModelId('byo:openai')).toBeNull();
    expect(parseByoModelId('openai/gpt-5.6-terra')).toBeNull();
    expect(parseByoModelId(undefined)).toBeNull();
    expect(isByoModelId('openai/gpt-5.6-terra')).toBe(false);
  });

  it('every default model is in its provider catalog', () => {
    for (const provider of BYO_PROVIDERS) {
      expect(
        BYO_PROVIDER_MODELS[provider].some(
          (m) => m.id === BYO_DEFAULT_MODEL[provider],
        ),
      ).toBe(true);
    }
  });
});

describe('secret-name mapping', () => {
  it('maps every provider secret name back to its provider', () => {
    for (const provider of BYO_PROVIDERS) {
      expect(providerForSecretName(BYO_SECRET_NAMES[provider])).toBe(provider);
    }
    expect(providerForSecretName('SOME_OTHER_SECRET')).toBeUndefined();
  });
});

describe('byoModelForRole (role translation)', () => {
  it('main resolves to the turn model', () => {
    expect(byoModelForRole('anthropic', 'main', 'claude-opus-5')).toBe(
      'claude-opus-5',
    );
  });

  it('served roles translate through the provider map', () => {
    expect(byoModelForRole('chatgpt', 'subagent', 'gpt-5.6-terra')).toBe(
      'gpt-5.6-luna',
    );
    expect(byoModelForRole('anthropic', 'guard', 'claude-sonnet-5')).toBe(
      'claude-haiku-4-5',
    );
    expect(byoModelForRole('gemini', 'custom_medium', 'x')).toBe(
      'gemini-3.6-flash',
    );
  });

  it('known-but-unserved roles fall back to the platform (null)', () => {
    // embedding is unserved everywhere.
    for (const provider of BYO_PROVIDERS) {
      expect(byoModelForRole(provider, 'embedding', 'x')).toBeNull();
    }
    // DeepSeek's chat models are text-only — vision stays platform-side.
    expect(byoModelForRole('deepseek', 'vision', 'x')).toBeNull();
    expect(byoModelForRole('openai', 'vision', 'x')).toBe('gpt-5.6-luna');
  });

  it('unknown plugin-custom roles fall back to the cheap subagent model', () => {
    expect(byoModelForRole('openai', 'my-plugin-role', 'x')).toBe(
      'gpt-5.6-luna',
    );
    expect(byoModelForRole('deepseek', 'my-plugin-role', 'x')).toBe(
      'deepseek-v4-flash',
    );
  });
});

describe('parseChatGptOAuthTokens', () => {
  it('parses a valid blob and rejects malformed ones', () => {
    const tokens = {
      accessToken: 'at',
      refreshToken: 'rt',
      accountId: 'acc',
      expiresAt: 123,
    };
    expect(parseChatGptOAuthTokens(JSON.stringify(tokens))).toEqual(tokens);
    expect(parseChatGptOAuthTokens('{}')).toBeNull();
    expect(parseChatGptOAuthTokens('not json')).toBeNull();
    expect(
      parseChatGptOAuthTokens(JSON.stringify({ ...tokens, accessToken: '' })),
    ).toBeNull();
  });
});

describe('buildByoModelListing', () => {
  it('lists namespaced ids for connected providers, never as default', () => {
    const items = buildByoModelListing(['deepseek']);
    expect(items.map((i) => i.id)).toEqual([
      'byo:deepseek/deepseek-v4-flash',
      'byo:deepseek/deepseek-v4-pro',
    ]);
    expect(items.every((i) => i.isDefault === false)).toBe(true);
    expect(items[0]!.family).toBe('deepseek');
  });
});
