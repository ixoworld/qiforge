import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { validateManifest } from '../../core/manifest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { UserKvLimitError } from '../../core/user-kv';
import type {
  HubActionStatusRead,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import type { ActionReferenceV1 as ActionReference } from '@ixo/action-protocol';
import { HubActionClient } from '../../hub-actions/client';
import { prepareHubAction } from '../../hub-actions/request';
import {
  HubActionRefused,
  type HubActionOrigin,
} from '../../hub-actions/store';
import { resetUpstreamHealth, type ChainCall } from '../ixo-chain/http';
import { fetchEntities, JOB_LIST_URLS, resetCatalogCache } from './catalog';
import { FORM_MAX_BYTES, getJson } from './reads';
import type { ClefRequest, ClefResponse, ClefRunner } from './clef';
import { allDrafts, draftKey, updateDraft, type Kv } from './drafts';
import milestoneApplication from './fixtures/form-9787-bco.json';
import milestoneClaim from './fixtures/form-9787-vct.json';
import treePlanting from './fixtures/form-8724-vct.json';
import {
  HUB_STATUS_TIMEOUT_MS,
  MAX_CARD_REFRESHES,
  MAX_RESULT_CHARS,
  YomaPlugin,
  type InstantPermission,
} from './yoma.plugin';

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
    state: 0,
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
    state: 0,
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
    state: 0,
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
    state: 0,
    startDate: null,
    endDate: '2026-09-13T00:00:00',
    quota: '0',
    count: '0',
    payments: null,
  },
  // Paused by its admin (x/claims CollectionState 1): the chain refuses claims on it.
  {
    id: '7001',
    entity: ENTITY,
    admin: ADMIN,
    protocol: MILESTONE,
    state: 1,
    startDate: null,
    endDate: null,
    quota: '0',
    count: '0',
    payments: null,
  },
];
/** A gateway media link valid for a day, as the gateway signs it. */
const mediaLink = (id: string) =>
  `https://channels.test/media/binding-1/${id}?exp=${Math.floor(Date.now() / 1000) + 86_400}&sig=x`;
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
  if (query.includes('c: claimCollections'))
    data.c = {
      nodes: query.includes('state: { equalTo: 0 }')
        ? COLLECTIONS.filter((c) => c.state === 0)
        : COLLECTIONS,
    };
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
type Outcome = NonNullable<
  Awaited<ReturnType<HubActions['status']>>['outcome']
