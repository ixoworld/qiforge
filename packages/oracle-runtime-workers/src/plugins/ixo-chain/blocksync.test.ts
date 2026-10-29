import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blocksyncLookup,
  lookupDocument,
  type AliasedField,
} from './blocksync';
import {
  TOOL_BUDGET_MS,
  UNHEALTHY_MS,
  resetUpstreamHealth,
  type ChainCall,
} from './http';

const FIELDS: AliasedField[] = [
  { alias: 'r0', field: 'r0: claim(claimId: "x") { claimId }' },
];
const DOCUMENT = 'query ChainLookup { r0: claim(claimId: "x") { claimId } }';
const R1: AliasedField = {
  alias: 'r1',
  field: 'r1: claim(claimId: "y") { claimId }',
};
const TWO: AliasedField[] = [...FIELDS, R1];

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

function callWith(
  fetcher: typeof fetch,
  overrides: Partial<ChainCall> = {},
): ChainCall {
  return {
    network: 'mainnet',
    restUrl: 'https://rest.test/rest',
    blocksyncUrl: 'https://blocksync.test/graphql',
    deadline: Date.now() + TOOL_BUDGET_MS,
    signal: new AbortController().signal,
    fetch: fetcher,
    ...overrides,
  };
}

/** A fetch that answers with `responses` in turn and records each request. */
function sequence(...responses: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const next = responses[calls.length - 1];
      if (!next) throw new Error('unexpected extra request');
      return next();
    },
  );
  return { fetcher, calls };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetUpstreamHealth();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  // The default retry wait is uniform in 1–3 s: pin it to its middle, 2 s.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('blocksyncLookup', () => {
  it('posts the document as `{ query }` with no variables, once', async () => {
    const { fetcher, calls } = sequence(() =>
      json({ data: { r0: { claimId: 'x' } } }),
    );
    const result = await blocksyncLookup(callWith(fetcher), FIELDS);
    expect(result).toEqual({
      ok: true,
      value: { data: { r0: { claimId: 'x' } }, errors: [] },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://blocksync.test/graphql');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      query: DOCUMENT,
    });
    expect(calls[0]?.init?.redirect).toBe('manual');
    expect(lookupDocument(FIELDS)).toBe(DOCUMENT);
  });

  it('waits 2 s after a 429 and asks once more', async () => {
    vi.useFakeTimers();
    const { fetcher } = sequence(
      () => new Response('slow down', { status: 429 }),
      () => json({ data: { r0: null } }),
    );
    const pending = blocksyncLookup(callWith(fetcher), FIELDS);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      ok: true,
      value: { data: { r0: null }, errors: [] },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[ixo-chain] blocksync attempt 1 failed: HTTP 429',
    );
  });

  it('honours Retry-After up to 5 s', async () => {
    vi.useFakeTimers();
    const { fetcher } = sequence(
      () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
      () => new Response('', { status: 429 }),
    );
    const pending = blocksyncLookup(callWith(fetcher), FIELDS);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      ok: false,
      failure: {
        reason: 'rate_limited',
        detail:
          'Blocksync is rate-limiting requests; try again in a few seconds.',
        retryable: true,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('gives up as unavailable (retryable) after two 503s', async () => {
    vi.useFakeTimers();
    const { fetcher } = sequence(
      () => new Response('', { status: 503 }),
      () => new Response('', { status: 503 }),
    );
    const pending = blocksyncLookup(callWith(fetcher), FIELDS);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({
      ok: false,
      failure: {
        reason: 'unavailable',
        detail: 'Blocksync is unavailable right now (HTTP 503).',
        retryable: true,
      },
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('never asks again after a statement timeout', async () => {
    const { fetcher } = sequence(() =>
      json({
        data: { r0: null },
        errors: [
          {
            message: 'canceling statement due to statement timeout',
            path: ['r0'],
          },
        ],
      }),
    );
    const result = await blocksyncLookup(callWith(fetcher), FIELDS);
    expect(result).toEqual({
      ok: true,
      value: {
        data: { r0: null },
        errors: [
          {
            message: 'canceling statement due to statement timeout',
            path: ['r0'],
          },
        ],
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('asks again after a transient database error and keeps the second answer', async () => {
    vi.useFakeTimers();
    const { fetcher } = sequence(
      () =>
        json({
          data: { r0: null },
          errors: [
            {
              message:
                'current transaction is aborted, commands ignored until end of transaction block',
              path: ['r0'],
            },
          ],
        }),
      () => json({ data: { r0: { claimId: 'x' } } }),
    );
    const pending = blocksyncLookup(callWith(fetcher), FIELDS);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({
      ok: true,
      value: { data: { r0: { claimId: 'x' } }, errors: [] },
    });
  });

  it('keeps a transient answer when the budget leaves no room to ask again', async () => {
    const answer = {
      data: { r0: null },
      errors: [{ message: 'Connection terminated unexpectedly', path: ['r0'] }],
    };
    const { fetcher } = sequence(() => json(answer));
    const result = await blocksyncLookup(
      callWith(fetcher, { deadline: Date.now() + 2_500 }),
      FIELDS,
    );
    expect(result).toEqual({ ok: true, value: answer });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns errors beside the aliases that answered', async () => {
    const { fetcher } = sequence(() =>
      json({
        data: { r0: null, r1: { totalCount: 0, nodes: [] } },
        errors: [{ message: 'boom', path: ['r0', 'nodes', 0] }],
      }),
    );
    const result = await blocksyncLookup(callWith(fetcher), FIELDS);
    expect(result).toEqual({
      ok: true,
      value: {
        data: { r0: null, r1: { totalCount: 0, nodes: [] } },
        errors: [{ message: 'boom', path: ['r0', 'nodes', '0'] }],
      },
    });
  });

  it('times out an attempt after 11 s (past the server statement timeout) and does not retry it', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const pending = blocksyncLookup(callWith(fetcher), FIELDS);
    await vi.advanceTimersByTimeAsync(10_999);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      ok: false,
      failure: {
        reason: 'timeout',
        detail:
          'Blocksync did not answer in time; narrow the question (fewer rows or requests).',
        retryable: true,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses an oversized body as too_large without retrying', async () => {
    const { fetcher } = sequence(() =>
      json({ data: { r0: { blob: 'x'.repeat(2_000) } } }),
    );
    const result = await blocksyncLookup(callWith(fetcher), FIELDS, {
      maxBytes: 1_000,
    });
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'too_large',
        detail:
          'The answer was too large to read; ask for fewer rows or a narrower filter.',
        retryable: false,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed JSON and an answer with neither data nor errors', async () => {
    const malformed = sequence(() => new Response('<html>502</html>'));
    expect(await blocksyncLookup(callWith(malformed.fetcher), FIELDS)).toEqual({
      ok: false,
      failure: {
        reason: 'unavailable',
        detail:
          'Blocksync is unavailable right now (it answered something that is not JSON).',
        retryable: false,
      },
    });
    const empty = sequence(() => json({}));
    expect(
      await blocksyncLookup(callWith(empty.fetcher), FIELDS),
    ).toMatchObject({
      ok: false,
      failure: { reason: 'unavailable', retryable: false },
    });
  });

  it('retries a network error once', async () => {
    vi.useFakeTimers();
    const { fetcher } = sequence(
      () => {
        throw new TypeError('fetch failed');
      },
      () => {
        throw new TypeError('fetch failed');
      },
    );
    const pending = blocksyncLookup(callWith(fetcher), FIELDS);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({
      ok: false,
      failure: {
        reason: 'unavailable',
        detail: 'Blocksync is unavailable right now (network error).',
        retryable: true,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry other client errors or follow redirects', async () => {
    const bad = sequence(() => new Response('', { status: 400 }));
    expect(await blocksyncLookup(callWith(bad.fetcher), FIELDS)).toEqual({
      ok: false,
      failure: {
        reason: 'unavailable',
        detail: 'Blocksync is unavailable right now (HTTP 400).',
        retryable: false,
      },
    });
    expect(bad.fetcher).toHaveBeenCalledTimes(1);
    const moved = sequence(
      () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://elsewhere.test/' },
        }),
    );
    expect(await blocksyncLookup(callWith(moved.fetcher), FIELDS)).toEqual({
      ok: false,
      failure: {
        reason: 'unavailable',
        detail:
          'Blocksync is unavailable right now (it redirected the request).',
        retryable: false,
      },
    });
    expect(moved.fetcher).toHaveBeenCalledTimes(1);
  });

  it("rethrows the turn's abort instead of reporting a failure", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const pending = blocksyncLookup(
      callWith(fetcher, { signal: controller.signal }),
      FIELDS,
    );
    controller.abort(new Error('turn cancelled'));
    await expect(pending).rejects.toThrow('turn cancelled');
  });

  it('asks again only the aliases a transient error named, and merges the answers', async () => {
    vi.useFakeTimers();
    const { fetcher, calls } = sequence(
      () =>
        json({
          data: { r0: { claimId: 'x' }, r1: null },
          errors: [
            {
              message:
                'current transaction is aborted, commands ignored until end of transaction block',
              path: ['r1'],
            },
          ],
        }),
      () => json({ data: { r1: { claimId: 'y' } } }),
    );
    const pending = blocksyncLookup(callWith(fetcher), TWO);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({
      ok: true,
      value: {
        data: { r0: { claimId: 'x' }, r1: { claimId: 'y' } },
        errors: [],
      },
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      query: lookupDocument([R1]),
    });
    expect(String(calls[1]?.init?.body)).not.toContain('r0:');
  });

  it('asks every alias again after a transient error with no path', async () => {
    vi.useFakeTimers();
    const { calls, fetcher } = sequence(
      () =>
        json({
          data: null,
          errors: [{ message: 'Connection terminated unexpectedly' }],
        }),
      () => json({ data: { r0: { claimId: 'x' }, r1: null } }),
    );
    const pending = blocksyncLookup(callWith(fetcher), TWO);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({
      ok: true,
      value: { data: { r0: { claimId: 'x' }, r1: null }, errors: [] },
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      query: lookupDocument(TWO),
    });
  });

  it('never asks again an alias that timed out, even beside a transient one', async () => {
    vi.useFakeTimers();
    const timeout = {
      message: 'canceling statement due to statement timeout',
      path: ['r0'],
    };
    const { calls, fetcher } = sequence(
      () =>
        json({
          data: { r0: null, r1: null },
          errors: [
            timeout,
            { message: 'Connection terminated unexpectedly', path: ['r1'] },
          ],
        }),
      () => json({ data: { r1: { claimId: 'y' } } }),
    );
    const pending = blocksyncLookup(callWith(fetcher), TWO);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({
      ok: true,
      value: { data: { r0: null, r1: { claimId: 'y' } }, errors: [timeout] },
    });
    expect(String(calls[1]?.init?.body)).not.toContain('r0:');
  });

  it('keeps the first answer when the retry of its transient aliases fails', async () => {
    vi.useFakeTimers();
    const first = {
      data: { r0: { claimId: 'x' }, r1: null },
      errors: [{ message: 'Connection terminated unexpectedly', path: ['r1'] }],
    };
    const { fetcher } = sequence(
      () => json(first),
      () => new Response('', { status: 503 }),
    );
    const pending = blocksyncLookup(callWith(fetcher), TWO);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({ ok: true, value: first });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      '[ixo-chain] blocksync attempt 2 failed: HTTP 503',
    );
  });

  it('caps a future HTTP-date Retry-After at 5 s', async () => {
    vi.useFakeTimers();
    const at = new Date(Date.now() + 60_000).toUTCString();
    const { fetcher } = sequence(
      () => new Response('', { status: 429, headers: { 'retry-after': at } }),
      () => json({ data: { r0: null } }),
    );
    const pending = blocksyncLookup(callWith(fetcher), FIELDS);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('honours Retry-After on 502, 503 and 504 too', async () => {
    vi.useFakeTimers();
    for (const status of [502, 503, 504]) {
      resetUpstreamHealth();
      const { fetcher } = sequence(
        () => new Response('', { status, headers: { 'retry-after': '4' } }),
        () => json({ data: { r0: null } }),
      );
      const pending = blocksyncLookup(callWith(fetcher), FIELDS);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ ok: true });
    }
  });

  it('skips the retry when the budget leaves no room after a failure', async () => {
    const { fetcher } = sequence(() => new Response('', { status: 503 }));
    // A 2 s wait and a 1 s attempt do not fit in the 2.5 s left.
    const result = await blocksyncLookup(
      callWith(fetcher, { deadline: Date.now() + 2_500 }),
      FIELDS,
    );
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'unavailable',
        detail: 'Blocksync is unavailable right now (HTTP 503).',
        retryable: true,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('times out an attempt whose body stalls after the headers', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":'));
              init?.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('aborted', 'AbortError')),
              );
            },
          }),
        ),
    );
    const pending = blocksyncLookup(callWith(fetcher), FIELDS);
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      failure: { reason: 'timeout', retryable: true },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("answers the isolate's other reads of an upstream that keeps answering 429, without asking it, for 10 s", async () => {
    vi.useFakeTimers();
    const { fetcher } = sequence(
      () => new Response('', { status: 429 }),
      () => new Response('', { status: 429 }),
      () => json({ data: { r0: null } }),
      () => json({ data: { r0: null } }),
    );
    const limited = {
      ok: false,
      failure: {
        reason: 'rate_limited',
        detail:
          'Blocksync is rate-limiting requests; try again in a few seconds.',
        retryable: true,
      },
    };
    const first = blocksyncLookup(callWith(fetcher), FIELDS);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(first).resolves.toEqual(limited);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(blocksyncLookup(callWith(fetcher), FIELDS)).resolves.toEqual(
      limited,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      '[ixo-chain] blocksync not attempted: the upstream answered 429 moments ago',
    );
    // Another upstream is asked as usual.
    await expect(
      blocksyncLookup(
        callWith(fetcher, { blocksyncUrl: 'https://other.test/graphql' }),
        FIELDS,
      ),
    ).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(UNHEALTHY_MS);
    await expect(
      blocksyncLookup(callWith(fetcher), FIELDS),
    ).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('marks an upstream unavailable after a 503 and clears the mark once it answers', async () => {
    vi.useFakeTimers();
    const { fetcher } = sequence(
      () => new Response('', { status: 503 }),
      () => json({ data: { r0: null } }),
      () => json({ data: { r0: null } }),
    );
    // The call's own retry is asked despite the mark its 503 set, and its
    // answer clears the mark for the next call.
    const first = blocksyncLookup(callWith(fetcher), FIELDS);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(
      blocksyncLookup(callWith(fetcher), FIELDS),
    ).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
