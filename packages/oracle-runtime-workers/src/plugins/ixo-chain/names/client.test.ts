import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { usersReading } from '../http';
import {
  BATCH_STALE_MS,
  BATCH_WINDOW_MS,
  MAX_BATCH_IDS,
  MAX_OUTSTANDING_IDS,
  MAX_RESPONSE_BYTES,
  MEMO_MAX_MS,
  MEMO_MIN_MS,
  NAMES_URLS,
  OUTSTANDING_MAX_MS,
  PAUSE_DEFAULT_MS,
  PAUSE_MAX_MS,
  POST_TIMEOUT_MS,
  batcherState,
  resetNamesClient,
  resolveNames,
  type NamesRequest,
} from './client';
import recorded from './fixtures/resolve-mainnet.json';

const BASE = NAMES_URLS.mainnet;
const CLIENT = 'ixo-chain-test-oracle-mainnet';
const entity = (n: number) =>
  `did:ixo:entity:${n.toString(16).padStart(32, '0')}`;
const nameOf = (id: string) => `Name ${id.slice(-4)}`;

/** The worker's result for `id`: resolved, named {@link nameOf}, unless `over` says otherwise. */
function resultFor(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'entity',
    normalized: id,
    display: nameOf(id),
    status: 'resolved',
    complete: true,
    name: nameOf(id),
    source: 'entity',
    selfChosen: true,
    cache: { hit: 'd1', freshUntil: null },
    ...over,
  };
}

const answerFor = (
  ids: readonly string[],
  over: (id: string) => Record<string, unknown> = () => ({}),
) => ({
  network: 'mainnet',
  results: Object.fromEntries(ids.map((id) => [id, resultFor(id, over(id))])),
  meta: {},
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

/** A request that waits for the init's abort, then rejects as fetch does. */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });

/** A request whose actor died: it never settles, not even on its abort. */
const dead = () => new Promise<Response>(() => undefined);

const bodySchema = z.object({
  ids: z.array(z.string()),
  options: z.object({ include: z.array(z.string()) }),
});

interface Post {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: z.infer<typeof bodySchema>;
}

/** A fake worker: `respond` answers each POST (default: every id named). */
function worker(
  respond: (
    ids: string[],
    init?: RequestInit,
  ) => Response | Promise<Response> = (ids) => json(answerFor(ids)),
) {
  const posts: Post[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = bodySchema.parse(JSON.parse(String(init?.body)));
    posts.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body,
    });
    return respond(body.ids, init);
  });
  return { fetch, posts, asked: () => posts.map((post) => post.body.ids) };
}

function request(
  fetch: typeof globalThis.fetch,
  over: Partial<NamesRequest> = {},
): NamesRequest {
  return {
    network: 'mainnet',
    baseUrl: BASE,
    clientId: CLIENT,
    fetch,
    deadline: Date.now() + 4_000,
    signal: new AbortController().signal,
    ...over,
  };
}

/** `resolveNames` with the batch window run out. */
async function resolved(
  ids: readonly string[],
  req: NamesRequest,
): Promise<Awaited<ReturnType<typeof resolveNames>>> {
  const pending = resolveNames(ids, req);
  await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
  return pending;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  resetNamesClient();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  resetNamesClient();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resolveNames: the request', () => {
  it('POSTs the ids once to /v1/resolve with its client id, asking for names and cache', async () => {
    const { fetch, posts } = worker();
    const ids = [entity(1), entity(2), entity(1)];
    await resolved(ids, request(fetch));
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post?.url).toBe('https://names.ixo.earth/v1/resolve');
    expect(post?.method).toBe('POST');
    expect(post?.headers.get('content-type')).toBe('application/json');
    expect(post?.headers.get('x-client-id')).toBe(CLIENT);
    expect(post?.body).toEqual({
      ids: [entity(1), entity(2)],
      options: { include: ['name', 'cache'] },
    });
  });

  it('asks the worker of the request, by its own base URL', async () => {
    const { fetch, posts } = worker((ids) =>
      json({ ...answerFor(ids), network: 'devnet' }),
    );
    expect(
      await resolved(
        [entity(1)],
        request(fetch, { network: 'devnet', baseUrl: NAMES_URLS.devnet }),
      ),
    ).toEqual({
      [entity(1)]: {
        name: nameOf(entity(1)),
        source: 'entity',
        selfChosen: true,
      },
    });
    expect(posts[0]?.url).toBe('https://devnet.names.ixo.earth/v1/resolve');
  });
});

