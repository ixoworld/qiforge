/**
 * First-turn user-context prefetch over fake deps: the six batch queries
 * (checked against `@ixo/common`'s builders), the request headers, slot
 * mapping and trimming (string caps, the whole-context budget), the
 * positive, empty-answer and negative caches, sanitised failure reasons,
 * the skip paths, the blocking cap, in-flight dedup, the LRU bound and
 * `status()`.
 */
import { MemoryEngineService } from '@ixo/common/services/memory-engine/memory-engine.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildUserContextQueries,
  capUserContextText,
  fitUserContextBudget,
  trimUserContextSlot,
  USER_CONTEXT_MAX_JSON_CHARS,
  USER_CONTEXT_MAX_TEXT_CHARS,
  UserContextFetcher,
  type UserContextFetcherDeps,
  type UserContextFetcherOptions,
  type UserContextDateFilter,
  type UserContextQuery,
} from './user-context-fetcher';

const ORACLE_DID = 'did:ixo:oracle';
const PARAMS = { roomId: '!room:x', userDid: 'did:ixo:user', sessionId: 's1' };
const NOW = new Date('2026-10-20T12:00:00.000Z');

function slot(
  overrides: {
    facts?: string[];
    entities?: string[];
    episodes?: string[];
    communities?: string[];
  } = {},
) {
  const facts = (overrides.facts ?? []).map((fact, i) => ({
    uuid: `f${i}`,
    fact,
    source_node_uuid: 'a',
    target_node_uuid: 'b',
    created_at: '2026-10-01T00:00:00Z',
    valid_at: null,
    invalid_at: null,
  }));
  const entities = (overrides.entities ?? []).map((name, i) => ({
    uuid: `e${i}`,
    name,
    summary: `${name} summary`,
    labels: ['Entity', 'Person'],
    group_id: 'g',
    created_at: '2026-10-01T00:00:00Z',
  }));
  const episodes = (overrides.episodes ?? []).map((content, i) => ({
    uuid: `p${i}`,
    name: `episode ${i}`,
    content,
    created_at: '2026-10-02T09:00:00Z',
    group_id: 'g',
  }));
  const communities = (overrides.communities ?? []).map((name, i) => ({
    uuid: `c${i}`,
    name,
    summary: `${name} cluster`,
    created_at: null,
  }));
  return {
    strategy_used: 'balanced',
    query: 'q',
    total_results: {
      facts: facts.length,
      entities: entities.length,
      episodes: episodes.length,
      communities: communities.length,
    },
    facts,
    entities,
    episodes,
    communities,
  };
}

function batchBody(results: unknown[]): string {
  return JSON.stringify({ results });
}

const SIX_SLOTS = batchBody([
  slot({ facts: ['The user is called Zed'], entities: ['Zed'] }),
  slot({ facts: ['Zed builds oracles'] }),
  slot(),
  slot({ communities: ['Sailing'] }),
  slot(),
  slot({ episodes: ['Talked about the Aegean'] }),
]);

type Reply = { status: number; body?: string } | Error;

interface Deferred {
  resolve(reply: Reply): void;
}

interface Harness {
  fetcher: UserContextFetcher;
  calls: Array<{ url: string; init: RequestInit }>;
  minted: Array<{ target: { did: string; capability: string }; can?: string }>;
  logs: string[];
  /** Replies queued for the next requests; `'hold'` returns a pending reply. */
  replies: Array<Reply | 'hold'>;
  held: Deferred[];
}

function toResponse(reply: Reply): Response {
  if (reply instanceof Error) throw reply;
  return new Response(reply.body ?? '', { status: reply.status });
}

function harness(
  overrides: Partial<UserContextFetcherDeps> & {
    replies?: Array<Reply | 'hold'>;
    options?: UserContextFetcherOptions;
  } = {},
): Harness {
  const calls: Harness['calls'] = [];
  const minted: Harness['minted'] = [];
  const logs: string[] = [];
  const replies: Harness['replies'] = overrides.replies ?? [
    { status: 200, body: SIX_SLOTS },
  ];
  const held: Deferred[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (next !== 'hold') return toResponse(next);
    return new Promise<Response>((resolve, reject) => {
      held.push({
        resolve: (reply) => {
          try {
            resolve(toResponse(reply));
          } catch (err) {
            reject(err);
          }
        },
      });
    });
  };
  const capture =
    (level: string) =>
    (message: unknown): void => {
      logs.push(`${level} ${String(message)}`);
    };
  const deps: UserContextFetcherDeps = {
    memoryEngineUrl: 'https://memory.test/',
    oracleDid: ORACLE_DID,
    ucan: {
      hasSigningKey: () => true,
      resolveServiceDid: async () => 'did:web:memory.test',
      mintInvocation: async (target, opts) => {
        minted.push({ target, can: opts?.can });
        return 'INVOCATION';
      },
    },
    logger: {
      log: capture('log'),
      warn: capture('warn'),
      error: capture('error'),
      debug: capture('debug'),
    },
    fetchImpl,
    ...overrides,
  };
  return {
    fetcher: new UserContextFetcher(deps, overrides.options),
    calls,
    minted,
    logs,
    replies,
    held,
  };
}

