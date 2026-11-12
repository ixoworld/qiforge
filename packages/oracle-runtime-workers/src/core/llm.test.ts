import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { RunnableLambda } from '@langchain/core/runnables';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { ChatOpenAICompletions } from '@langchain/openai';
import { createAgent, FakeToolCallingModel, tool } from 'langchain';
import { Client } from 'langsmith';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { nativeContentBlock } from '../attachments/content-blocks';
import {
  BYO_PROVIDER_MODELS,
  BYO_PROVIDERS,
  BYO_ROLE_MODELS,
} from '../llm/byo-catalog';
import { createByoLlmAdapter } from '../llm/byo-adapter';
import { createByoChatModel } from '../llm/byo-client';
import { LLM_MAX_OUTPUT_TOKENS_DEFAULT } from './env';
import {
  catalogCandidates,
  MAX_CONTEXT_TOKENS,
  MIN_CONTEXT_TOKENS,
} from './context-window';
import {
  findProviderStall,
  livenessRequestTimeoutMs,
  ProviderStallError,
} from '../llm/stream-liveness';
import {
  BUILTIN_CONTEXT_WINDOWS,
  createLlmAdapter,
  llmEnvFromWorkerEnv,
  outputCapEnv,
  redactSignedLinks,
  resolveLangsmithTracing,
  streamLivenessFromEnv,
  TRACE_STATE_TAIL_MESSAGES,
  DEFAULT_MODEL_ID,
  getModelCapabilities,
  listModelCatalog,
  MODEL_CATALOG,
  MODEL_INPUT_CAPS,
  NEBIUS_MODEL_MAP,
  OPENROUTER_GPT_5_6_IDS,
  OPENROUTER_MAIN_FALLBACKS,
  OPENROUTER_MODEL_MAP,
  openRouterPromptCacheKwargs,
  openRouterProviderRouting,
  type ProviderModelRole,
} from './llm';

describe('MODEL_CATALOG', () => {
  const ids = MODEL_CATALOG.map((entry) => entry.id);

  it('has one entry per id, and the default model among them', () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_MODEL_ID);
    expect(OPENROUTER_MODEL_MAP.main).toBe(DEFAULT_MODEL_ID);
  });

  it('flags exactly one listing item as the default, under its own label', () => {
    const listing = listModelCatalog(undefined);
    const defaults = listing.models.filter((m) => m.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({
      id: DEFAULT_MODEL_ID,
      label: 'GPT-5.6 Luna',
    });
    expect(listing.default).toBe(DEFAULT_MODEL_ID);
    // The "GPT-5.4 Nano" option runs GPT-5.4 Nano.
    expect(listing.models.find((m) => m.label === 'GPT-5.4 Nano')?.id).toBe(
      'openai/gpt-5.4-nano',
    );
  });

  it('keys every id-keyed table by catalog ids, and covers every catalog id', () => {
    expect(Object.keys(MODEL_INPUT_CAPS).sort()).toEqual([...ids].sort());
    for (const id of ids)
      expect(getModelCapabilities(id)).toBe(MODEL_INPUT_CAPS[id]);
    // A catalog entry that says it reads images accepts image input.
    for (const entry of MODEL_CATALOG)
      expect(getModelCapabilities(entry.id).image).toBe(entry.vision);
  });
});

describe('built-in context windows', () => {
  it('gives every catalog entry a sane window, and carries it into the table', () => {
    for (const entry of MODEL_CATALOG) {
      expect(Number.isInteger(entry.contextTokens)).toBe(true);
      // The resolver's sane-window range: a typo (4096, an extra zero) fails.
      expect(entry.contextTokens).toBeGreaterThanOrEqual(MIN_CONTEXT_TOKENS);
      expect(entry.contextTokens).toBeLessThanOrEqual(MAX_CONTEXT_TOKENS);
      expect(BUILTIN_CONTEXT_WINDOWS.get(entry.id)).toBe(entry.contextTokens);
    }
  });

  it('knows every chat model id the platform role maps send', () => {
    const chatIds = (map: Record<ProviderModelRole, string>): string[] =>
      Object.entries(map)
        .filter(([role, id]) => role !== 'embedding' && id !== '')
        .map(([, id]) => id);
    const sent = [
      ...chatIds(OPENROUTER_MODEL_MAP),
      ...OPENROUTER_MAIN_FALLBACKS,
      ...chatIds(NEBIUS_MODEL_MAP),
    ];
    expect(sent.length).toBeGreaterThan(10);
    const unknown = sent.filter(
      (id) => !((BUILTIN_CONTEXT_WINDOWS.get(id) ?? 0) > 0),
    );
    expect(unknown).toEqual([]);
  });

  it('knows every BYO model id under the key the resolver looks it up by', () => {
    const unknown: string[] = [];
    for (const provider of BYO_PROVIDERS)
      for (const id of [
        ...Object.values(BYO_ROLE_MODELS[provider]),
        ...BYO_PROVIDER_MODELS[provider].map((m) => m.id),
      ])
        if (
          !catalogCandidates(id, provider).some(
            (candidate) => (BUILTIN_CONTEXT_WINDOWS.get(candidate) ?? 0) > 0,
          )
        )
          unknown.push(`${provider} ${id}`);
    expect(unknown).toEqual([]);
  });
});

