import { describe, expect, it } from 'vitest';
import {
  BYO_DEFAULT_MODEL,
  BYO_PROVIDER_MODELS,
  BYO_PROVIDERS,
  BYO_ROLE_MODELS,
  buildByoModelListing,
  byoModelForRole,
  isByoModelId,
  parseByoModelId,
  parseChatGptOAuthTokens,
  providerForSecretName,
  toByoModelId,
} from './byo-catalog.js';

describe('byo model ids', () => {
  it('round-trips to/parse for every curated model', () => {
    for (const provider of BYO_PROVIDERS) {
      for (const entry of BYO_PROVIDER_MODELS[provider]) {
        const id = toByoModelId(provider, entry.id);
        expect(isByoModelId(id)).toBe(true);
        expect(parseByoModelId(id)).toEqual({ provider, modelId: entry.id });
      }
    }
  });

  it('rejects unknown providers, unknown models, and malformed ids', () => {
    expect(parseByoModelId('byo:mistral/mistral-large')).toBeNull();
    expect(parseByoModelId('byo:openai/not-a-real-model')).toBeNull();
    expect(parseByoModelId('byo:openai')).toBeNull();
    expect(parseByoModelId('byo:/gpt-5.6-terra')).toBeNull();
    expect(parseByoModelId('openai/gpt-5.4-nano')).toBeNull();
    expect(parseByoModelId(undefined)).toBeNull();
    expect(parseByoModelId(null)).toBeNull();
  });

  it('every provider default model is in its curated list', () => {
    for (const provider of BYO_PROVIDERS) {
      expect(
        BYO_PROVIDER_MODELS[provider].some(
          (m) => m.id === BYO_DEFAULT_MODEL[provider],
        ),
      ).toBe(true);
    }
  });
});

describe('byoModelForRole', () => {
  it('main resolves to the turn-selected model', () => {
    expect(byoModelForRole('openai', 'main', 'gpt-5.6-sol')).toBe(
      'gpt-5.6-sol',
    );
  });

  it('translates mapped roles to the provider cheap model', () => {
    expect(byoModelForRole('anthropic', 'subagent', 'claude-opus-5')).toBe(
      'claude-haiku-4-5',
    );
    expect(byoModelForRole('gemini', 'session-title', 'x')).toBe(
      'gemini-3.1-flash-lite',
    );
  });

  it('embedding is never served by a BYO provider (platform fallback)', () => {
    for (const provider of BYO_PROVIDERS) {
      expect(byoModelForRole(provider, 'embedding', 'x')).toBeNull();
    }
  });

  it('vision on deepseek falls back to the platform (text-only models)', () => {
    expect(byoModelForRole('deepseek', 'vision', 'x')).toBeNull();
    expect(BYO_ROLE_MODELS.deepseek.vision).toBeUndefined();
  });

  it('unknown plugin-custom roles fall back to the provider subagent model', () => {
    expect(byoModelForRole('openai', 'my-plugin-role', 'x')).toBe(
      'gpt-5.6-luna',
    );
  });
});

describe('secret names', () => {
  it('maps every provider secret name back to its provider', () => {
    for (const provider of BYO_PROVIDERS) {
      const name = `BYO_LLM_${provider === 'chatgpt' ? 'CHATGPT_OAUTH' : `${provider.toUpperCase()}_API_KEY`}`;
      expect(providerForSecretName(name)).toBe(provider);
    }
    expect(providerForSecretName('SOME_OTHER_SECRET')).toBeUndefined();
  });
});

describe('parseChatGptOAuthTokens', () => {
  const valid = {
    accessToken: 'at',
    refreshToken: 'rt',
    accountId: 'acc',
    expiresAt: 123,
  };

  it('parses a well-formed blob', () => {
    expect(parseChatGptOAuthTokens(JSON.stringify(valid))).toEqual(valid);
  });

  it('returns null for malformed values instead of throwing', () => {
    expect(parseChatGptOAuthTokens('not-json')).toBeNull();
    expect(parseChatGptOAuthTokens('42')).toBeNull();
    expect(
      parseChatGptOAuthTokens(JSON.stringify({ ...valid, accessToken: '' })),
    ).toBeNull();
    expect(
      parseChatGptOAuthTokens(JSON.stringify({ ...valid, expiresAt: 'soon' })),
    ).toBeNull();
  });
});

describe('buildByoModelListing', () => {
  it('namespaces ids, zeroes pricing, and mirrors platform tier display', () => {
    const items = buildByoModelListing(['chatgpt', 'deepseek']);
    expect(items.length).toBe(
      BYO_PROVIDER_MODELS.chatgpt.length + BYO_PROVIDER_MODELS.deepseek.length,
    );
    const chatgptItem = items.find((i) => i.id === 'byo:chatgpt/gpt-5.6-terra');
    expect(chatgptItem?.badge).toBe('Balanced');
    expect(chatgptItem?.costLabel).toBe('$$');
    expect(chatgptItem?.pricing.inputPerMillion).toBe(0);
    const deepseekItem = items.find(
      (i) => i.id === 'byo:deepseek/deepseek-v4-flash',
    );
    expect(deepseekItem?.badge).toBe('Fast');
    expect(deepseekItem?.costLabel).toBe('$');
    expect(deepseekItem?.family).toBe('deepseek');
    expect(items.every((i) => !i.isDefault)).toBe(true);
  });

  it('returns nothing for no connected providers', () => {
    expect(buildByoModelListing([])).toEqual([]);
  });
});
