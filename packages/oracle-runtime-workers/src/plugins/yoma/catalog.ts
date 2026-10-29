/**
 * Yoma's programmes and the jobs inside them: the same list jambo.yoma.world
 * shows, worked out the same way (Jambo `jambo-yoma-v2`: `utils/projects.ts`,
 * `utils/claims.ts`, `hooks/useProtocolCollections.ts`).
 *
 *   1. The Jambo worker's list of entities Yoma admins chose
 *      (`GET /v1/entities`): one programme each, in the worker's order.
 *   2. Every claim collection those entities own, from Blocksync.
 *   3. Minus the collections admins hid per entity (`GET /v1/collections/<entity>`).
 *
 * Jambo still lists collections that have ended or are full; this does not,
 * as nobody can apply to or claim on them. A job is one collection; its name
 * is its claim form's title, as on Jambo.
 */
import { z } from 'zod';
import type { ChainCall, Failure, Outcome } from '../ixo-chain/http';
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
/** Collections read for all programmes together, before filtering. */
const COLLECTIONS_READ = 1000;
/** Open jobs kept after hidden, ended and full ones are dropped; more set `truncated`. */
export const MAX_JOBS = 300;
/** Upstream reads one catalog build runs at once. */
const CONCURRENCY = 6;
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

export interface Catalog {
  programmes: Programme[];
  jobs: Job[];
  /** More open jobs than {@link MAX_JOBS}; the rest are left out. */
  truncated?: true;
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
  c: Pick<RawCollection, 'startDate' | 'endDate' | 'quota' | 'count'>,
  now: Date,
): boolean {
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
 * cache, the rest in one Blocksync read. Ids that fail the pattern are not
 * asked.
 */
export async function fetchEntities(
  call: ChainCall,
  ids: readonly string[],
): Promise<Outcome<Map<string, RawEntity>>> {
  const asked = [...new Set(ids.filter((id) => ENTITY_DID.test(id)))].slice(
    0,
    MAX_PROGRAMMES * 2,
  );
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
  if (!missing.length) return { ok: true, value: found };
  const read = await blocksyncRead(call, [
    {
      alias: 'e',
      field: `e: entities(filter: { id: { in: [${missing.map(literal).join(', ')}] } }, first: ${missing.length}) { nodes { ${ENTITY_FIELDS} } }`,
    },
  ]);
  if (!read.ok) return read;
  for (const entity of nodesOf(read.value.e, entitySchema)) {
    entityCache.set(entity.id, { at: now, entity });
    found.set(entity.id, entity);
  }
  return { ok: true, value: found };
}

/** Where a protocol keeps its forms: `#bco` the application, `#vct` (or `#surveyTemplate`) the claim. */
export type FormKind = 'application' | 'claim';

export function formResource(protocol: RawEntity | undefined, form: FormKind) {
  const resources = protocol?.linkedResource ?? [];
  return form === 'application'
    ? resources.find((r) => /#bco(-\d+)?$/.test(r.id))
    : (resources.find((r) => /#vct(-\d+)?$/.test(r.id)) ??
        resources.find((r) => r.id.includes('#surveyTemplate')));
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

/** An entity's profile document, clipped; empty when it has none or it cannot be read. */
async function profileOf(
  call: ChainCall,
  entity: RawEntity | undefined,
): Promise<Profile> {
  const endpoint = profileEndpoint(entity);
  if (!endpoint) return {};
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
    },
  );
  if (!read.ok) return {};
  const doc = read.value;
  const name = clippedText(doc.name, 120);
  const brand = clippedText(doc.brand, 120);
  const location = clippedText(doc.location, 120);
  const description = clippedText(doc.description, 600);
  return {
    ...(name ? { name } : {}),
    ...(brand ? { brand } : {}),
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
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
 * The programmes and their open jobs. One build per isolate at a time: a
 * call during a build waits for it. A built list is kept five minutes, a
 * failed one 30 seconds, so a struggling upstream is not asked again by
 * every call.
 */
export async function loadCatalog(
  call: ChainCall,
  now = new Date(),
): Promise<Outcome<Catalog>> {
  const base = JOB_LIST_URLS[call.network];
  if (!base) return { ok: true, value: { programmes: [], jobs: [] } };
  const cached = listCache.get(call.network);
  if (cached && now.getTime() - cached.at < cached.ttl) return cached.pending;
  const entry = {
    at: now.getTime(),
    ttl: LIST_TTL_MS,
    pending: buildCatalog(call, base, now),
  };
  listCache.set(call.network, entry);
  const built = await entry.pending.catch((error: unknown) => {
    listCache.delete(call.network);
    throw error;
  });
  if (!built.ok) entry.ttl = FAILED_TTL_MS;
  return built;
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

async function buildCatalog(
  call: ChainCall,
  base: string,
  now: Date,
): Promise<Outcome<Catalog>> {
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
  const entityIds = [
    ...new Set(listed.value.data.entities.filter((id) => ENTITY_DID.test(id))),
  ].slice(0, MAX_PROGRAMMES);
  if (!entityIds.length)
    return { ok: true, value: { programmes: [], jobs: [] } };

  // A hide list that cannot be read must not show what it hides: that
  // programme shows as unavailable, with none of its jobs; the rest of the
  // list stands. A 404 is a programme with nothing hidden.
  const hidden = await mapLimit(entityIds, (id) =>
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
      },
    ),
  );
  const hiddenBy = new Map<string, Set<string>>();
  const unreadable = new Set<string>();
  hidden.forEach((read, index) => {
    const id = entityIds[index]!;
    if (read.ok) hiddenBy.set(id, new Set(read.value.data?.blacklist ?? []));
    else if (read.failure.reason === 'not_found') hiddenBy.set(id, new Set());
    else unreadable.add(id);
  });

  const ids = entityIds.map(literal).join(', ');
  const first = await blocksyncRead(call, [
    {
      alias: 'c',
      field: `c: claimCollections(filter: { entity: { in: [${ids}] } }, first: ${COLLECTIONS_READ}) { nodes { id entity admin protocol startDate endDate quota count payments } }`,
    },
    {
      alias: 'e',
      field: `e: entities(filter: { id: { in: [${ids}] } }, first: ${entityIds.length}) { nodes { ${ENTITY_FIELDS} } }`,
    },
  ]);
  if (!first.ok) return first;
  const collections = nodesOf(first.value.c, collectionSchema);
  const entities = new Map(
    nodesOf(first.value.e, entitySchema).map((n) => [n.id, n]),
  );
  const order = new Map(entityIds.map((id, index) => [id, index]));
  const allOpen = collections
    .filter(
      (c) =>
        !unreadable.has(c.entity) &&
        !hiddenBy.get(c.entity)?.has(c.id) &&
        isOpen(c, now),
    )
    .sort(
      (x, y) =>
        order.get(x.entity)! - order.get(y.entity)! ||
        Number(x.id) - Number(y.id),
    );
  const open = allOpen.slice(0, MAX_JOBS);

  const protocolIds = [...new Set(open.map((c) => c.protocol))];
  const protocols = await fetchEntities(call, protocolIds);
  if (!protocols.ok) return protocols;
  const profiles = await mapLimit(
    entityIds,
    async (id) => [id, await profileOf(call, entities.get(id))] as const,
  );
  const titles = await mapLimit(protocolIds, async (id) => {
    const form = await loadForm(call, protocols.value.get(id), 'claim');
    return [id, form.ok ? templateTitle(form.value) : undefined] as const;
  });
  const profileOfId = new Map(profiles);
  const titleOf = new Map(titles);

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
      ...(allOpen.length > open.length ? { truncated: true as const } : {}),
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