describe('summarizer role', () => {
  it('is the main model on the OpenRouter lane, a per-request choice included, at the helper reasoning effort', () => {
    const adapter = createLlmAdapter({
      OPEN_ROUTER_API_KEY: 'k',
      DEFAULT_MODEL: 'anthropic/claude-sonnet-5',
      MAIN_REASONING_EFFORT: 'high',
    });
    expect(adapter.modelForRole('summarizer')).toBe(
      'anthropic/claude-sonnet-5',
    );
    expect(adapter.modelForRole('summarizer')).toBe(
      adapter.modelForRole('main'),
    );
    expect(adapter.modelForRole('routing')).toBe(OPENROUTER_MODEL_MAP.routing);

    const summarizer = adapter.get('summarizer');
    expect(summarizer).toBeInstanceOf(ChatOpenAICompletions);
    if (!(summarizer instanceof ChatOpenAICompletions))
      throw new Error('unreachable');
    expect(summarizer.model).toBe('anthropic/claude-sonnet-5');
    // Helper effort, not the reply's; no fallback model list.
    expect(summarizer.modelKwargs).toMatchObject({
      reasoning: { effort: 'medium' },
    });
    expect(summarizer.modelKwargs?.models).toBeUndefined();
    const main = adapter.get('main');
    if (!(main instanceof ChatOpenAICompletions))
      throw new Error('unreachable');
    expect(main.modelKwargs).toMatchObject({ reasoning: { effort: 'high' } });

    const chosen = adapter.get('summarizer', { model: 'openai/gpt-5.6-sol' });
    if (!(chosen instanceof ChatOpenAICompletions))
      throw new Error('unreachable');
    expect(chosen.model).toBe('openai/gpt-5.6-sol');
  });

  it('is the main model on the Nebius lane', () => {
    const adapter = createLlmAdapter({
      OPEN_ROUTER_API_KEY: '',
      LLM_PROVIDER: 'nebius',
      NEBIUS_API_KEY: 'n',
    });
    expect(NEBIUS_MODEL_MAP.summarizer).toBe(NEBIUS_MODEL_MAP.main);
    expect(adapter.modelForRole('summarizer')).toBe(NEBIUS_MODEL_MAP.main);
    const summarizer = adapter.get('summarizer');
    if (!(summarizer instanceof ChatOpenAICompletions))
      throw new Error('unreachable');
    expect(summarizer.model).toBe(NEBIUS_MODEL_MAP.main);
  });
});

describe('output cap', () => {
  /** The `max_tokens` a Chat Completions request from this model would carry. */
  const wireMaxTokens = (
    model: ChatOpenAICompletions,
  ): number | null | undefined => {
    const params = model.invocationParams({});
    return 'max_tokens' in params ? params.max_tokens : undefined;
  };

  it('caps every platform call at LLM_MAX_OUTPUT_TOKENS, sent as max_tokens', () => {
    const adapter = createLlmAdapter({
      OPEN_ROUTER_API_KEY: 'k',
      DEFAULT_MODEL: 'openai/gpt-5.6-luna',
    });
    for (const role of ['main', 'summarizer', 'subagent'] as const) {
      const model = adapter.get(role);
      if (!(model instanceof ChatOpenAICompletions))
        throw new Error('unreachable');
      expect(model.maxTokens).toBe(LLM_MAX_OUTPUT_TOKENS_DEFAULT);
    }
    const main = adapter.get('main');
    if (!(main instanceof ChatOpenAICompletions))
      throw new Error('unreachable');
    expect(wireMaxTokens(main)).toBe(LLM_MAX_OUTPUT_TOKENS_DEFAULT);

    const nebius = createLlmAdapter({
      OPEN_ROUTER_API_KEY: '',
      LLM_PROVIDER: 'nebius',
      NEBIUS_API_KEY: 'n',
      LLM_MAX_OUTPUT_TOKENS: 4096,
    }).get('main');
    if (!(nebius instanceof ChatOpenAICompletions))
      throw new Error('unreachable');
    expect(nebius.maxTokens).toBe(4096);
  });

  it('leaves the limit to the model at 0, and lets a caller set its own', () => {
    const uncapped = createLlmAdapter({
      OPEN_ROUTER_API_KEY: 'k',
      LLM_MAX_OUTPUT_TOKENS: 0,
    }).get('main');
    if (!(uncapped instanceof ChatOpenAICompletions))
      throw new Error('unreachable');
    expect(uncapped.maxTokens).toBeUndefined();
    expect(wireMaxTokens(uncapped)).toBeUndefined();

    const own = createLlmAdapter({ OPEN_ROUTER_API_KEY: 'k' }).get('main', {
      maxTokens: 500,
    });
    if (!(own instanceof ChatOpenAICompletions)) throw new Error('unreachable');
    expect(own.maxTokens).toBe(500);
  });

  it('reads the cap from raw Worker env and validated config alike', () => {
    expect(
      llmEnvFromWorkerEnv({ LLM_MAX_OUTPUT_TOKENS: '2048' })
        .LLM_MAX_OUTPUT_TOKENS,
    ).toBe(2048);
    expect(
      llmEnvFromWorkerEnv({ LLM_MAX_OUTPUT_TOKENS: 'lots' })
        .LLM_MAX_OUTPUT_TOKENS,
    ).toBeUndefined();
    expect(outputCapEnv({ LLM_MAX_OUTPUT_TOKENS: 0 })).toEqual({
      LLM_MAX_OUTPUT_TOKENS: 0,
    });
    expect(outputCapEnv({})).toEqual({});
  });
});