/** The six request payloads, written out from `@ixo/common`'s builders. */
function expectedQueries(recentSince: string): UserContextQuery[] {
  const current: UserContextDateFilter[][] = [
    [{ date: null, comparison_operator: 'IS NULL' }],
  ];
  return [
    {
      oracle_dids: [ORACLE_DID],
      query:
        'Who is the user — their name, age, background, personality traits, communication style, beliefs, values, and the core attributes that define how they see themselves and how they like to be addressed.',
      strategy: 'balanced',
      max_facts: 12,
      max_entities: 8,
      max_episodes: 3,
      max_communities: 2,
      knowledge_level: 'both',
      search_filters: {
        node_labels: [
          'Person',
          'Trait',
          'Value',
          'Identity',
          'Attribute',
          'Belief',
          'CommunicationStyle',
          'Language',
        ],
        invalid_at: current,
      },
    },
    {
      oracle_dids: [ORACLE_DID],
      query:
        'What the user works on — their job and role, current and past projects, the tools and technologies they use, code or systems they build, technical problems they solve (migrations, refactors, bug fixes, integrations), and the people they collaborate with at work.',
      strategy: 'balanced',
      max_facts: 15,
      max_entities: 10,
      max_episodes: 5,
      max_communities: 2,
      knowledge_level: 'both',
      search_filters: { invalid_at: current },
    },
    {
      oracle_dids: [ORACLE_DID],
      query:
        'What the user is trying to achieve or improve — goals and aspirations they have stated, things they are learning, habits and routines they are building, milestones they are working toward, and causes they care about.',
      strategy: 'balanced',
      max_facts: 10,
      max_entities: 6,
      max_episodes: 3,
      max_communities: 1,
      knowledge_level: 'both',
      search_filters: { invalid_at: current },
    },
    {
      oracle_dids: [ORACLE_DID],
      query:
        'What the user enjoys, cares about, or finds interesting — hobbies, favorite topics, preferences, products and content they engage with, things they like and dislike, and areas they have built expertise in outside of work.',
      strategy: 'balanced',
      max_facts: 10,
      max_entities: 6,
      max_episodes: 3,
      max_communities: 1,
      knowledge_level: 'both',
      search_filters: { invalid_at: current },
    },
    {
      oracle_dids: [ORACLE_DID],
      query:
        'People the user interacts with or has mentioned — colleagues they work with, collaborators on projects, friends and family members, and any named individuals or groups they have brought up in conversation.',
      strategy: 'balanced',
      max_facts: 8,
      max_entities: 10,
      max_episodes: 3,
      max_communities: 1,
      knowledge_level: 'both',
      search_filters: { invalid_at: current },
    },
    {
      oracle_dids: [ORACLE_DID],
      query:
        'What the user has been doing, focusing on, or talking about recently — current activities, decisions they have made, ongoing problems they are working through, and topics that have come up in recent conversations.',
      strategy: 'recent_memory',
      max_facts: 10,
      max_entities: 6,
      max_episodes: 8,
      max_communities: 2,
      knowledge_level: 'both',
      search_filters: {
        created_at: [[{ date: recentSince, comparison_operator: '>=' }]],
      },
    },
  ];
}

function sentQueries(call: { init: RequestInit }): unknown {
  return JSON.parse(String(call.init.body)).queries;
}

describe('buildUserContextQueries', () => {
  it('produces the six Node payloads field for field, with the recent slot bounded to the last 90 days', () => {
    expect(buildUserContextQueries(ORACLE_DID, NOW)).toEqual(
      expectedQueries('2026-07-22T12:00:00.000Z'),
    );
  });

  it("matches @ixo/common's MemoryEngineService builders on the wire", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(batchBody([]), { status: 200 });
    });
    try {
      await new MemoryEngineService('https://memory.test').gatherUserContext({
        oracleDid: ORACLE_DID,
        roomId: '!room:x',
        oracleToken: '',
        userToken: '',
        oracleHomeServer: '',
        userHomeServer: '',
        ucanInvocation: 'INVOCATION',
      });
    } finally {
      vi.unstubAllGlobals();
    }
    const ours = buildUserContextQueries(ORACLE_DID, new Date());
    expect(bodies).toHaveLength(1);
    const node = JSON.parse(JSON.stringify(bodies[0])).queries;
    // The Node builder steps the date back in local time; the 90-day
    // windows agree up to a DST shift and the milliseconds between calls.
    const nodeSince = Date.parse(node[5].search_filters.created_at[0][0].date);
    const ourSince = Date.parse(
      ours[5]!.search_filters.created_at![0]![0]!.date!,
    );
    expect(Math.abs(nodeSince - ourSince)).toBeLessThanOrEqual(
      3_600_000 + 5_000,
    );
    node[5].search_filters.created_at[0][0].date = 'X';
    const oursComparable = JSON.parse(JSON.stringify(ours));
    oursComparable[5].search_filters.created_at[0][0].date = 'X';
    expect(oursComparable).toEqual(node);
  });
});

