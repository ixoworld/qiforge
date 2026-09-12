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

describe('terminal cleanup', () => {
  it('settles an in-flight action when the turn is aborted', async () => {
    const controller = new AbortController();
    async function* events() {
      yield {
        event: 'on_tool_start',
        run_id: 'action',
        name: 'send',
        data: { input: {} },
      };
      controller.abort();
    }
    const stream = createSseTurnStream({
      events: events(),
      sessionId: 's',
      requestId: 'r',
      abortController: controller,
      agActionNames: new Set(['send']),
    });
    const text = await new Response(stream).text();
    expect(text).toContain('"status":"error"');
    expect(text.match(/event: done/g)).toHaveLength(1);
  });
});
