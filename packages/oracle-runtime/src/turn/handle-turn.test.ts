import { AIMessageChunk, ToolMessage } from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import { handleTurn } from './handle-turn.js';
import { TURN_FRAME_VERSION, type TurnFrame } from './turn-stream.js';

const SESSION_ID = 'sess-1';
const REQUEST_ID = 'req-1';

function toolStart(runId: string, name: string, input: unknown): unknown {
  return { event: 'on_tool_start', run_id: runId, name, data: { input } };
}

function toolEnd(runId: string, name: string, content: string): unknown {
  return {
    event: 'on_tool_end',
    run_id: runId,
    name,
    data: {
      output: new ToolMessage({ content, name, tool_call_id: runId }),
    },
  };
}

function chatChunk(content: string): unknown {
  return {
    event: 'on_chat_model_stream',
    run_id: 'chat-run',
    name: 'model',
    data: { chunk: new AIMessageChunk({ content }) },
  };
}

async function* streamOf(events: unknown[]): AsyncGenerator<unknown> {
  for (const evt of events) {
    yield evt;
  }
}

interface RecordingSink {
  frames: TurnFrame[];
  closes: Array<Error | undefined>;
  write: (frame: TurnFrame) => Promise<void>;
  close: (error?: Error) => Promise<void>;
}

function recordingSink(opts?: { writeDelayMs?: number }): RecordingSink {
  const frames: TurnFrame[] = [];
  const closes: Array<Error | undefined> = [];
  return {
    frames,
    closes,
    write: async (frame) => {
      if (opts?.writeDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.writeDelayMs));
      }
      // Snapshot at write time, exactly like a real transport serializing
      // to the wire — tool/action payload objects are intentionally mutated
      // in place across start→end (legacy wire behaviour), so a reference
      // capture would see the final state, not what was written.
      frames.push({
        ...frame,
        payload: JSON.parse(JSON.stringify(frame.payload)) as unknown,
      });
    },
    close: async (error) => {
      closes.push(error);
    },
  };
}

describe('handleTurn', () => {
  it('emits versioned frames with a monotonic sequence starting at 0', async () => {
    const sink = recordingSink();
    const result = await handleTurn({
      stream: streamOf([
        chatChunk('Hello'),
        toolStart('run-1', 'get_weather', { city: 'tokyo' }),
        toolEnd('run-1', 'get_weather', '{"ok":true}'),
        chatChunk(' world'),
      ]),
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      signal: new AbortController().signal,
      sink,
    });

    expect(sink.frames.map((f) => f.seq)).toEqual(sink.frames.map((_, i) => i));
    expect(sink.frames.every((f) => f.v === TURN_FRAME_VERSION)).toBe(true);
    // message, tool isRunning, tool done, message, completion marker.
    expect(sink.frames.map((f) => f.event)).toEqual([
      'message',
      'tool_call',
      'tool_call',
      'message',
      'reasoning',
    ]);
    expect(result.fullContent).toBe('Hello world');
    expect(result.aborted).toBe(false);
  });

  it('awaits every sink write, so a slow transport paces the loop without reordering', async () => {
    const sink = recordingSink({ writeDelayMs: 5 });
    await handleTurn({
      stream: streamOf([chatChunk('a'), chatChunk('b'), chatChunk('c')]),
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      signal: new AbortController().signal,
      sink,
    });
    const messages = sink.frames.filter((f) => f.event === 'message');
    expect(
      messages.map((f) => (f.payload as { content: string }).content),
    ).toEqual(['a', 'b', 'c']);
    expect(messages.map((f) => f.seq)).toEqual([0, 1, 2]);
  });

  it('flushes orphaned tool calls with a sentinel before the completion marker', async () => {
    const sink = recordingSink();
    await handleTurn({
      stream: streamOf([toolStart('run-9', 'slow_tool', { q: 'x' })]),
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      signal: new AbortController().signal,
      sink,
    });

    const [running, orphan, completion] = sink.frames;
    expect((running?.payload as { status: string }).status).toBe('isRunning');
    expect((orphan?.payload as { status: string }).status).toBe('done');
    expect((orphan?.payload as { output: string }).output).toContain(
      'did not complete',
    );
    expect(completion?.event).toBe('reasoning');
    expect((completion?.payload as { isComplete: boolean }).isComplete).toBe(
      true,
    );
  });

  it('an aborted turn stops mid-stream and writes NO trailing frames', async () => {
    const abortController = new AbortController();
    const sink = recordingSink();
    // Abort as a side effect of consuming the second envelope.
    async function* abortingStream(): AsyncGenerator<unknown> {
      yield chatChunk('first');
      abortController.abort();
      yield chatChunk('never-written');
    }

    const result = await handleTurn({
      stream: abortingStream(),
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      signal: abortController.signal,
      sink,
    });

    expect(result.aborted).toBe(true);
    // Only the first message frame — no second chunk, no orphan flush, no
    // completion marker: an aborted turn must not write trailing frames.
    expect(sink.frames.map((f) => f.event)).toEqual(['message']);
    expect(sink.closes).toEqual([undefined]);
  });

  it('closes the sink exactly once on success and once with the error on failure', async () => {
    const okSink = recordingSink();
    await handleTurn({
      stream: streamOf([chatChunk('fine')]),
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      signal: new AbortController().signal,
      sink: okSink,
    });
    expect(okSink.closes).toEqual([undefined]);

    const failSink = recordingSink();
    const boom = new Error('stream exploded');
    async function* failingStream(): AsyncGenerator<unknown> {
      yield chatChunk('partial');
      throw boom;
    }
    await expect(
      handleTurn({
        stream: failingStream(),
        sessionId: SESSION_ID,
        requestId: REQUEST_ID,
        signal: new AbortController().signal,
        sink: failSink,
      }),
    ).rejects.toThrow('stream exploded');
    expect(failSink.closes).toEqual([boom]);
  });

  it('routes AG-UI action names to action_call frames and decodes failures', async () => {
    const sink = recordingSink();
    await handleTurn({
      stream: streamOf([
        toolStart('run-a', 'update_chart', { series: [1] }),
        toolEnd('run-a', 'update_chart', '{"success":false,"error":"nope"}'),
      ]),
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      agActionNames: new Set(['update_chart']),
      signal: new AbortController().signal,
      sink,
    });

    expect(sink.frames.map((f) => f.event)).toEqual([
      'action_call',
      'action_call',
      'reasoning',
    ]);
    const done = sink.frames[1]?.payload as { status: string; error: string };
    expect(done.status).toBe('error');
    expect(done.error).toBe('nope');
  });

  it('propagates a sink write failure as a turn failure with close(error)', async () => {
    const closes: Array<Error | undefined> = [];
    const writeFailure = new Error('transport gone');
    const sink = {
      write: vi.fn().mockRejectedValue(writeFailure),
      close: async (error?: Error) => {
        closes.push(error);
      },
    };
    await expect(
      handleTurn({
        stream: streamOf([chatChunk('x')]),
        sessionId: SESSION_ID,
        requestId: REQUEST_ID,
        signal: new AbortController().signal,
        sink,
      }),
    ).rejects.toThrow('transport gone');
    expect(closes).toEqual([writeFailure]);
  });
});