describe('trimUserContextSlot', () => {
  it('keeps only what the prompt renders and the totals', () => {
    expect(
      trimUserContextSlot(
        slot({
          facts: ['a fact'],
          entities: ['Zed'],
          episodes: ['an episode'],
          communities: ['Sailing'],
        }),
      ),
    ).toEqual({
      facts: [{ fact: 'a fact' }],
      entities: [
        { name: 'Zed', labels: ['Entity', 'Person'], summary: 'Zed summary' },
      ],
      episodes: [{ content: 'an episode', created_at: '2026-10-02T09:00:00Z' }],
      communities: [{ name: 'Sailing', summary: 'Sailing cluster' }],
      total_results: { facts: 1, entities: 1, episodes: 1, communities: 1 },
    });
  });

  it('drops malformed and blank entries and leaves empty arrays out', () => {
    expect(
      trimUserContextSlot({
        facts: [{ fact: null }, { fact: '  ' }, 'oops', { fact: 'kept' }],
        entities: [{ summary: 'no name' }, { name: '' }, null],
        episodes: [{ content: null, created_at: '2026-01-01' }],
        communities: [],
      }),
    ).toEqual({ facts: [{ fact: 'kept' }] });
  });

  it('caps every stored fact, summary and episode at 400 characters', () => {
    const long = 'word '.repeat(200).trim(); // 999 characters
    const trimmed = trimUserContextSlot({
      facts: [{ fact: long }],
      entities: [{ name: 'Zed', summary: long }],
      episodes: [{ content: long }],
      communities: [{ name: 'Sailing', summary: long }],
    });
    const capped = capUserContextText(long);
    expect(capped.length).toBeLessThanOrEqual(USER_CONTEXT_MAX_TEXT_CHARS);
    // Cut at a word boundary, then the ellipsis.
    expect(capped).toMatch(/ word…$/);
    expect(trimmed).toEqual({
      facts: [{ fact: capped }],
      entities: [{ name: 'Zed', summary: capped }],
      episodes: [{ content: capped }],
      communities: [{ name: 'Sailing', summary: capped }],
    });
  });
});

describe('capUserContextText', () => {
  it('keeps text within the cap unchanged', () => {
    const exact = 'x'.repeat(USER_CONTEXT_MAX_TEXT_CHARS);
    expect(capUserContextText(exact)).toBe(exact);
  });

  it('cuts at the last word boundary inside the cap', () => {
    expect(capUserContextText('alpha beta gamma delta', 12)).toBe(
      'alpha beta…',
    );
  });

  it('cuts hard when the only boundary would drop more than half', () => {
    const text = `ab ${'c'.repeat(30)}`;
    const capped = capUserContextText(text, 12);
    expect(capped).toBe(`ab ${'c'.repeat(8)}…`);
    expect(capped).toHaveLength(12);
  });
});

describe('fitUserContextBudget', () => {
  const episode = (n: number) => ({
    content: `episode ${n} ${'e'.repeat(90)}`,
  });
  const entity = (n: number) => ({
    name: `entity ${n}`,
    summary: `summary ${n} ${'s'.repeat(90)}`,
  });

  it('leaves a context within the budget as it is', () => {
    const context = { identity: { facts: [{ fact: 'a' }] } };
    expect(fitUserContextBudget(context, 1_000)).toEqual({
      context,
      droppedEpisodes: 0,
      droppedSummaries: 0,
    });
  });

  it('drops episodes from the end of each slot, round-robin, until it fits', () => {
    const context = {
      identity: {
        facts: [{ fact: 'kept' }],
        episodes: [episode(1), episode(2)],
      },
      recent: { episodes: [episode(3), episode(4), episode(5)] },
    };
    const before = JSON.stringify(context).length;
    // Room for roughly two episodes less than the input.
    const budget = before - 150;
    const fitted = fitUserContextBudget(context, budget);
    expect(JSON.stringify(fitted.context).length).toBeLessThanOrEqual(budget);
    // One from each slot, from the end: identity's 2nd and recent's 3rd.
    expect(fitted).toEqual({
      context: {
        identity: { facts: [{ fact: 'kept' }], episodes: [episode(1)] },
        recent: { episodes: [episode(3), episode(4)] },
      },
      droppedEpisodes: 2,
      droppedSummaries: 0,
    });
    // The input is not modified.
    expect(context.recent.episodes).toHaveLength(3);
  });

  it('drops entity summaries after every episode, and omits a slot left empty', () => {
    const context = {
      identity: { entities: [entity(1), entity(2)] },
      recent: { episodes: [episode(1)] },
    };
    const fitted = fitUserContextBudget(context, 140);
    expect(fitted.droppedEpisodes).toBe(1);
    expect(fitted.droppedSummaries).toBe(2);
    expect(fitted.context).toEqual({
      identity: { entities: [{ name: 'entity 1' }, { name: 'entity 2' }] },
    });
    expect(JSON.stringify(fitted.context).length).toBeLessThanOrEqual(140);
  });

  it('keeps facts even when they alone exceed the budget', () => {
    const context = { work: { facts: [{ fact: 'f'.repeat(200) }] } };
    expect(fitUserContextBudget(context, 50)).toEqual({
      context,
      droppedEpisodes: 0,
      droppedSummaries: 0,
    });
  });
});