>;
type OutcomeStatus = Outcome['status'];
type Receipt = NonNullable<Outcome['receipt']>;

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
    instantPermission?: InstantPermission;
    /** Auth Hub's review status on a status read (default `prepared`). */
    reviewStatus?: HubActionStatusRead['reviewStatus'];
    hubActions?: (base: HubActions) => HubActions;
    capabilities?: Partial<Capabilities>;
    config?: Record<string, unknown>;
  } = {},
) {
  const plugin = new YomaPlugin({
    ...(opts.instantPermission
      ? { instantPermission: opts.instantPermission }
      : {}),
    getClef: () =>
      opts.clef === null ? undefined : (opts.clef ?? firstOption),
  });
  const tools = new Map<string, PluginTool>(
    plugin.getTools().map((t) => [t.name, t]),
  );
  const requests: HubRequest[] = [];
  const outcomes = new Map<string, OutcomeStatus>();
  /** A receipt to hand back with an outcome, by action id. */
  const receipts = new Map<string, Receipt>();
  const kv = opts.kv === undefined ? memoryKv() : opts.kv;
  const attachments: unknown[] = [];
  let runId = 'run-1';
  let requestId = 'request-1';
  let toolCalls = 0;
  const unused = () => Promise.reject(new Error('not used by the Yoma plugin'));
  const hubActions: HubActions = {
    capabilities: async () => ({
      ...capabilities(opts.operations ?? ['ixo.bid.submit.v1']),
      ...opts.capabilities,
    }),
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
        held: true,
        reviewStatus: opts.reviewStatus ?? 'prepared',
        operationStatus: null,
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
              receipt: receipts.get(actionId) ?? null,
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
  const context = (signal?: AbortSignal): RuntimeContext =>
    makeRuntimeContext({
      config: {
        NETWORK: 'mainnet',
        BLOCKSYNC_GRAPHQL_URL: BLOCKSYNC,
        ...opts.config,
      },
      ...(signal ? { abortSignal: signal } : {}),
      user: {
        did: DID,
        matrixUserId: '@user:test',
        ucanDelegation: { raw: 'delegation' },
      },
      session: {
        id: 'session-1',
        client: 'channel',
        requestId,
        runId,
        channel,
      },
      toolCallId: `tool-${++toolCalls}`,
      ...(kv ? { kv } : {}),
      hubActions: opts.hubActions ? opts.hubActions(hubActions) : hubActions,
    });
  const call = async (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} missing`);
    return answerSchema.parse(await tool.handler(args, context(signal)));
  };
  const lookup = (...reqs: Array<Record<string, unknown>>) =>
    call('yoma_lookup', { requests: reqs });
  const lookupWith = (
    signal: AbortSignal,
    ...reqs: Array<Record<string, unknown>>
  ) => call('yoma_lookup', { requests: reqs }, signal);
  const form = (args: Record<string, unknown>) => call('yoma_form', args);
  const formWith = (signal: AbortSignal, args: Record<string, unknown>) =>
    call('yoma_form', args, signal);
  const newRun = (id: string) => {
    runId = id;
  };
  /** The person's next message: a new request (and run). */
  let messages = 1;
  const newMessage = () => {
    messages += 1;
    requestId = `request-${messages}`;
    runId = `run-${messages}`;
  };
  /**
   * Reads every page of the review back, then sends on the person's next
   * message, as the guide asks.
   */
  const confirm = async (ref: Record<string, unknown>) => {
    const first = await form({ action: 'review', ...ref });
    for (let page = 2; page <= Number(first.pages ?? 1); page++)
      await form({ action: 'review', ...ref, page });
    newMessage();
    return form({ action: 'submit', confirmed: true, ...ref });
  };
  return {
    kv,
    attachments,
    requests,
    outcomes,
    receipts,
    lookup,
    lookupWith,
    form,
    formWith,
    newRun,
    newMessage,
    confirm,
  };
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
  it('sends nothing until the person said yes to the review', async () => {
    const { form, requests } = setup();
    const ref = await fillApplication(form);
    const unconfirmed = await form({ action: 'submit', ...ref });
    expect(unconfirmed).toMatchObject({
      ok: true,
      status: 'needs_confirmation',
    });
    expect(unconfirmed.answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'Lebo Mokoena' }),
      ]),
    );
    expect(
      (await form({ action: 'submit', confirmed: false, ...ref })).status,
    ).toBe('needs_confirmation');
    expect(requests).toHaveLength(0);
  });

  it('asks the application one question at a time and sends it as a card; locked while it waits', async () => {
    const { confirm, form, requests, outcomes } = setup();
    const ref = await fillApplication(form);
    expect((await form({ action: 'review', ...ref })).status).toBe('ready');
    expect((await confirm(ref)).status).toBe('prepared');
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
      runId: 'run-2',
      requestId: 'request-2',
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
    const { confirm, form, requests, outcomes, newRun } = setup();
    const ref = await fillApplication(form);
    expect((await confirm(ref)).status).toBe('prepared');
    outcomes.set('action-1', 'declined');
    newRun('run-2');
    expect((await confirm(ref)).status).toBe('prepared');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.requestKey).not.toBe(requests[0]!.requestKey);
  });

  it('never clears a card on time alone: only a final outcome or the Hub saying it expired does', async () => {
    const expired = Math.floor(Date.now() / 1000) - 3600;
    const waiting = setup({ expiresAt: expired });
    const ref = await fillApplication(waiting.form);
    await waiting.confirm(ref);
    expect(
      (
        await waiting.form({
          action: 'answer',
          ...ref,
          field: 'schema:name',
          reply: 'Lerato',
        })
      ).status,
    ).toBe('waiting_for_confirm');
    // A host that passes the Hub's review state: `expired` clears it.
    const told = setup({ expiresAt: expired, reviewStatus: 'expired' });
    const again = await fillApplication(told.form);
    await told.confirm(again);
    expect(
      (
        await told.form({
          action: 'answer',
          ...again,
          field: 'schema:name',
          reply: 'Lerato',
        })
      ).saved,
    ).toBe('schema:name');
    expect(told.requests).toHaveLength(1);
  });

  it("does not send when the Hub doesn't offer the application card to this account", async () => {
    const { confirm, form, requests } = setup({
      operations: ['ixo.bank.send.v1'],
    });
    const ref = await fillApplication(form);
    expect(await confirm(ref)).toMatchObject({
      ok: false,
      reason: 'not_enabled',
      retryable: false,
    });
    expect(requests).toHaveLength(0);
  });

  describe('instant permission', () => {
    /** A host hook that grants on 9787 only, recording each grant. */
    const hook = (fail = false) => {
      const grants: Array<{
        collectionId: string;
        admin: string;
        address: string;
        answers: Record<string, unknown>;
      }> = [];
      const instantPermission: InstantPermission = {
        allows: (collectionId) => collectionId === '9787',
        grant: async ({ collectionId, admin, address, answers }) => {
          if (fail) throw new Error('wallet out of gas');
          grants.push({ collectionId, admin, address, answers });
          world.allowed = true;
        },
      };
      return { grants, instantPermission };
    };

    it('grants on a finished application instead of sending the card', async () => {
      world.allowed = false;
      const { grants, instantPermission } = hook();
      const { confirm, form, requests } = setup({ instantPermission });
      const ref = await fillApplication(form);
      expect(await confirm(ref)).toMatchObject({
        ok: true,
        status: 'can_log_work',
        say: expect.stringContaining('They can start logging work now.'),
      });
      expect(requests).toHaveLength(0);
      expect(grants).toEqual([
        {
          collectionId: '9787',
          admin: expect.any(String),
          address: ADDRESS,
          answers: {
            'schema:name': 'Lebo Mokoena',
            'schema:identifier': '0001015800085',
            'schema:telephone': '0712345678',
          },
        },
      ]);
      expect((await form({ action: 'next', ...ref })).status).toBe('submitted');
      expect(
        (await form({ action: 'next', form: 'claim', collectionId: '9787' }))
          .status,
      ).not.toBe('not_accepted');
    });

    it('says it can take a few seconds when the grant is not visible yet', async () => {
      world.allowed = false;
      const instantPermission: InstantPermission = {
        allows: () => true,
        grant: async () => {},
      };
      const { confirm, form } = setup({ instantPermission });
      const ref = await fillApplication(form);
      expect((await confirm(ref)).say).toContain('a few seconds');
    });

    it('answers unavailable, retryable, when the grant fails, and keeps the application', async () => {
      world.allowed = false;
      const { instantPermission } = hook(true);
      const { confirm, form, requests } = setup({ instantPermission });
      const ref = await fillApplication(form);
      expect(await confirm(ref)).toMatchObject({
        ok: false,
        reason: 'unavailable',
        retryable: true,
      });
      expect(requests).toHaveLength(0);
      expect((await form({ action: 'next', ...ref })).status).not.toBe(
        'submitted',
      );
    });

    it('asks for the application first on a claim it allows', async () => {
      world.allowed = false;
      const { instantPermission } = hook();
      const { form } = setup({ instantPermission });
      expect(
        (await form({ action: 'next', form: 'claim', collectionId: '9787' }))
          .status,
      ).toBe('apply_first');
    });

    it('leaves a job it does not allow exactly as before', async () => {
      world.allowed = false;
      const { grants } = hook();
      const instantPermission: InstantPermission = {
        allows: () => false,
        grant: async () => {
          throw new Error('must not be called');
        },
      };
      const { confirm, form, requests } = setup({ instantPermission });
      const ref = await fillApplication(form);
      expect((await confirm(ref)).status).toBe('prepared');
      expect(requests).toHaveLength(1);
      expect(grants).toHaveLength(0);
      expect(
        (await form({ action: 'next', form: 'claim', collectionId: '9787' }))
          .status,
      ).toBe('not_accepted');
    });
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

  it('takes a file from the message it came with, saves as it goes, and sends the claim card with its evidence', async () => {
    const {
      confirm,
      form,
      lookup,
      kv,
      attachments,
      requests,
      outcomes,
      receipts,
      newRun,
    } = setup({ operations: ['ixo.bid.submit.v1', 'ixo.claim.submit.v1'] });
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
      url:
        'https://channels.test/media/binding-1/abc?exp=' +
        (Math.floor(Date.now() / 1000) + 86_400) +
        '&sig=x',
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
    expect(review.files).toContainEqual({
      label: expect.stringContaining('ertificate'),
      value: '📷 certificate.jpg',
    });
    // The card's rows are the answers of `data`, one each, as the Hub checks.
    expect(review.answers).toContainEqual({
      field: 'schema:addressCountry',
      label: 'Which country do you live in?',
      value: 'ZA',
      means: 'South Africa',
    });
    expect((await confirm(ref)).status).toBe('prepared');
    expect(requests).toHaveLength(1);
    const operation = requests[0]!.operation;
    if (operation.kind !== 'ixo.claim.submit.v1')
      throw new Error(`claim card expected, got ${operation.kind}`);
    expect(operation).toMatchObject({
      network: 'ixo mainnet',
      collectionId: '9787',
    });
    const data = JSON.parse(operation.data) as Record<string, unknown>;
    expect(data).not.toHaveProperty('ixo:evidenceType_certificate');
    expect(data).toMatchObject({ 'schema:givenName': 'Lebo' });
    expect(operation.evidence).toEqual([
      {
        field: 'ixo:evidenceType_certificate',
        url: photo.url,
        filename: photo.filename,
        mimetype: photo.mimetype,
        size: photo.size,
        sha256: photo.sha256,
      },
    ]);

    // The Hub stopped at the evidence step: the reason comes back once, and
    // the claim can be sent again in a new run.
    outcomes.set('action-1', 'failed');
    receipts.set('action-1', {
      kind: 'ixo.submission.failed.v1',
      actionId: 'action-1',
      revision: 1,
      digest: 'd'.repeat(64),
      step: 'evidence',
      message: 'A photo did not match the file that was sent',
      failedAt: 2,
    });
    newRun('run-2');
    const back = await form({ action: 'next', ...ref });
    expect(back.lastCard).toEqual({
      stoppedAt: 'evidence',
      hubSaid: 'A photo did not match the file that was sent',
    });
    expect((await confirm(ref)).status).toBe('prepared');
    expect(requests[1]!.requestKey).not.toBe(requests[0]!.requestKey);
    expect(
      (await storedDraft(kv, 'claim', '9787')).cardFailure,
    ).toBeUndefined();

    // Approved: submitted, with the claim's id from the receipt.
    outcomes.set('action-2', 'succeeded');
    receipts.set('action-2', {
      kind: 'ixo.claim.submission.v1',
      actionId: 'action-2',
      revision: 1,
      digest: 'd'.repeat(64),
      collectionId: '9787',
      claimId: 'bafkreiclaim',
      transactionHash: 'a'.repeat(64),
      height: 1234,
      submittedAt: 3,
    });
    expect(await form({ action: 'next', ...ref })).toMatchObject({
      status: 'submitted',
      claimId: 'bafkreiclaim',
    });
    // The sent claim moved out of the drafts: the same job takes another.
    const second = await form({ action: 'next', ...ref });
    expect(second).toMatchObject({
      status: 'in_progress',
      next: { field: 'schema:givenName' },
    });
    expect((await storedDraft(kv, 'claim', '9787')).card).toBeUndefined();
    const [listed] = (await lookup({ kind: 'my_drafts' })).results;
    expect(listed.sent).toEqual([
      expect.objectContaining({
        collectionId: '9787',
        form: 'claim',
        state: 'submitted',
        claimId: 'bafkreiclaim',
      }),
    ]);
  });

  it('answers not_enabled when the Hub does not offer the claim card', async () => {
    const { confirm, form, requests, attachments } = setup();
    const ref = { form: 'claim', collectionId: '9787' };
    await form({ action: 'next', ...ref });
    for (const [field, reply, value] of [
      ['schema:givenName', 'Lebo'],
      ['schema:familyName', 'Mokoena'],
      ['schema:email', 'lebo@gmail.com', 'lebo@gmail.com'],
      ['schema:addressCountry', 'South Africa'],
      ['schema:temporalCoverage', 'September'],
      ['schema:name', 'Data analysis bootcamp'],
      ['ixo:evidenceType_completionCode', 'UMZ-4411'],
    ] as Array<[string, string, string?]>) {
      await form({
        action: 'answer',
        ...ref,
        field,
        reply,
        ...(value ? { value } : {}),
      });
    }
    attachments.push({
      url:
        'https://channels.test/media/binding-1/abc?exp=' +
        (Math.floor(Date.now() / 1000) + 86_400) +
        '&sig=x',
      filename: 'certificate.jpg',
      mimetype: 'image/jpeg',
      size: 123456,
      sha256: 'a'.repeat(64),
      kind: 'image',
    });
    await form({
      action: 'answer',
      ...ref,
      field: 'ixo:evidenceType_certificate',
      reply: '[photo]',
    });
    attachments.length = 0;
    await form({
      action: 'skip',
      ...ref,
      field: 'dcterms:description_reflection',
    });
    expect(await confirm(ref)).toMatchObject({
      ok: false,
      reason: 'not_enabled',
      retryable: false,
    });
    expect(requests).toHaveLength(0);
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

/** Fills the milestone claim (9787) up to its certificate photo, with that photo sent. */
async function fillClaim(
  form: (a: Record<string, unknown>) => Promise<Record<string, unknown>>,
  attachments: unknown[],
  photoUrl = mediaLink('cert'),
) {
  const ref = { form: 'claim', collectionId: '9787' };
  await form({ action: 'next', ...ref });
  for (const [field, reply, value] of [
    ['schema:givenName', 'Lebo'],
    ['schema:familyName', 'Mokoena'],
    ['schema:email', 'lebo@gmail.com', 'lebo@gmail.com'],
    ['schema:addressCountry', 'South Africa'],
    ['schema:temporalCoverage', 'September'],
    ['schema:name', 'Data analysis bootcamp'],
    ['ixo:evidenceType_completionCode', 'UMZ-4411'],
  ] as Array<[string, string, string?]>)
    await form({
      action: 'answer',
      ...ref,
      field,
      reply,
      ...(value ? { value } : {}),
    });
  attachments.push({
    url: photoUrl,
    filename: 'certificate.jpg',
    mimetype: 'image/jpeg',
    size: 123456,
    sha256: 'c'.repeat(64),
    kind: 'image',
  });
  await form({
    action: 'answer',
    ...ref,
    field: 'ixo:evidenceType_certificate',
    reply: '[photo]',
  });
  attachments.length = 0;
  await form({
    action: 'skip',
    ...ref,
    field: 'dcterms:description_reflection',
  });
  return ref;
}

describe('consent to send', () => {
  it('sends only on a yes in a later message than the read-back of these very answers', async () => {
    const { form, requests, newMessage } = setup();
    const ref = await fillApplication(form);
    // A yes the model claims without any read-back.
    expect(
      await form({ action: 'submit', confirmed: true, ...ref }),
    ).toMatchObject({ status: 'needs_confirmation' });
    // The read-back and the yes in one message: not the person's answer to it.
    expect(
      (await form({ action: 'submit', confirmed: true, ...ref })).status,
    ).toBe('needs_confirmation');
    // Answers changed after the read-back: it no longer counts.
    newMessage();
    await form({
      action: 'answer',
      ...ref,
      field: 'schema:name',
      reply: 'Lebo M',
    });
    newMessage();
    expect(
      (await form({ action: 'submit', confirmed: true, ...ref })).status,
    ).toBe('needs_confirmation');
    expect(requests).toHaveLength(0);
    newMessage();
    expect(
      (await form({ action: 'submit', confirmed: true, ...ref })).status,
    ).toBe('prepared');
  });
});

describe('cards in flight', () => {
  it('treats submitted and unknown as in flight: never cleared, never sent again, whatever the time; then settles late', async () => {
    const { confirm, form, requests, outcomes, newMessage } = setup({
      // Expired long ago: time alone must not clear it.
      expiresAt: Math.floor(Date.now() / 1000) - 3600,
    });
    const ref = await fillApplication(form);
    expect((await confirm(ref)).status).toBe('prepared');
    for (const status of ['authorized', 'submitted', 'unknown'] as const) {
      outcomes.set('action-1', status);
      newMessage();
      expect(await form({ action: 'next', ...ref })).toMatchObject({
        status: 'waiting_for_confirm',
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
      expect(
        (await form({ action: 'skip', ...ref, field: 'schema:name' })).status,
      ).toBe('waiting_for_confirm');
      expect(
        (await form({ action: 'submit', confirmed: true, ...ref })).status,
      ).toBe('waiting_for_confirm');
      expect(
        (await form({ action: 'discard', confirmed: true, ...ref })).status,
      ).toBe('waiting_for_confirm');
    }
    expect((await form({ action: 'next', ...ref })).say).toContain(
      'Do not send it again',
    );
    expect(requests).toHaveLength(1);
    // The chain settles later.
    outcomes.set('action-1', 'succeeded');
    expect((await form({ action: 'next', ...ref })).status).toBe('submitted');
  });

  it('leaves a card alone when this owner object holds no such action (Auth Hub was not asked)', async () => {
    const { confirm, form } = setup({
      expiresAt: Math.floor(Date.now() / 1000) - 3600,
      reviewStatus: 'expired',
      hubActions: (base) => ({
        ...base,
        status: async () => ({
          held: false,
          reviewStatus: null,
          operationStatus: null,
          outcome: null,
          summary: null,
        }),
      }),
    });
    const ref = await fillApplication(form);
    await confirm(ref);
    expect((await form({ action: 'next', ...ref })).status).toBe(
      'waiting_for_confirm',
    );
  });

  it('lets a card with no final outcome a day after its expiry be deleted when they ask', async () => {
    const { confirm, form, outcomes } = setup({
      expiresAt: Math.floor(Date.now() / 1000) - 2 * 86_400,
    });
    const ref = await fillApplication(form);
    await confirm(ref);
    outcomes.set('action-1', 'unknown');
    expect(
      await form({ action: 'discard', confirmed: true, ...ref }),
    ).toMatchObject({
      status: 'deleted',
      say: expect.stringContaining('my_work'),
    });
  });

  it('locks sections while a card waits', async () => {
    const { confirm, form } = setup();
    const ref = await fillApplication(form);
    await confirm(ref);
    expect(
      (
        await form({
          action: 'section',
          ...ref,
          section: 'shops',
          addAnother: true,
        })
      ).status,
    ).toBe('waiting_for_confirm');
  });
});

describe('sent work', () => {
  it('lets them delete a sent application and apply again', async () => {
    const { confirm, form, outcomes } = setup();
    const ref = await fillApplication(form);
    await confirm(ref);
    outcomes.set('action-1', 'succeeded');
    expect((await form({ action: 'next', ...ref })).status).toBe('submitted');
    expect(
      (await form({ action: 'discard', confirmed: true, ...ref })).status,
    ).toBe('deleted');
    expect(await form({ action: 'next', ...ref })).toMatchObject({
      status: 'in_progress',
      next: { field: 'schema:name' },
    });
  });
});

describe('two answers at once', () => {
  it('keeps both: each lands on the draft as stored, not on a stale copy', async () => {
    const { form, kv } = setup();
    if (!kv) throw new Error('storage expected');
    const ref = { form: 'application', collectionId: '9787' };
    await form({ action: 'next', ...ref });
    await Promise.all([
      form({ action: 'answer', ...ref, field: 'schema:name', reply: 'Lebo' }),
      form({
        action: 'answer',
        ...ref,
        field: 'schema:identifier',
        reply: '0001015800085',
      }),
    ]);
    expect((await storedDraft(kv, 'application', '9787')).data).toMatchObject({
      'schema:name': 'Lebo',
      'schema:identifier': '0001015800085',
    });
  });
});

describe('sending, when Auth Hub says no', () => {
  const refusing = (error: unknown) =>
    setup({
      hubActions: (base) => ({
        ...base,
        request: async () => {
          throw error;
        },
      }),
    });

  it.each([
    [
      new HubActionRefused(
        'refused',
        'Auth Hub has no completed account or active channel link for this owner (not_found); retrying or changing the fields will not help.',
      ),
      {
        reason: 'refused',
        retryable: false,
        detail: expect.stringContaining('no completed account'),
      },
    ],
    [
      new HubActionRefused(
        'limit',
        'Reviews are prepared only in reply to a message from the user.',
      ),
      { reason: 'refused', retryable: false },
    ],
    [
      new HubActionRefused(
        'expired',
        'This review request expired before it reached Auth Hub; ask the user to confirm again.',
      ),
      { reason: 'expired', retryable: false },
    ],
    [
      new HubActionRefused(
        'refused',
        'Auth Hub is limiting requests from this oracle right now (rate_limited); try again later.',
        undefined,
        429,
      ),
      { reason: 'rate_limited', retryable: true },
    ],
    [
      new HubActionRefused(
        'refused',
        'Auth Hub did not accept this operation as written.',
        undefined,
        400,
      ),
      { reason: 'refused', retryable: false },
    ],
    [
      new Error('Hub action request returned 503'),
      { reason: 'unavailable', retryable: true },
    ],
    [
      new Error('Hub action request returned 429'),
      { reason: 'rate_limited', retryable: true },
    ],
    [
      new Error('Hub action request returned 400'),
      { reason: 'refused', retryable: false },
    ],
    [
      new Error('Hub action request returned 401'),
      { reason: 'unavailable', retryable: false },
    ],
    [
      new DOMException('The operation timed out.', 'TimeoutError'),
      { reason: 'timeout', retryable: true },
    ],
    [
      new Error('Hub action request key belongs to another operation'),
      { reason: 'unavailable', retryable: false },
    ],
  ])(
    'maps %s to plain words, retryable only when asking again can help',
    async (error, expected) => {
      const { confirm, form, kv } = refusing(error);
      if (!kv) throw new Error('storage expected');
      const ref = await fillApplication(form);
      expect(await confirm(ref)).toMatchObject({ ok: false, ...expected });
      // The next send gets a key of its own.
      expect((await storedDraft(kv, 'application', '9787')).cardAttempt).toBe(
        1,
      );
    },
  );

  it('retries after a 503 through the real prepare path: the first key stays bound to its run, the retry gets its own', async () => {
    const HUB = 'https://hub.test';
    const id = 'R'.repeat(32);
    let posts = 0;
    const client = new HubActionClient({
      origin: HUB,
      key: 'service-key',
      fetcher: {
        fetch: async (request: Request) => {
          if (request.method === 'GET')
            return Response.json(capabilities(['ixo.bid.submit.v1']));
          posts += 1;
          if (posts === 1)
            return Response.json({ error: 'unavailable' }, { status: 503 });
          const body = (await request.json()) as {
            bindingId: string;
            bindingRevision: number;
            expiresAt: number;
          };
          return Response.json({
            reference: {
              ...reference(1),
              id,
              url: `${HUB}/a/${id}`,
              bindingId: body.bindingId,
              bindingRevision: body.bindingRevision,
              expiresAt: body.expiresAt,
            },
          });
        },
      },
    });
    // The runtime's store rule (`HubActionStore.reserve`): a key is bound to
    // the run and request that reserved it, and to its operation.
    const reserved = new Map<
      string,
      { runId: string; requestId: string; operation: string }
    >();
    const recorded = new Map<string, ActionReference>();
    const store = {
      reserve: async (
        origin: HubActionOrigin,
        operation: unknown,
        expiresAt: number,
      ) => {
        const held = reserved.get(origin.requestKey);
        const encoded = JSON.stringify(operation);
        if (
          held &&
          (held.runId !== origin.runId ||
            held.requestId !== origin.requestId ||
            held.operation !== encoded)
        )
          throw new Error(
            'Hub action request key belongs to another operation',
          );
        reserved.set(origin.requestKey, {
          runId: origin.runId,
          requestId: origin.requestId,
          operation: encoded,
        });
        return expiresAt;
      },
      record: async (origin: HubActionOrigin, ref: ActionReference) => {
        recorded.set(origin.requestKey, ref);
        return ref;
      },
      byRequestKey: async (key: string) => recorded.get(key) ?? null,
    };
    const { confirm, form, kv } = setup({
      hubActions: (base) => ({
        ...base,
        capabilities: () => client.capabilities(),
        request: (input) => prepareHubAction(client, store, input),
      }),
    });
    if (!kv) throw new Error('storage expected');
    const ref = await fillApplication(form);
    expect(await confirm(ref)).toMatchObject({
      ok: false,
      reason: 'unavailable',
      retryable: true,
    });
    expect(await confirm(ref)).toMatchObject({ ok: true, status: 'prepared' });
    expect(posts).toBe(2);
    expect(reserved.size).toBe(2);
    const runs = [...reserved.values()].map((r) => r.runId);
    expect(new Set(runs).size).toBe(2);
    expect((await storedDraft(kv, 'application', '9787')).card?.actionId).toBe(
      id,
    );
  });
});

describe('the network', () => {
  it("sends on the network Auth Hub's account names, and refuses one that differs from the oracle's", async () => {
    const other = setup({ capabilities: { network: 'ixo testnet' } });
    const ref = await fillApplication(other.form);
    expect(await other.confirm(ref)).toMatchObject({
      ok: false,
      reason: 'unavailable',
      retryable: false,
      detail: expect.stringContaining('ixo testnet'),
    });
    expect(other.requests).toHaveLength(0);
    // The Hub names none (no bank sends or chain transactions on): the oracle's own.
    const unnamed = setup({ capabilities: { network: null } });
    await unnamed.confirm(await fillApplication(unnamed.form));
    expect(unnamed.requests[0]!.operation).toMatchObject({
      network: 'ixo mainnet',
    });
  });

  it('reads nothing when the oracle names no network, rather than guess mainnet', async () => {
    expect(
      await setup({ config: { NETWORK: 'moonnet' } }).lookup({
        kind: 'programmes',
      }),
    ).toMatchObject({ ok: false, reason: 'unavailable', retryable: false });
  });
});

describe('files', () => {
  it('asks for a file again when its gateway link lapses before the Hub could fetch it', async () => {
    const { confirm, form, kv, attachments, requests } = setup({
      operations: ['ixo.claim.submit.v1'],
    });
    if (!kv) throw new Error('storage expected');
    const soon = `https://channels.test/media/binding-1/cert?exp=${Math.floor(Date.now() / 1000) + 60}&sig=x`;
    const ref = await fillClaim(form, attachments, soon);
    expect(await confirm(ref)).toMatchObject({
      ok: true,
      status: 'file_expired',
      fields: ['ixo:evidenceType_certificate'],
      next: { field: 'ixo:evidenceType_certificate' },
    });
    expect(requests).toHaveLength(0);
    const stored = await storedDraft(kv, 'claim', '9787');
    expect(stored.evidence).toEqual([]);
    expect(stored.data).not.toHaveProperty('ixo:evidenceType_certificate');
  });
});

