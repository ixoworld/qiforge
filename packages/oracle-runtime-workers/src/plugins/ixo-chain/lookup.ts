/**
 * The `chain_lookup` executor. Every request is planned first; one its kind
 * refuses answers `invalid_input` on its own and is never read. The
 * Blocksync plans of a call become ONE GraphQL document (aliases `r0…r7`
 * by request position); the chain plans run their REST reads and denom
 * lookups at once. Every read takes one of the user's permits
 * (`USER_READ_PERMITS` in `http.ts`, shared by all of the user's calls), so
 * a call never has more in flight; all of it runs inside the call's 20 s
 * budget and the turn's abort. Each request answers on its own, in request
 * order; the answer is cut to {@link MAX_RESULT_CHARS}.
 */
import type { z } from 'zod';
import type { UserIdentity } from '../../core/user-identity';
import {
  blocksyncLookup,
  STATEMENT_TIMEOUT,
  TRANSIENT_ERROR,
  type AliasedField,
  type BlocksyncAnswer,
  type GraphqlError,
} from './blocksync';
import {
  denomDisplay,
  knownDisplay,
  unreadDisplay,
  type IbcDenomTable,
  type TokenDisplay,
} from './denoms';
import {
  throwIfAborted,
  tooLarge,
  unavailable,
  type ChainCall,
  type Failure,
  type Outcome,
  type Source,
} from './http';
import type {
  KindContext,
  KindDef,
  KindPlan,
  KindRestOptions,
  KindResult,
} from './kinds/types';
import { dropLastName, pruneNames } from './names/collect';
import type { NameMap } from './names/types';
import { firstOf, type Subject } from './queries';
import { restJson, type Absent } from './rest';
import { isRecord } from './summaries';

/** Largest answer handed to the model, in JSON characters. */
export const MAX_RESULT_CHARS = 12_000;
/**
 * Distinct denoms one request looks up to show its bank coins; any further
 * denom is shown unread (base units, `metadataUnavailable`).
 */
export const MAX_DISPLAY_DENOMS = 20;

/** One request: its kind and the arguments the kind validates. */
export interface KindRequest {
  kind: KindDef;
  args?: unknown;
  /**
   * The rows a list kind reads (1–20), used as given instead of the
   * request's `args.first` scaled for the call.
   */
  first?: number;
}

/** What a call's requests are read with besides the call itself. */
export interface LookupOptions {
  /**
   * The IBC table bank coins are shown with: the network's built-in
   * entries with the operator's `IXO_CHAIN_IBC_DENOMS` merged over them.
   */
  ibcDenoms: IbcDenomTable;
}

export type LookupResult =
  | {
      kind: string;
      source: Source;
      ok: true;
      subject?: Subject;
      first?: number;
      data: unknown;
      truncated?: boolean;
    }
  | ({ kind: string; source: Source; ok: false } & Failure);

const LEFT_OUT = tooLarge(
  'Left out to keep the answer small; ask for it on its own.',
);
const NO_ANSWER = unavailable('blocksync', 'no answer for this request', true);
const NO_BLOCKSYNC = unavailable(
  'blocksync',
  'no valid BLOCKSYNC_GRAPHQL_URL is configured',
  false,
);
const KIND_FAILED: Failure = {
  reason: 'unavailable',
  detail: 'This request failed inside the oracle; asking again will not help.',
  retryable: false,
};

/* ── contexts ─────────────────────────────────────────────────────────── */

/**
 * The kind contexts of one call. A REST read is `restJson` over the call
 * (each attempt under one of the user's permits); a denom that needs a
 * lookup is looked up once per call (and through `denoms.ts`'s per-isolate
 * cache), and each request looks up at most {@link MAX_DISPLAY_DENOMS}
 * distinct denoms. Returns each request's context for the rows it reads.
 */
