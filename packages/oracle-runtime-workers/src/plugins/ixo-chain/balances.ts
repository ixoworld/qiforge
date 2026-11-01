/**
 * An account's bank balances as `get_account_balances` shows them: one
 * REST read of one page, each denom through its display, `uixo` first,
 * then verified tokens, then by amount. The tool reads them with its own
 * readers; `get_account_overview` reads them as an unregistered kind
 * inside its one `runRequests` call.
 */
import { z } from 'zod';
import { formatUnits, type IbcTrace, type TokenDisplay } from './denoms';
import type { Outcome } from './http';
import { defineKind } from './kinds/types';
import { accountOf } from './queries';

/** Bank balances read per account (one page). */
export const BALANCE_PAGE = 50;
/** Tokens resolved at once; each runs its metadata, trace and channel reads in turn. */
const METADATA_CONCURRENCY = 4;

const balancesResponse = z.object({
  balances: z.array(z.object({ denom: z.string(), amount: z.string() })),
  pagination: z.object({ next_key: z.string().nullish() }).nullish(),
});

export type BalanceToken = {
  denom: string;
  symbol: string;
  decimals: number;
  verified: boolean;
  amountBaseUnits: string;
  amount: string;
  origin?: string;
  trace?: IbcTrace;
  metadataUnavailable?: true;
};

export interface Balances {
  tokens: BalanceToken[];
  /** The account holds more denoms than one page. */
  moreDenoms: boolean;
}

/** `items` mapped with at most `limit` running at once, in order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += limit)
    out.push(
      ...(await Promise.all(items.slice(index, index + limit).map(map))),
    );
  return out;
}

/** How the balances are read: one REST GET and each denom's display. */
export interface BalanceReaders {
  rest<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: { label: string },
  ): Promise<Outcome<z.infer<S>>>;
  display(denom: string): Promise<TokenDisplay>;
}

/**
 * The bank balances of `address` (an `ixo1` address of bech32 characters,
 * safe as a path segment), each token shown through `readers.display`.
 */
export async function readBalances(
  readers: BalanceReaders,
  address: string,
): Promise<Outcome<Balances>> {
  const read = await readers.rest(
    `/cosmos/bank/v1beta1/balances/${address}?pagination.limit=${BALANCE_PAGE}`,
    balancesResponse,
    { label: 'balances' },
  );
  if (!read.ok) return read;
  const coins = read.value.balances.filter((coin) =>
    /^(0|[1-9][0-9]{0,39})$/.test(coin.amount),
  );
  const tokens: BalanceToken[] = await mapLimit(
    coins,
    METADATA_CONCURRENCY,
    async (coin) => {
      const display = await readers.display(coin.denom);
      return {
        denom: coin.denom,
        symbol: display.symbol,
        decimals: display.decimals,
        verified: display.verified,
        amountBaseUnits: coin.amount,
        amount: formatUnits(coin.amount, display.decimals),
        ...(display.origin !== undefined ? { origin: display.origin } : {}),
        ...(display.trace !== undefined ? { trace: display.trace } : {}),
        ...(display.metadataUnavailable ? { metadataUnavailable: true } : {}),
      };
    },
  );
  const rank = (token: BalanceToken) =>
    token.denom === 'uixo' ? 0 : token.verified ? 1 : 2;
  tokens.sort(
    (a, b) => rank(a) - rank(b) || Number(b.amount) - Number(a.amount),
  );
  return {
    ok: true,
    value: { tokens, moreDenoms: !!read.value.pagination?.next_key },
  };
}

/**
 * The balances as a kind, for `get_account_overview` only (it is not in
 * the `chain_lookup` catalogue): `{ tokens, moreDenoms }` with the
 * account's `subject`. Its denoms are looked up through the request's
 * `display`, so at most `MAX_DISPLAY_DENOMS` of them.
 */
export const balancesKind = defineKind({
  name: 'balances',
  summary:
    'The bank balances of an account, as get_account_balances reads them.',
  explain:
    'Each token: denom, symbol, decimals, verified, amountBaseUnits and `amount` in display units; uixo first, then verified tokens, then by amount.',
  source: 'chain',
  list: false,
  args: z.strictObject({ address: z.string().optional() }),
  example: {},
  plan(input, ctx) {
    const account = accountOf(input.address, ctx.identity, 'address');
    if (!account.ok) return { invalid: account.detail };
    return {
      source: 'chain',
      async run() {
        const read = await readBalances(ctx, account.address);
        return read.ok
          ? { ok: true, subject: account.subject, data: read.value }
          : { ok: false, ...read.failure };
      },
    };
  },
});
