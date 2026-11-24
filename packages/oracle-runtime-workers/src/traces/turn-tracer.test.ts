import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { RunnableLambda, type RunnableConfig } from '@langchain/core/runnables';
import { tool } from '@langchain/core/tools';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import {
  interrupt,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ModelCallReporter } from '../core/model-call-reporter';
import { HarnessLimitError } from '../core/turn-budget';
import { turnModelUsageTotals, type ModelCallReport } from '../llm/model-call';
import { RUNTIME_VERSION } from './runtime-version';
import {
  RecordingModel,
  TEST_CONFIG,
  fakeIngest,
  quietLogger,
  record,
  tracerHarness,
  validStart,
  validTurn,
} from './test-helpers';
import { TurnTracer } from './turn-tracer';
import { traceSendStats } from './transport';

type State = { messages: BaseMessage[] };

const lookup = tool(async ({ q }: { q: string }) => `found ${q}`, {
  name: 'lookup',
  description: 'Look something up.',
  schema: z.object({ q: z.string() }),
});

const broken = tool(
  async (): Promise<string> => {
    throw new Error('D1_ERROR: overloaded');
  },
  {
    name: 'broken_tool',
    description: 'Always fails.',
    schema: z.object({}),
  },
);

/** A small agent: a named root, a nested chain, a model call and a tool call. */
function agentWith(
  body: (state: State, config: RunnableConfig) => Promise<State>,
) {
  return RunnableLambda.from(body).withConfig({ runName: 'Yo! Agent' });
}

const input = (): State => ({ messages: [new HumanMessage('hello there')] });

async function runTurn(
  h: ReturnType<typeof tracerHarness>,
  agent: ReturnType<typeof agentWith>,
  config: RunnableConfig = {},
): Promise<unknown> {
  let result: unknown;
  try {
    result = await agent.invoke(input(), {
      callbacks: [h.tracer],
      metadata: {
        user_did: 'did:ixo:ixo1testuser',
        thread_id: '$thread-1',
        client: 'channel',
      },
      ...config,
    });
  } catch (error) {
    result = error;
  }
  await awaitAllCallbacks();
  h.tracer.finish();
  await h.settle();
  return result;
}

function onlyTurn(h: ReturnType<typeof tracerHarness>) {
  const turns = h.ingest.turns();
  expect(turns).toHaveLength(1);
  return validTurn(turns[0]!.body);
}