describe('resolveNames: the answer', () => {
  it('maps the recorded mainnet answer, keeping selfChosen and leaving out what has no name', async () => {
    const ids = Object.keys(recorded.results);
    const { fetch } = worker(() => json(recorded));
    expect(await resolved(ids, request(fetch))).toEqual({
      ixo1cra6p0jefu8f907gqngkfzxur26k7f73an4v95: {
        name: 'Michael',
        source: 'matrix',
        selfChosen: true,
      },
      ixo1vafr2dqhgz8frc7gf22njz8y2u0fue4kuetey6: {
        name: 'IXO fee-grant service (feegrant.ixo.world)',
        source: 'table',
        selfChosen: false,
      },
      ixo1sd7r80y445fp5e7ycru8w6zl2p34l2wnp05hqm: {
        name: 'Admin account of Subscription Deed Protocol',
        source: 'entity-account',
        selfChosen: true,
      },
      'did:ixo:entity:f22eda1f500a2ce90a16c835e1099b6a': {
        name: 'Companion',
        source: 'entity',
        selfChosen: true,
      },
      'collection:340': {
        name: 'Oracle Service Claim #340',
        source: 'collection',
        selfChosen: true,
      },
    });
  });

  it('names only complete answers: partial, unresolved and unknown ids have none', async () => {
    const [named, partial, unresolved, unknown, incomplete] = [
      1, 2, 3, 4, 5,
    ].map(entity);
    const { fetch } = worker((ids) =>
      json(
        answerFor(ids, (id) => {
          if (id === partial)
            return { status: 'partial', complete: false, name: 'Half' };
          if (id === unresolved) return { status: 'unresolved', name: null };
          if (id === unknown)
            return { kind: 'unknown', status: 'unresolved', name: 'x' };
          if (id === incomplete) return { complete: false };
          return {};
        }),
      ),
    );
    const names = await resolved(
      [named, partial, unresolved, unknown, incomplete].flatMap((id) =>
        id ? [id] : [],
      ),
      request(fetch),
    );
    expect(Object.keys(names)).toEqual([named]);
  });

  it('returns names in the order of the ids asked, whatever order the worker answers in', async () => {
    const ids = [entity(3), entity(1), entity(2)];
    const { fetch } = worker((asked) => json(answerFor([...asked].reverse())));
    expect(Object.keys(await resolved(ids, request(fetch)))).toEqual(ids);
  });

  it('ignores answers for ids it did not ask', async () => {
    const { fetch } = worker((ids) => json(answerFor([...ids, entity(9)])));
    expect(Object.keys(await resolved([entity(1)], request(fetch)))).toEqual([
      entity(1),
    ]);
  });

  it('names nothing and logs once for a body that is no JSON, of the wrong shape, for another network or too large', async () => {
    const bodies: (() => Response)[] = [
      () => new Response('<html>', { status: 200 }),
      () => json({ network: 'mainnet', results: [resultFor(entity(1))] }),
      () =>
        json({
          network: 'mainnet',
          results: {
            [entity(1)]: resultFor(entity(1), { name: 'n'.repeat(121) }),
          },
        }),
      () => json({ ...answerFor([entity(1)]), network: 'testnet' }),
      () =>
        json({
          ...answerFor([entity(1)]),
          padding: 'x'.repeat(MAX_RESPONSE_BYTES),
        }),
    ];
    for (const body of bodies) {
      resetNamesClient();
      warn.mockClear();
      const { fetch, posts } = worker(body);
      expect(await resolved([entity(1)], request(fetch))).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line.startsWith('[ixo-chain] names: ')).toBe(true);
      expect(line).not.toContain(entity(1));
      // Nothing was kept: the next call asks again.
      await resolved([entity(1)], request(fetch));
      expect(posts).toHaveLength(2);
    }
  });
});

