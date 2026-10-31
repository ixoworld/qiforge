import {
  CHAIN_TX_GROUP_MESSAGE_TYPES,
  parseChainTxRefusal,
  type ActionOperationV1,
  type ActionReceiptV1,
  type ChainTxGroupAction,
  type ChainTxMessageType,
  type OptionsToken,
} from '@ixo/action-protocol';
import { chainTxRefusalWords, wordableRefusal } from './chain-tx-refusals';
import type {
  ChainTxGroupActionInput,
  ChainTxMessageInput,
  ChainTxStakeInput,
} from '../plugin-api/types';
import { quoteHubText } from './hub-text';
import type { ChainTxHostMessage } from './request';
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

/** `toBaseUnits`, its refusal naming the message's amount (`messages[0].amount`). */
function converted(at: string, amount: string, decimals: number): bigint {
  try {
    return toBaseUnits(amount, decimals);
  } catch (error) {
    if (error instanceof HubActionRefused)
      throw new HubActionRefused('refused', `${at}.amount: ${error.message}`);
    throw error;
  }
}

const isStakeInput = (
  message: ChainTxMessageInput | ChainTxGroupActionInput,
): message is ChainTxStakeInput =>
  message.type === 'cosmos.staking.delegate' ||
  message.type === 'cosmos.staking.undelegate' ||
  message.type === 'cosmos.staking.redelegate';

/**
 * Whether converting `messages` needs the owner's token list: a bank or
 * stake step (its amount and the owner's balance), or a new group
 * proposal's coin send of another token than IXO (its decimals).
 */
export function chainTxNeedsTokenList(
  messages: readonly ChainTxMessageInput[],
): boolean {
  return messages.some(
    (message) =>
      message.type === 'cosmos.bank.send' ||
      message.type === 'cosmos.staking.delegate' ||
      (message.type === 'daodao.proposal.create' &&
        message.actions.some(
          (action) =>
            action.type === 'cosmos.bank.send' &&
            (action.denom ?? IXO_TOKEN.denom) !== IXO_TOKEN.denom,
        )),
  );
}

/**
 * One action of a new group proposal with its amount in base units: a
 * stake's IXO with 6 decimals, a coin send's with the decimals of its token
 * (IXO without a list; another token from the owner's list, which is the
 * only place the runtime learns a token's decimals). No balance is
 * checked: the group's own account pays when it carries the proposal out,
 * and the network checks it then.
 */
function groupActionInBaseUnits(
  action: ChainTxGroupActionInput,
  at: string,
  tokens: readonly OptionsToken[] | null,
): ChainTxGroupAction {
  if (isStakeInput(action)) {
    const { amount, ...rest } = action;
    return {
      ...rest,
      amountBaseUnits: converted(at, amount, IXO_TOKEN.decimals).toString(),
    };
  }
  if (action.type !== 'cosmos.bank.send') return action;
  const denom = action.denom ?? IXO_TOKEN.denom;
  const token =
    denom === IXO_TOKEN.denom
      ? IXO_TOKEN
      : tokens?.find((item) => item.denom === denom);
  if (!token)
    throw new HubActionRefused(
      'refused',
      `${at}.denom: ${denom} is not in the owner's token list, so its decimals are unknown here; a group proposal can send IXO, or a token exactly as hub_action_options lists it.`,
    );
  return {
    type: 'cosmos.bank.send',
    toAddress: action.toAddress,
    amountBaseUnits: converted(at, action.amount, token.decimals).toString(),
    denom: token.denom,
  };
}

/**
 * A chain transaction's amounts in base units; messages without one pass
 * unchanged. Each bank step names a display `amount` of a token from the
 * owner's list (`denom`, absent = uixo): the token must be listed, the
 * amount converts with its listed decimals (`toBaseUnits`: a plain decimal,
 * no more digits after the point than the decimals, above zero; an
 * unverified token lists 0: base units), and the bank steps of one token
 * together stay within its listed balance. Each stake step (stake, unstake,
 * move stake) names a display `amount` of IXO, converted with IXO's 6
 * decimals; what a stake takes from the wallet counts against the listed
 * IXO balance together with the IXO bank steps, when the list has IXO
 * (Auth Hub checks every balance again before the card is made). A new
 * group proposal's bank and stake actions convert the same way
 * (`groupActionInBaseUnits`) and are never checked against the owner's
 * balance: the group's own account pays them when the group carries the
 * proposal out. `tokens` is the owner's list (hub_action_options
 * `transfer.tokens`), null when the Hub listed none; the caller reads it
 * only when `chainTxNeedsTokenList`.
 */