describe('instant permission, at most once', () => {
  it('never calls the grant again for an application whose grant never answered', async () => {
    world.allowed = false;
    let calls = 0;
    const instantPermission: InstantPermission = {
      allows: () => true,
      grant: ({ signal }) => {
        calls += 1;
        return new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      },
    };
    const { form, formWith, newMessage } = setup({ instantPermission });
    const ref = await fillApplication(form);
    await form({ action: 'review', ...ref });
    newMessage();
    const turn = new AbortController();
    const pending = formWith(turn.signal, {
      action: 'submit',
      confirmed: true,
      ...ref,
    });
    await vi.waitFor(() => expect(calls).toBe(1));
    turn.abort(new Error('turn ended'));
    await expect(pending).rejects.toThrow();
    newMessage();
    await form({ action: 'review', ...ref });
    newMessage();
    expect(
      (await form({ action: 'submit', confirmed: true, ...ref })).status,
    ).toBe('permission_pending');
    expect(calls).toBe(1);
  });

  it('starts a fresh application once the permission it gave is used up', async () => {
    world.allowed = false;
    const instantPermission: InstantPermission = {
      allows: () => true,
      grant: async () => {
        world.allowed = true;
      },
    };
    const { confirm, form } = setup({ instantPermission });
    const ref = await fillApplication(form);
    expect((await confirm(ref)).status).toBe('can_log_work');
    expect((await form({ action: 'next', ...ref })).status).toBe('submitted');
    world.allowed = false;
    expect((await form({ action: 'next', ...ref })).status).toBe('in_progress');
  });
});

