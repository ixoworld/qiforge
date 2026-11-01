/**
 * The IXO Names worker client: names for the identifiers of a tool result,
 * asked of the shared worker (`POST <base>/v1/resolve`).
 *
 * Per isolate, three things sit in front of the worker:
 * - a memo of its answers (at most {@link MEMO_ENTRIES}, each kept until
 *   the worker's `freshUntil`, at most {@link MEMO_MAX_MS} and at least
 *   {@link MEMO_MIN_MS}); partial answers are never kept;
 * - a batcher per worker and client id: the ids every call misses are
 *   gathered for {@link BATCH_WINDOW_MS} after the first one (or until
 *   {@link MAX_BATCH_IDS} are waiting) and asked in one POST; an id queued
 *   or in flight is joined, never asked twice, until it is too old to
 *   trust;
 * - a pause: after a 429 or 5xx no POST goes to that worker for its
 *   `Retry-After` ({@link PAUSE_DEFAULT_MS} without one, at most
 *   {@link PAUSE_MAX_MS}).
 *
 * A POST belongs to no call: it runs under its own {@link POST_TIMEOUT_MS}
 * through the plugin's bounded exchange (no redirects, body cut off at
 * {@link MAX_RESPONSE_BYTES}) and asks the worker to answer by
 * {@link RESPONSE_BUDGET_MS} with what is ready. Each call waits for its own ids only, until
 * its own deadline or its turn's abort; its answer then lands in the memo
 * for the next call. Names never fail a tool: any failure is one log line
 * (a status or an error class, never an identifier) and no names.
 *
 * A batcher is shared by every Durable Object of the isolate, while timers
 * and fetches belong to the actor that started them: if it dies they end
 * unsettled and nothing that follows them runs. A promise it made wakes no
 * one either, even when a live actor settles it. So no shared state waits
 * on one request finishing: age recovers it, noticed by the next caller.
 * That caller asks an open batch past {@link BATCH_STALE_MS} afresh and
 * sends it, and an id outstanding past {@link OUTSTANDING_MAX_MS} is
 * dropped, to be asked afresh by whoever needs it.
 */
import { z } from 'zod';
import { LruMap } from '../../../core/domain-context/lru';
import {
  READ_GRACE_MS,
  exchange,
  untilDeadline,
  type ChainCall,
} from '../http';
import type { NameInfo, NameMap } from './types';

/** The worker per IXO network; `IXO_NAMES_URL` overrides. */
export const NAMES_URLS = {
  mainnet: 'https://names.ixo.earth',
  testnet: 'https://testnet.names.ixo.earth',
  devnet: 'https://devnet.names.ixo.earth',
} as const;

/** The most ids the worker takes in one request. */
export const MAX_BATCH_IDS = 40;
/** How long a batch gathers ids after its first one before it is sent. */
export const BATCH_WINDOW_MS = 10;
/** An open batch this old lost its window timer: the next caller sends it. */
export const BATCH_STALE_MS = 100;
/** One POST's whole time, the body read included; no caller shortens it. */
export const POST_TIMEOUT_MS = 6_000;
/**
 * The worker answers by this time with what is ready, the rest as `partial`
 * ids, and finishes them in the background for the next call. Below
 * {@link POST_TIMEOUT_MS} by enough for network time and the worker's D1
 * reads, which come on top: an answer past the timeout would lose every id.
 */
export const RESPONSE_BUDGET_MS = 5_000;
/**
 * An id outstanding this long lost its POST: it is never joined again and
 * no longer counts toward {@link MAX_OUTSTANDING_IDS}.
 */
export const OUTSTANDING_MAX_MS = POST_TIMEOUT_MS + READ_GRACE_MS;
/**
 * Ids queued or in flight per batcher; a miss past this is not asked (its
 * call goes without that name). Five full POSTs, as many as the batcher's
 * permits let run at once.
 */
export const MAX_OUTSTANDING_IDS = 200;
/** The largest answer body read. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MEMO_ENTRIES = 5_000;
export const MEMO_MAX_MS = 10 * 60_000;
export const MEMO_MIN_MS = 30_000;
export const PAUSE_DEFAULT_MS = 60_000;
export const PAUSE_MAX_MS = 300_000;
/** The worker cleans names to at most this many characters. */
const NAME_MAX_CHARS = 120;

