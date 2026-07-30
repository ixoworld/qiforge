import type { StreamEvent } from '@langchain/core/tracers/log_stream';
import type { Response } from 'express';
import { AIMessageChunk, ToolMessage } from 'langchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBuilder } from './agent-builder.js';
import type { SendMessagePayload } from './dto/send-message.dto.js';
import { SseStreamRunner, type StreamRunInput } from './sse-stream-runner.js';
import {
  type FakeAgent,
  makeFakeAgent,
  makeThrowingFakeAgent,
} from './__test-fixtures__/fake-agent.js';
import { FakeResponse } from './__test-fixtures__/fake-response.js';
import { makePrepared } from './__test-fixtures__/deps.js';

const SESSION_ID = 'sess-1';
const REQUEST_ID = 'req-1';

function makeAgentBuilder(agent: FakeAgent): AgentBuilder {
  return {
    build: vi.fn().mockResolvedValue({
      agent,
      stateInput: {},
      langGraphConfig: { version: 'v2' },
    }),
  } as unknown as AgentBuilder;
}

function makePayload(
  overrides: Partial<StreamRunInput['payload']> = {},
): StreamRunInput['payload'] {
  const base: SendMessagePayload = {
    sessionId: SESSION_ID,
    did: 'did:ixo:user-1',
    message: 'hello',
  };
  return { ...base, ...overrides };
}

function makeInput(
  agent: FakeAgent,
  res: FakeResponse,
  overrides: Partial<StreamRunInput> = {},
): { input: StreamRunInput; runner: SseStreamRunner } {
  const agentBuilder = makeAgentBuilder(agent);
  const runner = new SseStreamRunner(agentBuilder);
  const input: StreamRunInput = {
    payload: makePayload(overrides.payload),
    prepared: makePrepared(),
    inputMessages: [],
    res: res as unknown as Response,
    abortControllers: new Map<string, AbortController>(),
    ...overrides,
  };
  return { input, runner };
}

function toolStartEvent(
  runId: string,
  name: string,
  input: unknown,
): StreamEvent {
  return {
    event: 'on_tool_start',
    run_id: runId,
    name,
    data: { input },
  } as unknown as StreamEvent;
}

function toolEndEvent(runId: string, output: ToolMessage): StreamEvent {
  return {
    event: 'on_tool_end',
    run_id: runId,
    name: output.name ?? 'tool',
    data: { output },
  } as unknown as StreamEvent;
}

function chatStreamEvent(
  content: string,
  extras: { reasoning?: string; reasoning_details?: unknown } = {},
): StreamEvent {
  const additional_kwargs: Record<string, unknown> = {};
  if (
    extras.reasoning !== undefined ||
    extras.reasoning_details !== undefined
  ) {
    additional_kwargs.__raw_response = {
      choices: [
        {
          delta: {
            ...(extras.reasoning !== undefined && {
              reasoning: extras.reasoning,
            }),
            ...(extras.reasoning_details !== undefined && {
              reasoning_details: extras.reasoning_details,
            }),
          },
        },
      ],
    };
  }
  const chunk = new AIMessageChunk({
    content,
    additional_kwargs,
  });
  return {
    event: 'on_chat_model_stream',
    run_id: 'chat-run',
    name: 'model',
    data: { chunk },
  } as unknown as StreamEvent;
}

function eventsFromWrites(
  writes: string[],
): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  for (const chunk of writes) {
    if (chunk.startsWith(': heartbeat')) continue;
    const eventMatch = /^event: (.+)$/m.exec(chunk);
    const dataMatch = /^data: (.+)$/m.exec(chunk);
    if (!eventMatch || !dataMatch) continue;
    events.push({
      event: eventMatch[1]!,
      data: JSON.parse(dataMatch[1]!) as unknown,
    });
  }
  return events;
}

