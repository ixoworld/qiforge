import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { ChatOpenAI } from '@langchain/openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
} from './byo-client';

function expectChatOpenAI(model: BaseChatModel): ChatOpenAI {
  expect(model).toBeInstanceOf(ChatOpenAI);
  if (!(model instanceof ChatOpenAI)) throw new Error('unreachable');
  return model;
}

/** A BYO-served role: the refusal wrapper around the user's ChatOpenAI. */
function expectByoChatOpenAI(model: BaseChatModel): ChatOpenAI {
  expect(model).toBeInstanceOf(ByoModelFallbackChatModel);
  if (!(model instanceof ByoModelFallbackChatModel))
    throw new Error('unreachable');
  return expectChatOpenAI(model.byoModel);
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
    const model = expectByoChatOpenAI(
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
    expect(expectByoChatOpenAI(byo.get('subagent')).model).toBe('gpt-5.6-luna');
    expect(expectByoChatOpenAI(byo.get('session-title')).model).toBe(
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
    const deepseek = expectByoChatOpenAI(
      createByoLlmAdapter(platform, {
        credential: { provider: 'deepseek', apiKey: 'sk-ds' },
        mainModelId: 'deepseek-v4-pro',
      }).get('main'),
    );
    expect(deepseek.clientConfig.baseURL).toBe(DEEPSEEK_BASE_URL);

    const anthropic = expectByoChatOpenAI(
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
    const model = expectByoChatOpenAI(byo.get('main'));
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
    const plain = expectByoChatOpenAI(
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

describe('createByoLlmAdapter — model refused by the provider', () => {
  const backendCalls: Array<{ url: string; body: unknown }> = [];

  beforeEach(() => {
    backendCalls.length = 0;
    // The ChatGPT backend's answer for a model the subscription does not
    // serve: an immediate 400 with an empty body.
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request ? input.url : new URL(String(input)).href;
        const body = typeof init?.body === 'string' ? init.body : '';
        backendCalls.push({ url, body: body ? JSON.parse(body) : undefined });
        return new Response(null, { status: 400 });
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
