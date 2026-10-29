/**
 * Bank coins as every kind shows them: `{ denom, symbol, amount,
 * amountBaseUnits, verified, origin?, trace?, metadataUnavailable? }`, the
 * `amount` converted to display units through the call's denom displays
 * (`KindContext.display`). IXO 1155 tokens are not bank coins: their
 * amounts stay whole units.
 */
import { formatUnits, type IbcTrace, type TokenDisplay } from '../denoms';
import type { KindContext } from './types';

/** A bank coin as shown: display amount and symbol, with the base units it came from. */
export type DisplayCoin = {
  denom: string;
  symbol: string;
  /** Display units (`amountBaseUnits` ÷ 10^decimals); base units when unverified. */
  amount: string;
  amountBaseUnits: string;
  verified: boolean;
  /** The chain a verified IBC token came from: tells apart two tokens of one symbol. */
  origin?: string;
  /** What an unverified IBC token's trace claims: self-reported, never what the token is. */
  trace?: IbcTrace;
  /** Its metadata was not read: it may still be verified. */
  metadataUnavailable?: true;
};

/** A chain coin: a denom and an amount as the chain's JSON gives it. */
export type ChainCoin = { denom: string; amount: string };

/** Coins shown per list; the rest are left out. */
export const COIN_CAP = 10;

/** The rule every kind's `explain` states for its bank coins. */
export const COINS_NOTE =
  'Bank coins: `amount` in display units beside `symbol` (uixo → IXO, upay → PAY, both 6 decimals), with `amountBaseUnits`; an unverified token (`verified: false`) is in base units under its full denom.';

/**
 * Whole base units of a Coin or DecCoin amount (a DecCoin's fraction, a
 * share of one base unit, is dropped); null when it is not a non-negative
 * decimal of at most 40 digits.
 */
export function wholeUnits(amount: string): string | null {
  return /^(0|[1-9][0-9]{0,39})(?:\.[0-9]{1,18})?$/.exec(amount)?.[1] ?? null;
}

/** `baseUnits` of `denom` as shown with `display`. */
export function coinView(
  denom: string,
  baseUnits: string,
  display: TokenDisplay,
): DisplayCoin {
  return {
    denom,
    symbol: display.symbol,
    amount: formatUnits(baseUnits, display.decimals),
    amountBaseUnits: baseUnits,
    verified: display.verified,
    ...(display.origin !== undefined ? { origin: display.origin } : {}),
    ...(display.trace !== undefined ? { trace: display.trace } : {}),
    ...(display.metadataUnavailable ? { metadataUnavailable: true } : {}),
  };
}

/** Each denom's display, looked up at once (the call's REST limit bounds them). */
export async function displaysOf(
  ctx: Pick<KindContext, 'display'>,
  denoms: readonly string[],
): Promise<Map<string, TokenDisplay>> {
  const out = new Map<string, TokenDisplay>();
  await Promise.all(
    [...new Set(denoms)].map(async (denom) => {
      out.set(denom, await ctx.display(denom));
    }),
  );
  return out;
}

/** Coins as shown, at most `max`; an amount that is not a decimal is left out. */
export async function displayCoins(
  ctx: Pick<KindContext, 'display'>,
  coins: readonly ChainCoin[],
  max = COIN_CAP,
): Promise<DisplayCoin[]> {
  const shown = coins
    .flatMap((coin) => {
      const units = wholeUnits(coin.amount);
      return units === null ? [] : [{ denom: coin.denom, units }];
    })
    .slice(0, max);
  return Promise.all(
    shown.map(async ({ denom, units }) =>
      coinView(denom, units, await ctx.display(denom)),
    ),
  );
}

/** One coin as shown; null when its amount is not a decimal. */
export async function displayCoin(
  ctx: Pick<KindContext, 'display'>,
  coin: ChainCoin,
): Promise<DisplayCoin | null> {
  return (await displayCoins(ctx, [coin], 1))[0] ?? null;
}

/** IXO as shown, from base units (uixo). */
export function ixo(baseUnits: string): DisplayCoin {
  return coinView('uixo', baseUnits, {
    symbol: 'IXO',
    decimals: 6,
    verified: true,
  });
}
