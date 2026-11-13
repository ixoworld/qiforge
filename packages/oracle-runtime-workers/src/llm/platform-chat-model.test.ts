import type { AIMessageChunk } from '@langchain/core/messages';
import { HumanMessage } from '@langchain/core/messages';
import { tool } from 'langchain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLlmAdapter, OPENROUTER_MAIN_FALLBACKS } from '../core/llm';
import type { Logger } from '../plugin-api/types';
import { modelCallOf, MODEL_CALL_METADATA_KEY } from './model-call';

const sse = (chunks: object[]): string =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
  'data: [DONE]\n\n';

const USAGE = {
  prompt_tokens: 37_000,
  completion_tokens: 105,
  total_tokens: 37_105,
  cost: 0.0021,
  is_byok: false,
  prompt_tokens_details: { cached_tokens: 31_500, cache_write_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 30 },
};

/**
 * A reply as OpenRouter streams it (shape recorded from a live call on
 * 2026-11-13): the last chunk carries the finish reason, a choice AND the
 * usage, with the served model and provider on every chunk.
 */
function openRouterReply(model: string, provider: string): string {
  const head = {
    id: 'gen-1794582969-abc',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    provider,
  };
  return sse([
    {
      ...head,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'Hello', reasoning: 'Hm' },
        },
      ],
    },
    { ...head, choices: [{ index: 0, delta: { content: ' there' } }] },
    {
      ...head,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: 'stop',
          native_finish_reason: 'completed',
        },
      ],
      usage: USAGE,
    },
  ]);
}

function capture() {
  const lines: { level: 'log' | 'warn'; text: string }[] = [];
  const logger: Logger = {
    log: (message) => lines.push({ level: 'log', text: String(message) }),
    warn: (message) => lines.push({ level: 'warn', text: String(message) }),
    error: () => {},
  };
  return { lines, logger };
}

function stubFetch(responses: Array<() => Response>) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const next = responses.shift();
      if (!next) throw new Error('no response left');
      return next();
    }),
  );
  return bodies;
}

const streamed = (body: string) => () =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });

async function streamAll(model: {
  stream: (input: HumanMessage[]) => Promise<AsyncIterable<AIMessageChunk>>;
}): Promise<AIMessageChunk | undefined> {
  let reply: AIMessageChunk | undefined;
  for await (const chunk of await model.stream([new HumanMessage('hi')]))
    reply = reply ? reply.concat(chunk) : chunk;
  return reply;
}