describe('model-call liveness wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the budgets per lane, from validated numbers or raw strings', () => {
    expect(streamLivenessFromEnv({}, 'platform')).toEqual({
      headersTimeoutMs: 120_000,
      idleTimeoutMs: 90_000,
      retries: 1,
    });
    // One BYO attempt is 120 s + 300 s: a retry could not finish within the
    // 600 s turn, so the defaults leave BYO without one.
    expect(streamLivenessFromEnv({}, 'byo')).toEqual({
      headersTimeoutMs: 120_000,
      idleTimeoutMs: 300_000,
      retries: 0,
    });
    const raw = {
      LLM_HEADERS_TIMEOUT_MS: '30000',
      LLM_STREAM_IDLE_TIMEOUT_MS: '45000',
      LLM_BYO_STREAM_IDLE_TIMEOUT_MS: 'not a number',
      LLM_STREAM_RETRIES: '0',
    };
    expect(streamLivenessFromEnv(raw, 'platform')).toEqual({
      headersTimeoutMs: 30_000,
      idleTimeoutMs: 45_000,
      retries: 0,
    });
    expect(streamLivenessFromEnv(raw, 'byo').idleTimeoutMs).toBe(300_000);
    expect(llmEnvFromWorkerEnv(raw)).toMatchObject({
      LLM_HEADERS_TIMEOUT_MS: 30_000,
      LLM_STREAM_IDLE_TIMEOUT_MS: 45_000,
      LLM_STREAM_RETRIES: 0,
    });
  });

  it('clamps the stall retries to what fits the turn deadline', () => {
    // A longer turn gives BYO its retry back (2 × 420 s ≤ 840 s).
    expect(
      streamLivenessFromEnv({ TURN_TIMEOUT_MS: 840_000 }, 'byo').retries,
    ).toBe(1);
    // A shorter one takes the platform retry away (2 × 210 s > 400 s), on
    // the raw Worker env path too.
    expect(
      streamLivenessFromEnv({ TURN_TIMEOUT_MS: '400000' }, 'platform').retries,
    ).toBe(0);
    expect(
      llmEnvFromWorkerEnv({ TURN_TIMEOUT_MS: '400000' }).TURN_TIMEOUT_MS,
    ).toBe(400_000);
    // Never below 0, never above 5, and never above what is configured.
    expect(
      streamLivenessFromEnv({ TURN_TIMEOUT_MS: 1_000 }, 'platform').retries,
    ).toBe(0);
    expect(
      streamLivenessFromEnv(
        {
          LLM_HEADERS_TIMEOUT_MS: 1_000,
          LLM_STREAM_IDLE_TIMEOUT_MS: 1_000,
          LLM_STREAM_RETRIES: '9',
        },
        'platform',
      ).retries,
    ).toBe(5);
    expect(
      streamLivenessFromEnv({ TURN_TIMEOUT_MS: 9_000_000 }, 'platform').retries,
    ).toBe(1);
  });

  it('gives platform and BYO models the SDK timeout as a backstop behind the guard', () => {
    const platform = createLlmAdapter({
      OPEN_ROUTER_API_KEY: 'sk-test',
      LLM_HEADERS_TIMEOUT_MS: 10_000,
      LLM_STREAM_IDLE_TIMEOUT_MS: 20_000,
      LLM_STREAM_RETRIES: 2,
    }).get('subagent');
    expect(platform).toBeInstanceOf(ChatOpenAICompletions);
    expect(platform instanceof ChatOpenAICompletions && platform.timeout).toBe(
      livenessRequestTimeoutMs({
        headersTimeoutMs: 10_000,
        idleTimeoutMs: 20_000,
        retries: 2,
      }),
    );
    const byo = createByoChatModel({
      credential: { provider: 'deepseek', apiKey: 'sk-user' },
      modelId: 'deepseek-chat',
      role: 'main',
    });
    expect(byo instanceof ChatOpenAICompletions && byo.timeout).toBe(
      livenessRequestTimeoutMs(streamLivenessFromEnv({}, 'byo')),
    );
  });

  it('fails a platform model call whose stream goes silent, without a retry', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        calls.push(input instanceof Request ? input.url : String(input));
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
              ),
            );
            // ...then nothing, ever.
          },
        });
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );
    const model = createLlmAdapter({
      OPEN_ROUTER_API_KEY: 'sk-test',
      LLM_STREAM_IDLE_TIMEOUT_MS: 200,
    }).get('subagent', { streaming: true });

    const started = Date.now();
    const failure = await model
      .invoke([new HumanMessage('hi')])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderStallError);
    expect(findProviderStall(failure)).not.toBeNull();
    expect(failure).toMatchObject({ phase: 'stream', idleMs: 200 });
    expect(Date.now() - started).toBeLessThan(5_000);
    // A stall mid-reply is never retried — by the guard or by LangChain.
    expect(calls).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
  });
});

describe('retries of a failing platform model call', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Requests a call made when every answer is `status`. */
  async function requestsUntilFailure(
    status: number,
    body: object,
  ): Promise<number> {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return Response.json(body, { status });
      }),
    );
    const model = createLlmAdapter({ OPEN_ROUTER_API_KEY: 'sk-test' }).get(
      'subagent',
      { streaming: true },
    );
    await expect(model.invoke([new HumanMessage('hi')])).rejects.toMatchObject({
      status,
    });
    return calls;
  }

  // The SDK never retries (LangChain builds its client with `maxRetries: 0`),
  // the stall guard only retries stalls, so a call is sent 1 + `maxRetries`
  // (2) times.
  it('sends a rate-limited call three times, with no Retry-After hint', async () => {
    expect(
      await requestsUntilFailure(429, {
        error: { message: 'Rate limit exceeded', code: 429 },
      }),
    ).toBe(3);
  });

  it('sends a call refused for good once', async () => {
    expect(
      await requestsUntilFailure(401, {
        error: { message: 'No auth credentials found', code: 401 },
      }),
    ).toBe(1);
  });
});

describe('a stall before the first byte through the OpenAI SDK', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the stall in the cause chain and is not retried by LangChain', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        // Headers, then nothing.
        return new Response(new ReadableStream<Uint8Array>(), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );
    const model = createLlmAdapter({
      OPEN_ROUTER_API_KEY: 'sk-test',
      LLM_STREAM_IDLE_TIMEOUT_MS: 200,
      LLM_STREAM_RETRIES: 0,
    }).get('subagent', { streaming: true });

    const failure = await model
      .invoke([new HumanMessage('hi')])
      .catch((error: unknown) => error);

    // The SDK wraps a failed fetch (APIConnectionError) — unless the
    // message matches /timed? ?out/i, when it drops the cause. Ours does
    // not, so the stall survives as the cause.
    expect(failure).not.toBeInstanceOf(ProviderStallError);
    expect(findProviderStall(failure)).toMatchObject({
      phase: 'first-byte',
      idleMs: 200,
    });
    // `maxRetries: 2` did not re-send it: the guard owns stall retries.
    expect(calls).toBe(1);
  });
});