describe('my_drafts under load', () => {
  it('asks Auth Hub about at most three cards, each for at most 3 s', async () => {
    const timeouts: Array<number | undefined> = [];
    const { lookup, kv } = setup({
      hubActions: (base) => ({
        ...base,
        status: async (_owner, _id, opts) => {
          timeouts.push(opts?.timeoutMs);
          throw new DOMException('The operation timed out.', 'TimeoutError');
        },
      }),
    });
    if (!kv) throw new Error('storage expected');
    for (const id of ['101', '102', '103', '104'])
      await updateDraft(kv, 'claim', id, () => ({
        v: 1,
        form: 'claim',
        collectionId: id,
        entityDid: ENTITY,
        protocolDid: MILESTONE,
        admin: ADMIN,
        title: `Job ${id}`,
        startedAt: '2026-10-30T00:00:00.000Z',
        updatedAt: `2026-10-30T00:00:0${id.slice(-1)}.000Z`,
        data: {},
        skipped: [],
        closedSections: [],
        evidence: [],
        cardAttempt: 0,
        card: {
          actionId: `action-${id}`,
          requestKey: 'k',
          sentAt: '2026-10-30T00:00:00.000Z',
          answersAt: '2026-10-30T00:00:00.000Z',
        },
      }));
    const [drafts] = (await lookup({ kind: 'my_drafts' })).results;
    expect(drafts.drafts).toHaveLength(4);
    expect(timeouts).toEqual(
      Array(MAX_CARD_REFRESHES).fill(HUB_STATUS_TIMEOUT_MS),
    );
  });
});

