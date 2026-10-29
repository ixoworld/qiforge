/**
 * What the chain REST kinds share: argument schemas, the account a request
 * is about, the chain's coin JSON, exact decimal arithmetic on the chain's
 * number strings, short labels, and a bounded per-isolate cache of
 * slow-changing reads. Coins are shown through `../coins.ts`.
 */
import { z } from 'zod';
import {
  BUDGET_SPENT,
  hasBudget,
  throwIfAborted,
  untilAborted,
  type Failure,
  type Outcome,
} from '../../http';
import { accountOf, type Subject } from '../../queries';
import { clip } from '../../summaries';
import { displayCoins, type DisplayCoin } from '../coins';
import type { KindContext, KindInvalid, KindResult } from '../types';

/* ── arguments ────────────────────────────────────────────────────────── */

// Account arguments are bounded by `accountOf`'s patterns before any read.
export const addressArg = z
  .string()
  .optional()
  .describe("An ixo1… address or did:ixo:ixo1… DID; default: the user's.");

export const firstArg = z
  .number()
  .int()
  .min(1)
  .max(20)
  .optional()
  .describe('Rows (1–20, default 10).');

export const directionArg = z
  .enum(['received', 'given'])
  .optional()
  .describe(
    'received (default): granted to this account; given: granted by it.',
  );

/** A claim collection id as x/claims numbers them. */
export const COLLECTION_ID = /^\d{1,12}$/;

/** The account a request names (the user's by default), or why it is refused. */
export function accountFor(
  ctx: KindContext,
  input: string | undefined,
): { address: string; subject: Subject } | KindInvalid {
  const account = accountOf(input, ctx.identity, 'address');
  return account.ok
    ? { address: account.address, subject: account.subject }
    : { invalid: account.detail };
}

/* ── results ──────────────────────────────────────────────────────────── */

export const failed = (failure: Failure): KindResult => ({
  ok: false,
  ...failure,
});

/** The last segment of a type URL: `/cosmos.bank.v1beta1.MsgSend` → `MsgSend`. */
export function shortType(typeUrl: string): string {
  return clip(typeUrl.slice(typeUrl.lastIndexOf('.') + 1) || typeUrl, 80);
}

/** Whether an RFC 3339 time is before now; false when it does not parse. */
export function isPast(time: string): boolean {
  const ms = Date.parse(time);
  return Number.isFinite(ms) && ms < Date.now();
}

/** A grant's expiry: the time (null = never) and whether it has passed. */
export function expiryOf(time: string | null | undefined): {
  expiration: string | null;
  expired: boolean;
} {
  return time
    ? { expiration: time, expired: isPast(time) }
    : { expiration: null, expired: false };
}

const UNITS = [
  [86_400n, 'day'],
  [3_600n, 'hour'],
  [60n, 'minute'],
] as const;

/**
 * A protobuf Duration as JSON gives it (`"2592000s"`, `"1.5s"`) in words:
 * `30 days`, `1 hour`, `90 minutes`; the largest unit that divides it
 * exactly. The input itself when it is not a duration.
 */
export function durationText(duration: string): string {
  const match = /^(\d{1,15})(?:\.\d{1,9})?s$/.exec(duration);
  if (!match?.[1]) return clip(duration, 40);
  const seconds = BigInt(match[1]);
  const unit = UNITS.find(([size]) => seconds >= size && seconds % size === 0n);
  const [count, name] = unit
    ? [seconds / unit[0], unit[1]]
    : [seconds, 'second'];
  return `${count} ${name}${count === 1n ? '' : 's'}`;
}

/** A duration in words, or null when it is absent or zero (no duration set). */
export function setDuration(
  duration: string | null | undefined,
): string | null {
  return !duration || /^0+(?:\.0+)?s$/.test(duration)
    ? null
    : durationText(duration);
}

/** The text of `items` with at most `max` named and the rest counted. */
export function listText(items: readonly string[], max = 5): string {
  const named = items.slice(0, max).join(', ');
  return items.length > max ? `${named} and ${items.length - max} more` : named;
}

/* ── coins ────────────────────────────────────────────────────────────── */

export const coinSchema = z.object({ denom: z.string(), amount: z.string() });
export const coinsSchema = z.array(coinSchema);

/**
 * Bank coins as shown, or `empty` when there are none: the word for what
 * that field's empty list means on chain ("none", "unlimited", "any",
 * "none allowed"), never an empty list.
 */
export async function coinsOr<Empty extends string>(
  ctx: Pick<KindContext, 'display'>,
  coins: z.infer<typeof coinsSchema>,
  empty: Empty,
): Promise<DisplayCoin[] | Empty> {
  const shown = await displayCoins(ctx, coins);
  return shown.length ? shown : empty;
}

/* ── decimals ─────────────────────────────────────────────────────────── */

