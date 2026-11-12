import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import {
  BaseChatOpenAI,
  ChatOpenAI,
  ChatOpenAICompletions,
} from '@langchain/openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createLlmAdapter,
  NEBIUS_BASE_URL,
  OPENROUTER_BASE_URL,
} from '../core/llm';
import type { LlmAdapter } from '../core/runtime-context';
import type { Logger } from '../plugin-api/types';
import { createByoLlmAdapter } from './byo-adapter';
import {
  ByoModelFallbackChatModel,
  ByoModelFallbackState,
} from './byo-model-fallback';
import type { ByoCredential } from './byo-catalog';
import { classifyLlmError, redactOperatorFault } from './provider-error';
import {
  ANTHROPIC_OPENAI_COMPAT_BASE_URL,
  CHATGPT_BACKEND_BASE_URL,
  chatGptBackendFromEnv,
  DEEPSEEK_BASE_URL,
  GEMINI_OPENAI_COMPAT_BASE_URL,
  OPENAI_API_BASE_URL,
} from './byo-client';

function expectChatOpenAI(model: BaseChatModel): ChatOpenAI {
  expect(model).toBeInstanceOf(ChatOpenAI);
  if (!(model instanceof ChatOpenAI)) throw new Error('unreachable');
  return model;
}

/** A BYO-served role: the refusal wrapper around the user's own model. */
function byoModelOf(model: BaseChatModel): BaseChatModel {
  expect(model).toBeInstanceOf(ByoModelFallbackChatModel);
  if (!(model instanceof ByoModelFallbackChatModel))
    throw new Error('unreachable');
  return model.byoModel;
}

/** The ChatGPT lane: `ChatOpenAI` on the Responses API. */
function expectByoChatOpenAI(model: BaseChatModel): ChatOpenAI {
  return expectChatOpenAI(byoModelOf(model));
}

/** An API-key lane: Chat Completions, whatever the model id. */
function expectByoCompletions(model: BaseChatModel): ChatOpenAICompletions {
  const byo = byoModelOf(model);
  expect(byo).toBeInstanceOf(ChatOpenAICompletions);
  if (!(byo instanceof ChatOpenAICompletions)) throw new Error('unreachable');
  return byo;
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

/**
 * The requests one call of a ChatGPT-lane model sends, answered with the
 * backend's empty 400 (the call then fails; only the requests matter).
 */
async function chatGptRequests(model: ChatOpenAI): Promise<Request[]> {
  const requests: Request[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 400 });
    },
  );
  try {
    await model.invoke('hi').catch(() => undefined);
  } finally {
    vi.unstubAllGlobals();
  }
  return requests;
}

