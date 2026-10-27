import type { ActionReceiptV1, OptionsToken } from '@ixo/action-protocol';
import { HubActionRefused } from './store';

/**
 * Any-token bank sends: the model names a token from the owner's
 * `hub_action_options` list and a decimal amount in that token's display
 * units; the runtime does the base-unit arithmetic itself, from the decimals
 * the Hub listed. It never guesses a denom (`ibc/…` hashes included) or a
 * fee: the Hub simulates gas and sets the fee.
 */

/** The token as the owner object stores it next to a prepared transfer. */
export type TransferToken = Pick<
  OptionsToken,
  'denom' | 'symbol' | 'decimals' | 'verified'
>;

const DECIMAL_AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * `amount` (a decimal string in display units) as base units for a token
 * with `decimals`. Refused: not a plain decimal, more fraction digits than
 * the token has (an unverified token has 0: base units), and zero.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const match = DECIMAL_AMOUNT.exec(amount);
  if (!match || amount.length > 80)
    throw new HubActionRefused(
      'refused',
      'The amount must be a plain decimal number such as 1.5.',
    );
  const whole = match[1]!;
  // Trailing zeros carry no value: "1.50" of a 1-decimal token is 1.5.
  const fraction = (match[2] ?? '').slice(1).replace(/0+$/, '');
  if (fraction.length > decimals)
    throw new HubActionRefused(
      'refused',
      decimals === 0
        ? 'This token is counted in whole base units: use an amount without decimals.'
        : `This token has ${decimals} decimals: use at most ${decimals} digits after the point.`,
    );
  const base =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0') || '0');
  if (base <= 0n)
    throw new HubActionRefused('refused', 'The amount must be above zero.');
  return base;
}

/** Base units in display units for `decimals` (no rounding, no trailing zeros). */
export function fromBaseUnits(base: string | bigint, decimals: number): string {
  const value = BigInt(base);
  if (decimals === 0) return value.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * How an amount of `token` reads to the owner: the listed symbol for a
 * verified token (with the full denom for anything but `uixo`), base units
 * and the full denom with an unverified marker otherwise.
 */
export function describeAmount(
  amountBaseUnits: string,
  token: TransferToken,
): string {
  if (!token.verified)
    return `${amountBaseUnits} base units of ${token.denom} (unverified token)`;
  const display = `${fromBaseUnits(amountBaseUnits, token.decimals)} ${token.symbol}`;
  return token.denom === 'uixo' ? display : `${display} (${token.denom})`;
}

/** IXO itself: the chain's staking token, always verified. */
const IXO_TOKEN: TransferToken = {
  denom: 'uixo',
  symbol: 'IXO',
  decimals: 6,
  verified: true,
};

/**
 * The owner-facing line for a bank receipt (v2 receipts carry `denom` and
 * `amountBaseUnits`), or null for any other receipt. Without a stored token
 * for that denom (another runtime prepared it) `uixo` still reads as IXO;
 * any other denom is shown in base units, unverified.
 */
export function bankReceiptSummary(
  receipt: ActionReceiptV1 | null,
  token: TransferToken | null,
): string | null {
  if (!receipt || receipt.kind !== 'ixo.bank.send.v1') return null;
  const amount =
    receipt.amountBaseUnits && receipt.denom
      ? describeAmount(
          receipt.amountBaseUnits,
          token && token.denom === receipt.denom
            ? token
            : receipt.denom === IXO_TOKEN.denom
              ? IXO_TOKEN
              : {
                  denom: receipt.denom,
                  symbol: receipt.denom,
                  decimals: 0,
                  verified: false,
                },
        )
      : null;
  const what = amount ? `Transfer of ${amount}` : 'Transfer';
  if (receipt.height === null)
    return `${what} was not included on chain${receipt.reason ? ` (${receipt.reason.replaceAll('_', ' ')})` : ''}. Transaction ${receipt.txHash}.`;
  return `${what} ${receipt.code === 0 ? 'confirmed' : 'failed'} on chain. Transaction ${receipt.txHash}, block ${receipt.height}.`;
}

/** What the model is told when Auth Hub refuses a transfer at preparation (400). */
const HUB_TRANSFER_REFUSALS: Record<string, string> = {
  simulation_failed:
    'Auth Hub simulated this transfer and it would fail on chain',
  fee_above_ceiling:
    "The network fee for this transfer is above this oracle's fee limit",
  insufficient_funds:
    'The account does not hold enough to cover this transfer and its network fee',
};
/** Hub codes that pass with time (a sequence race, the transfer path down). */
const HUB_TRANSIENT_CODES: Readonly<Record<number, readonly string[]>> = {
  409: ['sequence_mismatch'],
  503: ['transfer_unavailable'],
};

function hubErrorBody(
  body: unknown,
): { error: string; reason?: string } | null {
  if (!body || typeof body !== 'object' || !('error' in body)) return null;
  const error = body.error;
  if (typeof error !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(error))
    return null;
  const reason =
    'reason' in body && typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 200)
      : undefined;
  return reason ? { error, reason } : { error };
}

/**
 * A Hub refusal of a prepare (`{error, reason?}` with status 400, 409 or
 * 503) as a refusal the model can relay, or null when the status and code
 * are not one of those it maps:
 * - 400 `simulation_failed`, `fee_above_ceiling`, `insufficient_funds`: the
 *   transfer as asked cannot go ahead (with the Hub's reason);
 * - 409 `sequence_mismatch`, 503 `transfer_unavailable`: temporary, try
 *   again shortly;
 * - any other 409: the account may not use this operation (deterministic,
 *   a retry gets the same answer).
 */
export function hubPrepareRefusal(
  status: number,
  body: unknown,
): HubActionRefused | null {
  const parsed = hubErrorBody(body);
  if (!parsed) return null;
  const detail = parsed.reason ? `: ${parsed.reason}` : '';
  if (status === 400 && Object.hasOwn(HUB_TRANSFER_REFUSALS, parsed.error))
    return new HubActionRefused(
      'refused',
      `${HUB_TRANSFER_REFUSALS[parsed.error]}${detail}.`,
    );
  if (HUB_TRANSIENT_CODES[status]?.includes(parsed.error))
    return new HubActionRefused(
      'refused',
      `Auth Hub is temporarily unavailable for this (${parsed.error}); try again shortly.`,
    );
  if (status === 409)
    return new HubActionRefused(
      'refused',
      `This operation is not available for this account (${parsed.error}${detail}).`,
    );
  return null;
}