describe('the OpenRouter request of a main-model turn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The body a tool-calling main-model turn sends. Everything before the
   * newest message is the provider's cached prompt prefix (tools, system
   * message, history), so any change to it, key order included, costs a
   * full prompt-cache miss: it is pinned byte for byte.
   */
  const EXPECTED_BODY = {
    model: 'openai/gpt-5.6-luna',
    temperature: 0.8,
    stream: true,
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Weather for a city.',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
              city: { type: 'string', description: 'City name' },
              unit: { type: 'string', enum: ['c', 'f'] },
              days: { default: 1, type: 'integer', minimum: 1, maximum: 7 },
            },
            required: ['city', 'days'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'mcp_search',
          description: 'Search',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
            additionalProperties: false,
          },
        },
      },
    ],
    stream_options: { include_usage: true },
    include_reasoning: true,
    models: [...OPENROUTER_MAIN_FALLBACKS],
    provider: { order: ['openai', 'azure'], allow_fallbacks: true },
    reasoning: { effort: 'medium', summary: 'auto' },
    max_tokens: LLM_MAX_OUTPUT_TOKENS_DEFAULT,
    messages: [
      { role: 'system', content: 'You are the oracle. Be brief.' },
      { role: 'user', content: 'What is the weather in Paris?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_0',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      {
        role: 'tool',
        content: 'sunny',
        name: 'get_weather',
        tool_call_id: 'call_0',
      },
      { role: 'assistant', content: 'It is sunny.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'And this picture?' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
          },
          {
            type: 'file',
            file: {
              file_data: 'data:application/pdf;base64,JVBERi0=',
              filename: 'a.pdf',
            },
          },
        ],
      },
    ],
  };

  const sse = (chunks: object[]): string =>
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
    'data: [DONE]\n\n';
  const head = {
    id: 'gen-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'openai/gpt-5.6-luna',
  };
  /** A streamed reply: reasoning, text, one tool call in three slices, usage last. */
  const REPLY = sse([
    {
      ...head,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: '', reasoning: 'Thinking' },
        },
      ],
    },
    { ...head, choices: [{ index: 0, delta: { content: 'Hello ' } }] },
    {
      ...head,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '' },
              },
            ],
          },
        },
      ],
    },
    {
      ...head,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"city":' } }],
          },
        },
      ],
    },
    {
      ...head,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }],
          },
        },
      ],
    },
    {
      ...head,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    },
    {
      ...head,
      choices: [],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
        completion_tokens_details: { reasoning_tokens: 20 },
      },
    },
  ]);

  it('goes to Chat Completions with the pinned body, and reads the streamed reply', async () => {
    const requests: { url: string; body: unknown; headers: Headers }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: input instanceof Request ? input.url : String(input),
          body: init?.body,
          headers: new Headers(init?.headers),
        });
        return new Response(REPLY, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );
    const main = createLlmAdapter({ OPEN_ROUTER_API_KEY: 'sk-test' }).get(
      'main',
    );
    if (!(main instanceof ChatOpenAICompletions))
      throw new Error('unreachable');
    const weather = tool(async () => 'sunny', {
      name: 'get_weather',
      description: 'Weather for a city.',
      schema: z.object({
        city: z.string().describe('City name'),
        unit: z.enum(['c', 'f']).optional(),
        days: z.number().int().min(1).max(7).default(1),
      }),
    });
    const search = {
      type: 'function' as const,
      function: {
        name: 'mcp_search',
        description: 'Search',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
          additionalProperties: false,
        },
      },
    };

    let reply: AIMessageChunk | undefined;
    for await (const chunk of await main.bindTools([weather, search]).stream([
      new SystemMessage('You are the oracle. Be brief.'),
      new HumanMessage('What is the weather in Paris?'),
      new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'call_0',
            name: 'get_weather',
            args: { city: 'Paris' },
            type: 'tool_call',
          },
        ],
      }),
      new ToolMessage({
        content: 'sunny',
        tool_call_id: 'call_0',
        name: 'get_weather',
      }),
      new AIMessage('It is sunny.'),
      new HumanMessage({
        content: [
          { type: 'text', text: 'And this picture?' },
          {
            type: 'image',
            source_type: 'base64',
            mime_type: 'image/png',
            data: 'iVBORw0KGgo=',
          },
          nativeContentBlock({
            kind: 'file',
            mimeType: 'application/pdf',
            base64: 'JVBERi0=',
            filename: 'a.pdf',
          }),
        ],
      }),
    ]))
      reply = reply ? reply.concat(chunk) : chunk;

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
    expect(requests[0]?.body).toBe(JSON.stringify(EXPECTED_BODY));
    expect(requests[0]?.headers.get('http-referer')).toBe('oracle-app.com');
    expect(requests[0]?.headers.get('x-title')).toBe('Oracle App');

    expect(reply?.content).toBe('Hello ');
    expect(reply?.tool_calls).toEqual([
      {
        name: 'get_weather',
        args: { city: 'Paris' },
        id: 'call_1',
        type: 'tool_call',
      },
    ]);
    // One usage chunk, after the stream: the totals are OpenRouter's own.
    expect(reply?.usage_metadata).toEqual({
      input_tokens: 1000,
      output_tokens: 50,
      total_tokens: 1050,
      input_token_details: { cache_read: 800, cache_creation: 100 },
      output_token_details: { reasoning: 20 },
    });
  });
});

const weather = tool(async () => 'sunny', {
  name: 'get_weather',
  description: 'Weather for a city.',
  schema: z.object({ city: z.string() }),
});

/** The URL and raw body of the one request a tool-bound call of `model` sends. */
async function sentRequest(
  model: BaseChatModel,
): Promise<{ url: string; body: string }> {
  const requests: { url: string; body: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return Response.json({
        id: 'gen-1',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      });
    }),
  );
  if (!model.bindTools) throw new Error('unreachable');
  await model
    .bindTools([weather])
    .invoke([
      new SystemMessage('You are the oracle. Be brief.'),
      new HumanMessage('What is the weather in Paris?'),
    ]);
  vi.unstubAllGlobals();
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (!request) throw new Error('unreachable');
  return request;
}

