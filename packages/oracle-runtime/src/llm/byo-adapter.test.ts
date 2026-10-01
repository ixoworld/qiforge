import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { describe, expect, it, vi } from 'vitest';
import type { LlmAdapter } from '../runtime-context/ambient.js';
import { createByoLlmAdapter } from './byo-adapter.js';

const platformModel = { platform: true } as unknown as BaseChatModel;
const platform: LlmAdapter = {
  get: vi.fn(() => platformModel),
};

function llmType(model: BaseChatModel): string {
  return (model as unknown as { _llmType: () => string })._llmType();
}

describe('createByoLlmAdapter', () => {
  it('serves main with the turn model on the user key, stripping the byo: param', () => {
    const adapter = createByoLlmAdapter(platform, {
      credential: { provider: 'openai', apiKey: 'sk-user' },
      mainModelId: 'gpt-5.6-terra',
    });

    const model = adapter.get('main', { model: 'byo:openai/gpt-5.6-terra' });
    expect(llmType(model)).toBe('openai');
    expect(model).toHaveProperty('model', 'gpt-5.6-terra');
    expect(model).toHaveProperty('apiKey', 'sk-user');
  });

  it('translates sub-agent roles onto the same provider', () => {
    const adapter = createByoLlmAdapter(platform, {
      credential: { provider: 'anthropic', apiKey: 'sk-ant' },
      mainModelId: 'claude-opus-5',
    });

    const model = adapter.get('subagent');
    expect(llmType(model)).toBe('anthropic');
    expect(model).toHaveProperty('model', 'claude-haiku-4-5');
  });

  it('falls through to the platform adapter for unserved roles', () => {
    const adapter = createByoLlmAdapter(platform, {
      credential: { provider: 'deepseek', apiKey: 'sk-ds' },
      mainModelId: 'deepseek-v4-flash',
    });

    expect(adapter.get('embedding')).toBe(platformModel);
    expect(adapter.get('vision')).toBe(platformModel);
    expect(platform.get).toHaveBeenCalledWith('embedding', undefined);
  });

  it('points the chatgpt credential at the subscription backend with account headers', () => {
    const adapter = createByoLlmAdapter(platform, {
      credential: {
        provider: 'chatgpt',
        oauth: {
          accessToken: 'access',
          refreshToken: 'refresh',
          accountId: 'acc-1',
          expiresAt: Date.now() + 60_000,
        },
      },
      mainModelId: 'gpt-5.6-terra',
    });

    const model = adapter.get('main');
    expect(llmType(model)).toBe('openai');
    expect(model).toHaveProperty('model', 'gpt-5.6-terra');
    expect(model).toHaveProperty('apiKey', 'access');
    expect(model).toHaveProperty('streaming', true);
    const config = (
      model as unknown as {
        clientConfig: {
          baseURL?: string;
          defaultHeaders?: Record<string, string>;
        };
      }
    ).clientConfig;
    expect(config.baseURL).toBe('https://chatgpt.com/backend-api/codex');
    expect(config.defaultHeaders?.['ChatGPT-Account-ID']).toBe('acc-1');
    expect(config.defaultHeaders?.originator).toBe('codex_cli_rs');
  });
});
