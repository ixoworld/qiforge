import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLivenessFetch,
  findProviderStall,
  livenessFetchFor,
  livenessRequestTimeoutMs,
  ProviderStallError,
  stallAwareFailedAttemptHandler,
  type LivenessEvent,
  type LivenessFetchOptions,
} from './stream-liveness';

const URL_ = 'https://provider.example/v1/chat/completions';
const encoder = new TextEncoder();

/** A body the test feeds by hand; records whether it was cancelled. */
function controlledBody() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel,
  });
  return {
    stream,
    cancel,
    push(text: string) {
      controller?.enqueue(encoder.encode(text));
    },
    close() {
      controller?.close();
    },
    fail(error: Error) {
      controller?.error(error);
    },
  };
}

function sse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A response that never arrives (and ignores the abort signal). */
const never = (): Promise<Response> => new Promise<Response>(() => undefined);

function logger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function guarded(
  base: typeof fetch,
  overrides: Partial<LivenessFetchOptions> = {},
) {
  const events: LivenessEvent[] = [];
  const log = logger();
  const fetchFn = createLivenessFetch({
    headersTimeoutMs: 1_000,
    idleTimeoutMs: 5_000,
    retries: 1,
    label: 'test model',
    logger: log,
    fetch: base,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { fetchFn, events, log };
}

const post = { method: 'POST', body: '{"stream":true}' };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createLivenessFetch', () => {
  it('retries a request whose headers never arrive, then succeeds', async () => {
    const ok = controlledBody();
    ok.push('data: {"ok":true}\n\n');
    ok.close();
    const base = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(never)
      .mockResolvedValueOnce(sse(ok.stream));
    const { fetchFn, events, log } = guarded(base);

    const pending = fetchFn(URL_, post);
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await pending;

    expect(await response.text()).toBe('data: {"ok":true}\n\n');
    expect(base).toHaveBeenCalledTimes(2);
    expect(base.mock.calls[1]?.[1]?.body).toBe(post.body);
    expect(events.filter((e) => e.type === 'retry')).toEqual([
      { type: 'retry', phase: 'headers', attempt: 2 },
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      '[llm] test model: no response for 1 s, retrying (attempt 2)',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a response that sends no byte, then succeeds', async () => {
    const silent = controlledBody();
    const ok = controlledBody();
    ok.push('data: done\n\n');
    ok.close();
    const base = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(silent.stream))
      .mockResolvedValueOnce(sse(ok.stream));
    const { fetchFn, events, log } = guarded(base);

    const pending = fetchFn(URL_, post);
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;

    expect(await response.text()).toBe('data: done\n\n');
    expect(silent.cancel).toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'retry')).toEqual([
      { type: 'retry', phase: 'first-byte', attempt: 2 },
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      '[llm] test model: no bytes for 5 s, retrying (attempt 2)',
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringMatching(/^\[llm\] test model: first byte after \d+ ms$/),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails with a first-byte stall once the retries are spent', async () => {
    const first = controlledBody();
    const second = controlledBody();
    const base = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(first.stream))
      .mockResolvedValueOnce(sse(second.stream));
    const { fetchFn } = guarded(base);

    const outcome = fetchFn(URL_, post).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toMatchObject({
      name: 'ProviderStallError',
      phase: 'first-byte',
      idleMs: 5_000,
      bytesSeen: 0,
      label: 'test model',
    });

    expect(base).toHaveBeenCalledTimes(2);
    expect(first.cancel).toHaveBeenCalled();
    expect(second.cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never retries a request whose body is a stream', async () => {
    const base = vi.fn<typeof fetch>().mockImplementation(never);
    const { fetchFn } = guarded(base);

    const outcome = fetchFn(URL_, {
      method: 'POST',
      body: controlledBody().stream,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toMatchObject({
      name: 'ProviderStallError',
      phase: 'headers',
    });

    expect(base).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a stream alive on keep-alive comments alone', async () => {
    const body = controlledBody();
    const base = vi.fn<typeof fetch>().mockResolvedValue(sse(body.stream));
    const { fetchFn, events } = guarded(base);
    const keepAlive = setInterval(
      () => body.push(': OPENROUTER PROCESSING\n\n'),
      2_000,
    );

    const pending = fetchFn(URL_, post);
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await pending;
    const text = response.text();
    await vi.advanceTimersByTimeAsync(18_000);
    clearInterval(keepAlive);
    body.push('data: {"content":"hello"}\n\n');
    body.close();

    const received = await text;
    expect(received.match(/OPENROUTER PROCESSING/g)).toHaveLength(10);
    expect(received.endsWith('data: {"content":"hello"}\n\n')).toBe(true);
    expect(events.some((e) => e.type === 'stall')).toBe(false);
    expect(base).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('errors the stream on silence mid-reply, without a retry', async () => {
    const body = controlledBody();
    body.push('data: {"content":"partial"}\n\n');
    const base = vi.fn<typeof fetch>().mockResolvedValue(sse(body.stream));
    const { fetchFn, events, log } = guarded(base);

    const response = await fetchFn(URL_, post);
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(first?.done).toBe(false);

    const outcome = reader?.read().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(ProviderStallError);
    expect(error).toMatchObject({ phase: 'stream', idleMs: 5_000 });
    expect(error instanceof ProviderStallError && error.bytesSeen).toBe(
      encoder.encode('data: {"content":"partial"}\n\n').byteLength,
    );

    expect(base).toHaveBeenCalledTimes(1);
    expect(body.cancel).toHaveBeenCalled();
    expect(events.some((e) => e.type === 'retry')).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('a stall mid-reply is not retried'),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates a caller abort mid-stream as the abort, not a stall', async () => {
    const body = controlledBody();
    body.push('data: one\n\n');
    const base = vi.fn<typeof fetch>().mockResolvedValue(sse(body.stream));
    const { fetchFn, events } = guarded(base);
    const caller = new AbortController();

    const response = await fetchFn(URL_, { ...post, signal: caller.signal });
    const reader = response.body?.getReader();
    await reader?.read();
    const next = reader?.read().catch((e: unknown) => e);
    caller.abort();
    expect(await next).toMatchObject({ name: 'AbortError' });

    expect(body.cancel).toHaveBeenCalled();
    expect(events.some((e) => e.type === 'stall')).toBe(false);
    expect(base.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates a caller abort while waiting for headers, without a retry', async () => {
    const base = vi.fn<typeof fetch>().mockImplementation(never);
    const { fetchFn, events } = guarded(base);
    const caller = new AbortController();

    const outcome = fetchFn(URL_, { ...post, signal: caller.signal }).catch(
      (error: unknown) => error,
    );
    caller.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(base).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears every timer when the upstream fails', async () => {
    const body = controlledBody();
    body.push('data: one\n\n');
    const base = vi.fn<typeof fetch>().mockResolvedValue(sse(body.stream));
    const { fetchFn } = guarded(base);

    const response = await fetchFn(URL_, post);
    const reader = response.body?.getReader();
    await reader?.read();
    const next = reader?.read();
    body.fail(new Error('connection reset'));
    await expect(next).rejects.toThrow('connection reset');
    expect(vi.getTimerCount()).toBe(0);

    const refused = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('fetch failed'));
    await expect(guarded(refused).fetchFn(URL_, post)).rejects.toThrow(
      'fetch failed',
    );
    expect(refused).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles quietly when the consumer cancels during a pending read', async () => {
    const body = controlledBody();
    body.push('data: one\n\n');
    const base = vi.fn<typeof fetch>().mockResolvedValue(sse(body.stream));
    const { fetchFn, events } = guarded(base);

    const response = await fetchFn(URL_, post);
    const reader = response.body?.getReader();
    await reader?.read();
    // A pull is now waiting on the upstream; the consumer gives up.
    const pending = reader?.read();
    await reader?.cancel('no longer needed');

    expect(await pending).toEqual({ done: true, value: undefined });
    expect(body.cancel).toHaveBeenCalledWith('no longer needed');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.some((e) => e.type === 'stall')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours an abort signal carried on a Request input', async () => {
    const base = vi.fn<typeof fetch>().mockImplementation(never);
    const { fetchFn, events } = guarded(base);
    const caller = new AbortController();

    const outcome = fetchFn(
      new Request(URL_, { method: 'GET', signal: caller.signal }),
    ).catch((error: unknown) => error);
    caller.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(base).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never retries a Request input that carries a body', async () => {
    const base = vi.fn<typeof fetch>().mockImplementation(never);
    const { fetchFn } = guarded(base);

    const outcome = fetchFn(
      new Request(URL_, { method: 'POST', body: '{"stream":true}' }),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcome).toMatchObject({
      name: 'ProviderStallError',
      phase: 'headers',
    });
    expect(base).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the body of a response that arrives after the guard gave up', async () => {
    const late = controlledBody();
    let answer: ((response: Response) => void) | undefined;
    const base = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const { fetchFn } = guarded(base, { retries: 0 });

    const outcome = fetchFn(URL_, post).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toMatchObject({ phase: 'headers' });

    answer?.(sse(late.stream));
    await vi.advanceTimersByTimeAsync(0);
    expect(late.cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wraps a caller-supplied configuration.fetch and still detects its stalls', async () => {
    const silent = controlledBody();
    const callerFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        sse(silent.stream),
    );
    const guardedFetch = livenessFetchFor({
      settings: { headersTimeoutMs: 1_000, idleTimeoutMs: 5_000, retries: 0 },
      label: 'plugin model',
      callerFetch,
    });

    const outcome = guardedFetch(URL_, post).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(callerFetch).toHaveBeenCalledTimes(1);
    expect(callerFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(await outcome).toMatchObject({
      name: 'ProviderStallError',
      phase: 'first-byte',
      label: 'plugin model',
    });
    expect(silent.cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes a non-streaming response through unchanged', async () => {
    const base = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { message: 'Rate limit exceeded' } },
          { status: 429, headers: { 'retry-after': '3' } },
        ),
      );
    const { fetchFn } = guarded(base);

    const response = await fetchFn(URL_, post);

    expect(response.status).toBe(429);
    expect(response.ok).toBe(false);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(await response.json()).toEqual({
      error: { message: 'Rate limit exceeded' },
    });
    expect(vi.getTimerCount()).toBe(0);

    const empty = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const noContent = await guarded(empty).fetchFn(URL_, post);
    expect(noContent.status).toBe(204);
    expect(noContent.body).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('stall retry rules', () => {
  const stall = new ProviderStallError({
    phase: 'first-byte',
    idleMs: 5_000,
    elapsedMs: 6_000,
    bytesSeen: 0,
    label: 'test model',
  });

  it('finds a stall through wrapping errors', () => {
    const wrapped = new Error('Connection error.', { cause: stall });
    expect(findProviderStall(wrapped)).toBe(stall);
    expect(findProviderStall(new Error('other'))).toBeNull();
  });

  it('stops LangChain from retrying a stall the guard gave up on', () => {
    const handler = stallAwareFailedAttemptHandler();
    expect(() =>
      handler(new Error('Connection error.', { cause: stall })),
    ).toThrow('Connection error.');
    // Anything else follows LangChain's default rule.
    expect(() => handler(new Error('500 Internal Server Error'))).not.toThrow();
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(() => handler(abort)).toThrow('aborted');
  });

  it('sizes the SDK timeout behind every attempt the guard may make', () => {
    expect(
      livenessRequestTimeoutMs({
        headersTimeoutMs: 120_000,
        idleTimeoutMs: 90_000,
        retries: 1,
      }),
    ).toBe(425_000);
  });
});