describe('resolveNames: the memo', () => {
  it('answers a complete answer from the memo until it expires, and never keeps a partial one', async () => {
    const [named, unnamed, partial] = [1, 2, 3].map(entity);
    const { fetch, asked } = worker((ids) =>
      json(
        answerFor(ids, (id) =>
          id === unnamed
            ? { status: 'unresolved', name: null }
            : id === partial
              ? { status: 'partial', complete: false, name: null }
              : {},
        ),
      ),
    );
    const ids = [named, unnamed, partial].flatMap((id) => (id ? [id] : []));
    await resolved(ids, request(fetch));
    const again = await resolved(ids, request(fetch));
    expect(Object.keys(again)).toEqual([named]);
    // The named and the unnamed are kept; the partial is asked again.
    expect(asked()).toEqual([ids, [partial]]);
    await vi.advanceTimersByTimeAsync(MEMO_MAX_MS);
    await resolved(ids, request(fetch));
    expect(asked()[2]).toEqual(ids);
  });

  it(`keeps an answer until the worker's freshUntil, at least ${MEMO_MIN_MS / 1000} s and at most ${MEMO_MAX_MS / 60_000} min`, async () => {
    const [soon, later, far] = [1, 2, 3].map(entity);
    const nowS = () => Math.floor(Date.now() / 1000);
    const start = nowS();
    const { fetch, asked } = worker((ids) =>
      json(
        answerFor(ids, (id) => ({
          cache: {
            hit: 'd1',
            freshUntil:
              id === soon
                ? start + 5
                : id === later
                  ? start + 120
                  : start + 86_400,
          },
        })),
      ),
    );
    const ids = [soon, later, far].flatMap((id) => (id ? [id] : []));
    await resolved(ids, request(fetch));
    const askedAfter = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      const before = asked().length;
      await resolved(ids, request(fetch));
      return asked().slice(before).flat();
    };
    // 29 s in: all kept (the 5 s one for the 30 s floor).
    expect(await askedAfter(MEMO_MIN_MS - 1_000 - BATCH_WINDOW_MS)).toEqual([]);
    // 60 s in: the floor is over.
    expect(await askedAfter(30_000)).toEqual([soon]);
    // 3 min in: past `later`'s freshUntil (and `soon`'s new floor).
    expect(await askedAfter(120_000)).toEqual([soon, later]);
    // 11 min in: past the 10 min cap for `far` too.
    expect(await askedAfter(8 * 60_000)).toEqual(ids);
  });

  it('still answers from the memo while the worker is paused', async () => {
    let busy = false;
    const { fetch, posts } = worker((ids) =>
      busy ? new Response('', { status: 429 }) : json(answerFor(ids)),
    );
    await resolved([entity(1)], request(fetch));
    busy = true;
    await resolved([entity(2)], request(fetch));
    expect(posts).toHaveLength(2);
    const names = await resolved([entity(1), entity(2)], request(fetch));
    expect(Object.keys(names)).toEqual([entity(1)]);
    expect(posts).toHaveLength(2);
  });
});