describe('SseStreamRunner', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('headers + lifecycle', () => {
    it('sets SSE headers via setSSEHeaders + flushHeaders when !headersSent', async () => {
      const res = new FakeResponse();
      const { input, runner } = makeInput(makeFakeAgent([]), res);

      await runner.run(input);

      expect(res.headersSent).toBe(true);
      expect(res.setHeaders['Content-Type']).toBe('text/event-stream');
      expect(res.setHeaders['Cache-Control']).toBe('no-cache, no-transform');
      expect(res.setHeaders.Connection).toBe('keep-alive');
      expect(res.setHeaders['X-Request-Id']).toBe(REQUEST_ID);
      expect(res.setHeaders['Access-Control-Expose-Headers']).toBe(
        'X-Request-Id',
      );
    });

    it('skips setSSEHeaders when controller already sent headers', async () => {
      const res = new FakeResponse();
      res.headersSent = true;
      const { input, runner } = makeInput(makeFakeAgent([]), res);

      await runner.run(input);

      expect(res.setHeaders['Content-Type']).toBeUndefined();
      expect(res.setHeaders['X-Request-Id']).toBeUndefined();
    });

    it('starts the 15s heartbeat', async () => {
      vi.useFakeTimers();
      const res = new FakeResponse();
      // Stall the agent build so the heartbeat interval has time to fire
      // before run() resolves.
      let releaseBuild: () => void = () => undefined;
      const agentBuilder = {
        build: vi.fn(
          () =>
            new Promise((resolve) => {
              releaseBuild = () =>
                resolve({
                  agent: makeFakeAgent([]),
                  stateInput: {},
                  langGraphConfig: { version: 'v2' },
                });
            }),
        ),
      } as unknown as AgentBuilder;
      const runner = new SseStreamRunner(agentBuilder);
      const runPromise = runner.run({
        payload: makePayload(),
        prepared: makePrepared(),
        inputMessages: [],
        res: res as unknown as Response,
        abortControllers: new Map(),
      });

      await Promise.resolve();
      vi.advanceTimersByTime(15_000);

      expect(res.writes.some((w) => w.startsWith(': heartbeat'))).toBe(true);

      releaseBuild();
      vi.useRealTimers();
      await runPromise;
    });

    it('clears heartbeat in finally on clean finish', async () => {
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      const res = new FakeResponse();
      const { input, runner } = makeInput(makeFakeAgent([]), res);

      await runner.run(input);

      expect(clearSpy).toHaveBeenCalled();
    });

    it('clears heartbeat in finally on throw', async () => {
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      const res = new FakeResponse();
      const { input, runner } = makeInput(
        makeThrowingFakeAgent(new Error('boom')),
        res,
      );

      await runner.run(input);

      expect(clearSpy).toHaveBeenCalled();
    });

    it('calls res.end() in finally when !writableEnded', async () => {
      const res = new FakeResponse();
      const { input, runner } = makeInput(makeFakeAgent([]), res);

      await runner.run(input);

      expect(res.writableEnded).toBe(true);
    });

    it('does not call res.end() when writableEnded=true (idempotency)', async () => {
      const res = new FakeResponse();
      const endSpy = vi.spyOn(res, 'end');
      // Pre-end the response — the runner's finally must skip end().
      res.end();
      endSpy.mockClear();
      const { input, runner } = makeInput(makeFakeAgent([]), res);

      await runner.run(input);

      expect(endSpy).not.toHaveBeenCalled();
    });

    it("removes the 'close' listener in finally", async () => {
      const res = new FakeResponse();
      const { input, runner } = makeInput(makeFakeAgent([]), res);

      await runner.run(input);

      expect(res.listenerCount('close')).toBe(0);
    });
  });

  describe('AbortController registry', () => {
    it('registers controller under sessionId in abortControllers map', async () => {
      const res = new FakeResponse();
      const abortControllers = new Map<string, AbortController>();
      let observed: AbortController | undefined;
      const agentBuilder = {
        build: vi.fn(async (_args, controller?: AbortController) => {
          observed = abortControllers.get(SESSION_ID);
          return {
            agent: makeFakeAgent([]),
            stateInput: { _ctrl: controller },
            langGraphConfig: { version: 'v2' },
          };
        }),
      } as unknown as AgentBuilder;
      const runner = new SseStreamRunner(agentBuilder);
      await runner.run({
        payload: makePayload(),
        prepared: makePrepared(),
        inputMessages: [],
        res: res as unknown as Response,
        abortControllers,
      });

      expect(observed).toBeInstanceOf(AbortController);
    });

    it('aborts any existing controller for same sessionId before registering', async () => {
      const res = new FakeResponse();
      const existing = new AbortController();
      const abortControllers = new Map<string, AbortController>([
        [SESSION_ID, existing],
      ]);
      const { input, runner } = makeInput(makeFakeAgent([]), res, {
        abortControllers,
      });

      await runner.run(input);

      expect(existing.signal.aborted).toBe(true);
    });

    it('deletes controller from map in finally', async () => {
      const res = new FakeResponse();
      const abortControllers = new Map<string, AbortController>();
      const { input, runner } = makeInput(makeFakeAgent([]), res, {
        abortControllers,
      });

      await runner.run(input);

      expect(abortControllers.has(SESSION_ID)).toBe(false);
    });

    it("res 'close' event aborts the controller", async () => {
      const res = new FakeResponse();
      const abortControllers = new Map<string, AbortController>();
      let captured: AbortController | undefined;
      const agentBuilder = {
        build: vi.fn(async () => {
          captured = abortControllers.get(SESSION_ID);
          res.emit('close');
          return {
            agent: makeFakeAgent([]),
            stateInput: {},
            langGraphConfig: { version: 'v2' },
          };
        }),
      } as unknown as AgentBuilder;
      const runner = new SseStreamRunner(agentBuilder);
      await runner.run({
        payload: makePayload(),
        prepared: makePrepared(),
        inputMessages: [],
        res: res as unknown as Response,
        abortControllers,
      });

      expect(captured?.signal.aborted).toBe(true);
    });
  });

  describe('event loop translation', () => {
    it('does not emit the initial thinking event — MessagesService flushes it before run()', async () => {
      const res = new FakeResponse();
      // Empty agent — only the completion marker + done should land; the
      // instant "Thinking..." ack is owned by MessagesService.openStream so
      // it reaches the client before ANY pre-flight work, not here.
      const { input, runner } = makeInput(makeFakeAgent([]), res);

      await runner.run(input);

      const events = eventsFromWrites(res.writes);
      expect(events).toHaveLength(2);
      expect(events[0]?.event).toBe('reasoning');
      expect((events[0]?.data as { isComplete: boolean }).isComplete).toBe(
        true,
      );
      expect(events[1]?.event).toBe('done');
    });

    it('on_tool_start (non-action) emits ToolCallEvent isRunning keyed by run_id', async () => {
      const res = new FakeResponse();
      const { input, runner } = makeInput(
        makeFakeAgent([
          toolStartEvent('run-A', 'searchWeb', { query: 'cats' }),
        ]),
        res,
      );

      await runner.run(input);

      const events = eventsFromWrites(res.writes);
      const toolStart = events.find((e) => e.event === 'tool_call');
      expect(toolStart).toBeDefined();
      const payload = toolStart!.data as {
        status: string;
        eventId: string;
        toolName: string;
        args: { query: string; toolName: string };
      };
      expect(payload.status).toBe('isRunning');
      expect(payload.eventId).toBe('run-A');
      expect(payload.toolName).toBe('searchWeb');
      expect(payload.args.query).toBe('cats');
      expect(payload.args.toolName).toBe('searchWeb');
    });

    it('on_tool_start matching agActions name emits ActionCallEvent isRunning', async () => {
      const res = new FakeResponse();
      const { input, runner } = makeInput(
        makeFakeAgent([toolStartEvent('run-B', 'doThing', { x: 1 })]),
        res,
        {
          payload: makePayload({
            agActions: [{ name: 'doThing', description: 'd', schema: {} }],
          }),
        },
      );

      await runner.run(input);

      const events = eventsFromWrites(res.writes);
      const action = events.find((e) => e.event === 'action_call');
      expect(action).toBeDefined();
      const data = action!.data as {
        status: string;
        toolCallId: string;
        toolName: string;
        args: { x: number };
      };
      expect(data.status).toBe('isRunning');
      expect(data.toolCallId).toBe('run-B');
      expect(data.toolName).toBe('doThing');
      expect(data.args.x).toBe(1);
    });

    it('on_tool_end same run_id emits matching ToolCallEvent done', async () => {
      const res = new FakeResponse();
      const { input, runner } = makeInput(
        makeFakeAgent([
          toolStartEvent('run-C', 'lookup', { q: 'x' }),
          toolEndEvent(
            'run-C',
            new ToolMessage({
              content: 'result',
              tool_call_id: 'run-C',
              name: 'lookup',
            }),
          ),
        ]),
        res,
      );

      await runner.run(input);

      const events = eventsFromWrites(res.writes).filter(
        (e) => e.event === 'tool_call',
      );
      expect(events).toHaveLength(2);
      const done = events[1]!.data as {
        status: string;
        output: string;
        eventId: string;
        args: { toolName: string };
      };
      expect(done.status).toBe('done');
      expect(done.output).toBe('result');
      expect(done.eventId).toBe('run-C');
      expect(done.args.toolName).toBe('lookup');
    });

    it('on_tool_end for action with success:false sets status=error + error message', async () => {
      const res = new FakeResponse();
      const errorBody = JSON.stringify({ success: false, error: 'nope' });
      const { input, runner } = makeInput(
        makeFakeAgent([
          toolStartEvent('run-D', 'doThing', {}),
          toolEndEvent(
            'run-D',
            new ToolMessage({
              content: errorBody,
              tool_call_id: 'run-D',
              name: 'doThing',
            }),
          ),
        ]),
        res,
        {
          payload: makePayload({
            agActions: [{ name: 'doThing', description: 'd', schema: {} }],
          }),
        },
      );

      await runner.run(input);

      const actions = eventsFromWrites(res.writes).filter(
        (e) => e.event === 'action_call',
      );
      expect(actions).toHaveLength(2);
      const end = actions[1]!.data as { status: string; error: string };
      expect(end.status).toBe('error');
      expect(end.error).toBe('nope');
    });

    it('on_tool_start without matching on_tool_end flushes a terminal event at end of stream (orphan flush)', async () => {
      const res = new FakeResponse();
      const { input, runner } = makeInput(
        makeFakeAgent([
          toolStartEvent('lonely', 'search', { q: 'x' }),
          // no matching on_tool_end — stream ends with the tool still "running"
        ]),
        res,
      );

      await runner.run(input);

      const toolEvents = eventsFromWrites(res.writes).filter(
        (e) => e.event === 'tool_call',
      );
      // Two writes: initial isRunning from on_tool_start, then synthetic
      // terminal flush so the FE clears its spinner. Tool-call status type
      // is 'isRunning' | 'done' — no 'error' variant, so we use 'done' with
      // a sentinel output.
      expect(toolEvents).toHaveLength(2);
      const start = toolEvents[0]!.data as { status: string };
      const end = toolEvents[1]!.data as {
        status: string;
        eventId: string;
        output: string;
      };
      expect(start.status).toBe('isRunning');
      expect(end.status).toBe('done');
      expect(end.eventId).toBe('lonely');
      expect(end.output).toMatch(/did not complete/i);
    });

    it('on_tool_start (action) without matching end emits synthetic error at end of stream', async () => {
      const res = new FakeResponse();
      const { input, runner } = makeInput(
        makeFakeAgent([
          toolStartEvent('lost-action', 'declareIntent', { intent: 'x' }),
        ]),
        res,
        {
          payload: makePayload({
            agActions: [
              { name: 'declareIntent', description: 'd', schema: {} },
            ],
          }),
        },
      );

      await runner.run(input);

      const actionEvents = eventsFromWrites(res.writes).filter(
        (e) => e.event === 'action_call',
      );
      expect(actionEvents).toHaveLength(2);
      const flushed = actionEvents[1]!.data as {
        status: string;
        error: string;
        toolCallId: string;
      };
      expect(flushed.status).toBe('error');
      expect(flushed.error).toBe('Action did not complete');
      expect(flushed.toolCallId).toBe('lost-action');
    });

    it('on_tool_end for unknown run_id silently ignored (orphan tolerance)', async () => {
      const res = new FakeResponse();
      const { input, runner } = makeInput(
        makeFakeAgent([
          toolEndEvent(
            'orphan',
            new ToolMessage({
              content: 'lost',
              tool_call_id: 'orphan',
              name: 'ghost',
            }),
          ),
        ]),
        res,
      );

      await runner.run(input);

      const toolEvents = eventsFromWrites(res.writes).filter(
        (e) => e.event === 'tool_call' || e.event === 'action_call',
      );
      expect(toolEvents).toHaveLength(0);
    });

    it('on_chat_model_stream content chunks emit message events + accumulate text', async () => {
      const res = new FakeResponse();
      const seen: string[] = [];
      const { input, runner } = makeInput(
        makeFakeAgent([chatStreamEvent('hello '), chatStreamEvent('world')]),
        res,
        {
          onComplete: (text) => seen.push(text),
        },
      );

      await runner.run(input);

      const messages = eventsFromWrites(res.writes).filter(
        (e) => e.event === 'message',
      );
      expect(messages).toHaveLength(2);
      expect((messages[0]!.data as { content: string }).content).toBe('hello ');
      expect((messages[1]!.data as { content: string }).content).toBe('world');
      expect(seen).toEqual(['hello world']);
    });

    it('on_chat_model_stream reasoning_details emits ReasoningEvent (chunk)', async () => {
      const res = new FakeResponse();
      const { input, runner } = makeInput(
        makeFakeAgent([
          chatStreamEvent('', {
            reasoning: 'because',
            reasoning_details: [{ type: 'text', text: 'because' }],
          }),
        ]),
        res,
      );

      await runner.run(input);

      // The chunk reasoning is the first reasoning event (isComplete=false,
      // with our details) — the terminal completion marker follows it. The
      // "thinking" greeting is emitted upstream by MessagesService, not here.
      const reasonings = eventsFromWrites(res.writes).filter(
        (e) => e.event === 'reasoning',
      );
      expect(reasonings.length).toBeGreaterThanOrEqual(2);
      const chunk = reasonings[0]!.data as {
        reasoning: string;
        isComplete: boolean;
        reasoningDetails?: Array<{ type: string; text: string }>;
      };
      expect(chunk.reasoning).toBe('because');
      expect(chunk.isComplete).toBe(false);
      expect(chunk.reasoningDetails).toEqual([
        { type: 'text', text: 'because' },
      ]);
    });

    it('Responses-mode chunks (array content) emit reasoning + text events', async () => {
      const res = new FakeResponse();
      const responsesChunk = (
        content: Array<Record<string, unknown>>,
      ): StreamEvent =>
        ({
          event: 'on_chat_model_stream',
          run_id: 'chat-run',
          name: 'model',
          data: { chunk: new AIMessageChunk({ content }) },
        }) as unknown as StreamEvent;
      const { input, runner } = makeInput(
        makeFakeAgent([
          responsesChunk([
            { type: 'reasoning', reasoning: 'thinking hard', index: 0 },
          ]),
          responsesChunk([{ type: 'text', text: 'the answer', index: 0 }]),
        ]),
        res,
      );

      await runner.run(input);

      const events = eventsFromWrites(res.writes);
      const reasonings = events.filter((e) => e.event === 'reasoning');
      expect((reasonings[0]!.data as { reasoning: string }).reasoning).toBe(
        'thinking hard',
      );
      const messages = events.filter((e) => e.event === 'message');
      expect(messages).toHaveLength(1);
      expect((messages[0]!.data as { content: string }).content).toBe(
        'the answer',
      );
    });

    it('terminal ReasoningEvent(complete=true) + done emitted on clean finish', async () => {
      const res = new FakeResponse();
      const { input, runner } = makeInput(
        makeFakeAgent([chatStreamEvent('hi')]),
        res,
      );

      await runner.run(input);

      const events = eventsFromWrites(res.writes);
      const last = events[events.length - 1]!;
      const secondLast = events[events.length - 2]!;
      expect(last.event).toBe('done');
      expect(secondLast.event).toBe('reasoning');
      expect((secondLast.data as { isComplete: boolean }).isComplete).toBe(
        true,
      );
    });

    it('calls onComplete with assembled assistantText on clean finish', async () => {
      const res = new FakeResponse();
      const onComplete = vi.fn();
      const { input, runner } = makeInput(
        makeFakeAgent([chatStreamEvent('foo'), chatStreamEvent(' bar')]),
        res,
        { onComplete },
      );

      await runner.run(input);

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith('foo bar');
    });

    it('skips onComplete + completion event when controller aborted mid-stream', async () => {
      const res = new FakeResponse();
      const abortControllers = new Map<string, AbortController>();
      const onComplete = vi.fn();
      // Build an agent that flips the controller's signal between events.
      const abortBetweenAgent: FakeAgent = {
        async *streamEvents() {
          yield chatStreamEvent('partial');
          // Flip the active controller's abort signal between events; the
          // for-await guard in the runner breaks at the next iteration.
          abortControllers.get(SESSION_ID)?.abort();
          await Promise.resolve();
          yield chatStreamEvent('never');
        },
        async invoke() {
          return { messages: [] };
        },
      };
      const { input, runner } = makeInput(abortBetweenAgent, res, {
        abortControllers,
        onComplete,
      });

      await runner.run(input);

      expect(onComplete).not.toHaveBeenCalled();
      const events = eventsFromWrites(res.writes);
      const completion = events.find(
        (e) =>
          e.event === 'reasoning' &&
          (e.data as { isComplete?: boolean }).isComplete === true,
      );
      expect(completion).toBeUndefined();
      expect(events.find((e) => e.event === 'done')).toBeUndefined();
    });
  });

  describe('writableEnded guards', () => {
    it('skips res.write once writableEnded becomes true mid-stream', async () => {
      const res = new FakeResponse();
      const flipAgent: FakeAgent = {
        async *streamEvents() {
          yield chatStreamEvent('first');
          res.end();
          yield chatStreamEvent('second');
        },
        async invoke() {
          return { messages: [] };
        },
      };
      const { input, runner } = makeInput(flipAgent, res);

      await runner.run(input);

      const messages = eventsFromWrites(res.writes).filter(
        (e) => e.event === 'message',
      );
      // Only the first chunk made it onto the wire — the second is silently
      // dropped because writableEnded is true.
      expect(messages).toHaveLength(1);
      expect((messages[0]!.data as { content: string }).content).toBe('first');
    });

    it('skips res.write when abortController already aborted', async () => {
      const res = new FakeResponse();
      const abortControllers = new Map<string, AbortController>();
      const flipAgent: FakeAgent = {
        async *streamEvents() {
          // Abort before the very first chunk is emitted — the writeSse guard
          // must drop the chunk, but the runner is still free to loop until
          // the next iteration checks the signal.
          abortControllers.get(SESSION_ID)?.abort();
          yield chatStreamEvent('dropped');
        },
        async invoke() {
          return { messages: [] };
        },
      };
      const { input, runner } = makeInput(flipAgent, res, {
        abortControllers,
      });

      await runner.run(input);

      const messages = eventsFromWrites(res.writes).filter(
        (e) => e.event === 'message',
      );
      expect(messages).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('AbortError caught -> emits done only (no error)', async () => {
      const res = new FakeResponse();
      const abortErr = new Error('AbortError');
      abortErr.name = 'AbortError';
      const { input, runner } = makeInput(makeThrowingFakeAgent(abortErr), res);

      await runner.run(input);

      const events = eventsFromWrites(res.writes);
      expect(events.some((e) => e.event === 'error')).toBe(false);
      expect(events.some((e) => e.event === 'done')).toBe(true);
    });

    it('non-abort error caught -> emits error then done', async () => {
      const res = new FakeResponse();
      const { input, runner } = makeInput(
        makeThrowingFakeAgent(new Error('boom')),
        res,
      );

      await runner.run(input);

      const events = eventsFromWrites(res.writes);
      const errIdx = events.findIndex((e) => e.event === 'error');
      const doneIdx = events.findIndex((e) => e.event === 'done');
      expect(errIdx).toBeGreaterThanOrEqual(0);
      expect(doneIdx).toBeGreaterThan(errIdx);
      expect((events[errIdx]!.data as { error: string }).error).toBe('boom');
    });

    it('error AFTER res.writableEnded -> emits nothing (no double-end)', async () => {
      const res = new FakeResponse();
      let writesAtEnd = 0;
      const flipAgent: FakeAgent = {
        // Generator throws before yielding anything — that's the whole
        // scenario. The empty `yield` keeps the generator-shape contract
        // satisfied (require-yield) and is unreachable past the throw.
        async *streamEvents() {
          res.end();
          writesAtEnd = res.writes.length;
          throw new Error('after-end');
          yield;
        },
        async invoke() {
          return { messages: [] };
        },
      };
      const { input, runner } = makeInput(flipAgent, res);

      await runner.run(input);

      // After res.end(), every helper (sendSSEError, sendSSEDone, res.write
      // via writeSse) no-ops on writableEnded — the buffer must be frozen
      // at the snapshot taken immediately after end().
      expect(res.writes.length).toBe(writesAtEnd);
    });
  });
});