describe('the catalog build', () => {
  it('lists only OPEN collections: a paused one is never offered', async () => {
    const [jobs] = (
      await setup().lookup({ kind: 'programme_jobs', programme: ENTITY })
    ).results;
    expect(
      jobs.jobs.map((j: { collectionId: string }) => j.collectionId),
    ).not.toContain('7001');
    const query = fetcher.mock.calls
      .filter(([u]) => u === BLOCKSYNC)
      .map(([, init]) => String(init.body))
      .find((body) => body.includes('claimCollections'));
    expect(query).toContain('state: { equalTo: 0 }');
  });

  it('reads every page of collections and orders jobs by number, not as text', async () => {
    const page2 = {
      ...COLLECTIONS[0],
      id: '10000',
    };
    world.route = (url, init) => {
      if (url !== BLOCKSYNC) return undefined;
      const query = JSON.parse(String(init?.body)).query as string;
      if (!query.includes('c: claimCollections')) return undefined;
      return query.includes('after:')
        ? json({
            data: {
              c: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [page2],
              },
            },
          })
        : json({
            data: {
              c: {
                pageInfo: { hasNextPage: true, endCursor: 'Y3Vyc29y' },
                nodes: COLLECTIONS.filter((c) => c.state === 0),
              },
            },
          });
    };
    const [jobs] = (
      await setup().lookup({ kind: 'programme_jobs', programme: ENTITY })
    ).results;
    expect(
      jobs.jobs.map((j: { collectionId: string }) => j.collectionId),
    ).toEqual(['8724', '9787', '10000']);
  });

  it('is not aborted by the caller that started it: another caller waiting on it still gets the list', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.route = (url) =>
      url === `${WORKER}/v1/entities`
        ? gate.then(() => json({ data: { entities: [ENTITY, QUIET] } }))
        : undefined;
    const first = setup();
    const second = setup();
    const turn = new AbortController();
    const started = first.lookupWith(turn.signal, { kind: 'programmes' });
    const joined = second.lookup({ kind: 'programmes' });
    turn.abort(new Error('first caller left'));
    await expect(started).rejects.toThrow('first caller left');
    release();
    const [programmes] = (await joined).results;
    expect(programmes.ok).toBe(true);
    expect(programmes.programmes).toHaveLength(2);
    expect(
      fetcher.mock.calls.filter(([u]) => u === `${WORKER}/v1/entities`),
    ).toHaveLength(1);
  });

  it('keeps a list with a piece missing for 30 s only, a complete one for minutes', async () => {
    vi.useFakeTimers();
    const listReads = () =>
      fetcher.mock.calls.filter(([u]) => u === `${WORKER}/v1/entities`).length;
    world.route = (url) =>
      url.startsWith(`${WORKER}/v1/collections/${encodeURIComponent(QUIET)}`)
        ? new Response('nope', { status: 500 })
        : undefined;
    const { lookup } = setup();
    await lookup({ kind: 'programmes' });
    vi.setSystemTime(Date.now() + 31_000);
    await lookup({ kind: 'programmes' });
    expect(listReads()).toBe(2);
    world.route = undefined;
    vi.setSystemTime(Date.now() + 31_000);
    await lookup({ kind: 'programmes' });
    vi.setSystemTime(Date.now() + 31_000);
    await lookup({ kind: 'programmes' });
    expect(listReads()).toBe(3);
  });

  it('holds back only the address that failed, not its whole origin, when asked to', async () => {
    vi.useFakeTimers();
    const call: ChainCall = {
      network: 'mainnet',
      restUrl: 'https://rest.test',
      blocksyncUrl: BLOCKSYNC,
      user: 'did:ixo:test',
      deadline: Date.now() + 20_000,
      signal: new AbortController().signal,
      fetch: (input, init) => globalThis.fetch(input, init),
    };
    const down = `${WORKER}/v1/collections/down`;
    const up = `${WORKER}/v1/collections/up`;
    world.route = (url) =>
      url === down
        ? new Response('down', { status: 503 })
        : url === up
          ? json({ data: { blacklist: [] } })
          : undefined;
    const read = (url: string, healthPerUrl: boolean) =>
      getJson(call, 'job-list', url, z.unknown(), {
        label: 'hide list',
        maxBytes: 1024,
        what: 'A hide list',
        healthPerUrl,
      });
    const failed = read(down, true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await failed).ok).toBe(false);
    expect((await read(up, true)).ok).toBe(true);
    resetUpstreamHealth();
    const failedAgain = read(down, false);
    await vi.advanceTimersByTimeAsync(5_000);
    await failedAgain;
    expect((await read(up, false)).ok).toBe(false);
  });

  it('reads more than a hundred entities in as many reads as it takes, never dropping one', async () => {
    const ids = Array.from(
      { length: 150 },
      (_, i) => `did:ixo:entity:${i.toString(16).padStart(32, '0')}`,
    );
    world.route = (url, init) => {
      if (url !== BLOCKSYNC) return undefined;
      const query = JSON.parse(String(init?.body)).query as string;
      return json({
        data: {
          e: {
            nodes: ids
              .filter((id) => query.includes(JSON.stringify(id)))
              .map((id) => ({
                id,
                settings: null,
                service: [],
                linkedResource: [],
              })),
          },
        },
      });
    };
    const read = await fetchEntities(
      {
        network: 'mainnet',
        restUrl: 'https://rest.test',
        blocksyncUrl: BLOCKSYNC,
        user: 'did:ixo:test',
        deadline: Date.now() + 20_000,
        signal: new AbortController().signal,
        fetch: (input, init) => globalThis.fetch(input, init),
      },
      ids,
    );
    expect(read.ok && read.value.size).toBe(150);
    expect(fetcher.mock.calls.filter(([u]) => u === BLOCKSYNC)).toHaveLength(2);
  });
});