export function callContexts(
  call: ChainCall,
  identity: UserIdentity,
  options: LookupOptions,
): (first: number) => KindContext {
  function rest<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: KindRestOptions & { noneOn?: undefined },
  ): Promise<Outcome<z.infer<S>>>;
  function rest<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: KindRestOptions & { noneOn: readonly number[] },
  ): Promise<Outcome<z.infer<S>> | Absent>;
  function rest<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: KindRestOptions,
  ): Promise<Outcome<z.infer<S>> | Absent> {
    return restJson(call, path, schema, opts);
  }
  const lookups = new Map<string, Promise<TokenDisplay>>();
  const lookUp = (denom: string): Promise<TokenDisplay> => {
    const running = lookups.get(denom);
    if (running) return running;
    const pending = denomDisplay(call, denom, options.ibcDenoms);
    lookups.set(denom, pending);
    return pending;
  };
  return (first) => {
    const asked = new Set<string>();
    return {
      call,
      identity,
      first,
      rest,
      display(denom) {
        const known = knownDisplay(denom, options.ibcDenoms);
        if (known) return Promise.resolve(known);
        if (!asked.has(denom)) {
          if (asked.size >= MAX_DISPLAY_DENOMS)
            return Promise.resolve(unreadDisplay(denom));
          asked.add(denom);
        }
        return lookUp(denom);
      },
    };
  };
}

/** The request's own `first` when it is a whole number of at least 1 (its kind's schema checks the rest). */
function requestedFirst(args: unknown): number | undefined {
  const value = isRecord(args) ? args.first : undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : undefined;
}

/* ── one request ──────────────────────────────────────────────────────── */

/**
 * A kind that throws for anything but the turn's abort has a bug: its
 * request fails on its own (logged with the kind and the error's class
 * only: a message may carry request data) and the others still answer.
 */
function kindFailed(call: ChainCall, kind: string, error: unknown): KindResult {
  throwIfAborted(call.signal);
  // eslint-disable-next-line no-console -- console IS the logger on Workers
  console.error(
    `[ixo-chain] kind ${kind} threw: ${error instanceof Error ? error.name : 'non-error value'}`,
  );
  return { ok: false, ...KIND_FAILED };
}

type BlocksyncPlan = Extract<KindPlan, { source: 'blocksync' }>;
type ChainPlan = Extract<KindPlan, { source: 'chain' }>;

/** A request as its plan (and, for Blocksync, its document field), or its refusal. */
type Planned =
  | { plan: ChainPlan }
  | { plan: BlocksyncPlan; field: AliasedField }
  | { refused: KindResult };

function planOf(
  call: ChainCall,
  request: KindRequest,
  ctx: KindContext,
  alias: string,
): Planned {
  try {
    const plan = request.kind.plan(request.args, ctx);
    if ('invalid' in plan)
      return {
        refused: {
          ok: false,
          reason: 'invalid_input',
          detail: plan.invalid,
          retryable: false,
        },
      };
    if (plan.source === 'chain') return { plan };
    const field = plan.field(alias);
    // A field under another alias would break every request of the document.
    if (!field.startsWith(`${alias}: `))
      throw new Error(`its field is not aliased ${alias}`);
    return { plan, field: { alias, field } };
  } catch (error) {
    return { refused: kindFailed(call, request.kind.name, error) };
  }
}

async function settle(
  call: ChainCall,
  kind: string,
  answer: () => KindResult | Promise<KindResult>,
): Promise<KindResult> {
  try {
    return await answer();
  } catch (error) {
    return kindFailed(call, kind, error);
  }
}

/** The failure the document's errors give one alias, if any. */
function aliasFailure(alias: string, errors: GraphqlError[]): Failure | null {
  const mine = errors.filter(
    (error) => error.path.length === 0 || error.path[0] === alias,
  );
  if (!mine.length) return null;
  if (mine.some((error) => STATEMENT_TIMEOUT.test(error.message)))
    return {
      reason: 'index_timeout',
      detail:
        'The index could not answer in time; ask for fewer rows or a narrower filter.',
      retryable: false,
    };
  if (mine.some((error) => TRANSIENT_ERROR.test(error.message)))
    return unavailable('blocksync', 'a transient database error', true);
  const message = mine[0]?.message ?? '';
  return {
    reason: 'unavailable',
    detail: `Blocksync could not answer this request: ${message.length > 160 ? `${message.slice(0, 159)}…` : message}`,
    retryable: false,
  };
}