describe('resolveNames: failures and the pause', () => {
  it(`pauses names for Retry-After after a 429, at most ${PAUSE_MAX_MS / 1000} s`, async () => {
    let status = 429;
    const { fetch, posts } = worker((ids) =>
      status === 200
        ? json(answerFor(ids))
        : new Response('{"error":"rate_limited"}', {
            status,
            headers: { 'retry-after': '600' },
          }),
    );
    expect(await resolved([entity(1)], request(fetch))).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      '[ixo-chain] names: HTTP 429, Retry-After 600 s; paused for 300 s',
    );
    status = 200;
    await vi.advanceTimersByTimeAsync(PAUSE_MAX_MS - 1_000);
    expect(await resolved([entity(1)], request(fetch))).toEqual({});
    expect(posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(Object.keys(await resolved([entity(1)], request(fetch)))).toEqual([
      entity(1),
    ]);
    expect(posts).toHaveLength(2);
  });

  it(`pauses ${PAUSE_DEFAULT_MS / 1000} s after a 5xx or a 429 without Retry-After; not after a 4xx`, async () => {
    for (const [status, pauses] of [
      [429, true],
      [500, true],
      [503, true],
      [400, false],
    ] as const) {
      resetNamesClient();
      const { fetch, posts } = worker(() => new Response('', { status }));
      // A failed POST answers its callers at once, not at their deadline.
      const start = Date.now();
      expect(await resolved([entity(1)], request(fetch))).toEqual({});
      expect(Date.now() - start).toBeLessThan(1_000);
      await vi.advanceTimersByTimeAsync(PAUSE_DEFAULT_MS - 1_000);
      await resolved([entity(1)], request(fetch));
      expect(posts).toHaveLength(pauses ? 1 : 2);
      await vi.advanceTimersByTimeAsync(1_000);
      await resolved([entity(1)], request(fetch));
      expect(posts).toHaveLength(pauses ? 2 : 3);
    }
  });

  it(`ends a POST the worker does not answer after ${POST_TIMEOUT_MS / 1000} s, without a pause`, async () => {
    let answer = false;
    const { fetch, posts } = worker((ids, init) =>
      answer ? json(answerFor(ids)) : hang(init),
    );
    const pending = resolveNames(
      [entity(1)],
      request(fetch, { deadline: Date.now() + 10_000 }),
    );
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS + POST_TIMEOUT_MS);
    expect(await pending).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      `[ixo-chain] names: timeout after ${POST_TIMEOUT_MS} ms`,
    );
    answer = true;
    expect(Object.keys(await resolved([entity(1)], request(fetch)))).toEqual([
      entity(1),
    ]);
    expect(posts).toHaveLength(2);
    expect(usersReading()).toBe(0);
  });
});