describe('TurnTracer: what a turn collects', () => {
  it('sends one well-formed turn with nested runs, the start marker first', async () => {
    const h = tracerHarness();
    const model = new RecordingModel(record());
    const inner = RunnableLambda.from(
      async (state: State, config?: RunnableConfig) => {
        const reply = await model.invoke(state.messages, config);
        return { messages: [...state.messages, reply] };
      },
    ).withConfig({ runName: 'model_request' });
    const agent = agentWith(async (state, config) => {
      const next = await inner.invoke(state, config);
      await lookup.invoke({ q: 'x' }, config);
      return next;
    });
    await runTurn(h, agent);

    expect(h.ingest.received.map((r) => r.path)).toEqual([
      '/v1/ingest/turns/start',
      '/v1/ingest/turns',
    ]);
    const start = validStart(h.ingest.starts()[0]!.body);
    const turn = onlyTurn(h);
    expect(start.trace_id).toBe(turn.trace_id);
    // The marker's start_time is the turn's: it picks the index shard.
    expect(start.start_time).toBe(turn.start_time);
    expect(turn).toMatchObject({
      status: 'success',
      error: null,
      name: 'Yo! Agent',
      thread_id: '$thread-1',
      user_id: 'did:ixo:ixo1testuser',
      user_text: 'hello there',
      reply_text: 'Hi! How can I help?',
      metadata: {
        oracle_did: 'did:ixo:ixo1oracle',
        network: 'devnet',
        channel: 'whatsapp',
        runtime_version: RUNTIME_VERSION,
        request_id: 'req-1',
        served_model: 'openai/gpt-5.6-luna-20260709',
        fallback: 'false',
        // What LangSmith gets today rides along.
        user_did: 'did:ixo:ixo1testuser',
        client: 'channel',
      },
      usage: {
        input_tokens: 1200,
        cached_tokens: 800,
        output_tokens: 40,
        cost_usd: 0.0021,
      },
    });
    const byName = new Map(turn.runs.map((r) => [r.name, r]));
    const root = byName.get('Yo! Agent')!;
    const chain = byName.get('model_request')!;
    const llm = turn.runs.find((r) => r.run_type === 'llm')!;
    const toolRun = byName.get('lookup')!;
    expect(root.parent_run_id).toBeNull();
    expect(root.id).toBe(turn.trace_id);
    expect(chain.parent_run_id).toBe(root.id);
    expect(llm.parent_run_id).toBe(chain.id);
    expect(toolRun).toMatchObject({
      run_type: 'tool',
      parent_run_id: root.id,
      status: 'success',
    });
    expect(llm.dotted_order.startsWith(`${chain.dotted_order}.`)).toBe(true);
    expect(chain.dotted_order.startsWith(`${root.dotted_order}.`)).toBe(true);
    expect(llm).toMatchObject({
      prompt_tokens: 1200,
      completion_tokens: 40,
      total_tokens: 1240,
      total_cost: 0.0021,
      extra: {
        metadata: {
          served_model: 'openai/gpt-5.6-luna-20260709',
          fallback: false,
          usage_metadata: {
            input_tokens: 1200,
            output_tokens: 40,
            total_tokens: 1240,
          },
        },
      },
    });
    // Same headers on both requests; the turn is gzipped, the marker is not.
    const [startReq, turnReq] = h.ingest.received;
    expect(startReq!.headers['x-api-key']).toBe('ixt_w_testtest_secret');
    expect(startReq!.headers['content-encoding']).toBeUndefined();
    expect(turnReq!.headers['content-encoding']).toBe('gzip');
    expect(turnReq!.headers['content-type']).toBe('application/json');
  });

  it('marks a failed tool run as an error and keeps the turn a success', async () => {
    const h = tracerHarness();
    const agent = agentWith(async (state, config) => {
      await broken.invoke({}, config).catch(() => undefined);
      return state;
    });
    await runTurn(h, agent);
    const turn = onlyTurn(h);
    expect(turn.status).toBe('success');
    const failed = turn.runs.find((r) => r.name === 'broken_tool')!;
    expect(failed).toMatchObject({ run_type: 'tool', status: 'error' });
    expect(failed.error).toContain('D1_ERROR: overloaded');
  });

  it('reports a model fallback and the model that answered', async () => {
    const h = tracerHarness();
    const model = new RecordingModel(
      record({
        servedModel: 'anthropic/claude-sonnet-4.6',
        fallback: true,
        modelFallback: true,
      }),
    );
    const agent = agentWith(async (state, config) => ({
      messages: [...state.messages, await model.invoke(state.messages, config)],
    }));
    await runTurn(h, agent);
    const turn = onlyTurn(h);
    expect(turn.metadata).toMatchObject({
      served_model: 'anthropic/claude-sonnet-4.6',
      fallback: 'true',
    });
    const llm = turn.runs.find((r) => r.run_type === 'llm')!;
    expect(llm.extra).toMatchObject({
      metadata: { served_model: 'anthropic/claude-sonnet-4.6', fallback: true },
    });
  });

  it('keeps a failed model call and its record', async () => {
    const h = tracerHarness();
    const model = new RecordingModel(
      record({ outputTokens: 0, costUsd: 0.0004 }),
      { fail: true },
    );
    const agent = agentWith(async (state, config) => {
      await model.invoke(state.messages, config).catch(() => undefined);
      return state;
    });
    await runTurn(h, agent);
    const turn = onlyTurn(h);
    const llm = turn.runs.find((r) => r.run_type === 'llm')!;
    expect(llm).toMatchObject({ status: 'error', total_cost: 0.0004 });
    expect(turn.usage.cost_usd).toBe(0.0004);
  });

  it('sums the same usage onModelCall gets', async () => {
    const reports: ModelCallReport[] = [];
    const reporter = new ModelCallReporter(
      (call) => reports.push(call),
      quietLogger,
    );
    const h = tracerHarness();
    const first = new RecordingModel(
      record({
        promptTokens: 1000,
        cachedTokens: 600,
        outputTokens: 30,
        costUsd: 0.002,
      }),
    );
    const second = new RecordingModel(
      record({
        promptTokens: 1500,
        cachedTokens: 900,
        outputTokens: 50,
        costUsd: 0.003,
      }),
    );
    const agent = agentWith(async (state, config) => {
      await first.invoke(state.messages, config);
      return {
        messages: [
          ...state.messages,
          await second.invoke(state.messages, config),
        ],
      };
    });
    await runTurn(h, agent, { callbacks: [h.tracer, reporter] });
    const turn = onlyTurn(h);
    expect(reports).toHaveLength(2);
    const sum = (pick: (r: ModelCallReport) => number | undefined) =>
      reports.reduce((total, r) => total + (pick(r) ?? 0), 0);
    expect(turn.usage).toEqual({
      input_tokens: sum((r) => r.promptTokens),
      cached_tokens: sum((r) => r.cachedTokens),
      output_tokens: sum((r) => r.outputTokens),
      cost_usd: turnModelUsageTotals(reports).platformCostUsd,
    });
  });

  it('keeps parallel tool calls side by side under one parent', async () => {
    const h = tracerHarness();
    const agent = agentWith(async (state, config) => {
      await Promise.all([
        lookup.invoke({ q: 'a' }, config),
        lookup.invoke({ q: 'b' }, config),
        lookup.invoke({ q: 'c' }, config),
      ]);
      return state;
    });
    await runTurn(h, agent);
    const turn = onlyTurn(h);
    const tools = turn.runs.filter((r) => r.run_type === 'tool');
    expect(tools).toHaveLength(3);
    expect(new Set(tools.map((t) => t.parent_run_id))).toEqual(
      new Set([turn.trace_id]),
    );
    expect(new Set(tools.map((t) => t.id)).size).toBe(3);
  });

  it('sends a turn with no model call', async () => {
    const h = tracerHarness();
    const agent = agentWith(async (state, config) => {
      await lookup.invoke({ q: 'x' }, config);
      return state;
    });
    await runTurn(h, agent);
    const turn = onlyTurn(h);
    expect(turn.usage).toEqual({
      input_tokens: 0,
      cached_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    });
    expect(turn.metadata.fallback).toBe('false');
    expect(turn.metadata.served_model).toBeUndefined();
    expect(turn.reply_text).toBeNull();
  });

  it('collects no streamed tokens, only the first token time', async () => {
    const h = tracerHarness();
    const model = new FakeListChatModel({ responses: ['a streamed reply'] });
    const agent = agentWith(async (state, config) => {
      let text = '';
      for await (const chunk of await model.stream(state.messages, config))
        text += String(chunk.content);
      return { messages: [...state.messages, new HumanMessage(text)] };
    });
    await runTurn(h, agent);
    const turn = onlyTurn(h);
    const llm = turn.runs.find((r) => r.run_type === 'llm')!;
    expect(llm.events?.map((e) => e.name)).toEqual(['start', 'end']);
    expect(llm.first_token_time).toEqual(expect.any(String));
  });

  it('sends an aborted turn as interrupted', async () => {
    const controller = new AbortController();
    const h = tracerHarness({ signal: controller.signal });
    const agent = agentWith(async (state, config) => {
      await lookup.invoke({ q: 'x' }, config);
      controller.abort();
      config.signal?.throwIfAborted();
      return state;
    });
    await runTurn(h, agent, { signal: controller.signal });
    const turn = onlyTurn(h);
    expect(turn.status).toBe('interrupted');
  });

  it('sends a turn stopped by its time limit as an error', async () => {
    const controller = new AbortController();
    const h = tracerHarness({ signal: controller.signal });
    const agent = agentWith(async () => {
      const limit = new HarnessLimitError(
        'budget_exhausted',
        'time',
        'The turn reached its time limit.',
      );
      controller.abort(limit);
      throw limit;
    });
    await runTurn(h, agent);
    const turn = onlyTurn(h);
    expect(turn.status).toBe('error');
    expect(turn.error).toContain('The turn reached its time limit.');
  });

  it('sends a root that never ended as interrupted, its open runs pending', async () => {
    const h = tracerHarness({ finishGraceMs: 10 });
    // A stream abandoned mid-turn: LangChain started the runs and never ended them.
    const root = await h.tracer.handleChainStart(
      { lc: 1, type: 'not_implemented', id: ['Yo! Agent'] },
      { messages: [] },
      '0192f5d8-0000-7000-8000-000000000001',
      undefined,
      [],
      { user_did: 'did:ixo:ixo1testuser' },
      'chain',
      'Yo! Agent',
    );
    await h.tracer.handleToolStart(
      { lc: 1, type: 'not_implemented', id: ['lookup'] },
      '{"q":"x"}',
      '0192f5d8-0000-7000-8000-000000000002',
      root.id,
      [],
      {},
      'lookup',
    );
    h.tracer.finish();
    await h.settle();
    const turn = onlyTurn(h);
    expect(turn).toMatchObject({
      status: 'interrupted',
      error: null,
      reply_text: null,
    });
    expect(turn.runs.map((r) => [r.name, r.status, r.end_time])).toEqual([
      ['Yo! Agent', 'pending', null],
      ['lookup', 'pending', null],
    ]);
  });

  it('waits for a root that ends after finish (callbacks in the background)', async () => {
    const h = tracerHarness({ finishGraceMs: 2_000 });
    const runId = '0192f5d8-0000-7000-8000-000000000003';
    await h.tracer.handleChainStart(
      { lc: 1, type: 'not_implemented', id: ['Yo! Agent'] },
      { messages: [] },
      runId,
      undefined,
      [],
      {},
      'chain',
      'Yo! Agent',
    );
    h.tracer.finish();
    await h.tracer.handleChainEnd({ messages: [] }, runId);
    await h.settle();
    expect(onlyTurn(h).status).toBe('success');
  });

  it('sends each root of a turn as its own turn (the empty-reply nudge)', async () => {
    const h = tracerHarness();
    const agent = agentWith(async (state) => state);
    const config = { callbacks: [h.tracer] };
    await agent.invoke(input(), config);
    await agent.invoke(input(), config);
    await awaitAllCallbacks();
    h.tracer.finish();
    await h.settle();
    const turns = h.ingest.turns().map((t) => validTurn(t.body));
    expect(turns).toHaveLength(2);
    expect(turns[0]!.trace_id).not.toBe(turns[1]!.trace_id);
    expect(h.ingest.starts()).toHaveLength(2);
  });

  it('redacts signed links everywhere it sends them', async () => {
    const h = tracerHarness({
      userText: 'see https://r2.example/x?X-Amz-Signature=deadbeef01',
    });
    const leaky = tool(
      async () => 'https://r2.example/f?X-Amz-Signature=abcdef0123',
      {
        name: 'leaky',
        description: 'Returns a signed link.',
        schema: z.object({}),
      },
    );
    const agent = agentWith(async (state, config) => {
      await leaky.invoke({}, config);
      return state;
    });
    await runTurn(h, agent);
    const raw = JSON.stringify(h.ingest.turns()[0]!.body);
    expect(raw).not.toContain('abcdef0123');
    expect(raw).not.toContain('deadbeef01');
    expect(raw).toContain('X-Amz-Signature=[redacted]');
  });
});

