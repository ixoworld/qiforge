import { describe, expect, it } from 'vitest';
import { streamRun, StreamRunStartError, withRequestId } from './run-stream.js';
import type { SSEEvent } from './sse-parser.js';

function sse(
  frames: Array<{ event: string; id?: number; data: unknown }>,
): string {
  return frames
    .map(
      (f) =>
        `event: ${f.event}\n${f.id !== undefined ? `id: ${f.id}\n` : ''}data: ${JSON.stringify(f.data)}\n\n`,
    )
    .join('');
}

function response(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) },
  });
}

const runFrame = (runId: string, id = 1) => ({
  event: 'run',
  id,
  data: { runId, sessionId: 's', requestId: 'r' },
});
const msg = (id: number, content: string) => ({
  event: 'message',
  id,
  data: { content, timestamp: 't' },
});
const done = (id: number, extra: Record<string, unknown> = {}) => ({
  event: 'done',
  id,
  data: { runId: 'run-1', ...extra },
});

describe('streamRun', () => {
  it('reads a complete stream to its done frame', async () => {
    const events: SSEEvent[] = [];
    const result = await streamRun({
      start: async () =>
        response(
          sse([runFrame('run-1'), msg(2, 'hi '), msg(3, 'there'), done(4)]),
          {
            headers: { 'x-request-id': 'req-1', 'x-run-id': 'run-1' },
          },
        ),
      join: async () => {
        throw new Error('must not re-join a complete stream');
      },
      onEvent: (e) => {
        events.push(e);
      },
    });
    expect(result).toMatchObject({
      requestId: 'req-1',
      runId: 'run-1',
      ended: 'done',
      lastId: 4,
      text: 'hi there',
    });
    expect(events.map((e) => e.event)).toEqual([
      'run',
      'message',
      'message',
      'done',
    ]);
  });

  it('re-joins after a drop with the last id and never repeats the POST', async () => {
    let starts = 0;
    const joins: number[] = [];
    const disconnects: number[] = [];
    const result = await streamRun({
      start: async () => {
        starts += 1;
        return response(sse([runFrame('run-1'), msg(2, 'part one ')]), {
          headers: { 'x-run-id': 'run-1' },
        });
      },
      join: async (runId, after) => {
        joins.push(after);
        expect(runId).toBe('run-1');
        if (joins.length === 1) return response(sse([msg(3, 'part two ')])); // drops again
        return response(
          sse([msg(4, 'part three'), done(5, { messageId: 'm1' })]),
        );
      },
      onEvent: () => undefined,
      onDisconnect: ({ attempt }) => disconnects.push(attempt),
      rejoinDelayMs: () => 1,
    });
    expect(starts).toBe(1);
    expect(joins).toEqual([2, 3]);
    expect(disconnects).toEqual([1, 2]);
    expect(result.ended).toBe('done');
    expect(result.text).toBe('part one part two part three');
    expect(result.done).toMatchObject({ messageId: 'm1' });
  });

  it('gives up after the re-join budget and reports a disconnect', async () => {
    let joins = 0;
    const result = await streamRun({
      start: async () =>
        response(sse([runFrame('run-1'), msg(2, 'x')]), {
          headers: { 'x-run-id': 'run-1' },
        }),
      join: async () => {
        joins += 1;
        return response(sse([])); // drops immediately every time
      },
      onEvent: () => undefined,
      maxRejoins: 3,
      rejoinDelayMs: () => 1,
    });
    expect(joins).toBe(3);
    expect(result.ended).toBe('disconnected');
    expect(result.lastId).toBe(2);
  });

  it('stops re-joining once the run is gone (404)', async () => {
    let joins = 0;
    const result = await streamRun({
      start: async () =>
        response(sse([runFrame('run-1')]), {
          headers: { 'x-run-id': 'run-1' },
        }),
      join: async () => {
        joins += 1;
        return response('{"statusCode":404}', { status: 404 });
      },
      onEvent: () => undefined,
      rejoinDelayMs: () => 1,
    });
    expect(joins).toBe(1);
    expect(result.ended).toBe('disconnected');
  });

  it('does not re-join a runtime without durable runs (no run id)', async () => {
    let joins = 0;
    const result = await streamRun({
      start: async () =>
        response(sse([{ event: 'message', data: { content: 'old' } }])),
      join: async () => {
        joins += 1;
        return response('');
      },
      onEvent: () => undefined,
    });
    expect(joins).toBe(0);
    expect(result.runId).toBeNull();
    expect(result.ended).toBe('disconnected');
    expect(result.text).toBe('old');
  });

  it("the user's abort ends the stream without re-joining", async () => {
    const ac = new AbortController();
    let joins = 0;
    const result = await streamRun({
      start: async () =>
        response(sse([runFrame('run-1'), msg(2, 'a')]), {
          headers: { 'x-run-id': 'run-1' },
        }),
      join: async () => {
        joins += 1;
        return response('');
      },
      onEvent: (e) => {
        if (e.event === 'message') ac.abort();
      },
      signal: ac.signal,
    });
    expect(joins).toBe(0);
    expect(result.ended).toBe('aborted');
  });

  it('resumes a run that was already running (page reload) from a cursor', async () => {
    const result = await streamRun({
      start: async () => {
        throw new Error('resume must not POST');
      },
      join: async (runId, after) => {
        expect(runId).toBe('run-9');
        expect(after).toBe(7);
        return response(
          sse([msg(8, 'tail'), done(9, { status: 'finished' })]),
          {
            headers: { 'x-request-id': 'req-9' },
          },
        );
      },
      onEvent: () => undefined,
      resume: { runId: 'run-9', after: 7 },
    });
    expect(result).toMatchObject({
      requestId: 'req-9',
      runId: 'run-9',
      ended: 'done',
      text: 'tail',
      lastId: 9,
    });
  });

  it('cuts the text back to what the runtime kept when a resumed attempt is announced', async () => {
    const texts: string[] = [];
    const result = await streamRun({
      start: async () =>
        // The client saw "Hello world" but only "Hello " was persisted
        // before the restart.
        response(sse([runFrame('run-1'), msg(2, 'Hello '), msg(3, 'world')]), {
          headers: { 'x-run-id': 'run-1' },
        }),
      join: async (_runId, after) => {
        expect(after).toBe(3);
        return response(
          sse([
            {
              event: 'run',
              id: 4294967297,
              data: {
                runId: 'run-1',
                sessionId: 's',
                requestId: 'r',
                resumed: true,
                attempt: 1,
                partialLength: 6,
              },
            },
            msg(4294967298, 'world, again'),
            done(4294967299, { status: 'finished' }),
          ]),
        );
      },
      onEvent: (_e, state) => {
        texts.push(state.text);
      },
      rejoinDelayMs: () => 1,
    });
    expect(result.ended).toBe('done');
    expect(result.resumed).toBe(1);
    expect(result.text).toBe('Hello world, again');
    expect(texts).toEqual([
      '',
      'Hello ',
      'Hello world',
      'Hello ',
      'Hello world, again',
      'Hello world, again',
    ]);
    expect(result.lastId).toBe(4294967299);
  });

  it("an interrupted run's done frame carries the kept text, which replaces what was shown", async () => {
    const result = await streamRun({
      start: async () =>
        response(
          sse([
            runFrame('run-1'),
            msg(2, 'Hello '),
            msg(3, 'wor'),
            {
              event: 'error',
              id: 4,
              data: { error: 'interrupted', kind: 'interrupted' },
            },
            done(5, {
              status: 'interrupted',
              interrupted: true,
              partialText: 'Hello ',
            }),
          ]),
          { headers: { 'x-run-id': 'run-1' } },
        ),
      join: async () => response(''),
      onEvent: () => undefined,
    });
    expect(result.ended).toBe('done');
    expect(result.text).toBe('Hello ');
    expect(result.done).toMatchObject({ interrupted: true });
  });

  it('takes the request id from the run frame when the header is missing', async () => {
    const result = await streamRun({
      start: async () =>
        response(
          sse([
            {
              event: 'run',
              id: 1,
              data: {
                runId: 'run-1',
                sessionId: 's',
                requestId: 'req-from-frame',
              },
            },
            done(2),
          ]),
        ),
      join: async () => response(''),
      onEvent: () => undefined,
    });
    expect(result.requestId).toBe('req-from-frame');
    expect(result.runId).toBe('run-1');
  });

  it('a network error while re-joining is retried, an abort during it ends the stream', async () => {
    let joins = 0;
    const ac = new AbortController();
    const result = await streamRun({
      start: async () =>
        response(sse([runFrame('run-1'), msg(2, 'a')]), {
          headers: { 'x-run-id': 'run-1' },
        }),
      join: async () => {
        joins += 1;
        if (joins === 1) throw new TypeError('Failed to fetch');
        if (joins === 2) return response(sse([msg(3, 'b'), done(4)]));
        throw new Error('unreachable');
      },
      onEvent: () => undefined,
      rejoinDelayMs: () => 1,
      signal: ac.signal,
    });
    expect(joins).toBe(2);
    expect(result.ended).toBe('done');
    expect(result.text).toBe('ab');

    let abortedJoins = 0;
    const ac2 = new AbortController();
    const aborted = await streamRun({
      start: async () =>
        response(sse([runFrame('run-2'), msg(2, 'a')]), {
          headers: { 'x-run-id': 'run-2' },
        }),
      join: async () => {
        abortedJoins += 1;
        ac2.abort();
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
      onEvent: () => undefined,
      rejoinDelayMs: () => 1,
      signal: ac2.signal,
    });
    expect(abortedJoins).toBe(1);
    expect(aborted.ended).toBe('aborted');
  });

  it('throws a typed error when the turn request itself fails', async () => {
    await expect(
      streamRun({
        start: async () => response('{"message":"too large"}', { status: 413 }),
        join: async () => response(''),
        onEvent: () => undefined,
      }),
    ).rejects.toBeInstanceOf(StreamRunStartError);
  });
});

describe('withRequestId', () => {
  it('attaches the request id to a thrown error, wraps non-errors, keeps an existing id', () => {
    const plain = withRequestId(new Error('boom'), 'req-1');
    expect(plain.message).toBe('boom');
    expect(plain.requestId).toBe('req-1');

    const wrapped = withRequestId('string failure', 'req-2');
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('string failure');
    expect(wrapped.requestId).toBe('req-2');

    const own = Object.assign(new Error('x'), { requestId: 'req-own' });
    expect(withRequestId(own, 'req-3').requestId).toBe('req-own');

    expect(withRequestId(new Error('y'), null).requestId).toBeNull();
  });
});