export function chainTxAmountsInBaseUnits(
  messages: readonly ChainTxMessageInput[],
  tokens: readonly OptionsToken[] | null,
): ChainTxHostMessage[] {
  const spent = new Map<string, bigint>();
  /** The bank and stake steps of one listed token together, within its listed balance. */
  const spend = (
    at: string,
    token: OptionsToken,
    amount: bigint,
    what: string,
  ) => {
    const total = (spent.get(token.denom) ?? 0n) + amount;
    spent.set(token.denom, total);
    if (total > BigInt(token.balanceBaseUnits))
      throw new HubActionRefused(
        'refused',
        `${at}.amount: the owner holds ${describeAmount(token.balanceBaseUnits, token)}, less than ${total === amount ? what : 'what the steps of this transaction take of it together'}.`,
      );
  };
  return messages.map((message, index): ChainTxHostMessage => {
    const at = `messages[${index}]`;
    if (message.type === 'daodao.proposal.create')
      return {
        ...message,
        actions: message.actions.map((action, j) =>
          groupActionInBaseUnits(action, `${at}.actions[${j}]`, tokens),
        ),
      };
    if (
      message.type === 'cosmos.staking.delegate' ||
      message.type === 'cosmos.staking.undelegate' ||
      message.type === 'cosmos.staking.redelegate'
    ) {
      const { amount: display, ...rest } = message;
      const amount = converted(at, display, IXO_TOKEN.decimals);
      // Only a stake takes IXO from the wallet: unstaking and moving stake
      // work on what is already staked.
      const ixo = tokens?.find((item) => item.denom === IXO_TOKEN.denom);
      if (message.type === 'cosmos.staking.delegate' && ixo)
        spend(at, ixo, amount, 'this stake');
      return { ...rest, amountBaseUnits: amount.toString() };
    }
    if (message.type !== 'cosmos.bank.send') return message;
    if (!tokens?.length)
      throw new HubActionRefused(
        'refused',
        'Coin sends are not available for this owner right now (no token list from Auth Hub).',
      );
    const denom = message.denom ?? IXO_TOKEN.denom;
    const token = tokens.find((item) => item.denom === denom);
    if (!token)
      throw new HubActionRefused(
        'refused',
        `${at}.denom: ${denom} is not in the owner's token list; use a denom exactly as hub_action_options lists it (${tokens
          .map((item) => item.denom)
          .slice(0, 10)
          .join(', ')}).`,
      );
    const amount = converted(at, message.amount, token.decimals);
    spend(at, token, amount, 'this send');
    return {
      type: 'cosmos.bank.send',
      toAddress: message.toAddress,
      amountBaseUnits: amount.toString(),
      denom: token.denom,
    };
  });
}

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

/**
 * What a refused prepare is called in the words the model relays: a bank
 * send (`ixo.bank.send.v1`) is a transfer, a chain transaction
 * (`ixo.chain.tx.v1`, one or more messages) a transaction, anything else an
 * operation.
 */
export type HubPrepareSubject = 'transfer' | 'transaction' | 'operation';

export function prepareSubjectOf(
  kind: ActionOperationV1['kind'],
): HubPrepareSubject {
  return kind === 'ixo.bank.send.v1'
    ? 'transfer'
    : kind === 'ixo.chain.tx.v1'
      ? 'transaction'
      : 'operation';
}

/**
 * Why the chain's authorization check refused a chain transaction, by its
 * steps: a group step (the group may let only members carry proposals out
 * or propose), a claim step (the collection admin's authorization), or
 * neither.
 */
function notAuthorizedWhy(steps: readonly ChainTxMessageType[]): string {
  if (steps.some((type) => GROUP_STEP_TYPES.includes(type)))
    return ' (for a group step, the group may let only its members do this)';
  if (steps.some((type) => type.startsWith('ixo.claims.')))
    return ' (for claims, the collection admin has not granted the authorization)';
  return '';
}
const GROUP_STEP_TYPES: readonly ChainTxMessageType[] =
  CHAIN_TX_GROUP_MESSAGE_TYPES;

/** What the model is told when Auth Hub refuses a prepare (400). */
const HUB_PREPARE_REFUSALS: Record<
  string,
  (subject: HubPrepareSubject, steps: readonly ChainTxMessageType[]) => string
> = {
  simulation_failed: (subject) =>
    `Auth Hub simulated this ${subject} and it would fail on chain`,
  fee_above_ceiling: (subject) =>
    `The network fee for this ${subject} is above this oracle's fee limit`,
  insufficient_funds: (subject) =>
    `The account does not hold enough to cover this ${subject} and its network fee`,
  // Chain transactions: the Hub names the field it refused in `reason`
  // ("invalid_message: messages[1].toAddress"), so the model can correct
  // it or tell the owner what was wrong.
  operation_not_registered: (subject) =>
    `Auth Hub did not accept this ${subject} as written`,
  // The chain's authorization check refused the simulation: for claims,
  // the collection admin has not authorized this account; for a group step,
  // the group lets only its members do it.
  not_authorized: (subject, steps) =>
    `The account is not authorized on chain for this ${subject}${notAuthorizedWhy(steps)}`,
};
/** Appended to every refusal no retry or change of arguments can lift. */
const NOT_FIXABLE = 'retrying or changing the fields will not help';

/** A kind the account's operator turned off, in the subject's words. */
function kindOff(subject: HubPrepareSubject): string {
  return subject === 'transfer'
    ? 'Bank sends are'
    : subject === 'transaction'
      ? 'Chain transactions are'
      : 'This kind of operation is';
}