describe('UserContextFetcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts the six queries to <MEMORY_ENGINE_URL>/search-enhanced-batch with UCAN + room headers', async () => {
    const h = harness();
    const outcome = await h.fetcher.fetch(PARAMS);

    expect(outcome.kind).toBe('fresh');
    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call!.url).toBe('https://memory.test/search-enhanced-batch');
    expect(call!.init.method).toBe('POST');
    expect(call!.init.headers).toEqual({
      Authorization: 'Bearer INVOCATION',
      'X-Auth-Type': 'ucan',
      'x-room-id': '!room:x',
      'Content-Type': 'application/json',
    });
    expect(call!.init.signal).toBeInstanceOf(AbortSignal);
    expect(sentQueries(call!)).toEqual(
      expectedQueries('2026-07-22T12:00:00.000Z'),
    );
    expect(h.minted).toEqual([
      {
        target: { did: 'did:web:memory.test', capability: 'ixo:memory' },
        can: 'memory/*',
      },
    ]);
  });

  it('maps slots in query order, trims them and omits empty ones', async () => {
    const h = harness();
    const outcome = await h.fetcher.fetch(PARAMS);
    if (outcome.kind !== 'fresh') throw new Error(`got ${outcome.kind}`);

    expect(outcome.context).toEqual({
      identity: {
        facts: [{ fact: 'The user is called Zed' }],
        entities: [
          { name: 'Zed', labels: ['Entity', 'Person'], summary: 'Zed summary' },
        ],
        total_results: { facts: 1, entities: 1, episodes: 0, communities: 0 },
      },
      work: {
        facts: [{ fact: 'Zed builds oracles' }],
        total_results: { facts: 1, entities: 0, episodes: 0, communities: 0 },
      },
      interests: {
        communities: [{ name: 'Sailing', summary: 'Sailing cluster' }],
        total_results: { facts: 0, entities: 0, episodes: 0, communities: 1 },
      },
      recent: {
        episodes: [
          {
            content: 'Talked about the Aegean',
            created_at: '2026-10-02T09:00:00Z',
          },
        ],
        total_results: { facts: 0, entities: 0, episodes: 1, communities: 0 },
      },
    });
    expect(outcome.slots).toEqual({
      identity: 'f1/e1/p0/c0',
      work: 'f1/e0/p0/c0',
      goals: 'f0/e0/p0/c0',
      interests: 'f0/e0/p0/c1',
      relationships: 'f0/e0/p0/c0',
      recent: 'f0/e0/p1/c0',
    });
    expect(h.logs).toContainEqual(
      expect.stringMatching(
        /^log \[user-context\] fetched in \d+ ms for room=!room:x \(identity=f1\/e1\/p0\/c0, work=f1\/e0\/p0\/c0, goals=f0\/e0\/p0\/c0, interests=f0\/e0\/p0\/c1, relationships=f0\/e0\/p0\/c0, recent=f0\/e0\/p1\/c0\)$/,
      ),
    );
    // No user content in the logs.
    expect(h.logs.join('\n')).not.toMatch(/Zed|Aegean|Sailing/);
  });

  it('treats error slots and a short batch as missing slots, not a failure', async () => {
    const h = harness({
      replies: [
        {
          status: 200,
          body: batchBody([
            {
              error: { status_code: 504, detail: 'graph timeout' },
              query: 'q',
              strategy_used: 'balanced',
            },
            slot({ facts: ['Zed builds oracles'] }),
            slot(),
            slot(),
            slot(),
          ]),
        },
      ],
    });
    const outcome = await h.fetcher.fetch(PARAMS);
    if (outcome.kind !== 'fresh') throw new Error(`got ${outcome.kind}`);

    expect(Object.keys(outcome.context)).toEqual(['work']);
    expect(outcome.slots.identity).toBe('missing');
    expect(outcome.slots.recent).toBe('missing');
    expect(h.logs).toContain('warn [user-context] slot identity failed (504)');
    // The engine's detail can echo the query: debug level only.
    expect(h.logs).toContain(
      'debug [user-context] slot identity failure detail: graph timeout',
    );
    expect(
      h.logs.filter((l) => !l.startsWith('debug ')).join('\n'),
    ).not.toContain('graph timeout');
    expect(h.logs).toContain(
      'warn [user-context] batch length mismatch for room=!room:x: expected 6, got 5',
    );
    // A partially failed batch is still a positive answer.
    await expect(h.fetcher.fetch(PARAMS)).resolves.toMatchObject({
      kind: 'cached',
    });
    expect(h.calls).toHaveLength(1);
  });

  it('caches an all-empty answer as "no memory yet" for 30 s, not the full TTL', async () => {
    const h = harness({
      replies: [
        {
          status: 200,
          body: batchBody([slot(), slot(), slot(), slot(), slot(), slot()]),
        },
        { status: 200, body: SIX_SLOTS },
      ],
      options: { cacheTtlMs: 300_000 },
    });
    await expect(h.fetcher.fetch(PARAMS)).resolves.toMatchObject({
      kind: 'fresh',
      context: {},
    });
    vi.advanceTimersByTime(29_999);
    await expect(h.fetcher.fetch(PARAMS)).resolves.toMatchObject({
      kind: 'cached',
      context: {},
    });
    expect(h.calls).toHaveLength(1);

    vi.advanceTimersByTime(1);
    const next = await h.fetcher.fetch(PARAMS);
    expect(next.kind).toBe('fresh');
    expect(h.calls).toHaveLength(2);
    // A non-empty answer keeps the full TTL.
    vi.advanceTimersByTime(299_999);
    await expect(h.fetcher.fetch(PARAMS)).resolves.toMatchObject({
      kind: 'cached',
    });
    expect(h.calls).toHaveLength(2);
  });

  it('never keeps an empty answer longer than the cache TTL', async () => {
    const h = harness({
      replies: [
        {
          status: 200,
          body: batchBody([slot(), slot(), slot(), slot(), slot(), slot()]),
        },
      ],
      options: { cacheTtlMs: 10_000, emptyCacheTtlMs: 30_000 },
    });
    await h.fetcher.fetch(PARAMS);
    vi.advanceTimersByTime(10_000);
    await expect(h.fetcher.fetch(PARAMS)).resolves.toMatchObject({
      kind: 'fresh',
    });
    expect(h.calls).toHaveLength(2);
  });

  it.each([
    [
      'every slot an error',
      batchBody(
        Array.from({ length: 6 }, () => ({
          error: { status_code: 500, detail: 'down' },
          query: 'q',
          strategy_used: 'balanced',
        })),
      ),
    ],
    ['an empty results array', batchBody([])],
  ])('treats %s as failed and negative-caches it', async (_label, body) => {
    const h = harness({
      replies: [{ status: 200, body }],
      options: { failureTtlMs: 60_000 },
    });
    await expect(h.fetcher.fetch(PARAMS)).resolves.toEqual({
      kind: 'failed',
      reason: 'every slot failed',
    });
    expect(h.logs).toContain(
      'warn [user-context] failed for room=!room:x: every slot failed (not retried for 60s)',
    );
    await expect(h.fetcher.fetch(PARAMS)).resolves.toEqual({
      kind: 'skipped',
      reason: 'recently-failed',
    });
    expect(h.calls).toHaveLength(1);
    expect(h.fetcher.status(PARAMS.roomId).cached).toBe(false);
  });

  it('holds the stored context under the budget and says what it dropped', async () => {
    const longEpisodes = Array.from(
      { length: 8 },
      (_, i) => `episode ${i} ${'word '.repeat(100)}`,
    );
    const h = harness({
      replies: [
        {
          status: 200,
          body: batchBody(
            Array.from({ length: 6 }, () =>
              slot({ facts: ['kept fact'], episodes: longEpisodes }),
            ),
          ),
        },
      ],
    });
    const outcome = await h.fetcher.fetch(PARAMS);
    if (outcome.kind !== 'fresh') throw new Error(`got ${outcome.kind}`);
    expect(JSON.stringify(outcome.context).length).toBeLessThanOrEqual(
      USER_CONTEXT_MAX_JSON_CHARS,
    );
    // Every slot keeps its fact; the per-slot counts are what is stored.
    for (const value of Object.values(outcome.slots)) {
      expect(value).toMatch(/^f1\/e0\/p\d\/c0$/);
    }
    expect(h.logs).toContainEqual(
      expect.stringMatching(
        /^log \[user-context\] context over 16384 chars for room=!room:x; dropped \d+ episodes and 0 entity summaries$/,
      ),
    );
  });

  it('serves the room from cache across sessions until the TTL, then fetches again', async () => {
    const h = harness({ options: { cacheTtlMs: 300_000 } });
    const first = await h.fetcher.fetch(PARAMS);
    if (first.kind !== 'fresh') throw new Error(`got ${first.kind}`);

    vi.advanceTimersByTime(299_999);
    const second = await h.fetcher.fetch({ ...PARAMS, sessionId: 's2' });
    expect(second).toEqual({
      kind: 'cached',
      context: first.context,
      ageMs: 299_999,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.logs).toContain(
      'log [user-context] cache hit room=!room:x age=299999ms keys=4',
    );

    vi.advanceTimersByTime(1);
    await expect(h.fetcher.fetch(PARAMS)).resolves.toMatchObject({
      kind: 'fresh',
    });
    expect(h.calls).toHaveLength(2);
  });

  it.each([
    [
      'an HTTP 500',
      // The body is never read into the reason.
      { status: 500, body: 'boom: Who is the user' },
      'memory engine answered 500',
    ],
    ['a network error', new TypeError('fetch failed'), 'fetch failed'],
    [
      'a request timeout',
      new DOMException('The operation timed out.', 'TimeoutError'),
      'The operation timed out.',
    ],
    [
      'a malformed body',
      { status: 200, body: '{"nope":1}' },
      'malformed response (no results array)',
    ],
    [
      'a non-JSON body',
      { status: 200, body: '<html>Who is the user' },
      'malformed response (invalid JSON)',
    ],
  ] satisfies Array<[string, Reply, unknown]>)(
    'negative-caches %s for the failure TTL, then retries',
    async (_label, reply, reason) => {
      const h = harness({
        replies: [reply, { status: 200, body: SIX_SLOTS }],
        options: { failureTtlMs: 60_000 },
      });
      const outcome = await h.fetcher.fetch(PARAMS);
      expect(outcome).toEqual({ kind: 'failed', reason });
      expect(h.logs.join('\n')).not.toContain('Who is the user');

      vi.advanceTimersByTime(59_999);
      await expect(h.fetcher.fetch(PARAMS)).resolves.toEqual({
        kind: 'skipped',
        reason: 'recently-failed',
      });
      await h.fetcher.refresh(PARAMS);
      expect(h.calls).toHaveLength(1);

      vi.advanceTimersByTime(1);
      await expect(h.fetcher.fetch(PARAMS)).resolves.toMatchObject({
        kind: 'fresh',
      });
      expect(h.calls).toHaveLength(2);
    },
  );

  it('skips without a request when prerequisites are missing', async () => {
    const noUrl = harness({ memoryEngineUrl: undefined });
    await expect(noUrl.fetcher.fetch(PARAMS)).resolves.toEqual({
      kind: 'skipped',
      reason: 'no-engine-url',
    });

    const noRoom = harness();
    await expect(
      noRoom.fetcher.fetch({ ...PARAMS, roomId: '' }),
    ).resolves.toEqual({ kind: 'skipped', reason: 'no-room' });

    const noKey = harness({
      ucan: {
        hasSigningKey: () => false,
        resolveServiceDid: async () => 'did:web:memory.test',
        mintInvocation: async () => 'INVOCATION',
      },
    });
    await expect(noKey.fetcher.fetch(PARAMS)).resolves.toEqual({
      kind: 'skipped',
      reason: 'no-signing-key',
    });

    const noDid = harness({
      ucan: {
        hasSigningKey: () => true,
        resolveServiceDid: async () => null,
        mintInvocation: async () => 'INVOCATION',
      },
    });
    await expect(noDid.fetcher.fetch(PARAMS)).resolves.toEqual({
      kind: 'skipped',
      reason: 'no-invocation',
    });

    for (const h of [noUrl, noRoom, noKey, noDid]) expect(h.calls).toEqual([]);
  });

  it('does not negative-cache a missing delegation: the next turn mints again', async () => {
    let delegated = false;
    const h = harness({
      ucan: {
        hasSigningKey: () => true,
        resolveServiceDid: async () => 'did:web:memory.test',
        mintInvocation: async () => {
          if (!delegated) throw new Error('no ixo:memory delegation');
          return 'INVOCATION';
        },
      },
    });
    await expect(h.fetcher.fetch(PARAMS)).resolves.toEqual({
      kind: 'skipped',
      reason: 'no-invocation',
    });
    expect(h.calls).toEqual([]);

    delegated = true;
    await expect(h.fetcher.fetch(PARAMS)).resolves.toMatchObject({
      kind: 'fresh',
    });
    expect(h.calls).toHaveLength(1);
  });

  it('returns timeout at the blocking cap; the late answer lands in the cache', async () => {
    const h = harness({ replies: ['hold'], options: { blockingCapMs: 3_000 } });
    const pending = h.fetcher.fetch(PARAMS);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.held).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ kind: 'timeout', capMs: 3_000 });
    expect(h.logs).toContain(
      'warn [user-context] exceeded 3000ms cap for room=!room:x; continuing in the background',
    );
    expect(h.fetcher.status(PARAMS.roomId)).toMatchObject({
      cached: false,
      inFlight: true,
      lastOutcome: { kind: 'timeout', capMs: 3_000 },
    });

    // The caller keeps the object alive on the joined gather.
    const background = h.fetcher.refresh(PARAMS);
    h.held[0]!.resolve({ status: 200, body: SIX_SLOTS });
    await background;

    await expect(
      h.fetcher.fetch({ ...PARAMS, sessionId: 's2' }),
    ).resolves.toMatchObject({ kind: 'cached' });
    expect(h.calls).toHaveLength(1);
  });

  it('with a zero cap never waits but still gathers in the background', async () => {
    const h = harness({ options: { blockingCapMs: 0 } });
    await expect(h.fetcher.fetch(PARAMS)).resolves.toEqual({
      kind: 'timeout',
      capMs: 0,
    });
    await h.fetcher.refresh(PARAMS);
    await expect(h.fetcher.fetch(PARAMS)).resolves.toMatchObject({
      kind: 'cached',
    });
    expect(h.calls).toHaveLength(1);
  });

  it('joins one in-flight gather per room', async () => {
    const h = harness({ replies: ['hold'] });
    const a = h.fetcher.fetch(PARAMS);
    const b = h.fetcher.fetch({ ...PARAMS, sessionId: 's2' });
    const c = h.fetcher.refresh(PARAMS);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(1);

    h.held[0]!.resolve({ status: 200, body: SIX_SLOTS });
    const [ra, rb] = await Promise.all([a, b, c]);
    expect(ra.kind).toBe('fresh');
    expect(rb).toBe(ra);
    expect(h.calls).toHaveLength(1);
  });

  describe('a gather that never settles', () => {
    // The held reply ignores the request's abort signal, so the gather hangs
    // past its own timeout the way a lost request context does. Stale after
    // requestTimeoutMs (1 s) + 5 s grace.
    const STALE_AFTER_MS = 6_000;
    const options = { requestTimeoutMs: 1_000, blockingCapMs: 500 };
    const STALE_SLOTS = batchBody([
      slot({ facts: ['The detached gather answered late'] }),
      slot(),
      slot(),
      slot(),
      slot(),
      slot(),
    ]);

    /** First contact times out at the cap on a held reply. */
    async function strand(h: Harness): Promise<void> {
      const first = h.fetcher.fetch(PARAMS);
      await vi.advanceTimersByTimeAsync(options.blockingCapMs);
      await expect(first).resolves.toEqual({
        kind: 'timeout',
        capMs: options.blockingCapMs,
      });
      expect(h.calls).toHaveLength(1);
    }

    it('is joined within its request timeout plus 5 s', async () => {
      const h = harness({
        replies: ['hold', { status: 200, body: SIX_SLOTS }],
        options,
      });
      await strand(h);
      await vi.advanceTimersByTimeAsync(STALE_AFTER_MS - options.blockingCapMs);

      const joined = h.fetcher.fetch({ ...PARAMS, sessionId: 's2' });
      await vi.advanceTimersByTimeAsync(options.blockingCapMs);
      await expect(joined).resolves.toEqual({
        kind: 'timeout',
        capMs: options.blockingCapMs,
      });
      expect(h.calls).toHaveLength(1);
      expect(h.logs.filter((line) => line.includes('unsettled'))).toEqual([]);
      expect(h.fetcher.status(PARAMS.roomId).inFlight).toBe(true);
    });

    it('is abandoned after that: the next fetch starts a new request and returns its answer', async () => {
      const h = harness({
        replies: ['hold', { status: 200, body: SIX_SLOTS }],
        options,
      });
      await strand(h);
      await vi.advanceTimersByTimeAsync(
        STALE_AFTER_MS - options.blockingCapMs + 1,
      );

      const second = await h.fetcher.fetch({ ...PARAMS, sessionId: 's2' });
      expect(h.logs).toContain(
        `warn [user-context] gather for room=!room:x unsettled after ${STALE_AFTER_MS + 1}ms; starting a new one`,
      );
      expect(h.calls).toHaveLength(2);
      expect(h.held).toHaveLength(1);
      expect(second).toMatchObject({
        kind: 'fresh',
        context: { identity: { facts: [{ fact: 'The user is called Zed' }] } },
      });
      expect(h.fetcher.status(PARAMS.roomId)).toMatchObject({
        cached: true,
        inFlight: false,
      });
    });

    it('does not repopulate the room when the abandoned gather answers late', async () => {
      const h = harness({
        replies: ['hold', { status: 200, body: SIX_SLOTS }],
        options,
      });
      await strand(h);
      // Hold on to the stranded gather, as the turn's `waitUntil` does.
      const detached = h.fetcher.refresh(PARAMS);
      await vi.advanceTimersByTimeAsync(
        STALE_AFTER_MS - options.blockingCapMs + 1,
      );
      const second = await h.fetcher.fetch({ ...PARAMS, sessionId: 's2' });
      if (second.kind !== 'fresh') throw new Error(`got ${second.kind}`);

      h.held[0]!.resolve({ status: 200, body: STALE_SLOTS });
      await detached;

      await expect(
        h.fetcher.fetch({ ...PARAMS, sessionId: 's3' }),
      ).resolves.toEqual({
        kind: 'cached',
        context: second.context,
        ageMs: 0,
      });
      expect(h.calls).toHaveLength(2);
    });
  });

  it('refresh does nothing while the cache is fresh and never rejects', async () => {
    const h = harness();
    await h.fetcher.fetch(PARAMS);
    await h.fetcher.refresh(PARAMS);
    expect(h.calls).toHaveLength(1);

    const failing = harness({ replies: [new TypeError('fetch failed')] });
    await expect(failing.fetcher.refresh(PARAMS)).resolves.toBeUndefined();
    expect(failing.fetcher.status(PARAMS.roomId).lastOutcome).toEqual({
      kind: 'failed',
      reason: 'fetch failed',
    });

    const throwing = harness({
      ucan: {
        hasSigningKey: () => {
          throw new Error('keystore gone');
        },
        resolveServiceDid: async () => null,
        mintInvocation: async () => 'INVOCATION',
      },
    });
    await expect(throwing.fetcher.refresh(PARAMS)).resolves.toBeUndefined();
    await expect(throwing.fetcher.fetch(PARAMS)).resolves.toEqual({
      kind: 'failed',
      reason: 'keystore gone',
    });
    expect(throwing.calls).toEqual([]);
  });

  it('keeps at most maxCachedRooms rooms, evicting the least recently used', async () => {
    const h = harness({ options: { maxCachedRooms: 2 } });
    const room = (roomId: string) => ({ ...PARAMS, roomId });
    await h.fetcher.fetch(room('!a:x'));
    await h.fetcher.fetch(room('!b:x'));
    // Touch a, so b is the least recently used when c arrives.
    await expect(h.fetcher.fetch(room('!a:x'))).resolves.toMatchObject({
      kind: 'cached',
    });
    await h.fetcher.fetch(room('!c:x'));
    expect(h.calls).toHaveLength(3);

    expect(h.fetcher.status('!a:x').cached).toBe(true);
    expect(h.fetcher.status('!b:x').cached).toBe(false);
    expect(h.fetcher.status('!c:x').cached).toBe(true);
    await expect(h.fetcher.fetch(room('!b:x'))).resolves.toMatchObject({
      kind: 'fresh',
    });
    expect(h.calls).toHaveLength(4);
  });

  it('reports cache age, in-flight state and the last outcome in status()', async () => {
    const h = harness({ replies: ['hold'] });
    expect(h.fetcher.status(PARAMS.roomId)).toEqual({
      cached: false,
      inFlight: false,
    });

    const pending = h.fetcher.fetch(PARAMS);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetcher.status(PARAMS.roomId)).toEqual({
      cached: false,
      inFlight: true,
    });

    h.held[0]!.resolve({ status: 200, body: SIX_SLOTS });
    const outcome = await pending;
    vi.advanceTimersByTime(1_500);
    expect(h.fetcher.status(PARAMS.roomId)).toEqual({
      cached: true,
      ageMs: 1_500,
      inFlight: false,
      lastOutcome: outcome,
      lastAt: NOW.getTime(),
    });
  });

  it('invalidate drops the cache and detaches a running gather', async () => {
    const h = harness({ replies: ['hold'] });
    const first = h.fetcher.fetch(PARAMS);
    await vi.advanceTimersByTimeAsync(0);
    h.fetcher.invalidate(PARAMS.roomId);
    expect(h.fetcher.status(PARAMS.roomId).inFlight).toBe(false);

    h.held[0]!.resolve({ status: 200, body: SIX_SLOTS });
    await expect(first).resolves.toMatchObject({ kind: 'fresh' });
    // The detached answer did not repopulate the room.
    expect(h.fetcher.status(PARAMS.roomId).cached).toBe(false);

    h.replies.splice(0, h.replies.length, { status: 200, body: SIX_SLOTS });
    await expect(h.fetcher.fetch(PARAMS)).resolves.toMatchObject({
      kind: 'fresh',
    });
    expect(h.calls).toHaveLength(2);
    h.fetcher.invalidate(PARAMS.roomId);
    expect(h.fetcher.status(PARAMS.roomId).cached).toBe(false);
  });
});
