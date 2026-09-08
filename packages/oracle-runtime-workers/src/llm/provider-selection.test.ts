import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { ChatOpenAI } from '@langchain/openai';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_ID,
  NEBIUS_BASE_URL,
  NEBIUS_MODEL_MAP,
  OPENROUTER_BASE_URL,
  createLlmAdapter,
  langsmithEnvFromWorkerEnv,
  llmEnvFromWorkerEnv,
  resolveLangsmithTracing,
} from '../core/llm';

function expectChatOpenAI(model: BaseChatModel): ChatOpenAI {
  expect(model).toBeInstanceOf(ChatOpenAI);
  if (!(model instanceof ChatOpenAI)) throw new Error('unreachable');
  return model;
}

describe('createLlmAdapter provider selection', () => {
  it('defaults to OpenRouter (existing behaviour, no LLM_PROVIDER)', () => {
    const adapter = createLlmAdapter({ OPEN_ROUTER_API_KEY: 'or-key' });
    expect(adapter.defaultModelId).toBe(DEFAULT_MODEL_ID);
    expect(adapter.providerConfig.baseURL).toBe(OPENROUTER_BASE_URL);
    const model = expectChatOpenAI(adapter.get('main'));
    expect(model.model).toBe(DEFAULT_MODEL_ID);
    expect(model.clientConfig.baseURL).toBe(OPENROUTER_BASE_URL);
    expect(model.modelKwargs).toMatchObject({ require_parameters: true });
  });

  it('LLM_PROVIDER=nebius selects the Nebius adapter with the fixed role map', () => {
    const adapter = createLlmAdapter({
      OPEN_ROUTER_API_KEY: 'or-key',
      LLM_PROVIDER: 'nebius',
      NEBIUS_API_KEY: 'nb-key',
      // Nebius deliberately ignores DEFAULT_MODEL (Node parity).
      DEFAULT_MODEL: 'openai/gpt-5.6-sol',
    });
    expect(adapter.defaultModelId).toBe(NEBIUS_MODEL_MAP.main);
    expect(adapter.providerConfig).toEqual({
      baseURL: NEBIUS_BASE_URL,
      apiKey: 'nb-key',
      headers: {},
    });
    expect(adapter.modelForRole('main')).toBe(NEBIUS_MODEL_MAP.main);
    expect(adapter.modelForRole('vision')).toBe(NEBIUS_MODEL_MAP.vision);
    // Unknown roles fall back to subagent, as on OpenRouter.
    expect(adapter.modelForRole('someCustomRole')).toBe(
      NEBIUS_MODEL_MAP.subagent,
    );

    const guard = expectChatOpenAI(adapter.get('guard'));
    expect(guard.model).toBe(NEBIUS_MODEL_MAP.guard);
    expect(guard.temperature).toBe(0);
    expect(guard.clientConfig.baseURL).toBe(NEBIUS_BASE_URL);
    // No OpenRouter wire extras on the Nebius branch.
    expect(guard.modelKwargs?.require_parameters).toBeUndefined();

    const main = expectChatOpenAI(adapter.get('main'));
    expect(main.temperature).toBe(0.8);
    // params.model still wins.
    expect(
      expectChatOpenAI(adapter.get('main', { model: 'custom/model' })).model,
    ).toBe('custom/model');
  });

  it('llmEnvFromWorkerEnv narrows the raw Worker env safely', () => {
    expect(
      llmEnvFromWorkerEnv({
        OPEN_ROUTER_API_KEY: 'k',
        LLM_PROVIDER: 'nebius',
        NEBIUS_API_KEY: 'n',
        MAIN_REASONING_EFFORT: 'high',
        DEFAULT_MODEL: '',
        ORACLE_NAME: 42,
      }),
    ).toEqual({
      OPEN_ROUTER_API_KEY: 'k',
      DEFAULT_MODEL: undefined,
      MAIN_REASONING_EFFORT: 'high',
      ORACLE_NAME: undefined,
      LLM_PROVIDER: 'nebius',
      NEBIUS_API_KEY: 'n',
    });
    expect(llmEnvFromWorkerEnv({}).LLM_PROVIDER).toBe('openrouter');
    expect(llmEnvFromWorkerEnv({ LLM_PROVIDER: 'other' }).LLM_PROVIDER).toBe(
      'openrouter',
    );
  });
});

