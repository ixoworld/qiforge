import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { validateManifest } from '../../core/manifest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { UserKvLimitError } from '../../core/user-kv';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';
import { resetUpstreamHealth } from '../ixo-chain/http';
import { JOB_LIST_URLS, resetCatalogCache } from './catalog';
import type { ClefRequest, ClefResponse, ClefRunner } from './clef';
import { allDrafts, draftKey, type Kv } from './drafts';
import milestoneApplication from './fixtures/form-9787-bco.json';
import milestoneClaim from './fixtures/form-9787-vct.json';
import treePlanting from './fixtures/form-8724-vct.json';
import { MAX_RESULT_CHARS, YomaPlugin } from './yoma.plugin';

const ADDRESS = 'ixo1cra6p0jefu8f907gqngkfzxur26k7f73an4v95';
const DID = `did:ixo:${ADDRESS}`;
const ADMIN = 'ixo1x4p6j0h3mzv8e7mhd6q9wquh2vqd9yh5ttnzyg';
const WORKER = JOB_LIST_URLS.mainnet!;
const BLOCKSYNC = 'https://blocksync.test/graphql';
const ENTITY = 'did:ixo:entity:0123456789abcdef0123456789abcdef';
/** A programme on the list with nothing open right now. */
const QUIET = 'did:ixo:entity:fedcba9876543210fedcba9876543210';
const MILESTONE = 'did:ixo:entity:11111111111111111111111111111111';
const TREES = 'did:ixo:entity:22222222222222222222222222222222';
const USDC =
  'ibc/6BBE9BD4246F8E04948D5A4EEE7164B2630263B9EBB5E7DC5F0A46C62A2FF97B';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

const COLLECTIONS = [
  {
    id: '9787',
    entity: ENTITY,
    admin: ADMIN,
    protocol: MILESTONE,
    startDate: null,
    endDate: null,
    quota: '0',
    count: '0',
    payments: null,
  },
  {
    id: '8724',
    entity: ENTITY,
    admin: ADMIN,
    protocol: TREES,
    startDate: null,
    endDate: null,
    quota: '10',
    count: '2',
    payments: { approval: { amount: [{ denom: USDC, amount: '1270000' }] } },
  },
  // Hidden by the admins, and ended: neither is shown.
  {
    id: '9000',
    entity: ENTITY,
    admin: ADMIN,
    protocol: MILESTONE,
    startDate: null,
    endDate: null,
    quota: '0',
    count: '0',
    payments: null,
  },
  {
    id: '733',
    entity: ENTITY,
    admin: ADMIN,
    protocol: MILESTONE,
    startDate: null,
    endDate: '2026-09-13T00:00:00',
    quota: '0',
    count: '0',
    payments: null,
  },
];
const ENTITIES = [
  {
    id: ENTITY,
    settings: { Profile: { serviceEndpoint: 'https://profiles.test/umuzi' } },
    service: [],
    linkedResource: [],
  },
  { id: QUIET, settings: null, service: [], linkedResource: [] },
  {
    id: MILESTONE,
    linkedResource: [
      { id: '{id}#vct', serviceEndpoint: 'https://forms.test/milestone-vct' },
      { id: '{id}#bco', serviceEndpoint: 'forms:/milestone-bco' },
    ],
    service: [
      {
        id: '{id}#forms',
        type: 'Cellnode',
        serviceEndpoint: 'https://forms.test/',
      },
    ],
  },
  {
    id: TREES,
    linkedResource: [
      { id: '{id}#vct', serviceEndpoint: 'https://forms.test/trees-vct' },
    ],
    service: [],
  },
];

/** What the stubbed upstreams answer; tests change it. */
let world: {
  allowed: boolean;
  route?: (
    url: string,
    init?: RequestInit,
  ) => Response | Promise<Response> | undefined;
};

