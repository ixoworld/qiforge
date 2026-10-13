import { describe, expect, it, vi } from 'vitest';
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

  it('renews the credentials once when a re-join is refused (401), then re-joins with the new ones (stage 1 only)', async () => {
    let token = 'inv-old';
    const seen: string[] = [];
    const stages: number[] = [];
    let renewals = 0;
    let starts = 0;
    const result = await streamRun({
      start: async () => {
        starts += 1;
        return response(sse([runFrame('run-1'), msg(2, 'a')]), {
          headers: { 'x-run-id': 'run-1' },
        });
      },
      join: async () => {
        seen.push(token);
        if (token === 'inv-old') return response('', { status: 401 });
        return response(sse([msg(3, 'b'), done(4)]));
      },
      onUnauthorized: (stage) => {
        renewals += 1;
        stages.push(stage);
        token = 'inv-new';
      },
      onEvent: () => undefined,
      rejoinDelayMs: () => 1,
    });
    expect(starts).toBe(1);
    expect(renewals).toBe(1);
    expect(stages).toEqual([1]); // no delegation was minted
    expect(seen).toEqual(['inv-old', 'inv-new']);
    expect(result.ended).toBe('done');
    expect(result.text).toBe('ab');
  });

  it('stops with `unauthorized` when the credentials are refused after both renewal stages, without spinning through the re-join budget', async () => {
    let joins = 0;
    const stages: number[] = [];
    const result = await streamRun({
      start: async () =>
        response(sse([runFrame('run-1'), msg(2, 'a')]), {
          headers: { 'x-run-id': 'run-1' },
        }),
      join: async () => {
        joins += 1;
        return response('', { status: 403 });
      },
      onUnauthorized: (stage) => {
        stages.push(stage);
      },
      onEvent: () => undefined,
      rejoinDelayMs: () => 1,
    });
    expect(stages).toEqual([1, 2]);
    expect(joins).toBe(3);
    expect(result.ended).toBe('unauthorized');
    expect(result.lastId).toBe(2);
  });

  it('stops at the first refused re-join when there is no way to renew the credentials', async () => {
    let joins = 0;
    const result = await streamRun({
      start: async () =>
        response(sse([runFrame('run-1')]), {
          headers: { 'x-run-id': 'run-1' },
        }),
      join: async () => {
        joins += 1;
        return response('', { status: 401 });
      },
      onEvent: () => undefined,
      rejoinDelayMs: () => 1,
    });
    expect(joins).toBe(1);
    expect(result.ended).toBe('unauthorized');
  });

  it('renews again, from stage 1, for a later refusal once a renewed re-join went through', async () => {
    let generation = 0;
    const stages: number[] = [];
    let joins = 0;
    const result = await streamRun({
      start: async () =>
        response(sse([runFrame('run-1'), msg(2, 'a')]), {
          headers: { 'x-run-id': 'run-1' },
        }),
      join: async () => {
        joins += 1;
        // Every credential generation is accepted for one re-join only.
        if (joins === 1 || joins === 3) return response('', { status: 401 });
        if (joins === 2) return response(sse([msg(3, 'b')])); // drops again
        return response(sse([msg(4, 'c'), done(5)]));
      },
      onUnauthorized: (stage) => {
        stages.push(stage);
        generation += 1;
      },
      onEvent: () => undefined,
      rejoinDelayMs: () => 1,
    });
    expect(generation).toBe(2);
    expect(stages).toEqual([1, 1]);
    expect(result.ended).toBe('done');
    expect(result.text).toBe('abc');
  });

  it('a resumed run whose join is refused through both renewal stages reports `unauthorized`', async () => {
    let joins = 0;
    let renewals = 0;
    const result = await streamRun({
      start: async () => {
        throw new Error('resume must not POST');
      },
      join: async () => {
        joins += 1;
        return response('', { status: 401 });
      },
      onUnauthorized: () => {
        renewals += 1;
      },
      onEvent: () => undefined,
      resume: { runId: 'run-9', after: 0 },
    });
    expect(joins).toBe(3);
    expect(renewals).toBe(2);
    expect(result.ended).toBe('unauthorized');
  });

  it('a re-join refused twice gets through after stage 2 (a fresh delegation)', async () => {
    let joins = 0;
    const stages: number[] = [];
    const result = await streamRun({
      start: async () =>
        response(sse([runFrame('run-1'), msg(2, 'a')]), {
          headers: { 'x-run-id': 'run-1' },
        }),
      join: async () => {
        joins += 1;
        // The fresh invocation is still proved by a revoked delegation.
        if (!stages.includes(2)) return response('', { status: 401 });
        return response(sse([msg(3, 'b'), done(4)]));
      },
      onUnauthorized: (stage) => {
        stages.push(stage);
      },
      onEvent: () => undefined,
      rejoinDelayMs: () => 1,
    });
    expect(stages).toEqual([1, 2]);
    expect(joins).toBe(3);
    expect(result.ended).toBe('done');
    expect(result.text).toBe('ab');
  });

  it('a refused POST is renewed (stage 1) and sent exactly once more', async () => {
    let token = 'inv-old';
    const starts: string[] = [];
    const stages: number[] = [];
    const result = await streamRun({
      start: async () => {
        starts.push(token);
        if (token === 'inv-old')
          return response('{"statusCode":401}', { status: 401 });
        return response(sse([runFrame('run-1'), msg(2, 'hi'), done(3)]), {
          headers: { 'x-run-id': 'run-1', 'x-request-id': 'req-2' },
        });
      },
      join: async () => {
        throw new Error('a complete stream is never re-joined');
      },
      onUnauthorized: (stage) => {
        stages.push(stage);
        token = 'inv-new';
      },
      onEvent: () => undefined,
    });
    expect(starts).toEqual(['inv-old', 'inv-new']);
    expect(stages).toEqual([1]);
    expect(result).toMatchObject({
      ended: 'done',
      requestId: 'req-2',
      text: 'hi',
    });
  });

  it('a POST refused through both stages throws the refusal and was sent three times', async () => {
    let starts = 0;
    const stages: number[] = [];
    const error = await streamRun({
      start: async () => {
        starts += 1;
        return response('{"statusCode":401,"message":"expired"}', {
          status: 401,
        });
      },
      join: async () => response(''),
      onUnauthorized: (stage) => {
        stages.push(stage);
      },
      onEvent: () => undefined,
    }).catch((e: unknown) => e);
    expect(starts).toBe(3);
    expect(stages).toEqual([1, 2]);
    expect(error).toBeInstanceOf(StreamRunStartError);
    expect(error).toMatchObject({
      status: 401,
      body: '{"statusCode":401,"message":"expired"}',
    });
  });

  it('a renewal that could not mint anything ends the attempt without repeating it', async () => {
    let starts = 0;
    const error = await streamRun({
      start: async () => {
        starts += 1;
        return response('', { status: 401 });
      },
      join: async () => response(''),
      onUnauthorized: () => false,
      onEvent: () => undefined,
    }).catch((e: unknown) => e);
    expect(starts).toBe(1);
    expect(error).toBeInstanceOf(StreamRunStartError);

    let joins = 0;
    const result = await streamRun({
      start: async () => {
        throw new Error('resume must not POST');
      },
      join: async () => {
        joins += 1;
        return response('', { status: 401 });
      },
      onUnauthorized: () => false,
      onEvent: () => undefined,
      resume: { runId: 'run-9' },
    });
    expect(joins).toBe(1);
    expect(result.ended).toBe('unauthorized');
  });

  it('a 403 that new credentials cannot fix ends the re-join without renewing', async () => {
    let joins = 0;
    const stages: number[] = [];
    const result = await streamRun({
      start: async () => {
        throw new Error('resume must not POST');
      },
      join: async () => {
        joins += 1;
        return response(
          JSON.stringify({ statusCode: 403, code: 'VFS_AUTH_FAILED' }),
          { status: 403 },
        );
      },
      onUnauthorized: (stage) => {
        stages.push(stage);
      },
      onEvent: () => undefined,
      resume: { runId: 'run-9' },
    });
    expect(joins).toBe(1);
    expect(stages).toEqual([]);
    expect(result.ended).toBe('unauthorized');
  });

  it("the user's abort while a refused POST is renewed ends the turn `aborted` without sending it again", async () => {
    const ac = new AbortController();
    let starts = 0;
    const result = await streamRun({
      start: async () => {
        starts += 1;
        return response('', { status: 401 });
      },
      join: async () => response(''),
      onUnauthorized: () => {
        ac.abort();
      },
      onEvent: () => undefined,
      signal: ac.signal,
    });
    expect(starts).toBe(1);
    expect(result.ended).toBe('aborted');
  });

  it("an error thrown by the caller's frame handler surfaces and is not treated as a drop", async () => {
    let joins = 0;
    const handled: number[] = [];
    await expect(
      streamRun({
        start: async () =>
          response(
            sse([runFrame('run-1'), msg(2, 'a'), msg(3, 'b'), done(4)]),
            { headers: { 'x-run-id': 'run-1' } },
          ),
        join: async () => {
          joins += 1;
          return response(sse([done(4)]));
        },
        onEvent: (e) => {
          if (typeof e.id === 'number') handled.push(e.id);
          if (e.id === 2) throw new Error('host callback failed');
        },
        rejoinDelayMs: () => 1,
      }),
    ).rejects.toThrow('host callback failed');
    expect(joins).toBe(0);
    expect(handled).toEqual([1, 2]);
  });

  it('a handler error on the done frame does not re-join a finished run', async () => {
    let joins = 0;
    await expect(
      streamRun({
        start: async () =>
          response(sse([runFrame('run-1'), done(2)]), {
            headers: { 'x-run-id': 'run-1' },
          }),
        join: async () => {
          joins += 1;
          return response(sse([done(2)]));
        },
        onEvent: (e) => {
          if (e.event === 'done') throw new Error('done handler failed');
        },
        rejoinDelayMs: () => 1,
      }),
    ).rejects.toThrow('done handler failed');
    expect(joins).toBe(0);
  });

  it('a frame re-sent on a re-join (id at or below the cursor) is not applied twice', async () => {
    const delivered: number[] = [];
    const result = await streamRun({
      start: async () =>
        response(sse([runFrame('run-1'), msg(2, 'Hello ')]), {
          headers: { 'x-run-id': 'run-1' },
        }),
      join: async (_runId, after) => {
        expect(after).toBe(2);
        return response(sse([msg(2, 'Hello '), msg(3, 'world'), done(4)]));
      },
      onEvent: (e) => {
        if (typeof e.id === 'number') delivered.push(e.id);
      },
      rejoinDelayMs: () => 1,
    });
    expect(result.text).toBe('Hello world');
    expect(delivered).toEqual([1, 2, 3, 4]);
  });

  it('the cursor never moves back: a lower id after a re-join is skipped and the next re-join asks after the highest id', async () => {
    const afters: number[] = [];
    const result = await streamRun({
      start: async () =>
        response(sse([runFrame('run-1'), msg(5, 'x')]), {
          headers: { 'x-run-id': 'run-1' },
        }),
      join: async (_runId, after) => {
        afters.push(after);
        if (afters.length === 1) return response(sse([msg(3, 'stale')])); // drops again
        return response(sse([msg(6, 'y'), done(7)]));
      },
      onEvent: () => undefined,
      rejoinDelayMs: () => 1,
    });
    expect(afters).toEqual([5, 5]);
    expect(result.text).toBe('xy');
    expect(result.lastId).toBe(7);
  });

  it('frames without an id (a runtime without durable runs) are always applied', async () => {
    const result = await streamRun({
      start: async () =>
        response(
          sse([
            { event: 'message', data: { content: 'a' } },
            { event: 'message', data: { content: 'a' } },
          ]),
        ),
      join: async () => response(''),
      onEvent: () => undefined,
    });
    expect(result.text).toBe('aa');
    expect(result.lastId).toBe(0);
  });

  it('a stream that ends in the middle of a frame re-joins after the last complete frame', async () => {
    const afters: number[] = [];
    // The cut frame's data is not JSON; the parser reports it and skips it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await streamRun({
      start: async () =>
        response(
          `${sse([runFrame('run-1'), msg(2, 'a')])}id: 3\nevent: message\ndata: {"content":"b`,
          { headers: { 'x-run-id': 'run-1' } },
        ),
      join: async (_runId, after) => {
        afters.push(after);
        return response(sse([msg(3, 'b'), done(4)]));
      },
      onEvent: () => undefined,
      rejoinDelayMs: () => 1,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(afters).toEqual([2]);
    expect(result.text).toBe('ab');
    expect(result.ended).toBe('done');
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
