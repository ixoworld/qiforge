import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { UserIdentity } from '../../core/user-identity';
import { readBalances } from './balances';
import { denomDisplay, ibcDenomTable, resetDenomMetadataCache } from './denoms';
import {
  resetUpstreamHealth,
  TOOL_BUDGET_MS,
  USER_READ_PERMITS,
  usersReading,
  type ChainCall,
} from './http';
import { CORE_KINDS } from './kinds/core';
import { defineKind, type KindContext, type KindDef } from './kinds/types';
import {
  chainLookup,
  cutRow,
  cutRowAcross,
  fitNames,
  MAX_DISPLAY_DENOMS,
  MAX_RESULT_CHARS,
  runRequests,
  type KindRequest,
  type LookupAnswer,
  type LookupOptions,
} from './lookup';
import type { NameMap } from './names/types';
import { restJson } from './rest';

const ADDRESS = 'ixo1cra6p0jefu8f907gqngkfzxur26k7f73an4v95';
const USER: UserIdentity = { did: `did:ixo:${ADDRESS}`, address: ADDRESS };
const REST = 'https://rest.test/rest';
const BLOCKSYNC = 'https://blocksync.test/graphql';
const OPTIONS: LookupOptions = {
  ibcDenoms: ibcDenomTable('mainnet', undefined),
};

const core = (name: string): KindDef => {
  const kind = CORE_KINDS.find((k) => k.name === name);
  if (!kind) throw new Error(`no core kind ${name}`);
  return kind;
};

/**
 * A chain kind for these tests only: `reads` REST reads at once (paths
 * `/stub/<id>/<n>`), answering the paths read and the `first` it was given.
 */
function stubKind(
  name = 'stub',
  run?: (ctx: KindContext, id: string) => Promise<unknown>,
): KindDef {
  return defineKind({
    name,
    summary: 'A stub chain kind.',
    explain: 'For tests.',
    source: 'chain',
    list: true,
    args: z.strictObject({
      id: z.string().regex(/^[a-z0-9]{1,8}$/),
      reads: z.number().int().min(0).max(8).optional(),
      first: z.number().int().min(1).max(20).optional(),
    }),
    example: { id: 'a' },
    plan: (args, ctx) => ({
      source: 'chain',
      async run() {
        if (run) return { ok: true, data: await run(ctx, args.id) };
        const reads = await Promise.all(
          Array.from({ length: args.reads ?? 1 }, (_, n) =>
            ctx.rest(`/stub/${args.id}/${n}`, z.object({ n: z.number() }), {
              label: 'stub',
            }),
          ),
        );
        const failed = reads.find((read) => !read.ok);
        if (failed && !failed.ok) return { ok: false, ...failed.failure };
        return {
          ok: true,
          subject: 'other',
          first: ctx.first,
          data: { reads: reads.length },
        };
      },
    }),
  });
}

function callFor(
  overrides: Partial<ChainCall> = {},
  signal = new AbortController().signal,
): ChainCall {
  return {
    network: 'mainnet',
    restUrl: REST,
    blocksyncUrl: BLOCKSYNC,
    user: USER.did,
    deadline: Date.now() + TOOL_BUDGET_MS,
    signal,
    fetch: (input, init) => globalThis.fetch(input, init),
    ...overrides,
  };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

function stubFetch(
  route: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    route(String(input), init),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

/** A response that never comes: the request fails only when its signal aborts. */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });

const queryOf = (init?: RequestInit): string => {
  const body: unknown = JSON.parse(String(init?.body));
  if (!body || typeof body !== 'object' || !('query' in body))
    throw new Error('expected { query }');
  return String(body.query);
};

/** A chain kind for these tests only: shows each of `denoms` through `ctx.display`. */
function displayKind(denoms: string[]): KindDef {
  return defineKind({
    name: 'shows',
    summary: 'A stub kind showing denoms.',
    explain: 'For tests.',
    source: 'chain',
    list: false,
    args: z.strictObject({}),
    example: {},
    plan: (_args, ctx) => ({
      source: 'chain',
      async run() {
        return {
          ok: true,
          data: await Promise.all(denoms.map((denom) => ctx.display(denom))),
        };
      },
    }),
  });
}

