import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { ChatOpenAI } from '@langchain/openai';
import { createAgent, FakeToolCallingModel, tool } from 'langchain';
import { Client } from 'langsmith';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  BYO_PROVIDER_MODELS,
  BYO_PROVIDERS,
  BYO_ROLE_MODELS,
} from '../llm/byo-catalog';
import { createByoChatModel } from '../llm/byo-client';
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
  OPENROUTER_MAIN_FALLBACKS,
  OPENROUTER_MODEL_MAP,
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
    expect(summarizer).toBeInstanceOf(ChatOpenAI);
    if (!(summarizer instanceof ChatOpenAI)) throw new Error('unreachable');
    expect(summarizer.model).toBe('anthropic/claude-sonnet-5');
    // Helper effort, not the reply's; no fallback model list.
    expect(summarizer.modelKwargs).toMatchObject({
      reasoning: { effort: 'medium' },
    });
    expect(summarizer.modelKwargs?.models).toBeUndefined();
    const main = adapter.get('main');
    if (!(main instanceof ChatOpenAI)) throw new Error('unreachable');
    expect(main.modelKwargs).toMatchObject({ reasoning: { effort: 'high' } });

    const chosen = adapter.get('summarizer', { model: 'openai/gpt-5.6-sol' });
    if (!(chosen instanceof ChatOpenAI)) throw new Error('unreachable');
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
    if (!(summarizer instanceof ChatOpenAI)) throw new Error('unreachable');
    expect(summarizer.model).toBe(NEBIUS_MODEL_MAP.main);
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
    expect(platform).toBeInstanceOf(ChatOpenAI);
    expect(platform instanceof ChatOpenAI && platform.timeout).toBe(
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
    expect(byo instanceof ChatOpenAI && byo.timeout).toBe(
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
});

function toBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  return new TextEncoder().encode(typeof body === 'string' ? body : '');
}
