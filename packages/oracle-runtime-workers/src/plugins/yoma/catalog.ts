/**
 * Yoma's programmes and the jobs inside them: the same list jambo.yoma.world
 * shows, worked out the same way (Jambo `jambo-yoma-v2`: `utils/projects.ts`,
 * `utils/claims.ts`, `hooks/useProtocolCollections.ts`).
 *
 *   1. The Jambo worker's list of entities Yoma admins chose
 *      (`GET /v1/entities`): one programme each, in the worker's order.
 *   2. Every claim collection those entities own, from Blocksync.
 *   3. Minus the collections admins hid per entity (`GET /v1/collections/<entity>`).
 *   4. Plus the host's bot-only jobs ({@link BotOnlyJob}): test collections
 *      offered in chat but not on jambo.yoma.world, after Jambo's programmes.
 *
 * Jambo still lists collections that are not open (state PAUSED or CLOSED),
 * have ended or are full; this does not, as the chain refuses a claim on
 * them (x/claims `SubmitClaim`: state OPEN, dates, quota). A job is one
 * collection; its name is its claim form's title, as on Jambo.
 */
import { z } from 'zod';
import {
  TOOL_BUDGET_MS,
  untilAborted,
  unavailable,
  type ChainCall,
  type Failure,
  type Outcome,
} from '../ixo-chain/http';
import {
  blocksyncRead,
  FORM_MAX_BYTES,
  getJson,
  JOB_LIST_MAX_BYTES,
  literal,
  PROFILE_MAX_BYTES,
} from './reads';
import { clippedText } from './text';

/** The Jambo worker that holds the list, per network. A network without one has no programmes. */
export const JOB_LIST_URLS: Partial<Record<ChainCall['network'], string>> = {
  mainnet: 'https://ixo-yoma-jambo-worker.ixo-api.workers.dev',
};

export const ENTITY_DID = /^did:ixo:entity:[0-9a-f]{32}$/;
export const COLLECTION_ID = /^[1-9][0-9]{0,11}$/;

/** Programmes read from the worker's list; more are left out. */
export const MAX_PROGRAMMES = 50;
/** Open collections read per Blocksync page, and the pages read; more set `truncated`. */
export const COLLECTIONS_PAGE = 500;
export const MAX_COLLECTION_PAGES = 4;
/** Entities asked in one Blocksync read; more are read in further reads. */
const ENTITIES_PER_READ = 100;
/** Open jobs kept after hidden, ended and full ones are dropped; more set `truncated`. */
export const MAX_JOBS = 300;
/**
 * Reads one catalog build queues at once; they then take permits from the
 * build's own pool (ixo-chain's {@link USER_READ_PERMITS}, keyed by network),
 * not from the person who happened to start it.
 */
const CONCURRENCY = 6;
/** `x/claims` `CollectionState`: OPEN = 0, PAUSED = 1, CLOSED = 2 (Blocksync stores the number). */
export const COLLECTION_OPEN = 0;
/** How long a failed build answers without being tried again. */
const FAILED_TTL_MS = 30_000;
/** How long a protocol entity is kept per isolate. */
const ENTITY_TTL_MS = 10 * 60_000;
/** Forms kept per isolate, and their total size. */
const FORM_CACHE_ENTRIES = 50;
const FORM_CACHE_BYTES = 5 * 1024 * 1024;
/** How long a built list is kept per isolate. */
const LIST_TTL_MS = 5 * 60_000;
/** How long a form template is kept per isolate. */
const FORM_TTL_MS = 10 * 60_000;

export interface Coin {
  denom: string;
  amount: string;
}

export interface Job {
  collectionId: string;
  /** The entity that owns the collection: its programme. */
  entityDid: string;
  /** The protocol entity whose linked resources hold the forms. */
  protocolDid: string;
  /** The collection's admin account, which gives people permission to claim. */
  admin: string;
  title: string;
  provider: string;
  location?: string;
  description?: string;
  endDate?: string;
  /** Claims still accepted (quota minus count), when the collection has a quota. */
  slotsLeft?: number;
  /** What an approved claim pays, as the collection lists it. Empty: no incentive. */
  reward: Coin[];
}

