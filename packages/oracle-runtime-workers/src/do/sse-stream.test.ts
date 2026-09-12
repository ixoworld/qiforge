import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { createSseTurnStream } from './sse-stream';

async function* fakeEvents(): AsyncGenerator<unknown> {
  yield {
    event: 'on_tool_start',
    run_id: 'run-1',
    name: 'list_capabilities',
    data: { input: { input: { includeOnDemand: true } } },
  };
  yield {
    event: 'on_tool_end',
    run_id: 'run-1',
    name: 'list_capabilities',
    data: {
      output: new ToolMessage({ content: '[]', tool_call_id: 'run-1' }),
    },
  };
  yield {
    event: 'on_chat_model_stream',
    run_id: 'run-2',
    data: { chunk: { content: 'Done.' } },
  };
}

describe('createSseTurnStream mirror', () => {
  it('mirrors tool_call / router_update frames to the session sockets, never message chunks', async () => {
    const mirrored: Array<{ name: string; payload: Record<string, unknown> }> =
      [];
    const stream = createSseTurnStream({
      events: fakeEvents(),
      sessionId: 's1',
      requestId: 'r1',
      abortController: new AbortController(),
      mirror: (name, payload) => mirrored.push({ name, payload }),
    });
    const sse = await new Response(stream).text();
    expect(sse).toContain('event: tool_call');
    const names = mirrored.map((m) => m.name);
    expect(names).toContain('router_update');
    expect(names.filter((n) => n === 'tool_call')).toHaveLength(2);
    expect(names).not.toContain('message');
    expect(names).not.toContain('done');
    for (const m of mirrored) expect(m.payload.sessionId).toBe('s1');
    const done = mirrored.find(
      (m) => m.name === 'tool_call' && m.payload.status === 'done',
    );
    expect(done?.payload.toolName).toBe('list_capabilities');
  });
});

async function* failingToolEvents(): AsyncGenerator<unknown> {
  yield {
    event: 'on_tool_start',
    run_id: 'run-9',
    name: 'search_memory_engine',
    data: { input: { input: { query: 'colour code' } } },
  };
  yield {
    event: 'on_tool_error',
    run_id: 'run-9',
    name: 'search_memory_engine',
    data: { error: new Error('memory engine returned HTTP 502') },
  };
}

describe('createSseTurnStream tool errors', () => {
  it('reports a thrown tool with its message instead of "did not complete"', async () => {
    const stream = createSseTurnStream({
      events: failingToolEvents(),
      sessionId: 's1',
      requestId: 'r1',
      abortController: new AbortController(),
    });
    const sse = await new Response(stream).text();
    expect(sse).toContain('⚠️ memory engine returned HTTP 502');
    expect(sse).not.toContain('Tool did not complete');
  });
});

async function* internalModelEvents(): AsyncGenerator<unknown> {
  // The summarization middleware's own model call, as streamEvents sees it.
  yield {
    event: 'on_chat_model_stream',
    run_id: 'run-sum',
    metadata: { lc_source: 'summarization' },
    data: {
      chunk: {
        content: 'Here is a summary of the conversation to date: the user…',
        additional_kwargs: {
          __raw_response: {
            choices: [{ delta: { reasoning: 'condensing the thread' } }],
          },
        },
      },
    },
  };
  // A sub-agent's inner turn (tagged by subagent-as-tool).
  yield {
    event: 'on_chat_model_stream',
    run_id: 'run-sub',
    tags: ['internal', 'subagent:firecrawl'],
    data: { chunk: { content: 'scraping example.com…' } },
  };
  // The main agent's reply.
  yield {
    event: 'on_chat_model_stream',
    run_id: 'run-main',
    metadata: { langgraph_node: 'model_request' },
    data: { chunk: { content: 'Your answer.' } },
  };
}

describe('createSseTurnStream internal model calls', () => {
  it('never streams the summarizer’s or a sub-agent’s tokens as message or reasoning frames', async () => {
    const stream = createSseTurnStream({
      events: internalModelEvents(),
      sessionId: 's1',
      requestId: 'r1',
      abortController: new AbortController(),
    });
    const sse = await new Response(stream).text();
    expect(sse).not.toContain('summary of the conversation');
    expect(sse).not.toContain('condensing the thread');
    expect(sse).not.toContain('scraping example.com');
    expect(sse).toContain('Your answer.');
    // The stream's own empty reasoning close frame is fine; no reasoning TEXT.
    const reasoningFrames = sse
      .split('\n\n')
      .filter((f) => f.startsWith('event: reasoning'))
      .map(
        (f) =>
          JSON.parse(f.slice(f.indexOf('data: ') + 6)) as {
            reasoning?: string;
          },
      );
    expect(reasoningFrames.every((f) => !f.reasoning)).toBe(true);
  });
});