const metadataOf = (url: string) =>
  /denoms_metadata_by_query_string\?denom=(.+)$/.exec(url)?.[1];
/** DenomMetadata of `denom` with a 6-decimal display unit named after it. */
const metadata = (denom: string) =>
  json({
    metadata: {
      denom_units: [
        { denom, exponent: 0 },
        { denom: `${denom}x`, exponent: 6 },
      ],
      display: `${denom}x`,
      symbol: denom.slice(1).toUpperCase(),
    },
  });

/**
 * A stubbed fetch that answers after 5 ms and counts the requests in
 * flight: metadata for denom lookups, an empty claims page for a POST, a
 * balance of `uzzz` for a bank balances read, `{ n: 1 }` otherwise.
 */
function countingFetch() {
  let active = 0;
  let peak = 0;
  const fetcher = stubFetch(async (url) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const denom = metadataOf(url);
    if (denom) return metadata(denom);
    if (url === BLOCKSYNC)
      return json({ data: { r2: { totalCount: 0, nodes: [] } } });
    if (url.includes('/cosmos/bank/v1beta1/balances/'))
      return json({ balances: [{ denom: 'uzzz', amount: '1' }] });
    return json({ n: 1 });
  });
  return { fetcher, peak: () => peak };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetUpstreamHealth();
  resetDenomMetadataCache();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runRequests', () => {
  it('answers Blocksync, chain and refused requests in request order, with one POST', async () => {
    const posts: string[] = [];
    const fetcher = stubFetch((url, init) => {
      if (url === BLOCKSYNC) {
        posts.push(queryOf(init));
        return json({
          data: {
            r0: { totalCount: 0, nodes: [] },
            r3: { totalCount: 0, nodes: [] },
          },
        });
      }
      if (url.startsWith(`${REST}/stub/`)) return json({ n: 1 });
      throw new Error(`unexpected ${url}`);
    });
    const stub = stubKind();
    const results = await runRequests(
      callFor(),
      USER,
      [
        { kind: core('claims') },
        { kind: stub, args: { id: 'a', reads: 2 } },
        { kind: core('claim'), args: { claimId: 'not a claim id' } },
        { kind: core('token_balances') },
        { kind: stub, args: { id: 'BAD' } },
      ],
      OPTIONS,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/^query ChainLookup \{ r0: claims\(/);
    expect(posts[0]).toContain(' r3: tokenBalances(');
    expect(posts[0]).not.toContain('r1:');
    expect(posts[0]).not.toContain('r2:');
    // Five requests share the call: each list reads at most 8 rows.
    expect(posts[0]).toContain('first: 8,');
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      BLOCKSYNC,
      `${REST}/stub/a/0`,
      `${REST}/stub/a/1`,
    ]);
    expect(results).toEqual([
      {
        kind: 'claims',
        source: 'blocksync',
        ok: true,
        subject: 'user',
        first: 8,
        data: { totalCount: 0, items: [] },
      },
      {
        kind: 'stub',
        source: 'chain',
        ok: true,
        subject: 'other',
        first: 8,
        data: { reads: 2 },
      },
      {
        kind: 'claim',
        source: 'blocksync',
        ok: false,
        reason: 'invalid_input',
        detail: 'claimId must be a claim id (a CID such as "bafkrei…").',
        retryable: false,
      },
      {
        kind: 'token_balances',
        source: 'blocksync',
        ok: true,
        subject: 'user',
        first: 8,
        data: expect.objectContaining({ totalCount: 0, items: [] }),
      },
      {
        kind: 'stub',
        source: 'chain',
        ok: false,
        reason: 'invalid_input',
        detail: expect.stringMatching(
          /^Invalid args for kind "stub" \(id: .+\)\. Call describe_chain_kinds with \["stub"\] for its arguments\.$/,
        ),
        retryable: false,
      },
    ]);
  });

  it("gives a kind its request's first, scaled for the call", async () => {
    stubFetch(() => json({ n: 1 }));
    const stub = stubKind();
    const firsts = async (requests: KindRequest[]) =>
      (await runRequests(callFor(), USER, requests, OPTIONS)).map((result) =>
        result.ok ? result.first : result.reason,
      );
    expect(await firsts([{ kind: stub, args: { id: 'a' } }])).toEqual([10]);
    expect(
      await firsts([{ kind: stub, args: { id: 'a', first: 20 } }]),
    ).toEqual([20]);
    expect(
      await firsts(
        Array.from({ length: 8 }, () => ({
          kind: stub,
          args: { id: 'a', first: 20 },
        })),
      ),
    ).toEqual(Array.from({ length: 8 }, () => 5));
  });

  it("uses a request's own first as given", async () => {
    const posts: string[] = [];
    stubFetch((url, init) => {
      if (url === BLOCKSYNC) {
        posts.push(queryOf(init));
        return json({ data: { r0: { totalCount: 0, nodes: [] } } });
      }
      return json({ n: 1 });
    });
    const results = await runRequests(
      callFor(),
      USER,
      [
        { kind: core('claims'), first: 3 },
        ...Array.from({ length: 7 }, () => ({
          kind: stubKind(),
          args: { id: 'a', first: 20 },
          first: 2,
        })),
      ],
      OPTIONS,
    );
    expect(posts[0]).toContain('first: 3,');
    expect(results.map((result) => result.ok && result.first)).toEqual([
      3, 2, 2, 2, 2, 2, 2, 2,
    ]);
  });

  it("shows bank coins with the call's IBC table, looking each other denom up once per call", async () => {
    const operator = `ibc/${'A'.repeat(64)}`;
    const fetcher = stubFetch((url) => {
      const denom = metadataOf(url);
      return denom ? metadata(denom) : new Response('{}', { status: 404 });
    });
    const shows = displayKind(['uixo', operator, 'upay', 'upay']);
    const results = await runRequests(
      callFor(),
      USER,
      [{ kind: shows }, { kind: shows }],
      {
        ibcDenoms: ibcDenomTable('mainnet', {
          [operator]: { symbol: 'OSMO', decimals: 6, origin: 'osmosis-1' },
        }),
      },
    );
    const shown = [
      { symbol: 'IXO', decimals: 6, verified: true },
      { symbol: 'OSMO', decimals: 6, verified: true, origin: 'osmosis-1' },
      { symbol: 'PAY', decimals: 6, verified: true },
      { symbol: 'PAY', decimals: 6, verified: true },
    ];
    expect(results).toMatchObject([
      { ok: true, data: shown },
      { ok: true, data: shown },
    ]);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${REST}/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=upay`,
    ]);
  });

  it(`looks up at most ${MAX_DISPLAY_DENOMS} distinct denoms per request and shows the rest unread`, async () => {
    const fetcher = stubFetch((url) => {
      const denom = metadataOf(url);
      return denom ? metadata(denom) : new Response('{}', { status: 404 });
    });
    const denoms = Array.from(
      { length: MAX_DISPLAY_DENOMS + 2 },
      (_, n) => `utok${n}`,
    );
    const [result] = await runRequests(
      callFor(),
      USER,
      [{ kind: displayKind(['uixo', ...denoms, 'utok0']) }],
      OPTIONS,
    );
    expect(fetcher).toHaveBeenCalledTimes(MAX_DISPLAY_DENOMS);
    expect(result?.ok && result.data).toEqual([
      { symbol: 'IXO', decimals: 6, verified: true },
      ...denoms.slice(0, MAX_DISPLAY_DENOMS).map((denom) => ({
        symbol: denom.slice(1).toUpperCase(),
        decimals: 6,
        verified: true,
      })),
      ...denoms.slice(MAX_DISPLAY_DENOMS).map((denom) => ({
        symbol: denom,
        decimals: 0,
        verified: false,
        metadataUnavailable: true,
      })),
      { symbol: 'TOK0', decimals: 6, verified: true },
    ]);
  });

  it(`counts denom lookups and the Blocksync POST among the user's ${USER_READ_PERMITS} reads in flight`, async () => {
    const { fetcher, peak } = countingFetch();
    const results = await runRequests(
      callFor(),
      USER,
      [
        { kind: stubKind(), args: { id: 'a', reads: 3 } },
        { kind: displayKind(['uaaa', 'ubbb', 'uccc', 'uddd']) },
        { kind: core('claims') },
      ],
      OPTIONS,
    );
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(peak()).toBe(USER_READ_PERMITS);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(usersReading()).toBe(0);
  });

  it(`keeps at most ${USER_READ_PERMITS} reads of one user in flight across three tool calls and a balances read at once`, async () => {
    const { fetcher, peak } = countingFetch();
    const stub = stubKind();
    // Each call: three REST reads, two denom lookups (its own denoms, so
    // none is shared through the per-isolate cache) and one POST.
    const call = (n: number) =>
      runRequests(
        callFor(),
        USER,
        [
          { kind: stub, args: { id: `c${n}`, reads: 3 } },
          { kind: displayKind([`ua${n}x`, `ub${n}x`]) },
          { kind: core('claims') },
        ],
        OPTIONS,
      );
    // `get_account_balances` reads over a call of the same user.
    const balancesCall = callFor();
    const balances = readBalances(
      {
        rest: (path, schema, opts) =>
          restJson(balancesCall, path, schema, opts),
        display: (denom) =>
          denomDisplay(balancesCall, denom, OPTIONS.ibcDenoms),
      },
      ADDRESS,
    );
    const [first, second, third, held] = await Promise.all([
      call(0),
      call(1),
      call(2),
      balances,
    ]);
    // 3 × (3 + 2 + 1) reads, and the balances read with its one denom.
    expect(fetcher).toHaveBeenCalledTimes(3 * 6 + 2);
    expect(peak()).toBe(USER_READ_PERMITS);
    for (const results of [first, second, third])
      expect(results.every((result) => result.ok)).toBe(true);
    expect(held).toMatchObject({
      ok: true,
      value: { tokens: [{ denom: 'uzzz', symbol: 'ZZZ', amount: '0.000001' }] },
    });
    expect(usersReading()).toBe(0);
  });

  it("does not hold back one user's reads behind another user's", async () => {
    vi.useFakeTimers();
    const fetcher = stubFetch((url, init) =>
      url.includes('/stub/busy/') ? hang(init) : json({ n: 1 }),
    );
    const stub = stubKind();
    const busyTurn = new AbortController();
    const busy = runRequests(
      callFor({}, busyTurn.signal),
      USER,
      [{ kind: stub, args: { id: 'busy', reads: 8 } }],
      OPTIONS,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(USER_READ_PERMITS);
    const OTHER = 'ixo1rtjje8u0ctwwcdk8x07f4zgmexnjcmk8w6dgvq';
    const other: UserIdentity = { did: `did:ixo:${OTHER}`, address: OTHER };
    const results = await runRequests(
      callFor({ user: other.did }),
      other,
      [{ kind: stub, args: { id: 'free', reads: 3 } }],
      OPTIONS,
    );
    expect(results).toMatchObject([{ ok: true, data: { reads: 3 } }]);
    expect(fetcher).toHaveBeenCalledTimes(USER_READ_PERMITS + 3);
    expect(usersReading()).toBe(1);
    const reason = new Error('turn aborted');
    busyTurn.abort(reason);
    await expect(busy).rejects.toBe(reason);
    expect(usersReading()).toBe(0);
  });

  it('fits every read into the 20 s budget: queued reads start late and are cut to what is left', async () => {
    vi.useFakeTimers();
    const fetcher = stubFetch((url, init) => hang(init));
    const stub = stubKind();
    const pending = runRequests(
      callFor(),
      USER,
      [
        { kind: stub, args: { id: 'a', reads: 4 } },
        { kind: stub, args: { id: 'b', reads: 4 } },
        { kind: stub, args: { id: 'c', reads: 4 } },
        { kind: core('claims') },
      ],
      OPTIONS,
    );
    await vi.advanceTimersByTimeAsync(TOOL_BUDGET_MS);
    const results = await pending;
    // Five permits, the POST holding one until its own 11 s: `a` reads at
    // 0–8 s, `b` at 8–16 s, `c`'s first at 11–19 s and its others from 16 s,
    // cut at the deadline. Every read was attempted once.
    expect(fetcher).toHaveBeenCalledTimes(12 + 1);
    expect(results).toEqual([
      ...['stub', 'stub', 'stub'].map((kind) => ({
        kind,
        source: 'chain',
        ok: false,
        reason: 'timeout',
        detail: 'The chain node did not answer in time; try again shortly.',
        retryable: true,
      })),
      {
        kind: 'claims',
        source: 'blocksync',
        ok: false,
        reason: 'timeout',
        detail:
          'Blocksync did not answer in time; narrow the question (fewer rows or requests).',
        retryable: true,
      },
    ]);
    expect(warn).toHaveBeenCalled();
  });

  it("throws the turn's abort, and a queued read never starts after it", async () => {
    const controller = new AbortController();
    const fetcher = stubFetch((url, init) => hang(init));
    const stub = stubKind();
    const pending = runRequests(
      callFor({}, controller.signal),
      USER,
      [{ kind: stub, args: { id: 'a', reads: 6 } }, { kind: core('claims') }],
      OPTIONS,
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5));
    const reason = new Error('turn aborted');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('fails only the Blocksync requests when the POST fails, or when no Blocksync URL is configured', async () => {
    const fetcher = stubFetch((url) =>
      url === BLOCKSYNC ? new Response('', { status: 400 }) : json({ n: 1 }),
    );
    const requests: KindRequest[] = [
      { kind: core('claims') },
      { kind: stubKind(), args: { id: 'a' } },
    ];
    expect(await runRequests(callFor(), USER, requests, OPTIONS)).toMatchObject(
      [
        {
          kind: 'claims',
          source: 'blocksync',
          ok: false,
          reason: 'unavailable',
          detail: 'Blocksync is unavailable right now (HTTP 400).',
          retryable: false,
        },
        { kind: 'stub', source: 'chain', ok: true },
      ],
    );
    fetcher.mockClear();
    expect(
      await runRequests(callFor({ blocksyncUrl: '' }), USER, requests, OPTIONS),
    ).toMatchObject([
      {
        kind: 'claims',
        ok: false,
        reason: 'unavailable',
        detail:
          'Blocksync is unavailable right now (no valid BLOCKSYNC_GRAPHQL_URL is configured).',
        retryable: false,
      },
      { kind: 'stub', ok: true },
    ]);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${REST}/stub/a/0`,
    ]);
  });

  it('answers a request whose kind throws as a failure of its own, and the others still', async () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    stubFetch(() => json({ n: 1 }));
    const broken = stubKind('broken', async () => {
      throw new TypeError('boom');
    });
    expect(
      await runRequests(
        callFor(),
        USER,
        [
          { kind: broken, args: { id: 'a' } },
          { kind: stubKind(), args: { id: 'b' } },
        ],
        OPTIONS,
      ),
    ).toMatchObject([
      {
        kind: 'broken',
        source: 'chain',
        ok: false,
        reason: 'unavailable',
        detail:
          'This request failed inside the oracle; asking again will not help.',
        retryable: false,
      },
      { kind: 'stub', ok: true },
    ]);
    // The class only: an error's message may carry request data.
    expect(error).toHaveBeenCalledWith(
      '[ixo-chain] kind broken threw: TypeError',
    );
  });
  it('keeps a Blocksync field that is not under its alias out of the document', async () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const posts: string[] = [];
    stubFetch((url, init) => {
      posts.push(queryOf(init));
      return json({ data: { r1: { totalCount: 0, nodes: [] } } });
    });
    const misaliased = defineKind({
      name: 'misaliased',
      summary: 'A stub Blocksync kind.',
      explain: 'For tests.',
      source: 'blocksync',
      list: false,
      args: z.strictObject({}),
      example: {},
      plan: () => ({
        source: 'blocksync',
        field: () => 'r9: claims { totalCount }',
        shape: () => ({ ok: true, data: null }),
      }),
    });
    expect(
      await runRequests(
        callFor(),
        USER,
        [{ kind: misaliased }, { kind: core('token_balances') }],
        OPTIONS,
      ),
    ).toMatchObject([
      { kind: 'misaliased', ok: false, reason: 'unavailable' },
      { kind: 'token_balances', ok: true },
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).not.toContain('r9:');
    expect(error).toHaveBeenCalledWith(
      '[ixo-chain] kind misaliased threw: Error',
    );
  });
});

describe('chainLookup', () => {
  it('cuts the answer to the size cap, leaving out the largest answer that cannot be cut', async () => {
    stubFetch(() =>
      json({
        data: {
          r1: {
            id: `did:ixo:entity:${'a'.repeat(32)}`,
            type: 'dao',
          },
        },
      }),
    );
    const big = stubKind('big', async () => ({ blob: 'x'.repeat(13_000) }));
    const small = stubKind('small', async () => ({ rows: [1, 2, 3] }));
    const answer = await chainLookup(
      callFor(),
      USER,
      [
        { kind: big, args: { id: 'a' } },
        {
          kind: core('entity'),
          args: { id: `did:ixo:entity:${'a'.repeat(32)}` },
        },
        { kind: small, args: { id: 'b' } },
      ],
      OPTIONS,
    );
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(answer).toEqual({
      ok: true,
      network: 'mainnet',
      fetchedAt: expect.any(String),
      results: [
        {
          kind: 'big',
          source: 'chain',
          ok: false,
          reason: 'too_large',
          detail: 'Left out to keep the answer small; ask for it on its own.',
          retryable: false,
        },
        {
          kind: 'entity',
          source: 'blocksync',
          ok: true,
          subject: 'other',
          data: expect.objectContaining({ type: 'dao' }),
        },
        {
          kind: 'small',
          source: 'chain',
          ok: true,
          data: { rows: [1, 2, 3] },
        },
      ],
    });
  });

  it('halves the lists of a chain answer before leaving anything out', async () => {
    stubFetch(() => json({}));
    const rows = stubKind('rows', async () => ({
      items: Array.from({ length: 200 }, (_, i) => ({
        i,
        pad: 'p'.repeat(100),
      })),
    }));
    const answer = await chainLookup(
      callFor(),
      USER,
      [{ kind: rows, args: { id: 'a' } }],
      OPTIONS,
    );
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(answer.results).toMatchObject([
      { kind: 'rows', ok: true, truncated: true },
    ]);
  });
});

describe('fitNames', () => {
  const entity = (n: number) =>
    `did:ixo:entity:${n.toString(16).padStart(32, '0')}`;
  const namesOf = (ids: readonly string[]): NameMap =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        {
          name: `Entity ${id.slice(-4)} ${'n'.repeat(100)}`,
          source: 'entity',
          selfChosen: false,
        },
      ]),
    );
  const answerOf = (data: unknown, names: NameMap): LookupAnswer => ({
    ok: true,
    network: 'mainnet',
    fetchedAt: '2026-10-30T00:00:00.000Z',
    results: [{ kind: 'entities', source: 'blocksync', ok: true, data }],
    names,
  });
  const fit = (answer: LookupAnswer) =>
    fitNames(answer, () => cutRowAcross(answer.results));

  it('leaves an answer that fits as it is', () => {
    const ids = [entity(1), entity(2)];
    const answer = answerOf({ items: ids.map((id) => ({ id })) }, namesOf(ids));
    const before = structuredClone(answer);
    fit(answer);
    expect(answer).toEqual(before);
  });

  it('cuts rows first, one at a time, then leaves out the names of the identifiers cut', () => {
    const ids = Array.from({ length: 40 }, (_, n) => entity(n));
    const rowsOf = (count: number) =>
      ids.slice(0, count).map((id) => ({ id, pad: 'p'.repeat(200) }));
    const answer = answerOf({ items: rowsOf(40) }, namesOf(ids));
    expect(JSON.stringify(answer).length).toBeGreaterThan(MAX_RESULT_CHARS);
    fit(answer);
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(answer.results).toMatchObject([{ ok: true, truncated: true }]);
    const [result] = answer.results;
    const { items: kept } = z
      .object({ items: z.array(z.object({ id: z.string() })) })
      .parse(result?.ok ? result.data : null);
    // The most rows that fit with their names: one more would not.
    const fits = (count: number) => {
      const candidate = answerOf(
        { items: rowsOf(count) },
        namesOf(ids.slice(0, count)),
      );
      const [only] = candidate.results;
      if (only?.ok) only.truncated = true;
      return JSON.stringify(candidate).length <= MAX_RESULT_CHARS;
    };
    expect(fits(kept.length)).toBe(true);
    expect(fits(kept.length + 1)).toBe(false);
    expect(kept.length).toBeGreaterThan(20);
    expect(kept.map((row) => row.id)).toEqual(ids.slice(0, kept.length));
    expect(Object.keys(answer.names ?? {})).toEqual(kept.map((row) => row.id));
  });

  it('cuts the last row of the largest list in any result', () => {
    const answer = answerOf(
      { small: [1, 2], large: ['a'.repeat(50), 'b'.repeat(50), 'c'] },
      {},
    );
    answer.results.push({
      kind: 'other',
      source: 'chain',
      ok: true,
      data: { rows: ['x', 'y'] },
    });
    expect(cutRowAcross(answer.results)).toBe(true);
    expect(answer.results).toMatchObject([
      {
        ok: true,
        truncated: true,
        data: { small: [1, 2], large: ['a'.repeat(50), 'b'.repeat(50)] },
      },
      { ok: true, data: { rows: ['x', 'y'] } },
    ]);
    expect(answer.results[1]).not.toHaveProperty('truncated');
  });

  it('cutRow keeps one row of every list and says when none is left to cut', () => {
    const holder: { truncated?: boolean; tokens: string[] } = {
      tokens: ['a', 'b'],
    };
    expect(cutRow(holder, holder.tokens)).toBe(true);
    expect(holder).toEqual({ tokens: ['a'], truncated: true });
    expect(cutRow(holder, holder.tokens)).toBe(false);
    expect(holder.tokens).toEqual(['a']);
  });

  it('with no row left to cut, leaves out names from the end, never a result', () => {
    const ids = Array.from({ length: 10 }, (_, n) => entity(n));
    const record = Object.fromEntries(ids.map((id, n) => [`e${n}`, id]));
    const answer = answerOf(
      { ...record, blob: 'x'.repeat(10_500) },
      namesOf(ids),
    );
    fit(answer);
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(answer.results).toMatchObject([{ ok: true, kind: 'entities' }]);
    expect(answer.results[0]).not.toHaveProperty('truncated');
    const left = Object.keys(answer.names ?? {});
    expect(left.length).toBeGreaterThan(0);
    expect(left).toEqual(ids.slice(0, left.length));
  });

  it('removes the map once no name is left', () => {
    const answer = answerOf(
      { owner: entity(1), blob: 'x'.repeat(11_700) },
      namesOf([entity(1)]),
    );
    fit(answer);
    expect(answer).not.toHaveProperty('names');
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  });
});