describe('prompt caching of Anthropic models on OpenRouter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * `body` as an Anthropic model's request: the model id replaced and
   * `cache_control` right after `reasoning`, every other key in its place.
   */
  function asAnthropicBody(body: string, modelId: string): string {
    const entries: [string, unknown][] = [];
    for (const [key, value] of Object.entries(JSON.parse(body))) {
      entries.push([key, key === 'model' ? modelId : value]);
      if (key === 'reasoning')
        entries.push(['cache_control', { type: 'ephemeral' }]);
    }
    return JSON.stringify(Object.fromEntries(entries));
  }

  const ANTHROPIC_IDS = MODEL_CATALOG.filter(
    (entry) => entry.family === 'anthropic',
  ).map((entry) => entry.id);

  it('marks exactly the anthropic/ ids of the catalog and role maps', () => {
    expect(ANTHROPIC_IDS).toEqual([
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-4.8',
    ]);
    for (const id of ANTHROPIC_IDS)
      expect(openRouterPromptCacheKwargs(id)).toEqual({
        cache_control: { type: 'ephemeral' },
      });
    const others = [
      ...MODEL_CATALOG.filter((entry) => entry.family !== 'anthropic').map(
        (entry) => entry.id,
      ),
      ...Object.values(OPENROUTER_MODEL_MAP),
      ...OPENROUTER_MAIN_FALLBACKS,
      // A BYO lane's native Anthropic id is not an OpenRouter id.
      'claude-sonnet-5',
    ];
    for (const id of others)
      expect(openRouterPromptCacheKwargs(id)).toEqual({});
  });

  it('adds top-level cache_control to an Anthropic model’s request, and changes nothing else', async () => {
    const platform = createLlmAdapter({ OPEN_ROUTER_API_KEY: 'sk-test' });
    // The reference model is neither Anthropic nor GPT-5.6, so its `main`
    // body has the same provider routing as an Anthropic model's.
    const geminiDefault = createLlmAdapter({
      OPEN_ROUTER_API_KEY: 'sk-test',
      DEFAULT_MODEL: 'google/gemini-3.5-flash',
    });
    const anthropicDefault = createLlmAdapter({
      OPEN_ROUTER_API_KEY: 'sk-test',
      DEFAULT_MODEL: 'anthropic/claude-sonnet-5',
    });
    const cases: {
      anthropic: BaseChatModel;
      other: BaseChatModel;
      modelId: string;
    }[] = [
      // The deployment default, on the main role (with its fallback list)
      // and the summarizer that runs on it.
      {
        anthropic: anthropicDefault.get('main'),
        other: geminiDefault.get('main'),
        modelId: 'anthropic/claude-sonnet-5',
      },
      {
        anthropic: anthropicDefault.get('summarizer'),
        other: geminiDefault.get('summarizer'),
        modelId: 'anthropic/claude-sonnet-5',
      },
      // A per-request choice, on the main role and on helper roles.
      ...ANTHROPIC_IDS.flatMap((modelId) =>
        (['main', 'summarizer', 'subagent', 'session-title'] as const).map(
          (role) => ({
            anthropic: platform.get(role, { model: modelId }),
            other: platform.get(role, { model: 'google/gemini-3.5-flash' }),
            modelId,
          }),
        ),
      ),
    ];
    for (const { anthropic, other, modelId } of cases) {
      const sent = await sentRequest(anthropic);
      const reference = await sentRequest(other);
      expect(sent.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(reference.body).not.toContain('cache_control');
      expect(sent.body).toBe(asAnthropicBody(reference.body, modelId));
    }
  });

  it('sends no cache_control for any other model, on either platform lane', async () => {
    const platform = createLlmAdapter({ OPEN_ROUTER_API_KEY: 'sk-test' });
    const models: BaseChatModel[] = [
      ...Object.keys(OPENROUTER_MODEL_MAP)
        .filter((role) => role !== 'embedding')
        .map((role) => platform.get(role)),
      ...MODEL_CATALOG.filter((entry) => entry.family !== 'anthropic').map(
        (entry) => platform.get('main', { model: entry.id }),
      ),
      createLlmAdapter({
        OPEN_ROUTER_API_KEY: '',
        LLM_PROVIDER: 'nebius',
        NEBIUS_API_KEY: 'n',
      }).get('main'),
    ];
    for (const model of models)
      expect((await sentRequest(model)).body).not.toContain('cache_control');
  });

  it('leaves the BYO Anthropic lane without it: Anthropic’s OpenAI-compatible endpoint does not cache', async () => {
    const byo = createByoLlmAdapter(
      createLlmAdapter({ OPEN_ROUTER_API_KEY: 'sk-test' }),
      {
        credential: { provider: 'anthropic', apiKey: 'sk-ant-user' },
        mainModelId: 'claude-sonnet-5',
      },
    );
    const sent = await sentRequest(byo.get('main'));
    expect(sent.url).toBe('https://api.anthropic.com/v1/chat/completions');
    expect(JSON.parse(sent.body)).toMatchObject({ model: 'claude-sonnet-5' });
    expect(sent.body).not.toContain('cache_control');
  });
});