describe('upstream answers the plugin refuses', () => {
  it('says the index timed out when Blocksync hits its statement timeout', async () => {
    world.route = (url, init) =>
      url === BLOCKSYNC && String(init?.body).includes('w: claims')
        ? json({
            errors: [
              { message: 'canceling statement due to statement timeout' },
            ],
          })
        : undefined;
    expect(
      (await setup().lookup({ kind: 'my_work' })).results[0],
    ).toMatchObject({ ok: false, reason: 'index_timeout' });
  });

  it('never follows a redirect', async () => {
    world.route = (url) =>
      url === `${WORKER}/v1/entities`
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://elsewhere.test/' },
          })
        : undefined;
    expect(
      (await setup().lookup({ kind: 'programmes' })).results[0],
    ).toMatchObject({
      ok: false,
      reason: 'unavailable',
      detail: expect.stringContaining('redirected'),
    });
  });

  it('refuses a form at a plain http address, and one larger than the form cap', async () => {
    world.route = (url, init) => {
      if (url !== BLOCKSYNC) return undefined;
      const query = JSON.parse(String(init?.body)).query as string;
      if (!query.includes(JSON.stringify(TREES))) return undefined;
      return json({
        data: {
          e: {
            nodes: [
              {
                id: TREES,
                linkedResource: [
                  {
                    id: '{id}#vct',
                    serviceEndpoint: 'http://forms.test/trees-vct',
                  },
                ],
                service: [],
              },
            ],
          },
        },
      });
    };
    const [job] = (await setup().lookup({ kind: 'job', collectionId: '8724' }))
      .results;
    expect(job.logWork).toMatchObject({
      ok: false,
      reason: 'unavailable',
      retryable: false,
    });
    resetCatalogCache();
    world.route = (url) =>
      url === 'https://forms.test/trees-vct'
        ? new Response('x'.repeat(FORM_MAX_BYTES + 1), { status: 200 })
        : undefined;
    const [big] = (await setup().lookup({ kind: 'job', collectionId: '8724' }))
      .results;
    expect(big.logWork).toMatchObject({ ok: false, reason: 'too_large' });
  });
});

// The `warn` spy keeps expected retry log lines out of the test output.
void warn;