async function* rejectedToolEvents(): AsyncGenerator<unknown> {
  yield {
    event: 'on_tool_start',
    run_id: 'run-7',
    name: 'create_task',
    data: {
      input: { input: { title: 'x', schedule: '2026-09-13T10:00:00Z' } },
    },
  };
  // ToolNode rejected the arguments: toolRetry's onFailure turned it into an
  // error ToolMessage — no on_tool_error, the tool never ran.
  yield {
    event: 'on_tool_end',
    run_id: 'run-7',
    name: 'create_task',
    data: {
      output: new ToolMessage({
        content:
          'Received tool input did not match expected schema: schedule expected object, received string',
        tool_call_id: 'run-7',
        name: 'create_task',
        status: 'error',
      }),
    },
  };
}

describe('createSseTurnStream rejected tool calls', () => {
  it('reports an error ToolMessage as status error with the message, not as done', async () => {
    const stream = createSseTurnStream({
      events: rejectedToolEvents(),
      sessionId: 's1',
      requestId: 'r1',
      abortController: new AbortController(),
    });
    const sse = await new Response(stream).text();
    const frames = sse
      .split('\n\n')
      .filter((f) => f.startsWith('event: tool_call'))
      .map(
        (f) =>
          JSON.parse(f.slice(f.indexOf('data: ') + 6)) as Record<
            string,
            unknown
          >,
      );
    const last = frames.at(-1);
    expect(last?.status).toBe('error');
    expect(String(last?.error)).toContain('did not match expected schema');
    expect(last?.toolName).toBe('create_task');
    expect(frames.some((f) => f.status === 'done')).toBe(false);
  });
});

async function* rejectedBeforeStartEvents(): AsyncGenerator<unknown> {
  // The model asked for create_task with a bad schedule. LangChain validates
  // the arguments before the tool's start callback, so no on_tool_* events
  // exist for the call; the tools node returns the error ToolMessage.
  yield {
    event: 'on_chat_model_end',
    run_id: 'run-m',
    data: {
      output: {
        tool_calls: [
          {
            id: 'call-1',
            name: 'create_task',
            args: { title: 'x', schedule: '2026-09-13T10:00:00Z' },
          },
        ],
      },
    },
  };
  yield { event: 'on_chain_start', run_id: 'run-t', name: 'tools', data: {} };
  yield {
    event: 'on_chain_end',
    run_id: 'run-t',
    name: 'tools',
    data: {
      output: {
        messages: [
          new ToolMessage({
            content:
              'Invalid arguments for create_task: Received tool input did not match expected schema. Check the tool’s parameter schema and call it again with corrected arguments.',
            tool_call_id: 'call-1',
            name: 'create_task',
            status: 'error',
          }),
        ],
      },
    },
  };
}

async function* startedThenHandledEvents(): AsyncGenerator<unknown> {
  // A normal call: on_tool_start/on_tool_end report it; the tools node's
  // output must not produce a second frame.
  yield {
    event: 'on_chat_model_end',
    run_id: 'run-m',
    data: {
      output: {
        tool_calls: [{ id: 'call-2', name: 'list_my_tasks', args: {} }],
      },
    },
  };
  yield {
    event: 'on_tool_start',
    run_id: 'run-2',
    name: 'list_my_tasks',
    data: { input: {} },
  };
  yield {
    event: 'on_tool_end',
    run_id: 'run-2',
    name: 'list_my_tasks',
    data: {
      output: new ToolMessage({
        content: '[]',
        tool_call_id: 'call-2',
        name: 'list_my_tasks',
      }),
    },
  };
  yield {
    event: 'on_chain_end',
    run_id: 'run-t',
    name: 'tools',
    data: {
      output: {
        messages: [
          new ToolMessage({
            content: '[]',
            tool_call_id: 'call-2',
            name: 'list_my_tasks',
          }),
        ],
      },
    },
  };
}

const toolCallFrames = (sse: string) =>
  sse
    .split('\n\n')
    .filter((f) => f.startsWith('event: tool_call'))
    .map(
      (f) =>
        JSON.parse(f.slice(f.indexOf('data: ') + 6)) as Record<string, unknown>,
    );

describe('createSseTurnStream calls rejected before the tool starts', () => {
  it('reports the rejected call as an error frame with its name and arguments', async () => {
    const stream = createSseTurnStream({
      events: rejectedBeforeStartEvents(),
      sessionId: 's1',
      requestId: 'r1',
      abortController: new AbortController(),
    });
    const frames = toolCallFrames(await new Response(stream).text());
    expect(frames).toHaveLength(1);
    expect(frames[0]?.status).toBe('error');
    expect(frames[0]?.toolName).toBe('create_task');
    expect((frames[0]?.args as Record<string, unknown>).schedule).toBe(
      '2026-09-13T10:00:00Z',
    );
    expect(String(frames[0]?.error)).toContain(
      'Invalid arguments for create_task',
    );
    expect(frames[0]?.eventId).toBe('call-1');
  });

  it('does not duplicate a call the tool events already reported', async () => {
    const stream = createSseTurnStream({
      events: startedThenHandledEvents(),
      sessionId: 's1',
      requestId: 'r1',
      abortController: new AbortController(),
    });
    const frames = toolCallFrames(await new Response(stream).text());
    expect(frames.map((f) => f.status)).toEqual(['isRunning', 'done']);
  });
});