describe('resolveNames: batching', () => {
  it('sends the ids of two concurrent calls in one POST', async () => {
    const { fetch, asked } = worker();
    const first = resolveNames([entity(1), entity(2)], request(fetch));
    const second = resolveNames([entity(3)], request(fetch));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(Object.keys(await first)).toEqual([entity(1), entity(2)]);
    expect(Object.keys(await second)).toEqual([entity(3)]);
    expect(asked()).toEqual([[entity(1), entity(2), entity(3)]]);
  });

  it(`sends ${MAX_BATCH_IDS} ids at once and the rest after the window: 45 ids, two POSTs`, async () => {
    const { fetch, asked } = worker();
    const ids = Array.from({ length: 45 }, (_, n) => entity(n));
    const pending = resolveNames(ids, request(fetch));
    await vi.advanceTimersByTimeAsync(0);
    expect(asked()).toEqual([ids.slice(0, 40)]);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(asked()).toEqual([ids.slice(0, 40), ids.slice(40)]);
    expect(Object.keys(await pending)).toEqual(ids);
  });

  it('asks an id two calls want once, queued or in flight, every call getting its name', async () => {
    const { fetch, asked } = worker(
      (ids) =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(json(answerFor(ids))), 100),
        ),
    );
    // Both queued in the same window.
    const first = resolveNames([entity(1)], request(fetch));
    const second = resolveNames([entity(1)], request(fetch));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    // The POST is in flight: a third call joins it for entity(1).
    const third = resolveNames([entity(1), entity(2)], request(fetch));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS + 100);
    for (const call of [first, second])
      expect(Object.keys(await call)).toEqual([entity(1)]);
    expect(Object.keys(await third)).toEqual([entity(1), entity(2)]);
    expect(asked()).toEqual([[entity(1)], [entity(2)]]);
  });

  it("throws an aborted call's own abort, leaving the other call and the POST alone", async () => {
    let release: () => void = () => undefined;
    const { fetch, posts } = worker(
      (ids) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json(answerFor(ids)));
        }),
    );
    const controller = new AbortController();
    const aborted = resolveNames(
      [entity(1)],
      request(fetch, { signal: controller.signal }),
    );
    const other = resolveNames([entity(1)], request(fetch));
    // Settled into a value at once, so the rejection is never unhandled.
    const outcome = aborted.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : 'other'),
    );
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    controller.abort(new Error('turn aborted'));
    expect(await outcome).toBe('turn aborted');
    release();
    expect(Object.keys(await other)).toEqual([entity(1)]);
    expect(posts).toHaveLength(1);
  });

  it('stops one call at its own deadline while the POST runs on and lands in the memo', async () => {
    const { fetch, asked } = worker(
      (ids) =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(json(answerFor(ids))), 2_000),
        ),
    );
    const hurried = resolveNames(
      [entity(1)],
      request(fetch, { deadline: Date.now() + 500 }),
    );
    const patient = resolveNames([entity(1)], request(fetch));
    await vi.advanceTimersByTimeAsync(500);
    expect(await hurried).toEqual({});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(Object.keys(await patient)).toEqual([entity(1)]);
    // The answer is kept: the next call asks nothing.
    expect(Object.keys(await resolved([entity(1)], request(fetch)))).toEqual([
      entity(1),
    ]);
    expect(asked()).toEqual([[entity(1)]]);
  });

  it(`clears the ${BATCH_WINDOW_MS} ms window timer when a full batch goes early`, async () => {
    const { fetch } = worker();
    const ids = Array.from({ length: MAX_BATCH_IDS }, (_, n) => entity(n));
    const pending = resolveNames(ids, request(fetch));
    // Only the call's own deadline timer is left: the window timer was
    // cleared when the 40th id sent the batch.
    expect(vi.getTimerCount()).toBe(1);
    expect(batcherState(BASE, CLIENT)).toEqual({
      outstanding: MAX_BATCH_IDS,
      timer: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(Object.keys(await pending)).toHaveLength(MAX_BATCH_IDS);
    expect(vi.getTimerCount()).toBe(0);
    expect(batcherState(BASE, CLIENT)).toEqual({
      outstanding: 0,
      timer: false,
    });
  });

  it(`asks at most ${MAX_OUTSTANDING_IDS} ids at a time; a miss past that goes unnamed`, async () => {
    const { fetch, posts } = worker((_ids, init) => hang(init));
    const calls = Array.from({ length: 5 }, (_, call) =>
      resolveNames(
        Array.from({ length: MAX_BATCH_IDS }, (_, n) =>
          entity(call * MAX_BATCH_IDS + n),
        ),
        request(fetch),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(batcherState(BASE, CLIENT)?.outstanding).toBe(MAX_OUTSTANDING_IDS);
    const skipped = resolveNames([entity(999)], request(fetch));
    expect(batcherState(BASE, CLIENT)?.outstanding).toBe(MAX_OUTSTANDING_IDS);
    // Nothing to wait for: the skipped call answers at once.
    expect(await skipped).toEqual({});
    await vi.advanceTimersByTimeAsync(POST_TIMEOUT_MS);
    for (const call of calls) expect(await call).toEqual({});
    expect(posts).toHaveLength(5);
    expect(batcherState(BASE, CLIENT)?.outstanding).toBe(0);
  });
});

describe('resolveNames: an actor that died', () => {
  /** Opens a batch whose window timer died with its actor: it never fires. */
  function openWithDeadTimer(
    ids: readonly string[],
    fetch: typeof globalThis.fetch,
  ) {
    const fake = setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() =>
      fake(() => undefined, MEMO_MAX_MS),
    );
    void resolveNames(ids, request(fetch));
  }

  it("has the next caller send an open batch whose timer died, with that caller's fetch", async () => {
    const opener = worker();
    openWithDeadTimer([entity(1)], opener.fetch);
    const next = worker();
    // Up to the limit the batch is joined: a timer may just be late.
    await vi.advanceTimersByTimeAsync(BATCH_STALE_MS);
    void resolveNames([entity(2)], request(next.fetch));
    expect(next.posts).toHaveLength(0);
    expect(batcherState(BASE, CLIENT)).toEqual({ outstanding: 2, timer: true });
    await vi.advanceTimersByTimeAsync(1);
    const names = await resolved([entity(1), entity(3)], request(next.fetch));
    expect(Object.keys(names)).toEqual([entity(1), entity(3)]);
    expect(next.asked()).toEqual([[entity(1), entity(2)], [entity(3)]]);
    expect(opener.fetch).not.toHaveBeenCalled();
    expect(batcherState(BASE, CLIENT)).toEqual({
      outstanding: 0,
      timer: false,
    });
  });

  it('wakes a live call that joined the batch when the next caller sends it', async () => {
    const { fetch } = worker();
    openWithDeadTimer([entity(1)], fetch);
    const joined = resolveNames([entity(2)], request(fetch));
    await vi.advanceTimersByTimeAsync(BATCH_STALE_MS + 1);
    await resolved([entity(3)], request(fetch));
    expect(await Promise.race([joined, 'still waiting'])).toEqual({
      [entity(2)]: {
        name: nameOf(entity(2)),
        source: 'entity',
        selfChosen: true,
      },
    });
  });

  it(`asks an id afresh once its POST is ${OUTSTANDING_MAX_MS} ms old, ending joiners at their own deadlines`, async () => {
    let alive = false;
    const { fetch, asked } = worker((ids) =>
      alive ? json(answerFor(ids)) : dead(),
    );
    void resolveNames([entity(1)], request(fetch));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(asked()).toEqual([[entity(1)]]);
    const joiner = resolveNames(
      [entity(1)],
      request(fetch, { deadline: Date.now() + 500 }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(await joiner).toEqual({});
    // Up to the limit it is joined, never asked twice.
    await vi.advanceTimersByTimeAsync(
      OUTSTANDING_MAX_MS - 500 - BATCH_WINDOW_MS,
    );
    const atLimit = resolveNames(
      [entity(1)],
      request(fetch, { deadline: Date.now() + 1 }),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(await atLimit).toEqual({});
    expect(asked()).toEqual([[entity(1)]]);
    alive = true;
    expect(Object.keys(await resolved([entity(1)], request(fetch)))).toEqual([
      entity(1),
    ]);
    expect(asked()).toEqual([[entity(1)], [entity(1)]]);
    expect(batcherState(BASE, CLIENT)?.outstanding).toBe(0);
  });

  it(`counts no dead POST toward the ${MAX_OUTSTANDING_IDS} ids, nor keeps its permit`, async () => {
    let alive = false;
    const { fetch, posts } = worker((ids) =>
      alive ? json(answerFor(ids)) : dead(),
    );
    for (let call = 0; call < 5; call += 1)
      void resolveNames(
        Array.from({ length: MAX_BATCH_IDS }, (_, n) =>
          entity(call * MAX_BATCH_IDS + n),
        ),
        request(fetch),
      );
    await vi.advanceTimersByTimeAsync(0);
    expect(batcherState(BASE, CLIENT)?.outstanding).toBe(MAX_OUTSTANDING_IDS);
    expect(await resolveNames([entity(999)], request(fetch))).toEqual({});
    alive = true;
    await vi.advanceTimersByTimeAsync(OUTSTANDING_MAX_MS + 1);
    expect(Object.keys(await resolved([entity(999)], request(fetch)))).toEqual([
      entity(999),
    ]);
    expect(posts).toHaveLength(6);
    expect(batcherState(BASE, CLIENT)?.outstanding).toBe(0);
    expect(usersReading()).toBe(0);
  });

  it('leaves the replacement alone when a replaced POST settles after all', async () => {
    const replies: ((response: Response) => void)[] = [];
    const { fetch, posts } = worker(
      () => new Promise<Response>((resolve) => replies.push(resolve)),
    );
    void resolveNames([entity(1)], request(fetch));
    await vi.advanceTimersByTimeAsync(OUTSTANDING_MAX_MS + 1);
    const replacing = resolveNames([entity(1)], request(fetch));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(posts).toHaveLength(2);
    // The old POST answers nothing that could be memoised.
    replies[0]?.(json({ network: 'mainnet', results: {} }));
    await vi.advanceTimersByTimeAsync(0);
    expect(batcherState(BASE, CLIENT)?.outstanding).toBe(1);
    const joining = resolveNames([entity(1)], request(fetch));
    expect(posts).toHaveLength(2);
    replies[1]?.(json(answerFor([entity(1)])));
    expect(Object.keys(await replacing)).toEqual([entity(1)]);
    expect(Object.keys(await joining)).toEqual([entity(1)]);
    expect(batcherState(BASE, CLIENT)?.outstanding).toBe(0);
    expect(usersReading()).toBe(0);
  });
});