describe('provider routing on OpenRouter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PIN = { order: ['openai', 'azure'], allow_fallbacks: true };

  /** `body` with `model` and `provider` replaced, every key in its place. */
  function withRouting(
    body: string,
    modelId: string,
    provider: object,
  ): string {
    const entries = Object.entries(JSON.parse(body)).map(
      ([key, value]): [string, unknown] => [
        key,
        key === 'model' ? modelId : key === 'provider' ? provider : value,
      ],
    );
    return JSON.stringify(Object.fromEntries(entries));
  }

  /** `body` with `model` replaced and `provider` inserted before `reasoning`. */
  function withPinBeforeReasoning(body: string, modelId: string): string {
    const entries: [string, unknown][] = [];
    for (const [key, value] of Object.entries(JSON.parse(body))) {
      if (key === 'reasoning') entries.push(['provider', PIN]);
      entries.push([key, key === 'model' ? modelId : value]);
    }
    return JSON.stringify(Object.fromEntries(entries));
  }

  it('pins exactly the GPT-5.6 ids on every role; other models sort by latency on main only', () => {
    expect(OPENROUTER_GPT_5_6_IDS).toEqual([
      'openai/gpt-5.6-luna',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-sol',
    ]);
    const catalogGpt56 = MODEL_CATALOG.map((entry) => entry.id).filter((id) =>
      id.startsWith('openai/gpt-5.6-'),
    );
    expect(
      catalogGpt56.every((id) => OPENROUTER_GPT_5_6_IDS.includes(id)),
    ).toBe(true);
    const roles = Object.keys(OPENROUTER_MODEL_MAP);
    for (const id of OPENROUTER_GPT_5_6_IDS)
      for (const role of roles)
        expect(openRouterProviderRouting(id, role)).toEqual({ provider: PIN });
    const others = [
      ...MODEL_CATALOG.map((entry) => entry.id),
      ...Object.values(OPENROUTER_MODEL_MAP),
      ...OPENROUTER_MAIN_FALLBACKS,
    ].filter((id) => !OPENROUTER_GPT_5_6_IDS.includes(id));
    expect(others).toContain('anthropic/claude-sonnet-5');
    expect(others).toContain('google/gemini-3.5-flash');
    expect(others).toContain('meta-llama/llama-3.1-8b-instruct');
    for (const id of others) {
      expect(openRouterProviderRouting(id, 'main')).toEqual({
        provider: { sort: 'latency' },
      });
      for (const role of roles.filter((r) => r !== 'main'))
        expect(openRouterProviderRouting(id, role)).toEqual({});
    }
  });

  it('sends a GPT-5.6 main call the pin, with the fallback list, and nothing else changed', async () => {
    const platform = createLlmAdapter({ OPEN_ROUTER_API_KEY: 'sk-test' });
    const reference = (
      await sentRequest(
        platform.get('main', { model: 'google/gemini-3.5-flash' }),
      )
    ).body;
    expect(JSON.parse(reference)).toMatchObject({
      models: [...OPENROUTER_MAIN_FALLBACKS],
      provider: { sort: 'latency' },
    });
    const cases: { model: BaseChatModel; modelId: string }[] = [
      // The catalog default as the deployment default.
      { model: platform.get('main'), modelId: DEFAULT_MODEL_ID },
      // Each GPT-5.6 id as a deployment default and as a per-request choice.
      ...OPENROUTER_GPT_5_6_IDS.flatMap((modelId) => [
        {
          model: createLlmAdapter({
            OPEN_ROUTER_API_KEY: 'sk-test',
            DEFAULT_MODEL: modelId,
          }).get('main'),
          modelId,
        },
        { model: platform.get('main', { model: modelId }), modelId },
      ]),
    ];
    for (const { model, modelId } of cases)
      expect((await sentRequest(model)).body).toBe(
        withRouting(reference, modelId, PIN),
      );
  });

  it('pins every helper role that runs a GPT-5.6 model, by default or by choice, and changes nothing else', async () => {
    const platform = createLlmAdapter({ OPEN_ROUTER_API_KEY: 'sk-test' });
    // A helper role on a model that is not GPT-5.6: no `provider` field.
    const reference = (
      await sentRequest(
        platform.get('subagent', { model: 'google/gemini-3.5-flash' }),
      )
    ).body;
    expect(JSON.parse(reference)).not.toHaveProperty('provider');
    expect(JSON.parse(reference)).not.toHaveProperty('models');
    const cases: { model: BaseChatModel; modelId: string }[] = [
      // Roles whose default model is GPT-5.6 (the summarizer runs the main model).
      ...(['summarizer', 'skills', 'subagent'] as const).map((role) => ({
        model: platform.get(role),
        modelId: DEFAULT_MODEL_ID,
      })),
      // A GPT-5.6 id chosen for a role whose default is another model.
      ...(['session-title', 'vision', 'routing'] as const).map((role) => ({
        model: platform.get(role, { model: 'openai/gpt-5.6-sol' }),
        modelId: 'openai/gpt-5.6-sol',
      })),
    ];
    for (const { model, modelId } of cases)
      expect((await sentRequest(model)).body).toBe(
        withPinBeforeReasoning(reference, modelId),
      );
  });

  it('leaves Anthropic and Gemini main calls on latency sorting, and other-model helper roles without provider routing', async () => {
    const platform = createLlmAdapter({ OPEN_ROUTER_API_KEY: 'sk-test' });
    for (const modelId of [
      'anthropic/claude-sonnet-5',
      'google/gemini-3.5-flash',
    ]) {
      const fromDefault = createLlmAdapter({
        OPEN_ROUTER_API_KEY: 'sk-test',
        DEFAULT_MODEL: modelId,
      }).get('main');
      for (const model of [
        fromDefault,
        platform.get('main', { model: modelId }),
      ])
        expect(JSON.parse((await sentRequest(model)).body)).toMatchObject({
          model: modelId,
          models: [...OPENROUTER_MAIN_FALLBACKS],
          provider: { sort: 'latency' },
        });
    }
    // Their default models: llama (session-title, guard), gemini (vision,
    // custom_medium), gpt-oss (routing, custom_low).
    for (const role of [
      'session-title',
      'guard',
      'vision',
      'custom_medium',
      'routing',
      'custom_low',
    ] as const) {
      const body = JSON.parse((await sentRequest(platform.get(role))).body);
      expect(body.model).toBe(OPENROUTER_MODEL_MAP[role]);
      expect(body).not.toHaveProperty('provider');
    }
  });
});