describe('TurnTracer: never affects the turn', () => {
  it('returns the reply before the send completes, the send kept alive by waitUntil', async () => {
    let release: (r: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const ingest = fakeIngest((path) =>
      path === '/v1/ingest/turns' ? held : new Response(null, { status: 201 }),
    );
    const h = tracerHarness({}, ingest);
    const model = new RecordingModel(record());
    const agent = agentWith(async (state, config) => ({
      messages: [...state.messages, await model.invoke(state.messages, config)],
    }));
    const result = await agent.invoke(input(), { callbacks: [h.tracer] });
    await awaitAllCallbacks();
    h.tracer.finish();
    // The turn has its reply; the tracer handed its work to waitUntil.
    expect(result.messages).toHaveLength(2);
    expect(h.background.length).toBeGreaterThanOrEqual(2);
    let done = false;
    void h.tracer.settled().then(() => {
      done = true;
    });
    // Let the build and the fetch start, then check it is still in flight.
    for (let i = 0; i < 50 && ingest.turns().length === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ingest.turns()).toHaveLength(1);
    expect(done).toBe(false);
    release(new Response(null, { status: 201 }));
    await h.settle();
    expect(done).toBe(true);
  });

  it('throws nothing into the turn when everything around it fails', async () => {
    const failing = new TurnTracer({
      config: { apiKey: 'k', baseUrl: 'https://traces.test' },
      waitUntil: () => {
        throw new Error('waitUntil broke');
      },
      logger: {
        log: () => {
          throw new Error('log broke');
        },
        warn: () => {
          throw new Error('warn broke');
        },
        error: () => undefined,
      },
      threadId: 't',
      userId: 'u',
      finishGraceMs: 5,
      transport: {
        fetch: () => {
          throw new Error('fetch broke');
        },
      },
    });
    const model = new RecordingModel(record());
    const agent = agentWith(async (state, config) => ({
      messages: [...state.messages, await model.invoke(state.messages, config)],
    }));
    const result = await agent.invoke(input(), { callbacks: [failing] });
    await awaitAllCallbacks();
    expect(() => failing.finish()).not.toThrow();
    expect(result.messages).toHaveLength(2);
    await failing.settled();
  });

  it('counts and logs a failed send without content', async () => {
    const before = traceSendStats.failed;
    const ingest = fakeIngest(() => new Response('boom', { status: 503 }));
    const h = tracerHarness({ userText: 'my secret words' }, ingest);
    await runTurn(
      h,
      agentWith(async (state) => state),
    );
    expect(traceSendStats.failed).toBeGreaterThan(before);
    const joined = h.logs.join('\n');
    expect(joined).toContain('HTTP 503 after 2 attempts');
    expect(joined).not.toContain('my secret words');
    expect(joined).not.toContain('did:ixo:ixo1testuser');
    expect(joined).not.toContain('ixt_w_');
  });
});

describe('TurnTracer: the whole turn, once', () => {
  const report = (over: Partial<ModelCallReport>): ModelCallReport => ({
    ...record({
      promptTokens: 50,
      cachedTokens: 0,
      outputTokens: 3,
      costUsd: 0.0001,
    }),
    purpose: 'routing',
    callId: crypto.randomUUID(),
    startedAt: Date.now(),
    ...over,
  });

  it('adds the calls made outside its runs, never the title, never a run twice', async () => {
    const reports: ModelCallReport[] = [];
    const h = tracerHarness({ modelCalls: () => reports });
    // The router decided before the graph, and the meter reports every graph call too.
    reports.push(report({ purpose: 'routing' }));
    const model = new RecordingModel(record());
    const reporter = new ModelCallReporter(
      (call) => reports.push(call),
      quietLogger,
    );
    const agent = agentWith(async (state, config) => {
      const reply = await model.invoke(state.messages, config);
      return { messages: [...state.messages, reply] };
    });
    await runTurn(h, agent, { callbacks: [h.tracer, reporter] });
    // The title comes after the reply: not part of the trace.
    reports.push(report({ purpose: 'title', costUsd: 1 }));
    const turn = onlyTurn(h);
    expect(
      reports.filter((r) => r.purpose === 'reply' || r.purpose === 'other'),
    ).toHaveLength(1);
    expect(turn.usage.input_tokens).toBe(1200 + 50);
    expect(turn.usage.cost_usd).toBeCloseTo(0.0021 + 0.0001, 10);
    const outside = turn.runs.filter((r) => r.tags?.includes('outside_graph'));
    expect(outside.map((r) => r.name)).toEqual(['routing model call']);
    expect(turn.runs.filter((r) => r.run_type === 'llm')).toHaveLength(2);
  });

  it('never sends a root twice, also when its id comes back after the send', async () => {
    const h = tracerHarness();
    const agent = agentWith(async (state) => state);
    const runId = '0192f5d8-0000-7000-8000-0000000000aa';
    await agent.invoke(input(), { callbacks: [h.tracer], runId });
    await awaitAllCallbacks();
    h.tracer.finish();
    h.tracer.finish();
    await h.settle();
    // A resumed graph reusing the run id after the turn was sent.
    await agent.invoke(input(), { callbacks: [h.tracer], runId });
    await awaitAllCallbacks();
    await h.settle();
    expect(h.ingest.turns()).toHaveLength(1);
    expect(h.ingest.starts()).toHaveLength(1);
  });

  it('sends neither a marker nor a turn for a root without a usable id', async () => {
    const h = tracerHarness();
    await h.tracer.handleChainStart(
      { lc: 1, type: 'not_implemented', id: ['Yo! Agent'] },
      { messages: [] },
      '',
      undefined,
      [],
      {},
      'chain',
      'Yo! Agent',
    );
    await h.tracer.handleChainEnd({ messages: [] }, '');
    h.tracer.finish();
    await h.settle();
    expect(h.ingest.received).toEqual([]);
  });

  it('sends a valid turn for a graph stopped by interrupt()', async () => {
    const h = tracerHarness();
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('ask', () => {
        interrupt({ question: 'Which one?' });
        return {};
      })
      .addEdge(START, 'ask')
      .compile({ checkpointer: new MemorySaver(), name: 'Yo! Agent' });
    await graph.invoke(input(), {
      callbacks: [h.tracer],
      configurable: { thread_id: 't-interrupt' },
    });
    await awaitAllCallbacks();
    h.tracer.finish();
    await h.settle();
    const turn = onlyTurn(h);
    expect(turn.runs.length).toBeGreaterThan(1);
    expect(turn.runs[0]!.id).toBe(turn.trace_id);
  });

  it('does not send the marker once its turn went (the turn replaces it)', async () => {
    let releaseMarker: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const ingest = fakeIngest();
    const fetch: typeof ingest.fetch = async (url, init) => {
      if (url.endsWith('/start')) await held;
      return ingest.fetch(url, init);
    };
    const owner = {};
    const h = tracerHarness(
      { owner, transport: { fetch, sleep: async () => undefined } },
      ingest,
    );
    // An earlier marker of this owner is still in flight: this turn's waits.
    const blocker = new TurnTracer({
      config: TEST_CONFIG,
      waitUntil: () => undefined,
      logger: quietLogger,
      owner,
      threadId: '$t',
      userId: 'did:ixo:ixo1x',
      transport: { fetch, sleep: async () => undefined },
    });
    await agentWith(async (s) => s).invoke(input(), { callbacks: [blocker] });
    await agentWith(async (s) => s).invoke(input(), { callbacks: [h.tracer] });
    await awaitAllCallbacks();
    h.tracer.finish();
    for (let i = 0; i < 200 && h.ingest.turns().length === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.ingest.turns()).toHaveLength(1);
    releaseMarker();
    await h.settle();
    blocker.finish();
    await blocker.settled();
    // Only the blocker's marker reached the service; this turn's was skipped.
    expect(h.ingest.starts()).toHaveLength(1);
    expect(h.ingest.starts()[0]!.body.trace_id).not.toBe(
      h.ingest.turns()[0]!.body.trace_id,
    );
  });
});