/**
 * Hub refusals the model cannot fix (fixed words, no retry): the kind
 * turned off for the account, a field the runtime sets (signer, network,
 * chain id), a protocol or request the Hub does not accept from this
 * runtime, and no account or link for the owner (404). A 429 passes with
 * time, but not within a turn.
 */
function unfixableRefusal(
  status: number,
  parsed: { error: string; reason?: string } | null,
  subject: HubPrepareSubject,
): string | null {
  if (status === 404)
    return `Auth Hub has no completed account or active channel link for this owner (${parsed?.error ?? 'not_found'}); ${NOT_FIXABLE}.`;
  if (status === 429)
    return `Auth Hub is limiting requests from this oracle right now (${parsed?.error ?? 'rate_limited'}); try again later.`;
  if (status !== 400 || !parsed) return null;
  if (parsed.error === 'operation_not_registered') {
    if (parsed.reason === 'kind_disabled')
      return `${kindOff(subject)} turned off for this oracle account in Auth Hub (kind_disabled); ${NOT_FIXABLE}.`;
    const field = /^invalid_operation: (signer|network|chainId)$/.exec(
      parsed.reason ?? '',
    )?.[1];
    if (field)
      return `Auth Hub refused this ${subject}'s ${field}, which the runtime sets from the owner's account and this oracle's configuration (${parsed.reason}); ${NOT_FIXABLE}.`;
  }
  if (parsed.error === 'protocol_version_required')
    return `Auth Hub does not accept this ${subject} at this runtime's protocol version (protocol_version_required); ${NOT_FIXABLE}.`;
  if (parsed.error === 'invalid_request')
    return `Auth Hub refused the request itself, not its fields (invalid_request); ${NOT_FIXABLE}.`;
  return null;
}

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
      ? body.reason.trim()
      : undefined;
  return reason ? { error, reason } : { error };
}

/** The longest part of a Hub refusal's `reason` the model is given. */
const HUB_REASON_MAX = 200;

/**
 * A Hub refusal of a prepare (`{error, reason?}` with status 400, 409 or
 * 503, or any 404 or 429) as a refusal the model can relay, or null when
 * the status and code are not one of those it maps:
 * - fixed words that no retry or change of fields helps: 400
 *   `operation_not_registered` with reason `kind_disabled` or
 *   `invalid_operation: signer|network|chainId`, 400
 *   `protocol_version_required` and `invalid_request`, and 404; 429 says to
 *   try again later;
 * - 400 `simulation_failed`, `fee_above_ceiling`, `insufficient_funds`,
 *   `not_authorized`, `operation_not_registered`: the transfer or
 *   transaction as asked cannot go ahead (with the Hub's reason, quoted and
 *   labelled as data, see `quoteHubText`);
 * - 409 `sequence_mismatch`, 503 `transfer_unavailable`: temporary, try
 *   again shortly;
 * - any other 409: the account may not use this operation (deterministic,
 *   a retry gets the same answer).
 */
export function hubPrepareRefusal(
  status: number,
  body: unknown,
  subject: HubPrepareSubject = 'transfer',
  steps: readonly ChainTxMessageType[] = [],
): HubActionRefused | null {
  const parsed = hubErrorBody(body);
  const unfixable = unfixableRefusal(status, parsed, subject);
  if (unfixable)
    return new HubActionRefused('refused', unfixable, undefined, status);
  if (!parsed) return null;
  // A chain transaction Auth Hub would not make from what it read on chain,
  // or whose simulation named one message: a fixed code, in the runtime's
  // own words (the reason text is not passed on). Without a code, the
  // reason is passed on quoted, as below.
  const coded =
    status === 400 &&
    subject === 'transaction' &&
    (parsed.error === 'operation_not_registered' ||
      parsed.error === 'simulation_failed')
      ? wordableRefusal(parseChainTxRefusal(parsed.reason))
      : null;
  if (coded)
    return new HubActionRefused(
      'refused',
      chainTxRefusalWords(coded),
      undefined,
      status,
    );
  const reason = parsed.reason
    ? quoteHubText('reason', parsed.reason, HUB_REASON_MAX)
    : '';
  const words =
    status === 400 && Object.hasOwn(HUB_PREPARE_REFUSALS, parsed.error)
      ? HUB_PREPARE_REFUSALS[parsed.error]
      : undefined;
  if (words)
    return new HubActionRefused(
      'refused',
      `${words(subject, steps)}.${reason ? ` ${reason}.` : ''}`,
      undefined,
      status,
    );
  if (HUB_TRANSIENT_CODES[status]?.includes(parsed.error))
    return new HubActionRefused(
      'refused',
      `Auth Hub is temporarily unavailable for this (${parsed.error}); try again shortly.`,
      undefined,
      status,
    );
  if (status === 409)
    return new HubActionRefused(
      'refused',
      `This operation is not available for this account (${parsed.error}).${reason ? ` ${reason}.` : ''}`,
      undefined,
      status,
    );
  return null;
}