/** One alias's answer from the document, or why it has none. */
function aliasAnswer(
  read: Outcome<BlocksyncAnswer>,
  alias: string,
  plan: BlocksyncPlan,
): KindResult | Promise<KindResult> {
  if (!read.ok) return { ok: false, ...read.failure };
  const failure = aliasFailure(alias, read.value.errors);
  if (failure) return { ok: false, ...failure };
  // An alias the answer does not carry was not answered, which says
  // nothing about whether the record exists.
  const { data } = read.value;
  if (!data || !(alias in data)) return { ok: false, ...NO_ANSWER };
  return plan.shape(data[alias]);
}

function resultOf(
  kind: string,
  source: Source,
  result: KindResult,
): LookupResult {
  if (!result.ok)
    return {
      kind,
      source,
      ok: false,
      reason: result.reason,
      detail: result.detail,
      retryable: result.retryable,
    };
  return {
    kind,
    source,
    ok: true,
    ...(result.subject ? { subject: result.subject } : {}),
    ...(result.first !== undefined ? { first: result.first } : {}),
    data: result.data,
  };
}

/** The alias of the request at `index`. */
const aliasOf = (index: number) => `r${index}`;

/**
 * Every request's answer, in request order. Only the turn's abort is
 * thrown.
 */
export async function runRequests(
  call: ChainCall,
  identity: UserIdentity,
  requests: readonly KindRequest[],
  options: LookupOptions,
): Promise<LookupResult[]> {
  const contextFor = callContexts(call, identity, options);
  const planned = requests.map((request, index) => ({
    kind: request.kind,
    planned: planOf(
      call,
      request,
      contextFor(
        request.first ?? firstOf(requestedFirst(request.args), requests.length),
      ),
      aliasOf(index),
    ),
  }));
  const fields = planned.flatMap(({ planned: entry }) =>
    'field' in entry ? [entry.field] : [],
  );
  const document: Promise<Outcome<BlocksyncAnswer>> = !fields.length
    ? Promise.resolve({ ok: true, value: { data: null, errors: [] } })
    : call.blocksyncUrl
      ? blocksyncLookup(call, fields)
      : Promise.resolve({ ok: false, failure: NO_BLOCKSYNC });
  return Promise.all(
    planned.map(async ({ kind, planned: entry }) => {
      if ('refused' in entry)
        return resultOf(kind.name, kind.source, entry.refused);
      if (!('field' in entry)) {
        const { plan } = entry;
        return resultOf(
          kind.name,
          'chain',
          await settle(call, kind.name, () => plan.run()),
        );
      }
      const { plan, field } = entry;
      const read = await document;
      return resultOf(
        kind.name,
        'blocksync',
        await settle(call, kind.name, () =>
          aliasAnswer(read, field.alias, plan),
        ),
      );
    }),
  );
}

/* ── size ─────────────────────────────────────────────────────────────── */

const size = (value: unknown) => JSON.stringify(value).length;

/** The largest array (by JSON size) with more than one element inside `value`. */
function largestArray(
  value: unknown,
): { list: unknown[]; size: number } | null {
  let best: { list: unknown[]; size: number } | null = null;
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      if (node.length > 1) {
        const bytes = size(node);
        if (!best || bytes > best.size) best = { list: node, size: bytes };
      }
      node.forEach(visit);
    } else if (isRecord(node)) Object.values(node).forEach(visit);
  };
  visit(value);
  return best;
}

/**
 * Halves the largest list inside `within` (keeping its first rows) until
 * `holder` serialises within `budget` or no list is left to halve; marks
 * `holder` `truncated` when anything was cut.
 */
export function shrink(
  holder: { truncated?: boolean },
  within: unknown,
  budget: number,
): void {
  while (size(holder) > budget) {
    const found = largestArray(within);
    if (!found) return;
    found.list.length = Math.ceil(found.list.length / 2);
    holder.truncated = true;
  }
}

/**
 * One row cut: the last row of the largest list inside `within` left out
 * and `holder` marked `truncated`; false when no list has more than one
 * row left.
 */