describe('createByoLlmAdapter', () => {
  it('serves main on the turn model with the user key, stripping params.model', () => {
    const { adapter: platform, calls } = platformStub();
    const byo = createByoLlmAdapter(platform, {
      credential: OPENAI_CRED,
      mainModelId: 'gpt-5.6-terra',
    });
    const model = expectByoCompletions(
      byo.get('main', { model: 'byo:openai/gpt-5.6-terra' }),
    );
    expect(model.model).toBe('gpt-5.6-terra');
    expect(model.apiKey).toBe('sk-user');
    expect(calls).toEqual([]);
  });

  it('summarizes on the turn model with the user key, for every provider, never on the platform', () => {
    const { adapter: platform, calls } = platformStub();
    const turns: { credential: ByoCredential; mainModelId: string }[] = [
      { credential: OPENAI_CRED, mainModelId: 'gpt-5.6-sol' },
      { credential: CHATGPT_CRED, mainModelId: 'gpt-5.6-terra' },
      {
        credential: { provider: 'anthropic', apiKey: 'sk-ant' },
        mainModelId: 'claude-sonnet-5',
      },
      {
        credential: { provider: 'gemini', apiKey: 'g-key' },
        mainModelId: 'gemini-3.1-pro',
      },
      {
        credential: { provider: 'deepseek', apiKey: 'sk-ds' },
        mainModelId: 'deepseek-v4-pro',
      },
    ];
    for (const turn of turns) {
      const byo = createByoLlmAdapter(platform, turn);
      const summarizer = byo.get('summarizer', {
        model: `byo:${turn.credential.provider}/${turn.mainModelId}`,
      });
      expect(summarizer).toBeInstanceOf(ByoModelFallbackChatModel);
      if (!(summarizer instanceof ByoModelFallbackChatModel))
        throw new Error('unreachable');
      expect(summarizer.byoModel).toMatchObject({ model: turn.mainModelId });
    }
    expect(calls).toEqual([]);
  });

  it('translates non-main roles through the provider role map', () => {
    const { adapter: platform } = platformStub();
    const byo = createByoLlmAdapter(platform, {
      credential: OPENAI_CRED,
      mainModelId: 'gpt-5.6-sol',
    });
    expect(expectByoCompletions(byo.get('subagent')).model).toBe(
      'gpt-5.6-luna',
    );
    expect(expectByoCompletions(byo.get('session-title')).model).toBe(
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
    const deepseek = expectByoCompletions(
      createByoLlmAdapter(platform, {
        credential: { provider: 'deepseek', apiKey: 'sk-ds' },
        mainModelId: 'deepseek-v4-pro',
      }).get('main'),
    );
    expect(deepseek.clientConfig.baseURL).toBe(DEEPSEEK_BASE_URL);

    const anthropic = expectByoCompletions(
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

  it('builds the ChatGPT backend client: Responses API, streaming, account header', async () => {
    const { adapter: platform } = platformStub();
    const model = expectByoChatOpenAI(
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
    // The headers ride on the lane's fetch, never in the model's
    // constructor arguments (a traced run uploads those).
    expect(model.clientConfig.defaultHeaders).toBeUndefined();
    const [request] = await chatGptRequests(model);
    expect(request?.url).toBe(`${CHATGPT_BACKEND_BASE_URL}/responses`);
    expect(request?.headers.get('ChatGPT-Account-ID')).toBe('acct_123');
    expect(request?.headers.get('originator')).toBe('codex_cli_rs');
    expect(request?.headers.get('session-id')).toBeTruthy();
    expect(request?.headers.get('session-id')).toBe(
      request?.headers.get('session_id'),
    );
    expect(request?.headers.get('authorization')).toBe('Bearer access-token');
    expect(model.modelKwargs).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
    });
  });

  it('routes the ChatGPT lane through a configured backend proxy with its gate header', async () => {
    const { adapter: platform } = platformStub();
    const byo = createByoLlmAdapter(platform, {
      credential: CHATGPT_CRED,
      mainModelId: 'gpt-5.6-terra',
      chatGptBackend: {
        baseUrl: 'https://chatgpt.proxy.example',
        proxyAuthToken: 'shared-secret',
      },
    });
    const model = expectByoChatOpenAI(byo.get('main'));
    expect(model.clientConfig.baseURL).toBe('https://chatgpt.proxy.example');
    const [request] = await chatGptRequests(model);
    expect(request?.url).toBe('https://chatgpt.proxy.example/responses');
    expect(request?.headers.get('X-Proxy-Auth')).toBe('Bearer shared-secret');
    expect(request?.headers.get('ChatGPT-Account-ID')).toBe('acct_123');
    // Without a config the real backend is used and no gate header is sent.
    const plain = expectByoChatOpenAI(
      createByoLlmAdapter(platform, {
        credential: CHATGPT_CRED,
        mainModelId: 'gpt-5.6-terra',
      }).get('main'),
    );
    expect(plain.clientConfig.baseURL).toBe(CHATGPT_BACKEND_BASE_URL);
    const [plainRequest] = await chatGptRequests(plain);
    expect(plainRequest?.headers.get('X-Proxy-Auth')).toBeNull();
    expect(plainRequest?.headers.get('ChatGPT-Account-ID')).toBe('acct_123');
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

// ── A model the user's provider refuses ────────────────────────────────

/** Platform stand-in that streams a fixed reply and records its calls' tools. */
class RecordingPlatformModel extends FakeListChatModel {
  readonly seenTools: unknown[] = [];

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.seenTools.push(Reflect.get(options, 'tools'));
    yield* super._streamResponseChunks(messages, options, runManager);
  }
}

function recordingPlatform(reply: string): {
  adapter: LlmAdapter;
  roles: string[];
  models: RecordingPlatformModel[];
} {
  const roles: string[] = [];
  const models: RecordingPlatformModel[] = [];
  const adapter: LlmAdapter = {
    get(role) {
      roles.push(String(role));
      const model = new RecordingPlatformModel({ responses: [reply] });
      models.push(model);
      return model;
    },
  };
  return { adapter, roles, models };
}

interface CapturedLogger extends Logger {
  warnings: string[];
}

function captureLogger(): CapturedLogger {
  const warnings: string[] = [];
  return {
    warnings,
    log: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => undefined,
  };
}

type StreamEvent = { event: string; name?: string; data: unknown };

async function collectEvents(
  model: BaseChatModel,
  input: string,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const evt of model.streamEvents(input, { version: 'v2' }))
    events.push({ event: evt.event, name: evt.name, data: evt.data });
  return events;
}

function streamedText(events: StreamEvent[]): string {
  return events
    .filter((e) => e.event === 'on_chat_model_stream')
    .map((e) => {
      const chunk: unknown = Reflect.get(asRecord(e.data), 'chunk');
      return chunk instanceof AIMessageChunk ? chunk.text : '';
    })
    .join('');
}

/** A BYO model that streams some text, then fails with a 400. */
class HalfwayFailingModel extends BaseChatModel {
  calls = 0;

  constructor() {
    super({});
  }

  _llmType(): string {
    return 'halfway-failing';
  }

  async _generate(): Promise<ChatResult> {
    throw new Error('unused: the test streams');
  }

  override async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
    this.calls += 1;
    yield new ChatGenerationChunk({
      text: 'Partial ',
      message: new AIMessageChunk({ content: 'Partial ' }),
    });
    throw Object.assign(new Error('400 invalid request'), { status: 400 });
  }
}

/** A platform model whose operator key is rejected. */
class FailingPlatformModel extends BaseChatModel {
  constructor() {
    super({});
  }

  _llmType(): string {
    return 'failing-platform';
  }

  async _generate(): Promise<ChatResult> {
    throw Object.assign(new Error('401 invalid api key'), { status: 401 });
  }
}

describe('createByoLlmAdapter — base URLs the environment cannot change', () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];

  beforeEach(() => {
    requests.length = 0;
    // workerd fills `process.env` from vars and secrets; LangChain and the
    // openai SDK read these when a model names no base URL.
    vi.stubEnv('OPENAI_BASE_URL', 'https://elsewhere.example/v1');
    vi.stubEnv('OPENAI_API_BASE', 'https://elsewhere.example/v1');
    vi.stubEnv('LANGSMITH_GATEWAY', 'true');
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push({
          url: request.url,
          authorization: request.headers.get('authorization'),
        });
        return Response.json({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-5.6-terra',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
        });
      },
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends a BYO OpenAI call, with the user's key, to api.openai.com", async () => {
    const { adapter: platform } = platformStub();
    const model = byoModelOf(
      createByoLlmAdapter(platform, {
        credential: OPENAI_CRED,
        mainModelId: 'gpt-5.6-terra',
      }).get('main'),
    );
    await model.invoke('hi');
    expect(requests).toEqual([
      {
        url: `${OPENAI_API_BASE_URL}/chat/completions`,
        authorization: 'Bearer sk-user',
      },
    ]);
  });

  it('keeps every other lane and the platform adapters on their own base URL', () => {
    const { adapter: platform } = platformStub();
    const byoBaseUrl = (credential: ByoCredential, mainModelId: string) => {
      const model = byoModelOf(
        createByoLlmAdapter(platform, { credential, mainModelId }).get('main'),
      );
      if (!(model instanceof BaseChatOpenAI)) throw new Error('unreachable');
      return model.clientConfig.baseURL;
    };
    expect(
      byoBaseUrl({ provider: 'deepseek', apiKey: 'k' }, 'deepseek-v4-pro'),
    ).toBe(DEEPSEEK_BASE_URL);
    expect(
      byoBaseUrl({ provider: 'gemini', apiKey: 'k' }, 'gemini-3-pro'),
    ).toBe(GEMINI_OPENAI_COMPAT_BASE_URL);
    expect(
      byoBaseUrl({ provider: 'anthropic', apiKey: 'k' }, 'claude-sonnet-5'),
    ).toBe(ANTHROPIC_OPENAI_COMPAT_BASE_URL);
    expect(byoBaseUrl(CHATGPT_CRED, 'gpt-5.6-terra')).toBe(
      CHATGPT_BACKEND_BASE_URL,
    );
    const platformBaseUrl = (env: Parameters<typeof createLlmAdapter>[0]) => {
      const model = createLlmAdapter(env).get('main');
      if (!(model instanceof BaseChatOpenAI)) throw new Error('unreachable');
      return model.clientConfig.baseURL;
    };
    expect(platformBaseUrl({ OPEN_ROUTER_API_KEY: 'k' })).toBe(
      OPENROUTER_BASE_URL,
    );
    expect(
      platformBaseUrl({
        OPEN_ROUTER_API_KEY: '',
        LLM_PROVIDER: 'nebius',
        NEBIUS_API_KEY: 'k',
      }),
    ).toBe(NEBIUS_BASE_URL);
  });
});

describe('ChatGPT lane — stored tool call ids over the backend’s limit', () => {
  const LONG_ID = `toolu_${'b'.repeat(66)}`;

  async function outgoingCallIds(): Promise<string[]> {
    const model = expectByoChatOpenAI(
      createByoLlmAdapter(platformStub().adapter, {
        credential: CHATGPT_CRED,
        mainModelId: 'gpt-5.6-terra',
      }).get('main'),
    );
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body === 'string') bodies.push(init.body);
        return new Response(null, { status: 400 });
      },
    );
    const history = [
      new HumanMessage('look it up'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: LONG_ID, name: 'lookup', args: { q: 'x' } }],
      }),
      new ToolMessage({ content: 'found', tool_call_id: LONG_ID }),
      new HumanMessage('thanks'),
    ];
    try {
      await model.invoke(history).catch(() => undefined);
      // The stored messages keep their own id.
      expect(
        history[1] instanceof AIMessage && history[1].tool_calls?.[0]?.id,
      ).toBe(LONG_ID);
    } finally {
      vi.unstubAllGlobals();
    }
    const parsed: { input: Array<{ call_id?: string }> } = JSON.parse(
      bodies[0] ?? '{"input":[]}',
    );
    return parsed.input.flatMap((item) =>
      item.call_id === undefined ? [] : [item.call_id],
    );
  }

  it('sends a call id within 64 characters, the same for the call and its output, and the same on every conversion', async () => {
    expect(LONG_ID).toHaveLength(72);
    const first = await outgoingCallIds();
    expect(first).toHaveLength(2);
    expect(first[0]).toBe(first[1]);
    expect(first[0]!.length).toBeLessThanOrEqual(64);
    expect(first[0]).not.toBe(LONG_ID);
    expect(await outgoingCallIds()).toEqual(first);
  });
});