describe('resolveLangsmithTracing', () => {
  const DID = 'did:ixo:ixo1traced';

  it('always returns per-turn metadata', () => {
    const decision = resolveLangsmithTracing({
      userDid: DID,
      client: 'portal',
      env: {},
    });
    expect(decision.metadata).toEqual({
      user_did: DID,
      user_id: DID,
      client: 'portal',
    });
    expect(decision.callbacks).toBeUndefined();
  });

  it('fails closed without an API key, even with tracing switched on', () => {
    expect(
      resolveLangsmithTracing({
        userDid: DID,
        client: 'portal',
        env: { tracing: 'true' },
      }).callbacks,
    ).toBeUndefined();
    expect(
      resolveLangsmithTracing({
        userDid: DID,
        client: 'portal',
        env: { tracedDids: '*' },
      }).callbacks,
    ).toBeUndefined();
  });

  it('global mode traces every turn with an explicit tracer + client', () => {
    const decision = resolveLangsmithTracing({
      userDid: DID,
      client: 'matrix',
      env: { tracing: 'true', apiKey: 'ls-key', project: 'my-project' },
    });
    expect(decision.callbacks).toHaveLength(1);
    const tracer = decision.callbacks![0];
    expect(tracer).toBeInstanceOf(LangChainTracer);
    expect(tracer.projectName).toBe('my-project');
    // The client is explicit (no process.env on Workers) and defined.
    expect(tracer.client).toBeDefined();
  });

  it('selective mode gates by the DID allowlist', () => {
    const env = {
      apiKey: 'ls-key',
      tracedDids: ` ${DID} , did:ixo:ixo1other `,
    };
    expect(
      resolveLangsmithTracing({ userDid: DID, client: 'portal', env })
        .callbacks,
    ).toHaveLength(1);
    expect(
      resolveLangsmithTracing({
        userDid: 'did:ixo:ixo1untraced',
        client: 'portal',
        env,
      }).callbacks,
    ).toBeUndefined();
    expect(
      resolveLangsmithTracing({
        userDid: 'did:ixo:ixo1anyone',
        client: 'portal',
        env: { apiKey: 'ls-key', tracedDids: '*' },
      }).callbacks,
    ).toHaveLength(1);
  });

  it('memoises the langsmith Client per (apiKey, endpoint)', () => {
    const env = { tracing: 'true', apiKey: 'ls-key-shared' };
    const a = resolveLangsmithTracing({ userDid: 'a', client: 'portal', env });
    const b = resolveLangsmithTracing({ userDid: 'b', client: 'portal', env });
    expect(a.callbacks![0].client).toBe(b.callbacks![0].client);
    const c = resolveLangsmithTracing({
      userDid: 'c',
      client: 'portal',
      env: { ...env, endpoint: 'https://eu.api.smith.langchain.com' },
    });
    expect(c.callbacks![0].client).not.toBe(a.callbacks![0].client);
  });

  it('langsmithEnvFromWorkerEnv narrows the raw Worker env', () => {
    expect(
      langsmithEnvFromWorkerEnv({
        LANGSMITH_TRACING: 'true',
        LANGSMITH_API_KEY: 'k',
        LANGSMITH_PROJECT: 'p',
        LANGSMITH_ENDPOINT: 'https://x',
        LANGSMITH_TRACED_DIDS: 'did:a',
        UNRELATED: 'y',
      }),
    ).toEqual({
      tracing: 'true',
      apiKey: 'k',
      project: 'p',
      endpoint: 'https://x',
      tracedDids: 'did:a',
    });
    expect(langsmithEnvFromWorkerEnv({ LANGSMITH_TRACING: 7 })).toEqual({
      tracing: undefined,
      apiKey: undefined,
      project: undefined,
      endpoint: undefined,
      tracedDids: undefined,
    });
  });
});