function graphql(query: string) {
  const data: Record<string, unknown> = {};
  if (query.includes('w: claims'))
    data.w = {
      totalCount: 2,
      pageInfo: { hasNextPage: false, endCursor: 'Y3Vyc29y' },
      nodes: [
        {
          claimId: 'bafynewer',
          collectionId: '9787',
          submissionDate: '2026-10-27T09:00:00',
          paymentsStatus: { approval: 'NO_PAYMENT' },
          evaluationByClaimId: null,
        },
        {
          claimId: 'bafyolder',
          collectionId: '8724',
          submissionDate: '2026-10-16T11:34:49.498',
          paymentsStatus: { approval: 'PAID' },
          evaluationByClaimId: {
            status: 1,
            evaluationDate: '2026-10-20T08:00:00',
            amount: [],
          },
        },
      ],
    };
  if (query.includes('c: claimCollections')) data.c = { nodes: COLLECTIONS };
  if (query.includes('e: entities'))
    data.e = {
      nodes: ENTITIES.filter((e) => query.includes(JSON.stringify(e.id))),
    };
  return json({ data });
}

function upstream(
  url: string,
  init?: RequestInit,
): Response | Promise<Response> {
  const special = world.route?.(url, init);
  if (special) return special;
  if (url === `${WORKER}/v1/entities`)
    return json({ data: { entities: [ENTITY, QUIET] } });
  if (url.startsWith(`${WORKER}/v1/collections/`))
    return json({ data: { blacklist: ['9000'] } });
  if (url === BLOCKSYNC)
    return graphql(JSON.parse(String(init?.body)).query as string);
  if (url.includes('/cosmos/authz/v1beta1/grants'))
    return json({
      grants: world.allowed
        ? [
            {
              authorization: {
                '@type': '/ixo.claims.v1beta1.SubmitClaimAuthorization',
                admin: ADMIN,
                constraints: [
                  { collection_id: '9787', agent_quota: '1' },
                  { collection_id: '8724', agent_quota: '3' },
                ],
              },
            },
          ]
        : [],
    });
  if (url === 'https://profiles.test/umuzi')
    return json({ name: 'Umuzi', brand: 'Umuzi', location: 'South Africa' });
  if (url === 'https://forms.test/milestone-vct') return json(milestoneClaim);
  if (url === 'https://forms.test/milestone-bco')
    return json(milestoneApplication);
  if (url === 'https://forms.test/trees-vct') return json(treePlanting);
  return new Response('not found', { status: 404 });
}

let fetcher: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  world = { allowed: true };
  resetCatalogCache();
  resetUpstreamHealth();
  fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    upstream(String(input), init),
  );
  vi.stubGlobal('fetch', fetcher);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function memoryKv() {
  const rows = new Map<string, unknown>();
  const copy = (v: unknown) =>
    v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  return {
    rows,
    get: async (ns: string, k: string) => copy(rows.get(`${ns}/${k}`)),
    set: async (ns: string, k: string, v: unknown) =>
      void rows.set(`${ns}/${k}`, copy(v)),
    update: async (ns: string, k: string, fn: (c: unknown) => unknown) => {
      const next = fn(copy(rows.get(`${ns}/${k}`)));
      if (next === undefined) rows.delete(`${ns}/${k}`);
      else rows.set(`${ns}/${k}`, copy(next));
      return copy(next);
    },
    delete: async (ns: string, k: string) => void rows.delete(`${ns}/${k}`),
  };
}

/** A Clef that always picks the first option. */
const firstOption: ClefRunner = async (
  request: ClefRequest,
): Promise<ClefResponse> => {
  const answers: ClefResponse['answers'] = {};
  for (const [id, q] of Object.entries(request.questions)) {
    if (q.type === 'choice')
      answers[id] = {
        type: 'choice',
        choice: 'option_1',
        probabilities: Object.fromEntries(
          Object.keys(q.criteria).map((k) => [
            k,
            k === 'option_1' ? 0.95 : 0.01,
          ]),
        ),
      };
    else answers[id] = { type: 'noul', noul: id === 'option_1' ? 0.95 : 0.02 };
  }
  return { model: 'clef', answers };
};

type HubActions = NonNullable<RuntimeContext['hubActions']>;
type HubRequest = Parameters<HubActions['request']>[0];
type Reference = Awaited<ReturnType<HubActions['request']>>;
type Capabilities = Awaited<ReturnType<HubActions['capabilities']>>;
type OutcomeStatus = NonNullable<
  Awaited<ReturnType<HubActions['status']>>['outcome']
>['status'];

const reference = (n: number, expiresAt = 1999999999): Reference => ({
  version: 'ixo.auth-action/1',
  id: `action-${n}`,
  accountId: 'account-1',
  bindingId: 'binding-1',
  bindingRevision: 1,
  revision: 1,
  digest: 'd'.repeat(64),
  url: 'https://hub.test/a/1',
  expiresAt,
  title: 'Send your application',
});