/** The chain's `LegacyDec`: 18 decimal places. */
const DEC_PLACES = 18;
export const DEC_ONE = 10n ** BigInt(DEC_PLACES);
const DECIMAL = /^(0|[1-9][0-9]{0,59})(?:\.([0-9]{1,18}))?$/;

/** A non-negative decimal string as an integer of 10⁻¹⁸ units; null when it is not one. */
export function parseDec(value: string): bigint | null {
  const match = DECIMAL.exec(value);
  if (!match?.[1]) return null;
  return (
    BigInt(match[1]) * DEC_ONE +
    BigInt((match[2] ?? '').padEnd(DEC_PLACES, '0'))
  );
}

/** 10⁻³⁶ units as 10⁻¹⁸ units, rounded half-to-even (`LegacyDec`'s `chopPrecisionAndRound`). */
function chopHalfEven(value: bigint): bigint {
  const quotient = value / DEC_ONE;
  const remainder = value % DEC_ONE;
  const half = DEC_ONE / 2n;
  if (remainder < half) return quotient;
  if (remainder > half) return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/** `LegacyDec.Mul`: the product rounded half-to-even at 18 decimals. */
export function decMul(a: bigint, b: bigint): bigint {
  return chopHalfEven(a * b);
}

/**
 * `LegacyDec.Quo` of two non-negative decimals (10⁻¹⁸ units, `b` > 0): the
 * quotient truncated at 36 places, then rounded half-to-even at 18.
 */
export function decQuo(a: bigint, b: bigint): bigint {
  return chopHalfEven((a * DEC_ONE * DEC_ONE) / b);
}

/** Hundredths of a percent as text: `3333n` → `33.33%`. */
function hundredthsText(hundredths: bigint): string {
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}%` : `${whole}%`;
}

/** A decimal fraction as a percentage rounded down to hundredths: `"0.05"` → `5%`; null when it does not parse. */
export function decPercent(value: string): string | null {
  const scaled = parseDec(value);
  return scaled === null ? null : hundredthsText((scaled * 10_000n) / DEC_ONE);
}

/** `part / whole` as a percentage rounded down to hundredths; `0%` of nothing. */
export function sharePercent(part: bigint, whole: bigint): string {
  return hundredthsText(whole > 0n ? (part * 10_000n) / whole : 0n);
}

/* ── cache ────────────────────────────────────────────────────────────── */

const caches = new Set<{ clear(): void }>();

/** Tests only: forget every cached chain-kind read. */
export function resetChainKindCaches(): void {
  for (const cache of caches) cache.clear();
}

/**
 * Successful reads kept per isolate for `ttlMs`, keyed by REST base and
 * `key`, at most `limit` (the oldest written is dropped first). A failure
 * is never kept. A read in flight is shared by every call that needs the
 * same key. A call that joined a read which then timed out (the upstream,
 * or the launching call's budget) or was aborted by its launching turn
 * reads again itself while its own budget allows; it waits on its own
 * turn's abort and throws only that, never another turn's.
 */
export class ReadCache<T> {
  private readonly answers = new Map<string, { value: T; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<Outcome<T>>>();

  constructor(
    private readonly ttlMs: number,
    private readonly limit: number,
  ) {
    caches.add(this);
  }

  async get(
    ctx: KindContext,
    key: string,
    read: () => Promise<Outcome<T>>,
  ): Promise<Outcome<T>> {
    const id = `${ctx.call.restUrl}|${key}`;
    const hit = this.answers.get(id);
    if (hit && hit.expiresAt > Date.now())
      return { ok: true, value: hit.value };
    if (hit) this.answers.delete(id);
    const running = this.inflight.get(id);
    if (running) {
      const shared = await this.join(running, ctx);
      if (shared && (shared.ok || shared.failure.reason !== 'timeout'))
        return shared;
      // The shared read timed out, or its launching turn was aborted.
      if (hasBudget(ctx.call)) return this.get(ctx, key, read);
      return shared ?? { ok: false, failure: BUDGET_SPENT };
    }
    const pending = read().finally(() => this.inflight.delete(id));
    this.inflight.set(id, pending);
    const outcome = await pending;
    if (outcome.ok) this.remember(id, outcome.value);
    return outcome;
  }

  /**
   * A read another call started, as this call waits for it: its outcome,
   * or null when it threw (its launching turn was aborted). This turn's
   * own abort is thrown as soon as it happens.
   */
  private async join(
    running: Promise<Outcome<T>>,
    ctx: KindContext,
  ): Promise<Outcome<T> | null> {
    try {
      return await untilAborted(running, ctx.call.signal);
    } catch {
      throwIfAborted(ctx.call.signal);
      return null;
    }
  }

  clear(): void {
    this.answers.clear();
    this.inflight.clear();
  }

  private remember(id: string, value: T): void {
    this.answers.delete(id);
    if (this.answers.size >= this.limit) {
      const oldest = this.answers.keys().next();
      if (!oldest.done) this.answers.delete(oldest.value);
    }
    this.answers.set(id, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
