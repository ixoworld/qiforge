import { HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createByoChatModel } from '../llm/byo-client';
import {
  findProviderStall,
  livenessRequestTimeoutMs,
  ProviderStallError,
} from '../llm/stream-liveness';
import {
  createLlmAdapter,
  llmEnvFromWorkerEnv,
  streamLivenessFromEnv,
  DEFAULT_MODEL_ID,
  getModelCapabilities,
  listModelCatalog,
  MODEL_CATALOG,
  MODEL_INPUT_CAPS,
  OPENROUTER_MODEL_MAP,
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