export interface Programme {
  entityDid: string;
  name: string;
  provider: string;
  location?: string;
  description?: string;
  openJobs: number;
  /**
   * Its hide list could not be read, so none of its jobs are shown: a job it
   * hides must never be offered. The rest of the list stands.
   */
  unavailable?: true;
}

/**
 * A job the host offers in chat only, strictly for testing on a production
 * collection: the test runs on mainnet with real cards and payments, while
 * jambo.yoma.world, and so the partners' and opportunity providers' own
 * listings and results, never show it. Not for real opportunities: those
 * belong on Jambo's list. One collection of a programme's entity, shown
 * whether or not Jambo lists the entity. Its programme comes after Jambo's
 * (an entity Jambo lists keeps its place) and shows only its bot-only jobs;
 * Jambo's hide list does not apply to it. The chain still decides whether it
 * is open, so closing or pausing the collection ends the test.
 */
export interface BotOnlyJob {
  /** The entity that owns the collection (`did:ixo:entity:…`). */
  programme: string;
  collectionId: string;
}

export interface Catalog {
  programmes: Programme[];
  jobs: Job[];
  /** More open jobs than {@link MAX_JOBS}, or more collections than were read; the rest are left out. */
  truncated?: true;
  /** A piece could not be read (a hide list, a profile, a job's name): kept only briefly. */
  incomplete?: true;
}

/** A bank coin as Blocksync gives it; an amount that is not whole base units is left out. */
export const coinSchema = z.object({
  denom: z.string().max(128),
  amount: z.union([z.string(), z.number()]).transform(String),
});

/** Positive whole-unit coins, at most five. */
export function positiveCoins(
  coins: readonly Coin[] | null | undefined,
): Coin[] {
  return (coins ?? [])
    .filter((c) => /^\d{1,30}$/.test(c.amount) && Number(c.amount) > 0)
    .slice(0, 5);
}