/** The client's one log line: a status or an error class, never an identifier. */
function logFailure(reason: string): void {
  // eslint-disable-next-line no-console -- console is the logger on Workers
  console.warn(`[ixo-chain] names: ${reason}`);
}

type Network = ChainCall['network'];

/** The worker's answer for one id; extra fields are ignored. */
const resultSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  complete: z.boolean(),
  name: z.string().min(1).max(NAME_MAX_CHARS).nullable(),
  source: z.string().nullable(),
  selfChosen: z.boolean(),
  cache: z.object({ freshUntil: z.number().nullable() }).nullish(),
});
const responseSchema = z.object({
  network: z.string(),
  results: z.record(z.string(), resultSchema),
});
type WorkerResult = z.infer<typeof resultSchema>;

/** One id's answer: its name, or null for none (unnamed, unanswered or failed). */
type Answer = NameInfo | null;

/** Where a batch goes: the worker, the network it must answer for, and who asks. */
interface Target {
  network: Network;
  baseUrl: string;
  clientId: string;
}

/* ── memo ─────────────────────────────────────────────────────────────── */

const newMemo = () =>
  new LruMap<string, { answer: Answer; until: number }>({
    maxEntries: MEMO_ENTRIES,
  });
let memo = newMemo();

const memoKey = (baseUrl: string, id: string) => `${baseUrl}|${id}`;

/** The memoised answer for `id`; undefined when none is kept or it expired. */
function memoised(baseUrl: string, id: string): { answer: Answer } | undefined {
  const key = memoKey(baseUrl, id);
  const kept = memo.get(key);
  if (!kept) return undefined;
  if (kept.until > Date.now()) return kept;
  memo.delete(key);
  return undefined;
}

/**
 * The answer a result gives: a name only when the worker resolved the id
 * completely (a partial answer is the worker running out of time).
 */
function answerOf(result: WorkerResult): Answer {
  if (
    result.status === 'partial' ||
    !result.complete ||
    result.kind === 'unknown' ||
    result.name === null ||
    result.source === null
  )
    return null;
  return {
    name: result.name,
    source: result.source,
    selfChosen: result.selfChosen,
  };
}

/** Keeps a complete answer until `freshUntil`, clamped to {@link MEMO_MIN_MS}–{@link MEMO_MAX_MS}. */
function remember(baseUrl: string, result: WorkerResult, answer: Answer): void {
  if (result.status === 'partial' || !result.complete) return;
  const now = Date.now();
  const fresh = result.cache?.freshUntil;
  const until =
    typeof fresh === 'number'
      ? Math.min(Math.max(fresh * 1000, now + MEMO_MIN_MS), now + MEMO_MAX_MS)
      : now + MEMO_MAX_MS;
  memo.set(memoKey(baseUrl, result.id), { answer, until });
}

/* ── pause ────────────────────────────────────────────────────────────── */

/** Per worker base URL: the epoch ms until which no POST is sent to it. */
const pausedUntil = new Map<string, number>();

function paused(baseUrl: string): boolean {
  const until = pausedUntil.get(baseUrl);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  pausedUntil.delete(baseUrl);
  return false;
}

function pause(baseUrl: string, retryAfterMs: number | undefined): number {
  const ms = Math.min(retryAfterMs ?? PAUSE_DEFAULT_MS, PAUSE_MAX_MS);
  pausedUntil.set(baseUrl, Date.now() + ms);
  return ms;
}

/* ── one POST ─────────────────────────────────────────────────────────── */

/** A POST's own signal: no caller's abort reaches it. */
const NEVER_ABORTED = new AbortController().signal;

/**
 * Asks the worker for `ids` (at most {@link MAX_BATCH_IDS}); the answers it
 * gave, memoised when complete. Never throws: a failure is logged once
 * and answers nothing; a 429 or 5xx also pauses the worker.
 */
