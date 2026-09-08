import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { describe, expect, it } from 'vitest';
import type { LlmAdapter } from '../core/runtime-context';
import { createByoLlmAdapter } from './byo-adapter';
import type { ByoCredential } from './byo-catalog';
import {
  ANTHROPIC_OPENAI_COMPAT_BASE_URL,
  CHATGPT_BACKEND_BASE_URL,
  chatGptBackendFromEnv,
  DEEPSEEK_BASE_URL,
} from './byo-client';

function expectChatOpenAI(model: BaseChatModel): ChatOpenAI {
  expect(model).toBeInstanceOf(ChatOpenAI);
  if (!(model instanceof ChatOpenAI)) throw new Error('unreachable');
  return model;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function platformStub(): { adapter: LlmAdapter; calls: string[] } {
  const calls: string[] = [];
  const adapter: LlmAdapter = {
    get(role) {
      calls.push(String(role));
      return new ChatOpenAI({
        model: 'platform/model',
        apiKey: 'platform-key',
      });
    },
  };
  return { adapter, calls };
}

const OPENAI_CRED: ByoCredential = { provider: 'openai', apiKey: 'sk-user' };
const CHATGPT_CRED: ByoCredential = {
  provider: 'chatgpt',
  oauth: {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accountId: 'acct_123',
    expiresAt: Date.now() + 3_600_000,
  },
};

describe('createByoLlmAdapter', () => {
  it('serves main on the turn model with the user key, stripping params.model', () => {
    const { adapter: platform, calls } = platformStub();
    const byo = createByoLlmAdapter(platform, {
      credential: OPENAI_CRED,
      mainModelId: 'gpt-5.6-terra',
    });
    const model = expectChatOpenAI(
      byo.get('main', { model: 'byo:openai/gpt-5.6-terra' }),
    );
    expect(model.model).toBe('gpt-5.6-terra');
    expect(model.apiKey).toBe('sk-user');
    expect(calls).toEqual([]);
  });

  it('translates non-main roles through the provider role map', () => {
    const { adapter: platform } = platformStub();
    const byo = createByoLlmAdapter(platform, {
      credential: OPENAI_CRED,
      mainModelId: 'gpt-5.6-sol',
    });
    expect(expectChatOpenAI(byo.get('subagent')).model).toBe('gpt-5.6-luna');
    expect(expectChatOpenAI(byo.get('session-title')).model).toBe(
      'gpt-5.6-luna',
    );
  });

  it('falls back to the platform adapter for unserved roles', () => {
    const { adapter: platform, calls } = platformStub();
    const byo = createByoLlmAdapter(platform, {
      credential: OPENAI_CRED,
      mainModelId: 'gpt-5.6-terra',
    });
    const model = expectChatOpenAI(byo.get('embedding'));
    expect(model.model).toBe('platform/model');
    expect(calls).toEqual(['embedding']);

    // vision on deepseek is unserved too.
    const deepseek = createByoLlmAdapter(platform, {
      credential: { provider: 'deepseek', apiKey: 'sk-ds' },
      mainModelId: 'deepseek-v4-flash',
    });
    expect(expectChatOpenAI(deepseek.get('vision')).model).toBe(
      'platform/model',
    );
    expect(calls).toEqual(['embedding', 'vision']);
  });

  it('wires provider base URLs for OpenAI-compatible providers', () => {
    const { adapter: platform } = platformStub();
    const deepseek = expectChatOpenAI(
      createByoLlmAdapter(platform, {
        credential: { provider: 'deepseek', apiKey: 'sk-ds' },
        mainModelId: 'deepseek-v4-pro',
      }).get('main'),
    );
    expect(deepseek.clientConfig.baseURL).toBe(DEEPSEEK_BASE_URL);

    const anthropic = expectChatOpenAI(
      createByoLlmAdapter(platform, {
        credential: { provider: 'anthropic', apiKey: 'sk-ant' },
        mainModelId: 'claude-sonnet-5',
      }).get('main'),
    );
    expect(anthropic.clientConfig.baseURL).toBe(
      ANTHROPIC_OPENAI_COMPAT_BASE_URL,
    );
    // Claude 5 family rejects sampling params — must not be sent.
    expect(anthropic.temperature).toBeUndefined();
  });

  it('builds the ChatGPT backend client: Responses API, streaming, account header', () => {
    const { adapter: platform } = platformStub();
    const model = expectChatOpenAI(
      createByoLlmAdapter(platform, {
        credential: CHATGPT_CRED,
        mainModelId: 'gpt-5.6-terra',
      }).get('main'),
    );
    expect(model.model).toBe('gpt-5.6-terra');
    expect(model.apiKey).toBe('access-token');
    expect(model.useResponsesApi).toBe(true);
    expect(model.streaming).toBe(true);
    expect(model.zdrEnabled).toBe(true);
    expect(model.temperature).toBeUndefined();
    expect(model.clientConfig.baseURL).toBe(CHATGPT_BACKEND_BASE_URL);
    const headers = asRecord(model.clientConfig.defaultHeaders);
    expect(headers['ChatGPT-Account-ID']).toBe('acct_123');
    expect(headers.originator).toBe('codex_cli_rs');
    expect(headers['session-id']).toBeTruthy();
    expect(headers['session-id']).toBe(headers.session_id);
    expect(model.modelKwargs).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
    });
  });

  it('routes the ChatGPT lane through a configured backend proxy with its gate header', () => {
    const { adapter: platform } = platformStub();
    const byo = createByoLlmAdapter(platform, {
      credential: CHATGPT_CRED,
      mainModelId: 'gpt-5.6-terra',
      chatGptBackend: {
        baseUrl: 'https://chatgpt.proxy.example',
        proxyAuthToken: 'shared-secret',
      },
    });
    const model = expectChatOpenAI(byo.get('main'));
    const configuration = asRecord(
      asRecord(model.clientConfig).baseURL === undefined
        ? asRecord((model as unknown as { clientConfig: unknown }).clientConfig)
        : model.clientConfig,
    );
    expect(configuration.baseURL).toBe('https://chatgpt.proxy.example');
    const headers = asRecord(configuration.defaultHeaders);
    expect(headers['X-Proxy-Auth']).toBe('Bearer shared-secret');
    expect(headers['ChatGPT-Account-ID']).toBe('acct_123');
    // Without a config the real backend is used and no gate header is sent.
    const plain = expectChatOpenAI(
      createByoLlmAdapter(platform, {
        credential: CHATGPT_CRED,
        mainModelId: 'gpt-5.6-terra',
      }).get('main'),
    );
    const plainConfig = asRecord(plain.clientConfig);
    expect(plainConfig.baseURL).toBe(CHATGPT_BACKEND_BASE_URL);
    expect(
      asRecord(plainConfig.defaultHeaders)['X-Proxy-Auth'],
    ).toBeUndefined();
  });

  it('parses the backend override from the environment', () => {
    expect(chatGptBackendFromEnv({})).toEqual({
      baseUrl: CHATGPT_BACKEND_BASE_URL,
    });
    expect(
      chatGptBackendFromEnv({
        BYO_CHATGPT_BACKEND_URL: 'https://chatgpt.proxy.example/',
        BYO_CHATGPT_PROXY_AUTH_TOKEN: ' secret ',
      }),
    ).toEqual({
      baseUrl: 'https://chatgpt.proxy.example',
      proxyAuthToken: 'secret',
    });
    expect(() =>
      chatGptBackendFromEnv({ BYO_CHATGPT_BACKEND_URL: 'not a url' }),
    ).toThrow(/valid URL/);
  });
});