describe('createByoLlmAdapter — model refused by the provider', () => {
  const backendCalls: Array<{ url: string; body: unknown }> = [];

  beforeEach(() => {
    backendCalls.length = 0;
    // The backend's answer for a model the subscription does not serve: a
    // 400 whose body names the model as the problem.
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request ? input.url : new URL(String(input)).href;
        const body = typeof init?.body === 'string' ? init.body : '';
        backendCalls.push({ url, body: body ? JSON.parse(body) : undefined });
        return Response.json(
          {
            detail:
              "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.",
          },
          { status: 400 },
        );
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('announces the refusal, then answers the same call on the platform model', async () => {
    const { adapter: platform, roles } = recordingPlatform(
      'Hello from the platform.',
    );
    const logger = captureLogger();
    const byo = createByoLlmAdapter(
      platform,
      { credential: CHATGPT_CRED, mainModelId: 'gpt-6-luna' },
      logger,
    );
    const events = await collectEvents(
      byo.get('main', { model: 'byo:chatgpt/gpt-6-luna' }),
      'hi',
    );

    const noticeAt = events.findIndex(
      (e) => e.event === 'on_custom_event' && e.name === 'byo_fallback',
    );
    const firstTextAt = events.findIndex(
      (e) => e.event === 'on_chat_model_stream',
    );
    expect(noticeAt).toBeGreaterThanOrEqual(0);
    expect(firstTextAt).toBeGreaterThan(noticeAt);
    expect(events[noticeAt]?.data).toMatchObject({
      kind: 'byo_fallback',
      reason: 'model_unavailable',
      source: 'byo',
      provider: 'chatgpt',
      model: 'gpt-6-luna',
      retryable: false,
    });
    expect(Reflect.get(asRecord(events[noticeAt]?.data), 'error')).toBe(
      "Your ChatGPT subscription doesn't offer gpt-6-luna, so this reply used the platform model instead. Pick another model in your Personal Agent settings.",
    );
    expect(streamedText(events)).toBe('Hello from the platform.');
    // One model call on the wire: no error event, one end.
    expect(events.filter((e) => e.event === 'on_chat_model_end')).toHaveLength(
      1,
    );

    expect(backendCalls).toHaveLength(1);
    expect(backendCalls[0]?.url).toBe(`${CHATGPT_BACKEND_BASE_URL}/responses`);
    expect(roles).toEqual(['main']);
    expect(
      logger.warnings.filter((w) => w.startsWith('[byo] chatgpt refused')),
    ).toEqual([
      expect.stringContaining('refused model "gpt-6-luna" (HTTP 400)'),
    ]);
  });

  it('does not fall back on a bare 400: the call fails, no notice, no platform call', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 400 }));
    const { adapter: platform, roles } = recordingPlatform('platform reply');
    const byo = createByoLlmAdapter(platform, {
      credential: CHATGPT_CRED,
      mainModelId: 'gpt-6-luna',
    });
    const outcome = await collectEvents(
      byo.get('main', { model: 'byo:chatgpt/gpt-6-luna' }),
      'hi',
    ).then(
      (events) => ({ events }),
      (error: unknown) => ({ error }),
    );
    expect(outcome).toHaveProperty('error');
    expect(roles).toEqual([]);
  });

  it('sends every later call of the turn for that model to the platform model', async () => {
    const { adapter: platform, roles } = recordingPlatform('platform reply');
    const byo = createByoLlmAdapter(platform, {
      credential: CHATGPT_CRED,
      mainModelId: 'gpt-6-luna',
    });
    const main = byo.get('main');
    await collectEvents(main, 'first');
    const again = await collectEvents(main, 'second');
    expect(streamedText(again)).toBe('platform reply');
    expect(again.filter((e) => e.event === 'on_custom_event')).toHaveLength(0);

    // A model handed out after the refusal goes to the platform model too.
    expect(await byo.get('main').invoke('third')).toMatchObject({
      content: 'platform reply',
    });

    // The BYO model was asked exactly once for gpt-6-luna.
    expect(
      backendCalls.filter(
        (c) => Reflect.get(asRecord(c.body), 'model') === 'gpt-6-luna',
      ),
    ).toHaveLength(1);
    expect(roles).toEqual(['main', 'main']);
  });

  it('blames a failure of the answering platform model on the platform, not the user’s account', async () => {
    const failing: LlmAdapter = {
      get: () => new FailingPlatformModel(),
    };
    const byo = createByoLlmAdapter(failing, {
      credential: CHATGPT_CRED,
      mainModelId: 'gpt-6-luna',
    });
    const error: unknown = await byo
      .get('main')
      .invoke('hi')
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(Error);
    const classified = classifyLlmError(error, { byoProvider: 'chatgpt' });
    expect(classified.source).toBe('platform');
    expect(classified.provider).toBeUndefined();
    // So the platform's own auth fault is redacted at the wire, as on a
    // platform turn.
    expect(redactOperatorFault(classified).kind).toBe('unknown');
    // A failure wrapped by LangChain's middleware layers keeps that.
    const wrapped = new Error('wrapped', { cause: error });
    expect(classifyLlmError(wrapped, { byoProvider: 'chatgpt' }).source).toBe(
      'platform',
    );
    // The user's own model failing stays the user's.
    expect(
      classifyLlmError(new Error('401 invalid api key'), {
        byoProvider: 'chatgpt',
      }).source,
    ).toBe('byo');
  });

  it('keeps other BYO model ids on the user’s account', async () => {
    const { adapter: platform } = recordingPlatform('platform reply');
    const byo = createByoLlmAdapter(platform, {
      credential: CHATGPT_CRED,
      mainModelId: 'gpt-6-luna',
    });
    await collectEvents(byo.get('main'), 'first');
    // `subagent` maps to gpt-5.6-luna — not the refused id.
    expect(expectByoChatOpenAI(byo.get('subagent')).model).toBe('gpt-5.6-luna');
  });

  it('falls back on the non-streamed path too', async () => {
    const { adapter: platform } = recordingPlatform('platform reply');
    const byo = createByoLlmAdapter(platform, {
      credential: CHATGPT_CRED,
      mainModelId: 'gpt-6-luna',
    });
    const notices: unknown[] = [];
    const reply = await byo.get('main').invoke('hi', {
      callbacks: [
        {
          handleCustomEvent: (name: string, data: unknown) => {
            if (name === 'byo_fallback') notices.push(data);
          },
        },
      ],
    });
    expect(reply.content).toBe('platform reply');
    expect(notices).toEqual([
      expect.objectContaining({ reason: 'model_unavailable' }),
    ]);
    expect(backendCalls).toHaveLength(1);
  });

  it('keeps today’s failure when the provider fails after streaming output', async () => {
    const { adapter: platform, roles } = recordingPlatform('platform reply');
    const byoModel = new HalfwayFailingModel();
    const model = new ByoModelFallbackChatModel({
      provider: 'chatgpt',
      modelId: 'gpt-6-luna',
      byo: byoModel,
      platform: () => platform.get('main'),
      state: new ByoModelFallbackState(),
      logger: captureLogger(),
    });
    const events: StreamEvent[] = [];
    await expect(async () => {
      for await (const evt of model.streamEvents('hi', { version: 'v2' }))
        events.push({ event: evt.event, name: evt.name, data: evt.data });
    }).rejects.toThrow('400 invalid request');
    expect(streamedText(events)).toBe('Partial ');
    expect(events.some((e) => e.event === 'on_custom_event')).toBe(false);
    expect(byoModel.calls).toBe(1);
    expect(roles).toEqual([]);
  });

  it('binds tools so either model can answer: Responses format to the user’s backend, function format to the platform', async () => {
    const { adapter: platform, models } = recordingPlatform('platform reply');
    const byo = createByoLlmAdapter(platform, {
      credential: CHATGPT_CRED,
      mainModelId: 'gpt-6-luna',
    });
    const lookup = tool(async () => 'ok', {
      name: 'lookup',
      description: 'Look something up.',
      schema: z.object({ query: z.string() }),
    });
    const main = byo.get('main');
    const bound = main.bindTools?.([lookup]);
    if (!bound) throw new Error('bindTools missing');
    for await (const _ of bound.streamEvents('hi', { version: 'v2' })) {
      // drain
    }
    const sent = asRecord(backendCalls[0]?.body);
    expect(sent.tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'lookup' }),
    ]);
    expect(models[0]?.seenTools).toEqual([
      [
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({ name: 'lookup' }),
        }),
      ],
    ]);
  });
});