export function cutRow(
  holder: { truncated?: boolean },
  within: unknown,
): boolean {
  const found = largestArray(within);
  if (!found) return false;
  found.list.pop();
  holder.truncated = true;
  return true;
}

/**
 * One row cut across `results`: the last row of the largest list in any
 * `ok` result left out and that result marked `truncated`; false when no
 * result has a list of more than one row left.
 */
export function cutRowAcross(results: LookupResult[]): boolean {
  let largest: { result: LookupResult; size: number } | undefined;
  for (const result of results) {
    if (!result.ok) continue;
    const found = largestArray(result.data);
    if (found && (!largest || found.size > largest.size))
      largest = { result, size: found.size };
  }
  return largest?.result.ok
    ? cutRow(largest.result, largest.result.data)
    : false;
}

/**
 * Fits `answer`, which carries `names`, into {@link MAX_RESULT_CHARS}.
 * Rows go first, one `cutRows` at a time (one row each: {@link cutRow},
 * {@link cutRowAcross}), each cut followed by leaving out the names of
 * identifiers no longer in the answer; with no row left to cut, names go
 * from the end of the map (the least placed identifiers). An answer is
 * never left out whole to make room for names. An empty map is removed.
 */
export function fitNames(
  answer: { names?: NameMap },
  cutRows: () => boolean,
): void {
  while (size(answer) > MAX_RESULT_CHARS) {
    if (!cutRows()) break;
    pruneNames(answer);
  }
  while (size(answer) > MAX_RESULT_CHARS) if (!dropLastName(answer)) break;
  if (answer.names && !Object.keys(answer.names).length) delete answer.names;
}

/**
 * Fits `parts` (the results inside `whole`) into what
 * {@link MAX_RESULT_CHARS} leaves after the envelope: each part gets an
 * equal share, smallest first, and a share a part does not use passes to
 * the larger parts after it. A cut re-measures only its own part.
 */
function shareOut(
  whole: unknown,
  parts: { data: unknown; truncated?: boolean }[],
): void {
  const sizes = new Map(parts.map((part) => [part, size(part)]));
  let left =
    MAX_RESULT_CHARS -
    (size(whole) - [...sizes.values()].reduce((sum, n) => sum + n, 0));
  const bySize = [...parts].sort(
    (a, b) => (sizes.get(a) ?? 0) - (sizes.get(b) ?? 0),
  );
  bySize.forEach((part, index) => {
    shrink(part, part.data, Math.floor(left / (bySize.length - index)));
    left -= size(part);
  });
}

/**
 * Cuts `results` (inside `whole`) until `whole` fits
 * {@link MAX_RESULT_CHARS}: lists are halved within each result's share;
 * a result that cannot be cut to its share leaves the largest answers out,
 * one at a time, as `too_large`.
 */
export function fitResults(whole: unknown, results: LookupResult[]): void {
  shareOut(
    whole,
    results.flatMap((result) => (result.ok ? [result] : [])),
  );
  while (size(whole) > MAX_RESULT_CHARS) {
    let largest = -1;
    results.forEach((result, index) => {
      if (result.ok && (largest < 0 || size(result) > size(results[largest])))
        largest = index;
    });
    const evicted = results[largest];
    if (!evicted) break;
    results[largest] = {
      kind: evicted.kind,
      source: evicted.source,
      ok: false,
      ...LEFT_OUT,
    };
  }
}

export interface LookupAnswer {
  ok: true;
  network: ChainCall['network'];
  fetchedAt: string;
  results: LookupResult[];
  /** What the identifiers in the results are called (added by the tool). */
  names?: NameMap;
}

/** `chain_lookup`'s answer: every request's result in order, cut to size. */
export async function chainLookup(
  call: ChainCall,
  identity: UserIdentity,
  requests: readonly KindRequest[],
  options: LookupOptions,
): Promise<LookupAnswer> {
  const results = await runRequests(call, identity, requests, options);
  const whole = {
    ok: true as const,
    network: call.network,
    fetchedAt: new Date().toISOString(),
    results,
  };
  fitResults(whole, results);
  return whole;
}