async function post(
  target: Target,
  ids: readonly string[],
  fetcher: typeof fetch,
): Promise<Map<string, Answer>> {
  const answers = new Map<string, Answer>();
  // The POST's own "call": its permits are the batcher's, not a user's.
  const call: ChainCall = {
    network: target.network,
    restUrl: '',
    blocksyncUrl: '',
    user: `names|${target.baseUrl}|${target.clientId}`,
    deadline: Date.now() + POST_TIMEOUT_MS,
    signal: NEVER_ABORTED,
    fetch: fetcher,
  };
  try {
    const attempt = await exchange(
      call,
      'names',
      `${target.baseUrl}/v1/resolve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-client-id': target.clientId,
        },
        body: JSON.stringify({
          ids,
          options: { include: ['name', 'cache'], budgetMs: RESPONSE_BUDGET_MS },
        }),
      },
      { timeoutMs: POST_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES },
    );
    if (!attempt.ok) {
      const { status } = attempt;
      if (status !== undefined && (status === 429 || status >= 500)) {
        const ms = pause(target.baseUrl, attempt.retryAfterMs);
        logFailure(`${attempt.note}; paused for ${Math.ceil(ms / 1000)} s`);
      } else logFailure(attempt.note);
      return answers;
    }
    let body: unknown;
    try {
      body = JSON.parse(attempt.value);
    } catch {
      logFailure('the answer is not JSON');
      return answers;
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      logFailure('the answer has an unexpected shape');
      return answers;
    }
    if (parsed.data.network !== target.network) {
      logFailure('the worker answered for another network');
      return answers;
    }
    const asked = new Set(ids);
    for (const result of Object.values(parsed.data.results)) {
      if (!asked.has(result.id)) continue;
      const answer = answerOf(result);
      remember(target.baseUrl, result, answer);
      answers.set(result.id, answer);
    }
  } catch (error) {
    // Nothing above throws by design; a bug here still names nothing.
    logFailure(
      `the request threw (${error instanceof Error ? error.name : 'non-error value'})`,
    );
  }
  return answers;
}

/* ── batcher ──────────────────────────────────────────────────────────── */

/** An id queued or in flight: the promise callers join, and since when it is outstanding. */
interface Outstanding {
  answer: Promise<Answer>;
  settle: (answer: Answer | Promise<Answer>) => void;
  since: number;
}

/** The batch gathering ids: its ids, the fetch it is sent with, its start and timer. */
interface OpenBatch {
  ids: Map<string, Outstanding>;
  fetch: typeof fetch;
  since: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Gathers one worker's misses into POSTs of at most {@link MAX_BATCH_IDS}.
 * Each id queued or in flight has one promise every caller joins; it
 * settles with the id's answer (null when the POST failed or skipped it)
 * and never rejects, unless the actor behind it died (see the file header).
 */
class Batcher {
  private open: OpenBatch | null = null;
  /** In the order the ids were asked, so the oldest come first. */
  private readonly outstanding = new Map<string, Outstanding>();

  constructor(private readonly target: Target) {}

  /**
   * The promise of `id`'s answer: joined when it is already queued or in
   * flight, else queued in the open batch (opened with `fetcher`); undefined
   * when {@link MAX_OUTSTANDING_IDS} are outstanding.
   */
  ask(id: string, fetcher: typeof fetch): Promise<Answer> | undefined {
    this.recover(fetcher);
    const joined = this.outstanding.get(id);
    if (joined) return joined.answer;
    if (this.outstanding.size >= MAX_OUTSTANDING_IDS) return undefined;
    return this.queue(id, fetcher);
  }

  /** Puts `id` in the open batch, opened with `fetcher` if none is. */
  private queue(id: string, fetcher: typeof fetch): Promise<Answer> {
    let settle: Outstanding['settle'] = () => undefined;
    const answer = new Promise<Answer>((resolve) => {
      settle = resolve;
    });
    const entry = { answer, settle, since: Date.now() };
    this.outstanding.set(id, entry);
    this.open ??= {
      ids: new Map(),
      fetch: fetcher,
      since: entry.since,
      timer: setTimeout(() => this.flush(), BATCH_WINDOW_MS),
    };
    this.open.ids.set(id, entry);
    if (this.open.ids.size >= MAX_BATCH_IDS) this.flush();
    return answer;
  }

  /**
   * Drops the ids too old to trust, then sends an open batch whose timer is
   * presumed dead, in this caller's name: with its `fetcher` (the batch's
   * own may belong to the dead actor) and under new entries (the old
   * promises may too). The old entries follow the new ones, so a live call
   * that joined the batch still gets its answer.
   */
  private recover(fetcher: typeof fetch): void {
    const now = Date.now();
    for (const [id, entry] of this.outstanding) {
      if (now - entry.since <= OUTSTANDING_MAX_MS) break;
      this.outstanding.delete(id);
    }
    const stale = this.open;
    if (!stale || now - stale.since <= BATCH_STALE_MS) return;
    this.open = null;
    clearTimeout(stale.timer);
    for (const [id, entry] of stale.ids) {
      if (this.outstanding.get(id) !== entry) continue;
      this.outstanding.delete(id);
      entry.settle(this.queue(id, fetcher));
    }
    this.flush();
  }

  /** Sends the open batch now (its timer cleared). */
  private flush(): void {
    const batch = this.open;
    if (!batch) return;
    this.open = null;
    clearTimeout(batch.timer);
    void this.send(batch);
  }

  private async send(batch: OpenBatch): Promise<void> {
    // A pause that began while the batch gathered: nothing is asked.
    const answers = paused(this.target.baseUrl)
      ? new Map<string, Answer>()
      : await post(this.target, [...batch.ids.keys()], batch.fetch);
    for (const [id, entry] of batch.ids) {
      entry.settle(answers.get(id) ?? null);
      // An id asked afresh meanwhile keeps its new entry.
      if (this.outstanding.get(id) === entry) this.outstanding.delete(id);
    }
  }

  /** Tests only: ids queued or in flight, and whether a window timer runs. */
  state(): { outstanding: number; timer: boolean } {
    return { outstanding: this.outstanding.size, timer: this.open !== null };
  }

  /** Tests only: drops the open batch and its timer (its callers' waits end at their deadlines). */
  drop(): void {
    if (this.open) clearTimeout(this.open.timer);
    this.open = null;
    this.outstanding.clear();
  }
}

/** The isolate's batchers, one per worker base URL and client id. */
const batchers = new Map<string, Batcher>();

function batcherFor(target: Target): Batcher {
  const key = `${target.baseUrl}|${target.clientId}`;
  let batcher = batchers.get(key);
  if (!batcher) {
    batcher = new Batcher(target);
    batchers.set(key, batcher);
  }
  return batcher;
}

/** Tests only: the batcher of `baseUrl` and `clientId`, if one was made. */
export function batcherState(
  baseUrl: string,
  clientId: string,
): { outstanding: number; timer: boolean } | undefined {
  return batchers.get(`${baseUrl}|${clientId}`)?.state();
}

/** Tests only: forget the memo, the pauses and every batch. */
export function resetNamesClient(): void {
  memo = newMemo();
  pausedUntil.clear();
  for (const batcher of batchers.values()) batcher.drop();
  batchers.clear();
}

/* ── one call ─────────────────────────────────────────────────────────── */

export interface NamesRequest extends Target {
  fetch: typeof fetch;
  /** Epoch ms after which this call stops waiting (the POST runs on). */
  deadline: number;
  /** The turn's abort: thrown as soon as it fires. */
  signal: AbortSignal;
}

/**
 * The names of `ids` known by `request.deadline`, in the order of `ids`
 * (best placed first); identifiers without a name are absent. Memoised
 * answers come straight from the memo; the rest join or open a batch,
 * unless the worker is paused. Only the turn's abort is thrown.
 */
export async function resolveNames(
  ids: readonly string[],
  request: NamesRequest,
): Promise<NameMap> {
  const answers = new Map<string, Answer>();
  const waits: Promise<void>[] = [];
  const batcher = paused(request.baseUrl) ? null : batcherFor(request);
  for (const id of new Set(ids)) {
    const kept = memoised(request.baseUrl, id);
    if (kept) {
      answers.set(id, kept.answer);
      continue;
    }
    const asked = batcher?.ask(id, request.fetch);
    if (asked) waits.push(asked.then((answer) => void answers.set(id, answer)));
  }
  if (waits.length) await untilDeadline(Promise.all(waits), request);
  const names: NameMap = {};
  for (const id of ids) {
    const answer = answers.get(id);
    if (answer) names[id] = { ...answer };
  }
  return names;
}