const capabilities = (
  operations: Capabilities['operations'],
): Capabilities => ({
  version: 'ixo.auth-capabilities/2',
  accountId: 'account-1',
  oracleDid: 'did:ixo:oracle',
  network: 'ixo mainnet',
  resourceOrigin: null,
  operations,
  forms: [],
  transfer: null,
});

/** A tool answer, read as a plain record (the tools answer JSON). */
const answerSchema = z.record(z.string(), z.any());

/** A stored draft, as the person's storage holds it. */
async function storedDraft(
  kv: Kv,
  form: 'application' | 'claim',
  collectionId: string,
) {
  const key = draftKey(form, collectionId);
  for (const read of await allDrafts(kv))
    if (read.ok && draftKey(read.draft.form, read.draft.collectionId) === key)
      return read.draft;
  throw new Error('no draft stored');
}

function setup(
  opts: {
    clef?: ClefRunner | null;
    kv?: Kv | false;
    operations?: Capabilities['operations'];
    expiresAt?: number;
  } = {},
) {
  const plugin = new YomaPlugin({
    getClef: () =>
      opts.clef === null ? undefined : (opts.clef ?? firstOption),
  });
  const tools = new Map<string, PluginTool>(
    plugin.getTools().map((t) => [t.name, t]),
  );
  const requests: HubRequest[] = [];
  const outcomes = new Map<string, OutcomeStatus>();
  const kv = opts.kv === undefined ? memoryKv() : opts.kv;
  const attachments: unknown[] = [];
  let runId = 'run-1';
  const unused = () => Promise.reject(new Error('not used by the Yoma plugin'));
  const hubActions: HubActions = {
    capabilities: async () =>
      capabilities(opts.operations ?? ['ixo.bid.submit.v1']),
    options: unused,
    chainTransaction: unused,
    request: async (input) => {
      // The Hub refuses a request key it has seen with another body.
      if (requests.some((r) => r.requestKey === input.requestKey))
        throw new Error('request_conflict');
      requests.push(input);
      return reference(requests.length, opts.expiresAt);
    },
    status: async (_owner, actionId) => {
      const status = outcomes.get(actionId);
      return {
        outcome: status
          ? {
              version: 'ixo.auth-outcome/2',
              eventId: 'event-1',
              reference: reference(1),
              ownerDid: DID,
              authorizedRevision: 1,
              authorizedDigest: 'd'.repeat(64),
              sequence: 1,
              status,
              receipt: null,
              occurredAt: 1,
            }
          : null,
        summary: null,
      };
    },
  };
  // The channel as a runtime with WhatsApp files passes it (a field newer than this package's type).
  const channel = {
    provider: 'meta',
    bindingId: 'binding-1',
    bindingRevision: 1,
    attachments,
  };
  const context = (): RuntimeContext =>
    makeRuntimeContext({
      config: { NETWORK: 'mainnet', BLOCKSYNC_GRAPHQL_URL: BLOCKSYNC },
      user: {
        did: DID,
        matrixUserId: '@user:test',
        ucanDelegation: { raw: 'delegation' },
      },
      session: {
        id: 'session-1',
        client: 'channel',
        requestId: 'request-1',
        runId,
        channel,
      },
      ...(kv ? { kv } : {}),
      hubActions,
    });
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} missing`);
    return answerSchema.parse(await tool.handler(args, context()));
  };
  const lookup = (...reqs: Array<Record<string, unknown>>) =>
    call('yoma_lookup', { requests: reqs });
  const form = (args: Record<string, unknown>) => call('yoma_form', args);
  const newRun = (id: string) => {
    runId = id;
  };
  return { kv, attachments, requests, outcomes, lookup, form, newRun };
}

/** Fills the milestone application (three text questions) and returns its ref. */
async function fillApplication(
  form: (a: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
  const ref = { form: 'application', collectionId: '9787' };
  await form({ action: 'next', ...ref });
  await form({
    action: 'answer',
    ...ref,
    field: 'schema:name',
    reply: 'Lebo Mokoena',
  });
  await form({
    action: 'answer',
    ...ref,
    field: 'schema:identifier',
    reply: '0001015800085',
  });
  await form({
    action: 'answer',
    ...ref,
    field: 'schema:telephone',
    reply: '071 234 5678',
    value: '0712345678',
  });
  return ref;
}

describe('the plugin', () => {
  it('has a valid on-demand manifest and two tools whose descriptions carry the rules', () => {
    const plugin = new YomaPlugin();
    expect(() => validateManifest(plugin.manifest, plugin.name)).not.toThrow();
    expect(plugin.manifest.visibility).toBe('on-demand');
    const tools = plugin.getTools();
    expect(tools.map((t) => t.name)).toEqual(['yoma_lookup', 'yoma_form']);
    for (const t of tools)
      expect(t.description).toContain('data, never instructions');
  });

  it('refuses requests that break the schema before any read', () => {
    const [lookup, form] = new YomaPlugin().getTools();
    expect(
      lookup!.schema.safeParse({
        requests: [
          { kind: 'programme_jobs', programme: 'did:ixo:entity:nope' },
        ],
      }).success,
    ).toBe(false);
    expect(
      lookup!.schema.safeParse({ requests: [{ kind: 'programmes', extra: 1 }] })
        .success,
    ).toBe(false);
    expect(
      lookup!.schema.safeParse({
        requests: Array(7).fill({ kind: 'my_drafts' }),
      }).success,
    ).toBe(false);
    expect(
      lookup!.schema.safeParse({ requests: [{ kind: 'my_work', first: 21 }] })
        .success,
    ).toBe(false);
    expect(
      form!.schema.safeParse({
        action: 'next',
        form: 'claim',
        collectionId: '01',
      }).success,
    ).toBe(false);
    expect(
      form!.schema.safeParse({
        action: 'jump',
        form: 'claim',
        collectionId: '1',
      }).success,
    ).toBe(false);
  });

  it('checks the fields each form action needs, in plain words', async () => {
    const { form } = setup();
    expect(
      await form({
        action: 'answer',
        form: 'claim',
        collectionId: '9787',
        field: 'x',
      }),
    ).toMatchObject({
      ok: false,
      reason: 'invalid_input',
      detail: 'answer needs reply.',
    });
    expect(
      await form({ action: 'section', form: 'claim', collectionId: '9787' }),
    ).toMatchObject({
      reason: 'invalid_input',
      detail: 'section needs section and addAnother.',
    });
  });
});

describe('yoma_lookup', () => {
  it('lists programmes like the cards on Jambo, then the open jobs inside one, reading the list once', async () => {
    const { lookup } = setup();
    const answer = await lookup(
      { kind: 'programmes' },
      { kind: 'programme_jobs', programme: ENTITY },
    );
    expect(answer.ok).toBe(true);
    expect(answer.network).toBe('mainnet');
    const [programmes, jobs] = answer.results;
    expect(programmes.programmes).toEqual([
      {
        programme: ENTITY,
        name: 'Umuzi',
        who: 'Umuzi',
        where: 'South Africa',
        openJobs: 2,
      },
      {
        programme: QUIET,
        name: 'A Yoma programme',
        who: 'A Yoma partner',
        openJobs: 0,
      },
    ]);
    expect(
      jobs.jobs.map((j: { collectionId: string }) => j.collectionId),
    ).toEqual(['8724', '9787']);
    expect(jobs.jobs[0]).toMatchObject({
      what: 'K2C Tree Planting Submission',
      pay: '$1.27',
    });
    expect(jobs.jobs[1]).not.toHaveProperty('pay');
    expect(
      fetcher.mock.calls.filter(([u]) => String(u) === `${WORKER}/v1/entities`),
    ).toHaveLength(1);
  });

  it("matches the person's words against programmes and the jobs inside them", async () => {
    const { lookup } = setup();
    const [r] = (await lookup({ kind: 'programmes', query: 'tree planting' }))
      .results;
    expect(r.programmes.map((p: { programme: string }) => p.programme)).toEqual(
      [ENTITY],
    );
  });

  it('describes a job: places left, pins and web-only questions, and whether they can log work', async () => {
    const { lookup } = setup();
    const [job] = (await lookup({ kind: 'job', collectionId: '8724' })).results;
    expect(job).toMatchObject({
      ok: true,
      placesLeft: 8,
      canLogWorkNow: true,
      application: 'none needed',
    });
    expect(job.logWork.needsLocationPin).toBe(true);
    expect(job.logWork.needsTheWeb).toContain('jambo.yoma.world');
    const [missing] = (await lookup({ kind: 'job', collectionId: '9000' }))
      .results;
    expect(missing).toMatchObject({
      ok: false,
      reason: 'not_found',
      retryable: false,
    });
  });

  it('answers a malformed form on its own line, not as the whole job', async () => {
    world.route = (url) =>
      url === 'https://forms.test/trees-vct'
        ? json({ question: { title: 'Broken' } })
        : undefined;
    const [job] = (await setup().lookup({ kind: 'job', collectionId: '8724' }))
      .results;
    expect(job.ok).toBe(true);
    expect(job.logWork).toMatchObject({
      ok: false,
      reason: 'unavailable',
      retryable: false,
    });
  });

  it("says whether logged work was approved and paid, newest first, with each job's name", async () => {
    const { lookup } = setup();
    const [work] = (await lookup({ kind: 'my_work' })).results;
    expect(work.work).toEqual([
      {
        job: 'Tell us about the milestone you finished',
        sentOn: '2026-10-27',
        checked: 'Being checked',
        payment: '—',
      },
      {
        job: 'K2C Tree Planting Submission',
        sentOn: '2026-10-16',
        checked: 'Approved ✓',
        checkedOn: '2026-10-20',
        payment: 'Paid',
        amount: '$1.27',
      },
    ]);
    const query = JSON.parse(
      String(fetcher.mock.calls.find(([u]) => u === BLOCKSYNC)![1].body),
    ).query as string;
    expect(query).toContain(`agentAddress: { equalTo: "${ADDRESS}" }`);
    expect(query).not.toContain('$');
  });

  it('answers each request on its own: a failed one does not fail the rest', async () => {
    world.route = (url) =>
      url.includes('/v1/entities')
        ? new Response('nope', { status: 500 })
        : undefined;
    const answer = await setup().lookup(
      { kind: 'programmes' },
      { kind: 'my_work' },
    );
    expect(answer.results[0]).toMatchObject({
      kind: 'programmes',
      ok: false,
      reason: 'unavailable',
      retryable: true,
    });
    expect(answer.results[1]).toMatchObject({ kind: 'my_work', ok: true });
  });

  it('keeps a failed build for a moment instead of asking the upstream again', async () => {
    world.route = (url) =>
      url === `${WORKER}/v1/entities`
        ? new Response('nope', { status: 500 })
        : undefined;
    const { lookup } = setup();
    await lookup({ kind: 'programmes' });
    await lookup({ kind: 'programmes' });
    expect(
      fetcher.mock.calls.filter(([u]) => u === `${WORKER}/v1/entities`),
    ).toHaveLength(1);
  });

  it('retries a 429 once after its Retry-After, then answers', async () => {
    vi.useFakeTimers();
    let calls = 0;
    world.route = (url) => {
      if (url !== `${WORKER}/v1/entities`) return undefined;
      calls += 1;
      return calls === 1
        ? new Response('slow down', {
            status: 429,
            headers: { 'retry-after': '2' },
          })
        : undefined;
    };
    const pending = setup().lookup({ kind: 'programmes' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).results[0].ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('gives up after one retry on a 5xx', async () => {
    vi.useFakeTimers();
    world.route = (url) =>
      url === `${WORKER}/v1/entities`
        ? new Response('down', { status: 503 })
        : undefined;
    const pending = setup().lookup({ kind: 'programmes' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).results[0]).toMatchObject({
      ok: false,
      reason: 'unavailable',
      retryable: true,
    });
    expect(
      fetcher.mock.calls.filter(([u]) => u === `${WORKER}/v1/entities`),
    ).toHaveLength(2);
  });

  it('times out a read that never answers, without retrying it', async () => {
    vi.useFakeTimers();
    world.route = (url, init) =>
      url === `${WORKER}/v1/entities`
        ? new Promise<Response>((_r, reject) =>
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            ),
          )
        : undefined;
    const pending = setup().lookup({ kind: 'programmes' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await pending).results[0]).toMatchObject({
      ok: false,
      reason: 'timeout',
      retryable: true,
    });
    expect(
      fetcher.mock.calls.filter(([u]) => u === `${WORKER}/v1/entities`),
    ).toHaveLength(1);
  });

  it('refuses a malformed or oversized answer instead of guessing', async () => {
    world.route = (url) =>
      url === `${WORKER}/v1/entities`
        ? new Response('<html>', { status: 200 })
        : undefined;
    expect(
      (await setup().lookup({ kind: 'programmes' })).results[0],
    ).toMatchObject({ ok: false, reason: 'unavailable', retryable: false });
    resetCatalogCache();
    world.route = (url) =>
      url === `${WORKER}/v1/entities`
        ? new Response('x'.repeat(300 * 1024), { status: 200 })
        : undefined;
    expect(
      (await setup().lookup({ kind: 'programmes' })).results[0],
    ).toMatchObject({
      ok: false,
      reason: 'too_large',
      detail: expect.stringContaining('The Yoma job list is too large'),
    });
  });

  it('never shows what a hide list hides: an unreadable one marks that programme unavailable, the rest stands', async () => {
    world.route = (url) =>
      url.startsWith(`${WORKER}/v1/collections/${encodeURIComponent(ENTITY)}`)
        ? new Response('nope', { status: 500 })
        : undefined;
    const { lookup } = setup();
    const [programmes, jobs] = (
      await lookup(
        { kind: 'programmes' },
        { kind: 'programme_jobs', programme: ENTITY },
      )
    ).results;
    expect(programmes.programmes[0]).toMatchObject({
      programme: ENTITY,
      openJobs: 0,
      unavailable: true,
    });
    expect(programmes.programmes[1]).toMatchObject({ programme: QUIET });
    expect(jobs).toMatchObject({
      ok: false,
      reason: 'unavailable',
      retryable: true,
    });
  });

  it('keeps an answer under its size cap', async () => {
    const answer = await setup().lookup(
      ...Array(6).fill({ kind: 'job', collectionId: '9787' }),
    );
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  });

  it('lists drafts with their progress, and reports an unreadable one without dropping the others', async () => {
    const { form, lookup, kv } = setup();
    if (!kv) throw new Error('storage expected');
    await form({ action: 'next', form: 'claim', collectionId: '9787' });
    await form({
      action: 'answer',
      form: 'claim',
      collectionId: '9787',
      field: 'schema:givenName',
      reply: 'Lebo',
    });
    await form({ action: 'next', form: 'application', collectionId: '9787' });
    await kv.set('yoma', draftKey('application', '9787'), {
      v: 1,
      broken: true,
    });
    const [drafts] = (await lookup({ kind: 'my_drafts' })).results;
    expect(drafts.drafts).toHaveLength(1);
    expect(drafts.drafts[0]).toMatchObject({
      collectionId: '9787',
      form: 'claim',
      state: 'in_progress',
      progress: { answered: 1 },
    });
    expect(drafts.unreadable).toBe(1);
  });
});

describe('yoma_form', () => {
  it('asks the application one question at a time and sends it as a card; locked while it waits', async () => {
    const { form, requests, outcomes } = setup();
    const ref = await fillApplication(form);
    expect((await form({ action: 'review', ...ref })).status).toBe('ready');
    expect((await form({ action: 'submit', ...ref })).status).toBe('prepared');
    const operation = answerSchema.parse(requests[0]!.operation);
    expect(operation).toMatchObject({
      kind: 'ixo.bid.submit.v1',
      network: 'ixo mainnet',
      collectionId: '9787',
      role: 'SA',
    });
    expect(JSON.parse(String(operation.data))).toEqual({
      'schema:name': 'Lebo Mokoena',
      'schema:identifier': '0001015800085',
      'schema:telephone': '0712345678',
    });
    expect(requests[0]).toMatchObject({
      ownerDid: DID,
      provider: 'meta',
      bindingId: 'binding-1',
      runId: 'run-1',
    });
    expect(
      (
        await form({
          action: 'answer',
          ...ref,
          field: 'schema:name',
          reply: 'Lerato',
        })
      ).status,
    ).toBe('waiting_for_confirm');
    outcomes.set('action-1', 'succeeded');
    expect((await form({ action: 'next', ...ref })).status).toBe('submitted');
  });

  it('sends a new card after one was declined, with a new request key', async () => {
    const { form, requests, outcomes, newRun } = setup();
    const ref = await fillApplication(form);
    expect((await form({ action: 'submit', ...ref })).status).toBe('prepared');
    outcomes.set('action-1', 'declined');
    newRun('run-2');
    expect((await form({ action: 'submit', ...ref })).status).toBe('prepared');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.requestKey).not.toBe(requests[0]!.requestKey);
  });

  it('clears a card whose outcome never came once it has expired', async () => {
    const { form, requests } = setup({
      expiresAt: Math.floor(Date.now() / 1000) - 3600,
    });
    const ref = await fillApplication(form);
    await form({ action: 'submit', ...ref });
    expect(
      (
        await form({
          action: 'answer',
          ...ref,
          field: 'schema:name',
          reply: 'Lerato',
        })
      ).saved,
    ).toBe('schema:name');
    expect(requests).toHaveLength(1);
  });

  it("does not send when the Hub doesn't offer the application card to this account", async () => {
    const { form, requests } = setup({ operations: ['ixo.bank.send.v1'] });
    const ref = await fillApplication(form);
    expect(await form({ action: 'submit', ...ref })).toMatchObject({
      ok: false,
      reason: 'not_enabled',
      retryable: false,
    });
    expect(requests).toHaveLength(0);
  });

  it('only lets them log work once accepted', async () => {
    world.allowed = false;
    expect(
      (
        await setup().form({
          action: 'next',
          form: 'claim',
          collectionId: '9787',
        })
      ).status,
    ).toBe('not_accepted');
  });

  it('takes a file from the message it came with and saves as it goes; sending waits for the transaction card', async () => {
    const { form, kv, attachments, requests } = setup();
    if (!kv) throw new Error('storage expected');
    const ref = { form: 'claim', collectionId: '9787' };
    const answer = (field: string, reply: string, value?: string) =>
      form({
        action: 'answer',
        ...ref,
        field,
        reply,
        ...(value ? { value } : {}),
      });
    await form({ action: 'next', ...ref });
    await answer('schema:givenName', 'Lebo');
    await answer('schema:familyName', 'Mokoena');
    expect(
      await answer('schema:email', 'lebo at gmail', 'lebo at gmail'),
    ).toMatchObject({ status: 'invalid', say: expect.any(String) });
    await answer('schema:email', 'lebo@gmail.com', 'lebo@gmail.com');
    await answer('schema:addressCountry', 'South Africa');
    expect((await storedDraft(kv, 'claim', '9787')).data).toMatchObject({
      'schema:email': 'lebo@gmail.com',
      'schema:addressCountry': 'ZA',
    });
    expect((await form({ action: 'next', ...ref })).next.field).toBe(
      'schema:temporalCoverage',
    );
    await answer('schema:temporalCoverage', 'September');
    await answer('schema:name', 'Data analysis bootcamp');
    await answer('ixo:evidenceType_completionCode', 'UMZ-4411');
    expect(
      (await answer('ixo:evidenceType_certificate', '[photo]')).status,
    ).toBe('no_file');
    const photo = {
      url: 'https://channels.test/media/binding-1/abc?exp=1&sig=x',
      filename: 'certificate.jpg',
      mimetype: 'image/jpeg',
      size: 123456,
      sha256: 'a'.repeat(64),
      kind: 'image',
    };
    attachments.push(photo, {
      url: 'http://insecure.test/x',
      filename: 'x',
      mimetype: 'image/png',
      size: 1,
      sha256: 'b'.repeat(64),
      kind: 'image',
    });
    expect(
      (await answer('ixo:evidenceType_certificate', '[photo]')).saved,
    ).toBe('ixo:evidenceType_certificate');
    expect(
      (await answer('ixo:evidenceType_certificate', '[photo]')).status,
    ).toBe('duplicate');
    attachments.length = 0;
    await form({
      action: 'skip',
      ...ref,
      field: 'dcterms:description_reflection',
    });
    const review = await form({ action: 'review', ...ref });
    expect(review.status).toBe('ready');
    expect(review.answers).toContainEqual({
      label: expect.stringContaining('ertificate'),
      value: '📷 certificate.jpg',
    });
    expect((await form({ action: 'submit', ...ref })).status).toBe('not_yet');
    expect(requests).toHaveLength(0);
    expect((await storedDraft(kv, 'claim', '9787')).evidence).toEqual([
      expect.objectContaining({ sha256: photo.sha256, url: photo.url }),
    ]);
  });

  it('turns a shared pin into the map cell the web form stores', async () => {
    const { form, kv } = setup();
    if (!kv) throw new Error('storage expected');
    const ref = { form: 'claim', collectionId: '8724' };
    await form({ action: 'next', ...ref });
    for (const [field, reply] of [
      ['schema:addressLocality', 'Mfuwe'],
      ['schema:recipient', 'Grace Banda'],
      ['ixo:treeSpecies', 'Mango'],
    ])
      await form({ action: 'answer', ...ref, field, reply });
    expect(
      (
        await form({
          action: 'answer',
          ...ref,
          field: 'geo:location',
          reply: '📍 -13.105000, 31.801000 — Mfuwe',
        })
      ).saved,
    ).toBe('geo:location');
    expect(
      (await storedDraft(kv, 'claim', '8724')).data['geo:location'],
    ).toMatchObject({
      latitude: -13.105,
      longitude: 31.801,
      gridPrecision: 10,
      placeName: 'Mfuwe',
    });
  });

  it('without Clef takes an option number, and says unclear for words', async () => {
    const { form } = setup({ clef: null });
    const ref = { form: 'claim', collectionId: '9787' };
    await form({ action: 'next', ...ref });
    for (const [field, reply, value] of [
      ['schema:givenName', 'Lebo'],
      ['schema:familyName', 'M'],
      ['schema:email', 'l@x.org', 'l@x.org'],
    ] as Array<[string, string, string?]>)
      await form({
        action: 'answer',
        ...ref,
        field,
        reply,
        ...(value ? { value } : {}),
      });
    expect(
      await form({
        action: 'answer',
        ...ref,
        field: 'schema:addressCountry',
        reply: 'here in Mzansi',
      }),
    ).toMatchObject({
      ok: true,
      status: 'unclear',
      say: expect.any(String),
    });
    expect(
      (
        await form({
          action: 'answer',
          ...ref,
          field: 'schema:addressCountry',
          reply: '1',
        })
      ).saved,
    ).toBe('schema:addressCountry');
  });

  it('refuses to close a repeating section below its minimum', async () => {
    const SECTION_FORM = 'https://forms.test/milestone-vct';
    world.route = (url) =>
      url === SECTION_FORM
        ? json({
            question: {
              title: 'Shops',
              pages: [
                {
                  elements: [
                    {
                      type: 'paneldynamic',
                      name: 'shops',
                      // Required, with no items yet: SurveyJS starts it empty.
                      isRequired: true,
                      panelCount: 0,
                      templateElements: [
                        { type: 'text', name: 'shop', isRequired: true },
                      ],
                    },
                  ],
                },
              ],
            },
          })
        : undefined;
    const { form } = setup();
    const ref = { form: 'claim', collectionId: '9787' };
    await form({ action: 'next', ...ref });
    expect(
      await form({
        action: 'section',
        ...ref,
        section: 'shops',
        addAnother: false,
      }),
    ).toMatchObject({
      ok: true,
      status: 'needs_more',
      say: 'This section needs at least 1 item.',
    });
    const review = await form({ action: 'review', ...ref });
    expect(review.missing.map((m: { field: string }) => m.field)).toContain(
      'shops',
    );
  });

  it('keeps a form answer under the size cap, saying it was shortened', async () => {
    const options = Array.from(
      { length: 200 },
      (_, i) => `Option ${i} ${'x'.repeat(190)}`,
    );
    world.route = (url) =>
      url === 'https://forms.test/milestone-vct'
        ? json({
            question: {
              title: 'Long',
              pages: [
                {
                  elements: [
                    { type: 'radiogroup', name: 'pick', choices: options },
                  ],
                },
              ],
            },
          })
        : undefined;
    const step = await setup().form({
      action: 'next',
      form: 'claim',
      collectionId: '9787',
    });
    expect(JSON.stringify(step).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(step.truncated).toBe(true);
  });

  it('answers a full storage as too_large, not as an error', async () => {
    const full = memoryKv();
    const refuse: Kv = {
      ...full,
      update: async () => {
        throw new UserKvLimitError('value', 'yoma', 1, 2);
      },
    };
    expect(
      await setup({ kv: refuse }).form({
        action: 'next',
        form: 'claim',
        collectionId: '9787',
      }),
    ).toMatchObject({
      ok: false,
      reason: 'too_large',
      retryable: false,
    });
  });

  it('answers without storage as a result, not an error', async () => {
    expect(
      await setup({ kv: false }).form({
        action: 'next',
        form: 'claim',
        collectionId: '9787',
      }),
    ).toMatchObject({
      ok: false,
      reason: 'unavailable',
      retryable: false,
    });
  });
});

// The `warn` spy keeps expected retry log lines out of the test output.
void warn;