describe('PlatformChatModel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps OpenRouter usage once (it used to be exactly twice the real value)', async () => {
    stubFetch([streamed(openRouterReply('openai/gpt-5.6-luna', 'OpenAI'))]);
    const { logger } = capture();
    const reply = await streamAll(
      createLlmAdapter({ OPEN_ROUTER_API_KEY: 'sk-test' }, logger).get('main'),
    );
    expect(reply?.content).toBe('Hello there');
    expect(reply?.response_metadata.usage).toEqual(USAGE);
    expect(reply?.usage_metadata).toMatchObject({
      input_tokens: 37_000,
      output_tokens: 105,
      total_tokens: 37_105,
    });
  });

  it('records the call: generation id, served model, provider, tokens, cost', async () => {
    stubFetch([streamed(openRouterReply('openai/gpt-5.6-luna', 'OpenAI'))]);
    const { lines, logger } = capture();
    const reply = await streamAll(
      createLlmAdapter({ OPEN_ROUTER_API_KEY: 'sk-test' }, logger).get('main'),
    );
    const call = modelCallOf(reply);
    expect(call).toEqual({
      role: 'main',
      requestedModel: 'openai/gpt-5.6-luna',
      servedModel: 'openai/gpt-5.6-luna',
      provider: 'OpenAI',
      generationId: 'gen-1794582969-abc',
      fallback: false,
      modelFallback: false,
      providerFallback: false,
      promptTokens: 37_000,
      cachedTokens: 31_500,
      cacheWriteTokens: 0,
      outputTokens: 105,
      reasoningTokens: 30,
      costUsd: 0.0021,
      durationMs: expect.any(Number),
      ok: true,
      finishReason: 'stop',
    });
    expect(reply?.response_metadata[MODEL_CALL_METADATA_KEY]).toEqual(call);
    const logged = lines.filter((line) => line.text.startsWith('[llm-call] '));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!.text.slice('[llm-call] '.length))).toEqual(
      call,
    );
  });

  it('marks a provider fallback (Bedrock after the OpenAI, Azure pin) and a model fallback', async () => {
    stubFetch([
      streamed(openRouterReply('openai/gpt-5.6-luna', 'Amazon Bedrock')),
      streamed(
        openRouterReply('google/gemini-3.1-flash-lite', 'Google AI Studio'),
      ),
    ]);
    const adapter = createLlmAdapter(
      { OPEN_ROUTER_API_KEY: 'sk-test' },
      capture().logger,
    );
    const bedrock = modelCallOf(await streamAll(adapter.get('main')));
    expect(bedrock).toMatchObject({
      provider: 'Amazon Bedrock',
      fallback: true,
      providerFallback: true,
      modelFallback: false,
    });
    const gemini = modelCallOf(await streamAll(adapter.get('main')));
    expect(gemini).toMatchObject({
      servedModel: 'google/gemini-3.1-flash-lite',
      fallback: true,
      modelFallback: true,
      providerFallback: false,
    });
  });

  it('puts the failed call on the error: OpenRouter key limit (403)', async () => {
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'Key limit exceeded (daily limit)',
              code: 403,
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    ]);
    const { lines, logger } = capture();
    const model = createLlmAdapter(
      { OPEN_ROUTER_API_KEY: 'sk-test' },
      logger,
    ).get('main', { maxRetries: 0 });
    const error = await streamAll(model).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeDefined();
    expect(modelCallOf(error)).toMatchObject({
      role: 'main',
      requestedModel: 'openai/gpt-5.6-luna',
      ok: false,
      errorKind: 'auth',
      errorStatus: 403,
    });
    const warned = lines.filter(
      (line) => line.level === 'warn' && line.text.startsWith('[llm-call] '),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]!.text).toContain('Key limit exceeded');
  });

  it('records a non-streamed call too', async () => {
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            id: 'gen-2',
            object: 'chat.completion',
            created: 1,
            model: 'openai/gpt-5.6-luna',
            provider: 'Azure',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Hi' },
                finish_reason: 'stop',
              },
            ],
            usage: USAGE,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    ]);
    const model = createLlmAdapter(
      { OPEN_ROUTER_API_KEY: 'sk-test' },
      capture().logger,
    ).get('routing', { model: 'openai/gpt-5.6-luna' });
    const reply = await model.invoke([new HumanMessage('hi')]);
    expect(modelCallOf(reply)).toMatchObject({
      role: 'routing',
      generationId: 'gen-2',
      provider: 'Azure',
      providerFallback: true,
      promptTokens: 37_000,
      costUsd: 0.0021,
      ok: true,
    });
    expect(reply.response_metadata.usage).toEqual(USAGE);
  });

  it('sends the new fallback list, or the deployment’s own list and provider order', async () => {
    const bodies = stubFetch([
      streamed(openRouterReply('openai/gpt-5.6-luna', 'OpenAI')),
      streamed(openRouterReply('openai/gpt-5.6-luna', 'OpenAI')),
      streamed(openRouterReply('openai/gpt-5.6-luna', 'OpenAI')),
    ]);
    const { logger } = capture();
    await streamAll(
      createLlmAdapter({ OPEN_ROUTER_API_KEY: 'sk-test' }, logger).get('main'),
    );
    expect(bodies[0]).toMatchObject({
      models: ['google/gemini-3.1-flash-lite', 'google/gemini-2.5-flash-lite'],
      provider: { order: ['openai', 'azure'], allow_fallbacks: true },
    });
    expect(OPENROUTER_MAIN_FALLBACKS).not.toContain(
      'qwen/qwen3-235b-a22b-thinking-2507',
    );
    await streamAll(
      createLlmAdapter(
        {
          OPEN_ROUTER_API_KEY: 'sk-test',
          OPENROUTER_MAIN_FALLBACKS:
            'anthropic/claude-haiku-5.5 , google/gemini-2.5-flash-lite',
          OPENROUTER_PROVIDER_ORDER: 'azure,openai',
        },
        logger,
      ).get('main'),
    );
    expect(bodies[1]).toMatchObject({
      models: ['anthropic/claude-haiku-5.5', 'google/gemini-2.5-flash-lite'],
      provider: { order: ['azure', 'openai'], allow_fallbacks: true },
    });
    await streamAll(
      createLlmAdapter(
        {
          OPEN_ROUTER_API_KEY: 'sk-test',
          OPENROUTER_MAIN_FALLBACKS: 'none',
          OPENROUTER_PROVIDER_ORDER: 'none',
        },
        logger,
      ).get('main'),
    );
    expect(bodies[2]).not.toHaveProperty('models');
    expect(bodies[2]).toMatchObject({ provider: { sort: 'latency' } });
  });
});

describe('the tool schemas a platform model sends', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Yo's `set_chat_language` tool as it was on 13 Nov 2026. */
  const setChatLanguage = tool(async ({ language }) => `ok ${language}`, {
    name: 'set_chat_language',
    description: 'Change the chat language.',
    schema: z
      .object({
        language: z
          .string()
          .trim()
          .min(2)
          .max(80)
          .regex(/^[\p{L}\p{M}\s'-]+$/u, 'Use a language name.'),
        code: z.string().regex(/^[a-z]{2,3}$/),
      })
      .strict(),
  });

  it('leaves out the pattern OpenAI refuses, keeps the others, and warns once', async () => {
    const bodies = stubFetch([
      streamed(openRouterReply('openai/gpt-5.6-luna', 'OpenAI')),
      streamed(openRouterReply('openai/gpt-5.6-luna', 'OpenAI')),
    ]);
    const { lines, logger } = capture();
    const adapter = createLlmAdapter(
      { OPEN_ROUTER_API_KEY: 'sk-test' },
      logger,
    );
    await streamAll(adapter.get('main').bindTools!([setChatLanguage]));
    await streamAll(adapter.get('main').bindTools!([setChatLanguage]));

    for (const body of bodies) {
      const [sent] = body.tools as Array<{
        function: {
          parameters: { properties: Record<string, Record<string, unknown>> };
        };
      }>;
      const properties = sent!.function.parameters.properties;
      expect(properties.language).not.toHaveProperty('pattern');
      expect(properties.language).toMatchObject({
        minLength: 2,
        maxLength: 80,
      });
      expect(properties.code).toMatchObject({ pattern: '^[a-z]{2,3}$' });
    }
    const warnings = lines.filter((line) =>
      line.text.startsWith('[tool-schema] tool "set_chat_language"'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.text).toContain('properties.language');
    expect(warnings[0]!.text).toContain('bad escape \\p');
  });

  it('still checks the pattern when the tool is called', async () => {
    await expect(
      setChatLanguage.invoke({ language: 'isiZulu', code: 'zu' }),
    ).resolves.toBe('ok isiZulu');
    await expect(
      setChatLanguage.invoke({ language: 'Zulu 2!', code: 'zu' }),
    ).rejects.toThrow();
  });
});
