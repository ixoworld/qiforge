import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { describe, expect, it, vi } from 'vitest';
import { gpt6ResponseOptions } from '../core/gpt6';
import { createLlmAdapter, DEFAULT_MODEL_ID, MODEL_CATALOG } from '../core/llm';
import { createByoChatModel } from './byo-client';

function client(model: ReturnType<typeof createByoChatModel>): ChatOpenAI {
  if (!(model instanceof ChatOpenAI)) throw new Error('Expected OpenAI client');
  return model;
}
function response(output: unknown[]) {
  return new Response(
    JSON.stringify({
      id: 'resp_fixture',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model: 'gpt-6.1-sol',
      output,
      usage: {
        input_tokens: 10,
        output_tokens: 8,
        total_tokens: 18,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 3 },
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

describe('GPT-6 Responses compatibility', () => {
  it('streams Responses text and completion usage through the pinned SDK', async () => {
    const completion = await response([
      {
        type: 'message',
        id: 'msg_fixture',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
      },
    ]).json();
    const events = [
      {
        type: 'response.created',
        response: { id: 'resp_fixture', model: 'gpt-6-luna' },
      },
      {
        type: 'response.output_text.delta',
        delta: 'Hello',
        content_index: 0,
        output_index: 0,
        item_id: 'msg_fixture',
      },
      { type: 'response.completed', response: completion },
    ];
    const fetch = vi.fn(
      async () =>
        new Response(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join('') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const model = createByoChatModel({
      credential: { provider: 'openai', apiKey: 'fixture' },
      modelId: 'gpt-6-luna',
      role: 'main',
      params: {
        configuration: { fetch },
        maxRetries: 0,
        reasoning: { effort: 'none' },
      },
    });
    const chunks = [];
    for await (const chunk of await model.stream('Say hello'))
      chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe('Hello');
    expect(chunks.at(-1)?.usage_metadata?.total_tokens).toBe(18);
  });
  it('translates structured output schemas to text.format', async () => {
    let body: Record<string, unknown> = {};
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return response([
        {
          type: 'message',
          id: 'msg_fixture',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: '{"answer":"yes"}', annotations: [] },
          ],
        },
      ]);
    });
    const model = client(
      createByoChatModel({
        credential: { provider: 'openai', apiKey: 'fixture' },
        modelId: 'gpt-6.1-sol',
        role: 'main',
        params: { configuration: { fetch }, maxRetries: 0 },
      }),
    );
    const structured = model.withStructuredOutput(
      {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      { name: 'answer', method: 'jsonSchema', strict: true },
    );
    expect(await structured.invoke('Answer')).toEqual({ answer: 'yes' });
    expect(body).toMatchObject({
      text: { format: { type: 'json_schema', name: 'answer', strict: true } },
    });
    expect(body).not.toHaveProperty('response_format');
  });
  it('honors cancellation before contacting the provider', async () => {
    const fetch = vi.fn();
    const model = createByoChatModel({
      credential: { provider: 'openai', apiKey: 'fixture' },
      modelId: 'gpt-6.1-sol',
      role: 'main',
      params: { configuration: { fetch }, maxRetries: 0 },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      model.invoke('Do work', { signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('adds unique candidate IDs without changing the default or tier priority', () => {
    expect(new Set(MODEL_CATALOG.map((model) => model.id)).size).toBe(
      MODEL_CATALOG.length,
    );
    expect(DEFAULT_MODEL_ID).toBe('openai/gpt-5.6-luna');
    expect(MODEL_CATALOG.find((model) => model.tier === 'balanced')?.id).toBe(
      DEFAULT_MODEL_ID,
    );
    expect(
      MODEL_CATALOG.filter((model) => model.id.includes('gpt-6')).map(
        (model) => model.tier,
      ),
    ).toEqual(['everyday', 'balanced', 'top']);
  });
  it.each(['gpt-6.1-sol', 'gpt-6-astra'])(
    'maps unsupported none to low for %s',
    (model) => {
      expect(
        gpt6ResponseOptions(model, { reasoning: { effort: 'none' } })
          .modelKwargs,
      ).toMatchObject({ reasoning: { effort: 'low' } });
    },
  );
  it('preserves Luna none, strips sampling and migrates cache retention', () => {
    const options = gpt6ResponseOptions('gpt-6-luna', {
      temperature: 0.8,
      reasoning: { effort: 'none' },
      promptCacheRetention: '24h',
      modelKwargs: { top_p: 0.9 },
    });
    expect(options.temperature).toBeUndefined();
    expect(options.modelKwargs).toEqual({
      reasoning: { effort: 'none', summary: 'auto' },
      prompt_cache_options: { ttl: '30m' },
      store: false,
      include: ['reasoning.encrypted_content'],
    });
  });
  it('selects Responses on managed and personal routes while retaining credentials', () => {
    const managed = client(
      createLlmAdapter({ OPEN_ROUTER_API_KEY: 'fixture-router' }).get('main', {
        model: 'openai/gpt-6.1-sol',
      }),
    );
    const personal = client(
      createByoChatModel({
        credential: { provider: 'openai', apiKey: 'fixture-personal' },
        modelId: 'gpt-6.1-sol',
        role: 'main',
      }),
    );
    expect(managed.useResponsesApi).toBe(true);
    expect(personal.useResponsesApi).toBe(true);
    expect(managed.apiKey).toBe('fixture-router');
    expect(personal.apiKey).toBe('fixture-personal');
    const connected = client(
      createByoChatModel({
        credential: {
          provider: 'chatgpt',
          oauth: {
            accessToken: 'fixture-access',
            refreshToken: 'fixture-refresh',
            accountId: 'fixture-account',
            expiresAt: 1,
          },
        },
        modelId: 'gpt-6-astra',
        role: 'main',
        params: { reasoning: { effort: 'none' } },
      }),
    );
    expect(connected.useResponsesApi).toBe(true);
    expect(connected.modelKwargs).toMatchObject({
      store: false,
      reasoning: { effort: 'low' },
    });
  });
  it('uses the pinned SDK to match tool call IDs and account for reasoning usage', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toMatch(/\/responses$/);
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? response([
            {
              type: 'function_call',
              id: 'fc_fixture',
              call_id: 'call_fixture',
              name: 'lookup',
              arguments: '{"query":"test"}',
              status: 'completed',
            },
          ])
        : response([
            {
              type: 'message',
              id: 'msg_fixture',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Done', annotations: [] }],
            },
          ]);
    });
    const model = client(
      createByoChatModel({
        credential: { provider: 'openai', apiKey: 'fixture' },
        modelId: 'gpt-6.1-sol',
        role: 'main',
        params: {
          maxRetries: 0,
          configuration: { fetch },
          temperature: 0.8,
          maxTokens: 100,
        },
      }),
    );
    const bound = model.bindTools(
      [
        {
          type: 'function',
          function: {
            name: 'lookup',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
              additionalProperties: false,
            },
          },
        },
      ],
      { strict: true },
    );
    const prompt = new HumanMessage('Look this up');
    const first = await bound.invoke([prompt]);
    expect(first.tool_calls?.[0]).toMatchObject({
      id: 'call_fixture',
      name: 'lookup',
      args: { query: 'test' },
    });
    const final = await bound.invoke([
      prompt,
      first,
      new ToolMessage({ tool_call_id: 'call_fixture', content: 'Found' }),
    ]);
    expect(final.content).toEqual([
      { type: 'text', text: 'Done', annotations: [], phase: undefined },
    ]);
    expect(final.usage_metadata).toMatchObject({
      total_tokens: 18,
      output_token_details: { reasoning: 3 },
    });
    expect(bodies[0]).toMatchObject({
      reasoning: { effort: 'medium' },
      store: false,
      max_output_tokens: 100,
      tools: [{ type: 'function', name: 'lookup', strict: true }],
    });
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[1]?.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_fixture',
      output: 'Found',
    });
  });
});