export const paymentsSchema = z
  .object({
    approval: z
      .object({ amount: z.array(coinSchema).max(20).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .nullable()
  .optional();

const entitySchema = z
  .object({
    id: z.string(),
    settings: z.record(z.string(), z.unknown()).nullable().optional(),
    service: z
      .array(
        z
          .object({
            id: z.string(),
            type: z.string().optional(),
            serviceEndpoint: z.string(),
          })
          .passthrough(),
      )
      .max(50)
      .nullable()
      .optional(),
    linkedResource: z
      .array(
        z.object({ id: z.string(), serviceEndpoint: z.string() }).passthrough(),
      )
      .max(100)
      .nullable()
      .optional(),
  })
  .passthrough();

const collectionSchema = z.object({
  id: z.string().regex(COLLECTION_ID),
  entity: z.string().regex(ENTITY_DID),
  admin: z.string(),
  protocol: z.string(),
  state: z.number().int(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  quota: z.union([z.string(), z.number()]).transform(String).nullable(),
  count: z.union([z.string(), z.number()]).transform(String).nullable(),
  payments: paymentsSchema,
});

export type RawEntity = z.infer<typeof entitySchema>;
type RawCollection = z.infer<typeof collectionSchema>;

/**
 * The rows of a list field (`{ nodes: [...] }`) that match `schema`; a row of
 * another shape is left out rather than trusted.
 */
export function nodesOf<S extends z.ZodType>(
  value: unknown,
  schema: S,
): Array<z.infer<S>> {
  const list = z.object({ nodes: z.array(z.unknown()) }).safeParse(value);
  if (!list.success) return [];
  return list.data.nodes.flatMap((node) => {
    const parsed = schema.safeParse(node);
    return parsed.success ? [parsed.data] : [];
  });
}

/** An entity's Profile service endpoint, if its settings name one. */
function profileEndpoint(entity: RawEntity | undefined): string | undefined {
  const profile = z
    .object({ serviceEndpoint: z.string() })
    .safeParse(entity?.settings?.Profile);
  return profile.success ? profile.data.serviceEndpoint : undefined;
}

const entityListSchema = z.object({
  data: z.object({ entities: z.array(z.string()).max(500) }),
});
const hideListSchema = z.object({
  data: z
    .object({ blacklist: z.array(z.string()).max(1000) })
    .nullable()
    .optional(),
});
const profileSchema = z.record(z.string(), z.unknown());
const templateSchema = z.record(z.string(), z.unknown());

/**
 * A service endpoint as an entity writes it (`cellnode:/public/abc` names
 * the entity's `#cellnode` service), resolved to a URL, as Jambo's
 * `getServiceEndpoint`. A full URL is returned as it is.
 */
export function resolveEndpoint(
  endpoint: string,
  services: RawEntity['service'],
): string {
  const match = /^([A-Za-z][\w-]*):(.*)$/.exec(endpoint);
  if (!match || /^https?$/i.test(match[1]!)) return endpoint;
  const service = (services ?? []).find((s) => s.id.endsWith(`#${match[1]}`));
  if (!service) return endpoint;
  return `${service.serviceEndpoint.replace(/\/?$/, '/')}${match[2]!.replace(/^\//, '')}`;
}

/** A date the chain stores as "no date" reads as 1970 or earlier. */
function realDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getFullYear() <= 1970
    ? undefined
    : date;
}

export function isOpen(
  c: Pick<RawCollection, 'state' | 'startDate' | 'endDate' | 'quota' | 'count'>,
  now: Date,
): boolean {
  if (c.state !== COLLECTION_OPEN) return false;
  const start = realDate(c.startDate);
  const end = realDate(c.endDate);
  if (start && start > now) return false;
  if (end && end < now) return false;
  const quota = Number(c.quota ?? 0);
  return !(quota > 0 && Number(c.count ?? 0) >= quota);
}

const ENTITY_FIELDS = 'id settings service linkedResource';

const entityCache = new Map<string, { at: number; entity: RawEntity }>();

/**
 * Entities by id: the ones read in the last ten minutes from the isolate's
 * cache, the rest from Blocksync, {@link ENTITIES_PER_READ} per read. Ids
 * that fail the pattern are not asked. One read that fails fails the whole
 * answer.
 */
export async function fetchEntities(
  call: ChainCall,
  ids: readonly string[],
): Promise<Outcome<Map<string, RawEntity>>> {
  const asked = [...new Set(ids.filter((id) => ENTITY_DID.test(id)))];
  const found = new Map<string, RawEntity>();
  const now = Date.now();
  const missing: string[] = [];
  for (const id of asked) {
    const cached = entityCache.get(id);
    if (cached && now - cached.at < ENTITY_TTL_MS) found.set(id, cached.entity);
    else {
      entityCache.delete(id);
      missing.push(id);
    }
  }
  const chunks: string[][] = [];
  for (let at = 0; at < missing.length; at += ENTITIES_PER_READ)
    chunks.push(missing.slice(at, at + ENTITIES_PER_READ));
  const reads = await mapLimit(chunks, (chunk) =>
    blocksyncRead(call, [
      {
        alias: 'e',
        field: `e: entities(filter: { id: { in: [${chunk.map(literal).join(', ')}] } }, first: ${chunk.length}) { nodes { ${ENTITY_FIELDS} } }`,
      },
    ]),
  );
  for (const read of reads) {
    if (!read.ok) return read;
    for (const entity of nodesOf(read.value.e, entitySchema)) {
      entityCache.set(entity.id, { at: now, entity });
      found.set(entity.id, entity);
    }
  }
  return { ok: true, value: found };
}

/** Where a protocol keeps its forms: `#bco` the application, `#vct` (or `surveyTemplate`) the claim. */
export type FormKind = 'application' | 'claim';

/**
 * A protocol's form resource, matched exactly as Jambo matches it
 * (`jambo-yoma-v2` `screens/collectionForm.tsx`): the first linked
 * resource whose id contains `#bco` (the application), or `#vct`, else
 * `surveyTemplate` (the claim).
 */
export function formResource(protocol: RawEntity | undefined, form: FormKind) {
  const resources = protocol?.linkedResource ?? [];
  return form === 'application'
    ? resources.find((r) => r.id.includes('#bco'))
    : (resources.find((r) => r.id.includes('#vct')) ??
        resources.find((r) => r.id.includes('surveyTemplate')));
}

/** Forms by URL, least recently used first (a Map keeps insertion order). */
const formCache = new Map<
  string,
  { at: number; bytes: number; template: unknown }
>();
let formCacheBytes = 0;

function forgetForm(url: string): void {
  const entry = formCache.get(url);
  if (!entry) return;
  formCache.delete(url);
  formCacheBytes -= entry.bytes;
}

function rememberForm(url: string, template: unknown): void {
  forgetForm(url);
  const bytes = JSON.stringify(template).length;
  if (bytes > FORM_CACHE_BYTES) return;
  const now = Date.now();
  for (const [key, entry] of formCache)
    if (now - entry.at >= FORM_TTL_MS) forgetForm(key);
  while (
    formCache.size >= FORM_CACHE_ENTRIES ||
    formCacheBytes + bytes > FORM_CACHE_BYTES
  ) {
    const oldest = formCache.keys().next();
    if (oldest.done) break;
    forgetForm(oldest.value);
  }
  formCache.set(url, { at: now, bytes, template });
  formCacheBytes += bytes;
}

/**
 * A protocol's application or claim form (a SurveyJS template).
 * `{ ok: true, value: undefined }` only when the protocol has no such form;
 * a form that cannot be read is a failure.
 */
export async function loadForm(
  call: ChainCall,
  protocol: RawEntity | undefined,
  form: FormKind,
  opts: { healthPerUrl?: boolean } = {},
): Promise<Outcome<unknown>> {
  const resource = formResource(protocol, form);
  if (!resource) return { ok: true, value: undefined };
  const url = resolveEndpoint(resource.serviceEndpoint, protocol?.service);
  const cached = formCache.get(url);
  if (cached && Date.now() - cached.at < FORM_TTL_MS) {
    // Touched: moves to the most recently used end.
    formCache.delete(url);
    formCache.set(url, cached);
    return { ok: true, value: cached.template };
  }
  forgetForm(url);
  const read = await getJson(call, 'document', url, templateSchema, {
    label: `${form} form`,
    maxBytes: FORM_MAX_BYTES,
    what: 'This form',
    ...(opts.healthPerUrl ? { healthPerUrl: true } : {}),
  });
  if (read.ok) rememberForm(url, read.value);
  return read;
}

/** A form template's title, clipped. */
export function templateTitle(template: unknown): string | undefined {
  const parsed = z
    .object({
      title: z.unknown().optional(),
      question: z
        .object({ title: z.unknown().optional() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .safeParse(template);
  if (!parsed.success) return undefined;
  return clippedText(parsed.data.question?.title ?? parsed.data.title, 200);
}

interface Profile {
  name?: string;
  brand?: string;
  location?: string;
  description?: string;
}

/** An entity's profile document, clipped; empty when it has none, `failed` when it could not be read. */
async function profileOf(
  call: ChainCall,
  entity: RawEntity | undefined,
): Promise<{ profile: Profile; failed?: true }> {
  const endpoint = profileEndpoint(entity);
  if (!endpoint) return { profile: {} };
  const read = await getJson(
    call,
    'document',
    resolveEndpoint(endpoint, entity?.service),
    profileSchema,
    {
      label: 'profile',
      maxBytes: PROFILE_MAX_BYTES,
      notFoundOn404: true,
      what: 'A programme profile',
      healthPerUrl: true,
    },
  );
  if (!read.ok)
    return read.failure.reason === 'not_found'
      ? { profile: {} }
      : { profile: {}, failed: true };
  const doc = read.value;
  const name = clippedText(doc.name, 120);
  const brand = clippedText(doc.brand, 120);
  const location = clippedText(doc.location, 120);
  const description = clippedText(doc.description, 600);
  return {
    profile: {
      ...(name ? { name } : {}),
      ...(brand ? { brand } : {}),
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
    },
  };
}

/** The isolate's catalog per network: built, being built (shared), or failed a moment ago. */
const listCache = new Map<
  string,
  { at: number; ttl: number; pending: Promise<Outcome<Catalog>> }
>();

/** Tests only: forget the cached list, entities and forms. */
export function resetCatalogCache(): void {
  listCache.clear();
  entityCache.clear();
  formCache.clear();
  formCacheBytes = 0;
}

/**
 * The programmes and their open jobs. One build per isolate and network at
 * a time, run on its own: its own deadline ({@link TOOL_BUDGET_MS} from its
 * start), its own abort (only that deadline ends it) and its own permit pool,
 * so the caller that started it can be aborted without failing the others.
 * Every caller, the first included, waits for it with its own abort
 * (`untilAborted`). A complete list is kept five minutes; a failed build, or
 * one with a piece missing (a hide list, a profile, a job's name), 30
 * seconds, so a struggling upstream is not asked by every call and a gap
 * does not last. `botOnly`: the host's bot-only jobs (malformed ones are
 * left out).
 */
export async function loadCatalog(
  call: ChainCall,
  now = new Date(),
  botOnly: readonly BotOnlyJob[] = [],
): Promise<Outcome<Catalog>> {
  const base = JOB_LIST_URLS[call.network];
  const extra = botOnly.filter(
    (job) =>
      ENTITY_DID.test(job.programme) && COLLECTION_ID.test(job.collectionId),
  );
  if (!base && !extra.length)
    return { ok: true, value: { programmes: [], jobs: [] } };
  const key = [
    call.network,
    ...extra.map((job) => `${job.programme}/${job.collectionId}`),
  ].join('|');
  let entry = listCache.get(key);
  if (!entry || now.getTime() - entry.at >= entry.ttl) {
    const started = {
      at: now.getTime(),
      ttl: LIST_TTL_MS,
      pending: startBuild(call, base, now, extra),
    };
    entry = started;
    listCache.set(key, started);
    void started.pending.then((built) => {
      if (!built.ok || built.value.incomplete) started.ttl = FAILED_TTL_MS;
    });
  }
  return untilAborted(entry.pending, call.signal);
}

/** The build's reads: every caller's network and endpoints, but the build's own permits, deadline and abort. */
function startBuild(
  caller: ChainCall,
  base: string | undefined,
  now: Date,
  botOnly: readonly BotOnlyJob[],
): Promise<Outcome<Catalog>> {
  const controller = new AbortController();
  const call: ChainCall = {
    network: caller.network,
    restUrl: caller.restUrl,
    blocksyncUrl: caller.blocksyncUrl,
    user: `yoma-catalog:${caller.network}`,
    deadline: Date.now() + TOOL_BUDGET_MS,
    signal: controller.signal,
    fetch: caller.fetch,
  };
  // Every wait inside is bounded by the deadline; the abort is the backstop.
  const timer = setTimeout(
    () => controller.abort(new Error('catalog build deadline')),
    TOOL_BUDGET_MS + 1_000,
  );
  return buildCatalog(call, base, now, botOnly)
    .catch((error: unknown): Outcome<Catalog> => {
      console.warn(
        `[yoma] catalog build failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      return {
        ok: false,
        failure: unavailable('job-list', 'the list could not be built', true),
      };
    })
    .finally(() => clearTimeout(timer));
}

/** `work` over `items`, at most {@link CONCURRENCY} at a time, results in order. */
async function mapLimit<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, lane),
  );
  return out;
}

const pageInfoSchema = z.object({
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable(),
  }),
});
const CURSOR = /^[A-Za-z0-9+/=_-]{1,500}$/;

/**
 * The OPEN collections the programmes own, page by page
 * ({@link COLLECTIONS_PAGE} each, at most {@link MAX_COLLECTION_PAGES});
 * `more` when the last page read was not the last. Blocksync keeps ids as
 * text (its order puts "10" before "9"), so the caller sorts them as numbers.
 */
async function openCollections(
  call: ChainCall,
  entityIds: readonly string[],
): Promise<Outcome<{ rows: RawCollection[]; more: boolean }>> {
  const ids = entityIds.map(literal).join(', ');
  const rows: RawCollection[] = [];
  let after = '';
  for (let page = 0; page < MAX_COLLECTION_PAGES; page++) {
    const read = await blocksyncRead(call, [
      {
        alias: 'c',
        field: `c: claimCollections(filter: { entity: { in: [${ids}] }, state: { equalTo: ${COLLECTION_OPEN} } }, first: ${COLLECTIONS_PAGE}${after}, orderBy: PRIMARY_KEY_ASC) { pageInfo { hasNextPage endCursor } nodes { id entity admin protocol state startDate endDate quota count payments } }`,
      },
    ]);
    if (!read.ok) return read;
    rows.push(...nodesOf(read.value.c, collectionSchema));
    const info = pageInfoSchema.safeParse(read.value.c);
    const cursor = info.success ? info.data.pageInfo.endCursor : null;
    if (!info.success || !info.data.pageInfo.hasNextPage)
      return { ok: true, value: { rows, more: false } };
    if (!cursor || !CURSOR.test(cursor))
      return { ok: true, value: { rows, more: true } };
    after = `, after: ${literal(cursor)}`;
  }
  return { ok: true, value: { rows, more: true } };
}

async function buildCatalog(
  call: ChainCall,
  base: string | undefined,
  now: Date,
  botOnly: readonly BotOnlyJob[],
): Promise<Outcome<Catalog>> {
  let jamboIds: string[] = [];
  if (base) {
    const listed = await getJson(
      call,
      'job-list',
      `${base}/v1/entities`,
      entityListSchema,
      {
        label: 'job list',
        maxBytes: JOB_LIST_MAX_BYTES,
        what: 'The Yoma job list',
      },
    );
    if (!listed.ok) return listed;
    jamboIds = [
      ...new Set(
        listed.value.data.entities.filter((id) => ENTITY_DID.test(id)),
      ),
    ].slice(0, MAX_PROGRAMMES);
  }
  // Bot-only programmes after Jambo's; one Jambo lists keeps its place.
  const onJambo = new Set(jamboIds);
  const entityIds = [
    ...jamboIds,
    ...new Set(
      botOnly.map((job) => job.programme).filter((id) => !onJambo.has(id)),
    ),
  ];
  const botOnlyJobs = new Set(
    botOnly.map((job) => `${job.programme}/${job.collectionId}`),
  );
  const isBotOnly = (c: { entity: string; id: string }) =>
    botOnlyJobs.has(`${c.entity}/${c.id}`);
  if (!entityIds.length)
    return { ok: true, value: { programmes: [], jobs: [] } };

  // The hide lists, the collections and the programmes' entities at once.
  // A hide list that cannot be read must not show what it hides: that
  // programme shows as unavailable, with none of its jobs; the rest of the
  // list stands. A 404 is a programme with nothing hidden. Each hide list,
  // profile and form keeps its own health mark here, so one 503 holds back
  // only that address, after its own retry, not the rest of the build.
  // A bot-only programme has no hide list: only its bot-only jobs show.
  const [hidden, collections, programmeEntities] = await Promise.all([
    mapLimit(jamboIds, (id) =>
      getJson(
        call,
        'job-list',
        `${base}/v1/collections/${encodeURIComponent(id)}`,
        hideListSchema,
        {
          label: 'hide list',
          maxBytes: JOB_LIST_MAX_BYTES,
          notFoundOn404: true,
          what: 'A hide list',
          healthPerUrl: true,
        },
      ),
    ),
    openCollections(call, entityIds),
    fetchEntities(call, entityIds),
  ]);
  if (!collections.ok) return collections;
  let incomplete = !programmeEntities.ok;
  const hiddenBy = new Map<string, Set<string>>();
  const unreadable = new Set<string>();
  hidden.forEach((read, index) => {
    const id = jamboIds[index]!;
    if (read.ok) hiddenBy.set(id, new Set(read.value.data?.blacklist ?? []));
    else if (read.failure.reason === 'not_found') hiddenBy.set(id, new Set());
    else unreadable.add(id);
  });
  if (unreadable.size) incomplete = true;

  const order = new Map(entityIds.map((id, index) => [id, index]));
  const allOpen = collections.value.rows
    .filter(
      (c) =>
        (isBotOnly(c) ||
          (onJambo.has(c.entity) &&
            !unreadable.has(c.entity) &&
            !hiddenBy.get(c.entity)?.has(c.id))) &&
        isOpen(c, now),
    )
    .sort(
      (x, y) =>
        order.get(x.entity)! - order.get(y.entity)! ||
        Number(x.id) - Number(y.id),
    );
  const open = allOpen.slice(0, MAX_JOBS);

  // Names: profiles, and each protocol's claim form title, at once.
  const protocolIds = [...new Set(open.map((c) => c.protocol))];
  const entityOf = (id: string) =>
    programmeEntities.ok ? programmeEntities.value.get(id) : undefined;
  const [profiles, titles] = await Promise.all([
    mapLimit(
      entityIds,
      async (id) => [id, await profileOf(call, entityOf(id))] as const,
    ),
    fetchEntities(call, protocolIds).then((protocols) =>
      protocols.ok
        ? mapLimit(protocolIds, async (id) => {
            const form = await loadForm(
              call,
              protocols.value.get(id),
              'claim',
              { healthPerUrl: true },
            );
            return [id, form.ok ? templateTitle(form.value) : null] as const;
          })
        : null,
    ),
  ]);
  if (!titles || titles.some(([, title]) => title === null)) incomplete = true;
  if (profiles.some(([, read]) => read.failed)) incomplete = true;
  const profileOfId = new Map(profiles.map(([id, read]) => [id, read.profile]));
  const titleOf = new Map(
    (titles ?? []).flatMap(([id, title]) =>
      title ? [[id, title] as const] : [],
    ),
  );

  const jobs = open.map((c): Job => {
    const profile = profileOfId.get(c.entity) ?? {};
    const quota = Number(c.quota ?? 0);
    return {
      collectionId: c.id,
      entityDid: c.entity,
      protocolDid: c.protocol,
      admin: c.admin,
      title: titleOf.get(c.protocol) ?? profile.name ?? `Opportunity ${c.id}`,
      provider: profile.brand ?? profile.name ?? 'A Yoma partner',
      ...(profile.location ? { location: profile.location } : {}),
      ...(profile.description ? { description: profile.description } : {}),
      ...(realDate(c.endDate) ? { endDate: c.endDate!.slice(0, 10) } : {}),
      ...(quota > 0
        ? { slotsLeft: Math.max(0, quota - Number(c.count ?? 0)) }
        : {}),
      reward: positiveCoins(c.payments?.approval?.amount),
    };
  });
  const programmes = entityIds.map((id): Programme => {
    const profile = profileOfId.get(id) ?? {};
    return {
      entityDid: id,
      name: profile.name ?? 'A Yoma programme',
      provider: profile.brand ?? profile.name ?? 'A Yoma partner',
      ...(profile.location ? { location: profile.location } : {}),
      ...(profile.description ? { description: profile.description } : {}),
      openJobs: jobs.filter((job) => job.entityDid === id).length,
      ...(unreadable.has(id) ? { unavailable: true as const } : {}),
    };
  });
  return {
    ok: true,
    value: {
      programmes,
      jobs,
      ...(allOpen.length > open.length || collections.value.more
        ? { truncated: true as const }
        : {}),
      ...(incomplete ? { incomplete: true as const } : {}),
    },
  };
}

/** Words in a person's search matched against what a programme or job says about itself. */
export function matchesQuery(
  item: {
    title?: string;
    name?: string;
    provider?: string;
    location?: string;
    description?: string;
  },
  query: string,
  extra: string[] = [],
): boolean {
  const haystack = [
    item.title,
    item.name,
    item.provider,
    item.location,
    item.description,
    ...extra,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2);
  return words.length === 0 || words.some((word) => haystack.includes(word));
}

/** The failure a missing programme or job answers with. */
export const notOpen = (what: string): Failure => ({
  reason: 'not_found',
  detail: `That ${what} is not open on Yoma right now.`,
  retryable: false,
});
