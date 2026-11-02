/**
 * What the Blocksync-indexed kinds share: argument schemas and patterns,
 * the clipping every indexed string gets, bank coins and cw20 amounts, and
 * the parsing of the index's timestamps.
 *
 * Every string from the index is chain data written by anyone and is
 * clipped (ids, addresses and dates 120 characters, names and labels 200,
 * long text 240). Amounts stay strings: base units never pass through
 * `Number`. Bank coins are shown through `../coins.ts`.
 */
import { z } from 'zod';
import type { UserIdentity } from '../../../../core/user-identity';
import type { Failure } from '../../http';
import { accountOf, literal, type Subject } from '../../queries';
import { EXCERPT_CHARS, ID_CHARS, clip, isRecord, text } from '../../summaries';
import {
  COIN_CAP,
  displayCoins,
  wholeUnits,
  type ChainCoin,
  type DisplayCoin,
} from '../coins';
import type { KindContext, KindInvalid, KindResult } from '../types';

const COLLECTION_ID = /^\d{1,12}$/;
/** A claim id as the core `claim` kind takes it (a CID such as `bafkrei…`). */
const CLAIM_ID = /^[a-z0-9]{20,100}$/i;
/** A CosmWasm contract address: `ixo1` and 58 bech32 characters (32 bytes). */
export const CONTRACT_ADDRESS = /^ixo1[02-9ac-hj-np-z]{58}$/;

const LIST_CAP = 10;

export const collectionIdArg = (role: string) =>
  z
    .string()
    .regex(COLLECTION_ID, 'a collection number such as "8250"')
    .optional()
    .describe(role);

export const claimIdArg = (role: string) =>
  z
    .string()
    .regex(CLAIM_ID, 'a claim id (a CID such as "bafkrei…")')
    .optional()
    .describe(role);

/** The account an account argument names (the user's by default), or why it cannot be asked. */
export function accountFor(
  input: string | undefined,
  identity: UserIdentity,
  role: string,
): { address: string; subject: Subject } | KindInvalid {
  const account = accountOf(input, identity, role);
  return account.ok
    ? { address: account.address, subject: account.subject }
    : { invalid: account.detail };
}

/** `{ column: { equalTo: value } }` as a GraphQL filter literal. */
export const equalTo = (column: string, value: string): string =>
  literal({ [column]: { equalTo: value } });

/** An id, address or date, clipped to {@link ID_CHARS}. */
export const idText = (value: unknown) => text(value, ID_CHARS);

/** Long free text (a reason, a description), clipped to {@link EXCERPT_CHARS}. */
export const longText = (value: unknown) => text(value, EXCERPT_CHARS);

/** An amount (string or number) as clipped text; undefined otherwise. */
export function amountText(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number'
    ? clip(String(value), 80)
    : undefined;
}

/** Drops undefined entries so absent fields cost nothing in the answer. */
export function compact<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value))
    if (value[key] === undefined) delete value[key];
  return value;
}

export const nonEmpty = <T>(list: T[]): T[] | undefined =>
  list.length ? list : undefined;

/**
 * One `{ denom, amount }` bank coin from the index, its amount in whole
 * base units; undefined for anything else (an amount that is not a
 * non-negative decimal included).
 */
export function chainCoin(value: unknown): ChainCoin | undefined {
  if (!isRecord(value)) return undefined;
  const denom = idText(value.denom);
  const amount = amountText(value.amount);
  const units = amount === undefined ? null : wholeUnits(amount);
  return denom && units !== null ? { denom, amount: units } : undefined;
}

/** The bank coins of a JSON coin array, at most {@link COIN_CAP}; anything else is left out. */
export function chainCoins(value: unknown): ChainCoin[] {
  if (!Array.isArray(value)) return [];
  const out: ChainCoin[] = [];
  for (const entry of value) {
    if (out.length >= COIN_CAP) break;
    const coin = chainCoin(entry);
    if (coin) out.push(coin);
  }
  return out;
}

/** The bank coins of a JSON coin array as shown; undefined when there are none. */
export async function bankCoins(
  ctx: Pick<KindContext, 'display'>,
  value: unknown,
): Promise<DisplayCoin[] | undefined> {
  return nonEmpty(await displayCoins(ctx, chainCoins(value)));
}

/** cw20 amounts (`[{ address, amount }]`, base units of each token contract), at most ten. */
export function cw20Amounts(
  value: unknown,
): { address: string; amountBaseUnits: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { address: string; amountBaseUnits: string }[] = [];
  for (const entry of value) {
    if (out.length >= LIST_CAP) break;
    if (!isRecord(entry)) continue;
    const address = idText(entry.address);
    const amountBaseUnits = amountText(entry.amount);
    if (address && amountBaseUnits) out.push({ address, amountBaseUnits });
  }
  return out;
}

/**
 * cw1155 amounts (x/claims `CW1155Payment`: `[{ address, token_id, amount }]`,
 * whole units of the listed token ids of each contract), at most ten.
 */
export function cw1155Amounts(
  value: unknown,
): { address: string; tokenIds?: string[]; amount: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { address: string; tokenIds?: string[]; amount: string }[] = [];
  for (const entry of value) {
    if (out.length >= LIST_CAP) break;
    if (!isRecord(entry)) continue;
    const address = idText(entry.address);
    const amount = amountText(entry.amount);
    const ids = entry.token_id ?? entry.tokenId;
    const tokenIds = Array.isArray(ids)
      ? ids.slice(0, LIST_CAP).flatMap((id) => {
          const shown = idText(id);
          return shown ? [shown] : [];
        })
      : [];
    if (address && amount)
      out.push(compact({ address, tokenIds: nonEmpty(tokenIds), amount }));
  }
  return out;
}

const OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Epoch ms of an index timestamp. Blocksync's `TIMESTAMP(3)` columns hold
 * UTC without an offset (`2026-10-29T14:55:29.676`), so one without an
 * offset is read as UTC; NaN when it is not a date.
 */
function timeOf(value: string): number {
  return Date.parse(OFFSET.test(value) ? value : `${value}Z`);
}

/** Whether `value` is an index timestamp at or before `now`; undefined when it is not one. */
export function reached(value: unknown, now: number): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  const at = timeOf(value);
  return Number.isNaN(at) ? undefined : at <= now;
}

export const unexpected: Failure = {
  reason: 'unavailable',
  detail: 'Blocksync answered this request in an unexpected shape.',
  retryable: false,
};

/** A list answer: the rows, and `more` when the index holds rows past them. */
export const connection = <T extends z.ZodType>(node: T) =>
  z.looseObject({
    pageInfo: z.object({ hasNextPage: z.boolean() }).optional(),
    nodes: z.array(node),
  });

export const PAGE = 'pageInfo { hasNextPage }';

/** A list kind's answer by account or filter. */
export function listResult(
  data: Record<string, unknown>,
  first: number,
  subject?: Subject,
): KindResult {
  return {
    ok: true,
    data: compact(data),
    first,
    ...(subject ? { subject } : {}),
  };
}

export const str = z.string();
export const opt = z.string().nullish();
export const num = z.union([z.string(), z.number()]).nullish();