describe('redactSignedLinks', () => {
  const SIGNED =
    'https://r2.example/o/a.docx?X-Amz-Expires=10800&X-Amz-Signature=deadbeef0123&x-id=GetObject';

  it('removes the signature from a signed link, wherever it sits', () => {
    const redacted = JSON.stringify(
      redactSignedLinks({
        output: new ToolMessage({
          tool_call_id: 'f1',
          content: '{"ok":true}',
          artifact: { url: SIGNED },
        }),
        text: `[a.docx](${SIGNED})`,
      }),
    );
    expect(redacted).not.toContain('deadbeef0123');
    expect(redacted).toContain('X-Amz-Signature=[redacted]&x-id=GetObject');
  });

  it('hands back a payload with no signed link untouched', () => {
    const values = { messages: [new HumanMessage('hello')] };
    expect(redactSignedLinks(values)).toBe(values);
  });

  it('sends nothing it cannot read', () => {
    expect(redactSignedLinks({ big: 1n })).toEqual({});
    expect(
      redactSignedLinks({
        nested: [
          {
            broken: {
              toJSON: () => {
                throw new Error('no');
              },
            },
          },
        ],
      }),
    ).toEqual({});
  });

  it('serializes nothing when no signature can be present', () => {
    let serialized = 0;
    const history = {
      toJSON() {
        serialized += 1;
        return { messages: ['x'.repeat(10_000)] };
      },
    };
    const values = { inputs: [history, history] };
    expect(redactSignedLinks(values)).toBe(values);
    // The walk read it once (a shared object once); no stringify read it again.
    expect(serialized).toBe(1);
  });

  it('finds a signature wherever the JSON would carry one, as the full pass does', () => {
    const cyclic: Record<string, unknown> = { text: `see ${SIGNED}` };
    cyclic.self = cyclic;
    const cases: Array<Record<string, unknown>> = [
      // in a message, through its toJSON
      { messages: [[new HumanMessage(`open ${SIGNED}`)]] },
      // in a key
      { [SIGNED]: 1 },
      // any case, deep in an array
      { a: [[[{ b: SIGNED.replace('X-Amz-Signature', 'x-amz-signature') }]]] },
      // in a cycle
      { cyclic },
    ];
    for (const values of cases) {
      const out = redactSignedLinks(values);
      expect(out).not.toBe(values);
      expect(JSON.stringify(out)).not.toContain('deadbeef0123');
    }
    // The marker without a signature, a Map (no JSON keys) and a typed
    // array are left alone, as the full pass leaves them.
    for (const values of [
      { text: 'X-Amz-Signature=&x' },
      { map: new Map([['k', SIGNED]]) },
      { bytes: new Uint8Array([1, 2, 3]) },
    ])
      expect(redactSignedLinks(values)).toBe(values);
  });

  it('is what every tracer client applies to inputs and outputs, after collapsing thread state', () => {
    const { callbacks } = resolveLangsmithTracing({
      userDid: 'did:ixo:user',
      client: 'channel',
      env: { apiKey: 'key', tracing: 'true' },
    });
    const client = Object(Reflect.get(callbacks?.[0] ?? {}, 'client'));
    const thread = Array.from(
      { length: 10 },
      (_, i) => new HumanMessage({ id: `m${i}`, content: `turn ${i}` }),
    );
    for (const key of ['hideInputs', 'hideOutputs']) {
      const hide: unknown = Reflect.get(client, key);
      expect(typeof hide).toBe('function');
      const apply = (values: Record<string, unknown>): unknown =>
        Reflect.apply(Function.prototype.call, hide, [undefined, values]);
      // A node's thread state keeps its newest messages and a count.
      const collapsed = Object(apply({ messages: thread, step: 3 }));
      expect(collapsed.messages).toEqual(
        thread.slice(-TRACE_STATE_TAIL_MESSAGES),
      );
      expect(collapsed.messagesOmitted).toBe(
        thread.length - TRACE_STATE_TAIL_MESSAGES,
      );
      expect(collapsed.step).toBe(3);
      // A chat model's prompt (one list per prompt) is traced whole.
      const prompt = { messages: [thread] };
      expect(apply(prompt)).toBe(prompt);
      // Signed links are still redacted.
      expect(JSON.stringify(apply({ text: SIGNED }))).not.toContain(
        SIGNED.slice(SIGNED.indexOf('X-Amz-Signature=')),
      );
    }
  });

  it('keeps the signature out of everything a traced turn uploads', async () => {
    const trace = async (
      anonymizer: typeof redactSignedLinks | undefined,
    ): Promise<string[]> => {
      const bodies: string[] = [];
      vi.stubGlobal(
        'fetch',
        async (_url: unknown, init?: { body?: unknown }) => {
          bodies.push(new TextDecoder().decode(toBytes(init?.body)));
          return new Response('{}', { status: 200 });
        },
      );
      try {
        const client = new Client({
          apiKey: 'key',
          apiUrl: 'https://langsmith.example',
          autoBatchTracing: false,
          ...(anonymizer ? { anonymizer } : {}),
        });
        const sendFile = tool(
          async (_args, config: { toolCall?: { id?: string } }) =>
            new ToolMessage({
              tool_call_id: config.toolCall?.id ?? '',
              name: 'send_file',
              content: '{"ok":true}',
              artifact: { url: SIGNED },
            }),
          { name: 'send_file', description: 'Send.', schema: z.object({}) },
        );
        await createAgent({
          model: new FakeToolCallingModel({
            toolCalls: [[{ name: 'send_file', args: {}, id: 'f1' }], []],
          }) as never,
          tools: [sendFile],
        }).invoke(
          { messages: [new HumanMessage('go')] },
          { callbacks: [new LangChainTracer({ client, projectName: 'p' })] },
        );
        await vi.waitFor(() => {
          expect(bodies.length).toBeGreaterThan(0);
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        return bodies;
      } finally {
        vi.unstubAllGlobals();
      }
    };

    const unprotected = await trace(undefined);
    expect(unprotected.join('\n')).toContain('deadbeef0123');
    const protectedBodies = await trace(redactSignedLinks);
    expect(protectedBodies.length).toBeGreaterThan(0);
    expect(protectedBodies.join('\n')).toContain('[redacted]');
    expect(protectedBodies.join('\n')).not.toContain('deadbeef0123');
  });

  it('keeps signed links out of a traced run’s error and metadata, and uploads no environment values', async () => {
    // workerd fills `process.env` from vars and secrets.
    vi.stubEnv('LANGSMITH_TRACED_DIDS', 'did:ixo:someone-else');
    const uploads = captureLangsmithUploads();
    try {
      const { tracer, client } = tracerFor('error-metadata-key');
      await RunnableLambda.from(async (): Promise<never> => {
        throw new Error(`HTTP 403 downloading ${SIGNED}`);
      })
        .invoke(
          {},
          {
            callbacks: [tracer],
            runName: 'error_probe',
            metadata: { link: SIGNED },
          },
        )
        .catch(() => undefined);
      await client.awaitPendingTraceBatches();
      const sent = uploads.join('\n');
      expect(sent).toContain('error_probe');
      expect(sent).toContain('HTTP 403 downloading');
      expect(sent).toContain('X-Amz-Signature=[redacted]');
      expect(sent).not.toContain('deadbeef0123');
      expect(sent).not.toContain('LANGSMITH_TRACED_DIDS');
      expect(sent).not.toContain('did:ixo:someone-else');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('uploads no model header or key in a traced call’s serialized model', async () => {
    const uploads = captureLangsmithUploads();
    try {
      const { tracer, client } = tracerFor('serialized-key');
      const models = [
        createByoChatModel({
          credential: {
            provider: 'chatgpt',
            oauth: {
              accessToken: 'chatgpt-access-secret',
              refreshToken: 'chatgpt-refresh-secret',
              accountId: 'acct-secret-123',
              expiresAt: Date.now() + 3_600_000,
            },
          },
          modelId: 'gpt-5.6-terra',
          role: 'main',
          chatGptBackend: {
            baseUrl: 'https://chatgpt.proxy.example',
            proxyAuthToken: 'proxy-shared-secret',
          },
        }),
        createByoChatModel({
          credential: { provider: 'openai', apiKey: 'sk-byo-secret' },
          modelId: 'gpt-5.6-terra',
          role: 'main',
        }),
        createLlmAdapter({ OPEN_ROUTER_API_KEY: 'sk-or-secret' }).get('main'),
      ];
      for (const model of models)
        await model
          .invoke('hi', { callbacks: [tracer], runName: 'serialized_probe' })
          .catch(() => undefined);
      await client.awaitPendingTraceBatches();
      const sent = uploads.join('\n');
      // The models' constructor arguments were uploaded…
      expect(sent).toContain('serialized_probe');
      expect(sent).toContain('chatgpt.proxy.example');
      expect(sent).toContain('openrouter.ai');
      // …without a credential or a lane header in them.
      for (const secret of [
        'proxy-shared-secret',
        'acct-secret-123',
        'chatgpt-access-secret',
        'chatgpt-refresh-secret',
        'sk-byo-secret',
        'sk-or-secret',
        'session-id',
      ])
        expect(sent).not.toContain(secret);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uploads a traced turn through the shared client, gzipped when the server accepts it', async () => {
    const uploads: { encoding: string | null; text: string }[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('/info'))
          return Response.json({
            version: '0.11.0',
            batch_ingest_config: { use_multipart_endpoint: true },
            instance_flags: { gzip_body_enabled: true },
          });
        const headers = new Headers(init?.headers);
        const encoding = headers.get('content-encoding');
        const raw = new Response(init?.body ?? null).body;
        const body =
          raw && encoding === 'gzip'
            ? raw.pipeThrough(new DecompressionStream('gzip'))
            : raw;
        uploads.push({ encoding, text: await new Response(body).text() });
        return new Response('{}', { status: 200 });
      },
    );
    try {
      const { callbacks } = resolveLangsmithTracing({
        userDid: 'did:ixo:gzip-upload',
        client: 'portal',
        env: {
          apiKey: 'gzip-upload-key',
          tracing: 'true',
          endpoint: 'https://langsmith.example',
        },
      });
      const tracer = callbacks?.[0];
      if (!tracer || !(tracer.client instanceof Client))
        throw new Error('unreachable');
      const client = tracer.client;
      await RunnableLambda.from(async (input: { text: string }) => ({
        echoed: input.text,
      })).invoke(
        { text: `see ${SIGNED}` },
        { callbacks: [tracer], runName: 'gzip_probe' },
      );
      await client.awaitPendingTraceBatches();

      const runs = uploads.filter((upload) =>
        upload.text.includes('gzip_probe'),
      );
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((upload) => upload.encoding === 'gzip')).toBe(true);
      const sent = uploads.map((upload) => upload.text).join('\n');
      expect(sent).toContain('[redacted]');
      expect(sent).not.toContain('deadbeef0123');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Stub `fetch`: LangSmith at `https://langsmith.example` (gzip on) records
 * the text of every upload; any other request gets an empty 400.
 */
function captureLangsmithUploads(): string[] {
  const uploads: string[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (!request.url.startsWith('https://langsmith.example'))
        return new Response(null, { status: 400 });
      if (request.url.endsWith('/info'))
        return Response.json({
          version: '0.11.0',
          batch_ingest_config: { use_multipart_endpoint: true },
          instance_flags: { gzip_body_enabled: true },
        });
      const raw = request.body;
      const body =
        raw && request.headers.get('content-encoding') === 'gzip'
          ? raw.pipeThrough(new DecompressionStream('gzip'))
          : raw;
      uploads.push(await new Response(body).text());
      return new Response('{}', { status: 200 });
    },
  );
  return uploads;
}

/** The runtime's tracer for a turn traced through `captureLangsmithUploads`. */
function tracerFor(apiKey: string): {
  tracer: LangChainTracer;
  client: Client;
} {
  const { callbacks } = resolveLangsmithTracing({
    userDid: 'did:ixo:traced',
    client: 'portal',
    env: { apiKey, tracing: 'true', endpoint: 'https://langsmith.example' },
  });
  const tracer = callbacks?.[0];
  if (!tracer || !(tracer.client instanceof Client))
    throw new Error('unreachable');
  return { tracer, client: tracer.client };
}

function toBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  return new TextEncoder().encode(typeof body === 'string' ? body : '');
}
