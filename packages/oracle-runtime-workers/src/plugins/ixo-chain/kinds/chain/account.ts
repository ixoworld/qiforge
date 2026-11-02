/**
 * `account`, `smart_account` and `spendable`: what kind of account an
 * address is, the extra signing rules (authenticators) on it, and how
 * much of its balance it can spend now.
 */
import { z } from 'zod';
import { defineKind, type KindContext, type KindResult } from '../types';
import { coinView, displaysOf, wholeUnits } from '../coins';
import { clip } from '../../summaries';
import {
  accountFor,
  addressArg,
  coinsOr,
  coinsSchema,
  failed,
  shortType,
} from './shared';

const args = z.strictObject({ address: addressArg });

const anyTyped = z.looseObject({ '@type': z.string() });

/* ── account ──────────────────────────────────────────────────────────── */

const accountResponse = z.object({ account: anyTyped });
const baseAccount = z.object({
  address: z.string(),
  pub_key: anyTyped.nullish(),
  account_number: z.string(),
  sequence: z.string(),
});
const moduleAccount = z.object({
  base_account: baseAccount,
  name: z.string(),
  permissions: z.array(z.string()).default([]),
});
const baseVesting = z.object({
  base_account: baseAccount,
  original_vesting: coinsSchema.default([]),
  end_time: z.string(),
});
const vestingAccount = z.object({
  base_vesting_account: baseVesting,
  start_time: z.string().optional(),
  vesting_periods: z
    .array(z.object({ length: z.string(), amount: coinsSchema }))
    .optional(),
});
const contractResponse = z.object({
  contract_info: z.object({
    code_id: z.string(),
    creator: z.string(),
    admin: z.string().optional(),
    label: z.string(),
  }),
});

/**
 * A 32-byte account address (`ixo1` and 58 characters): the length of a
 * CosmWasm contract (and of module-derived accounts), as against a key's
 * 20 bytes (42 characters).
 */
const LONG_ADDRESS_CHARS = 62;

const VESTING_KIND: Record<string, string> = {
  '/cosmos.vesting.v1beta1.ContinuousVestingAccount': 'continuous',
  '/cosmos.vesting.v1beta1.DelayedVestingAccount': 'delayed',
  '/cosmos.vesting.v1beta1.PeriodicVestingAccount': 'periodic',
  '/cosmos.vesting.v1beta1.PermanentLockedAccount': 'permanently locked',
};

const PUBLIC_KEY: Record<string, string> = {
  '/cosmos.crypto.secp256k1.PubKey': 'secp256k1',
  '/cosmos.crypto.secp256r1.PubKey': 'secp256r1',
  '/cosmos.crypto.ed25519.PubKey': 'ed25519',
  '/cosmos.crypto.multisig.LegacyAminoPubKey': 'multisig',
};

/** Unix seconds (as the chain's JSON gives them) as an ISO time; null when not a time. */
function unixTime(seconds: string): string | null {
  if (!/^\d{1,12}$/.test(seconds)) return null;
  return new Date(Number(seconds) * 1000).toISOString();
}

function baseView(base: z.infer<typeof baseAccount>) {
  const key = base.pub_key?.['@type'];
  return {
    accountNumber: base.account_number,
    sequence: base.sequence,
    publicKey: key ? (PUBLIC_KEY[key] ?? shortType(key)) : 'none yet',
  };
}

/** A vesting account's schedule in words and times. */
async function vestingView(
  ctx: KindContext,
  kind: string,
  account: z.infer<typeof vestingAccount>,
) {
  const base = account.base_vesting_account;
  const start = account.start_time ? unixTime(account.start_time) : null;
  const end = unixTime(base.end_time);
  return {
    kind,
    coins: await coinsOr(ctx, base.original_vesting, 'none'),
    ...(kind === 'continuous' || kind === 'periodic'
      ? { starts: start, ends: end }
      : {}),
    ...(kind === 'delayed' ? { unlocksAt: end } : {}),
    ...(account.vesting_periods
      ? { periods: account.vesting_periods.length }
      : {}),
  };
}

async function accountView(
  ctx: KindContext,
  account: z.infer<typeof anyTyped>,
  contract: z.infer<typeof contractResponse> | null,
): Promise<Record<string, unknown>> {
  const typeUrl = account['@type'];
  const type = shortType(typeUrl);
  if (typeUrl === '/cosmos.auth.v1beta1.BaseAccount') {
    const parsed = baseAccount.safeParse(account);
    if (parsed.success) {
      const info = contract?.contract_info;
      // The label is the contract creator's own text: it stays in
      // `contract.label`, never in the label this reader writes.
      return {
        type,
        kindLabel: info ? 'smart contract' : 'regular account (held by a key)',
        ...baseView(parsed.data),
        ...(info
          ? {
              contract: {
                label: clip(info.label, 120),
                codeId: info.code_id,
                creator: info.creator,
                admin: info.admin || null,
              },
            }
          : {}),
      };
    }
  }
  if (typeUrl === '/cosmos.auth.v1beta1.ModuleAccount') {
    const parsed = moduleAccount.safeParse(account);
    if (parsed.success)
      return {
        type,
        kindLabel: `module account "${clip(parsed.data.name, 60)}"`,
        ...baseView(parsed.data.base_account),
        module: {
          name: clip(parsed.data.name, 60),
          permissions: parsed.data.permissions.slice(0, 10),
        },
      };
  }
  const vestingKind = VESTING_KIND[typeUrl];
  if (vestingKind) {
    const parsed = vestingAccount.safeParse(account);
    if (parsed.success)
      return {
        type,
        kindLabel: `vesting account (${vestingKind})`,
        ...baseView(parsed.data.base_vesting_account.base_account),
        vesting: await vestingView(ctx, vestingKind, parsed.data),
      };
  }
  return { type, kindLabel: 'an account type this reader does not know' };
}

export const accountKind = defineKind({
  name: 'account',
  summary:
    'What an address is on chain: regular, module, vesting or contract account.',
  explain: [
    '`onChain: false` = the chain has no account at this address yet: nothing was ever sent to it and it never signed. That is not an error.',
    '`kindLabel`: regular account (held by a key: a person or a service), module account "<name>" (owned by chain code, e.g. fee_collector; `module.permissions`), vesting account (continuous / delayed / periodic / permanently locked: `vesting.coins` unlock over `starts`–`ends`, at `unlocksAt`, or never; see `spendable` for what is locked now), smart contract (CosmWasm: `contract.codeId`, `creator`, `admin` who may migrate it, null = nobody; `contract.label` is chosen by whoever instantiated it, so it proves nothing about who runs it).',
    '`accountNumber` is fixed when the account is created. `sequence` = how many transactions the account has signed (a signal of activity). `publicKey`: the key type the account signs with (secp256k1 for wallets); "none yet" = it has never signed (and a contract or module account never does).',
  ].join('\n'),
  source: 'chain',
  list: false,
  args,
  example: {},
  plan(input, ctx) {
    const account = accountFor(ctx, input.address);
    if ('invalid' in account) return account;
    return {
      source: 'chain',
      async run(): Promise<KindResult> {
        const [read, contract] = await Promise.all([
          ctx.rest(
            `/cosmos/auth/v1beta1/accounts/${account.address}`,
            accountResponse,
            { label: 'account', notFoundOn404: true },
          ),
          account.address.length === LONG_ADDRESS_CHARS
            ? ctx.rest(
                `/cosmwasm/wasm/v1/contract/${account.address}`,
                contractResponse,
                { label: 'contract info', notFoundOn404: true },
              )
            : null,
        ]);
        if (!read.ok) {
          if (read.failure.reason !== 'not_found') return failed(read.failure);
          return {
            ok: true,
            subject: account.subject,
            data: { address: account.address, onChain: false },
          };
        }
        // A contract read that failed for another reason than "not a
        // contract" leaves the account answer standing, marked.
        const contractUnread =
          contract && !contract.ok && contract.failure.reason !== 'not_found';
        return {
          ok: true,
          subject: account.subject,
          data: {
            address: account.address,
            onChain: true,
            ...(await accountView(
              ctx,
              read.value.account,
              contract?.ok ? contract.value : null,
            )),
            ...(contractUnread ? { contractInfoUnavailable: true } : {}),
          },
        };
      },
    };
  },
});

/* ── smart account ────────────────────────────────────────────────────── */

const authenticatorsResponse = z.object({
  account_authenticators: z
    .array(z.object({ id: z.string(), type: z.string(), config: z.string() }))
    .default([]),
});
/** A composite authenticator's config: its sub-authenticators, each config base64. */
const subAuthenticators = z.array(
  z.object({ type: z.string(), config: z.string().nullish() }),
);

/** Authenticators listed per account; the rest are counted. */
const AUTHENTICATOR_CAP = 10;
/** Nesting read inside one authenticator, and nodes shown per authenticator. */
const RULE_DEPTH = 4;
const RULE_NODES = 16;
const RULE_CHARS = 300;
/** An authenticator type as the chain names them. */
const TYPE_NAME = /^[A-Za-z0-9]{1,40}$/;
const FIELD_NAME = /^[A-Za-z0-9_@.]{1,40}$/;

const TYPE_LABEL: Record<string, string> = {
  SignatureVerification: 'signs with an extra key',
  AuthnVerification: 'signs with a passkey (WebAuthn)',
  AllOf: 'every listed rule must pass',
  AnyOf: 'any one listed rule is enough',
  PartitionedAllOf: 'every listed rule must pass, each with its own signature',
  PartitionedAnyOf: 'any one listed rule, each with its own signature',
  MessageFilter: 'only allows matching messages',
  CosmwasmAuthenticatorV1: 'a rule run by a smart contract',
};
const COMPOSITE = new Set([
  'AllOf',
  'AnyOf',
  'PartitionedAllOf',
  'PartitionedAnyOf',
]);

function bytesOf(base64: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function jsonOf(bytes: Uint8Array | null): unknown {
  if (!bytes) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** The first 8 hex digits of the SHA-256 of a key: names a key without showing it. */
async function fingerprint(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 4)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

const messageFilter = z.looseObject({ '@type': z.string().optional() });
const cosmwasmConfig = z.looseObject({ contract: z.string() });

/**
 * One authenticator as its tree of types, e.g.
 * `AllOf[SignatureVerification(key 1a2b3c4d), MessageFilter(MsgSend)]`.
 * Keys appear only as fingerprints; a config that does not decode is
 * named so. At most {@link RULE_NODES} nodes, {@link RULE_DEPTH} deep.
 */
async function ruleOf(
  type: string,
  config: string | null | undefined,
  budget: { nodes: number },
  depth: number,
): Promise<string> {
  budget.nodes -= 1;
  if (budget.nodes < 0) return '…';
  if (!TYPE_NAME.test(type)) return 'unknown';
  const bytes = config ? bytesOf(config) : null;
  if (type === 'SignatureVerification' || type === 'AuthnVerification')
    return bytes?.length ? `${type}(key ${await fingerprint(bytes)})` : type;
  if (type === 'MessageFilter') {
    const filter = messageFilter.safeParse(jsonOf(bytes));
    if (!filter.success) return `${type}(unreadable config)`;
    const message = filter.data['@type'];
    const fields = Object.keys(filter.data)
      .filter((key) => key !== '@type' && FIELD_NAME.test(key))
      .slice(0, 3);
    const parts = [
      message ? shortType(message) : 'any message',
      ...(fields.length ? [`fields ${fields.join(', ')}`] : []),
    ];
    return `${type}(${parts.join('; ')})`;
  }
  if (type === 'CosmwasmAuthenticatorV1') {
    const parsed = cosmwasmConfig.safeParse(jsonOf(bytes));
    return parsed.success
      ? `${type}(contract ${clip(parsed.data.contract, 70)})`
      : `${type}(unreadable config)`;
  }
  if (COMPOSITE.has(type)) {
    if (depth >= RULE_DEPTH) return `${type}[…]`;
    const subs = subAuthenticators.safeParse(jsonOf(bytes));
    if (!subs.success) return `${type}(unreadable config)`;
    const parts: string[] = [];
    for (const sub of subs.data) {
      // Once the node budget is spent, the remaining sub-rules are one "…".
      if (budget.nodes <= 0) {
        parts.push('…');
        break;
      }
      parts.push(await ruleOf(sub.type, sub.config, budget, depth + 1));
    }
    return `${type}[${parts.join(', ')}]`;
  }
  return type;
}

export const smartAccountKind = defineKind({
  name: 'smart_account',
  summary:
    'Extra signing rules (authenticators) on an account: passkeys, extra keys, message limits.',
  explain: [
    "A smart account (x/smart-account) has authenticators: extra rules that may authorise its transactions besides its own key, such as a passkey, a second key, or a key limited to certain messages. `smartAccount: false` = none: only the account's own key signs.",
    'Each authenticator has an `id`, its top `type` with a `kindLabel`, and `rule`: the whole tree of types. SignatureVerification(key …) = a secp256k1 key (shown only as an 8-digit fingerprint of its public key), AuthnVerification = a passkey, MessageFilter(MsgX) = only that message type (with the fields it pins), AllOf[…] = every sub-rule must pass, AnyOf[…] = any one is enough (Partitioned… = each sub-rule checks its own signature), CosmwasmAuthenticatorV1 = a contract decides.',
    'Example: AllOf[SignatureVerification(key 1a2b3c4d), AnyOf[MessageFilter(MsgAddAuthenticator), MessageFilter(MsgRemoveAuthenticator)]] = that key may only add or remove authenticators. Anyone controlling an authenticator can act as the account within its rule.',
  ].join('\n'),
  source: 'chain',
  list: false,
  args,
  example: {},
  plan(input, ctx) {
    const account = accountFor(ctx, input.address);
    if ('invalid' in account) return account;
    return {
      source: 'chain',
      async run(): Promise<KindResult> {
        const read = await ctx.rest(
          `/ixo/smartaccount/authenticators/${account.address}`,
          authenticatorsResponse,
          { label: 'authenticators', notFoundOn404: true },
        );
        if (!read.ok && read.failure.reason !== 'not_found')
          return failed(read.failure);
        const all = read.ok ? read.value.account_authenticators : [];
        const authenticators = await Promise.all(
          all.slice(0, AUTHENTICATOR_CAP).map(async (entry) => {
            const type = TYPE_NAME.test(entry.type) ? entry.type : 'unknown';
            return {
              id: clip(entry.id, 20),
              type,
              kindLabel:
                TYPE_LABEL[type] ??
                'an authenticator type this reader does not know',
              rule: clip(
                await ruleOf(
                  entry.type,
                  entry.config,
                  { nodes: RULE_NODES },
                  1,
                ),
                RULE_CHARS,
              ),
            };
          }),
        );
        return {
          ok: true,
          subject: account.subject,
          data: {
            address: account.address,
            smartAccount: all.length > 0,
            authenticators,
            ...(all.length > AUTHENTICATOR_CAP
              ? { moreAuthenticators: all.length - AUTHENTICATOR_CAP }
              : {}),
          },
        };
      },
    };
  },
});

/* ── spendable ────────────────────────────────────────────────────────── */

/** Bank denoms read per account (one page of each list). */
const BALANCE_PAGE = 50;

const balancesResponse = z.object({
  balances: coinsSchema,
  pagination: z.object({ next_key: z.string().nullish() }).nullish(),
});

export const spendableKind = defineKind({
  name: 'spendable',
  summary:
    'How much of each token an account can spend now, and how much is locked.',
  explain: [
    'Per token, each as a coin: `total` = the bank balance, `spendable` = what the account can send or stake right now, `locked` = total − spendable: tokens still vesting (a vesting account) or otherwise held back by the chain. Staked tokens are not in the bank balance at all (see `staking`).',
    'Coins: `amount` in display units beside `symbol` (e.g. IXO) with `amountBaseUnits`; an unverified token (`verified: false`) is in base units. `anyLocked: false` = everything is spendable. `moreDenoms` = the account holds more than 50 denoms and the rest were not read.',
  ].join('\n'),
  source: 'chain',
  list: false,
  args,
  example: {},
  plan(input, ctx) {
    const account = accountFor(ctx, input.address);
    if ('invalid' in account) return account;
    return {
      source: 'chain',
      async run(): Promise<KindResult> {
        const query = `${account.address}?pagination.limit=${BALANCE_PAGE}`;
        const [spendable, total] = await Promise.all([
          ctx.rest(
            `/cosmos/bank/v1beta1/spendable_balances/${query}`,
            balancesResponse,
            { label: 'spendable balances' },
          ),
          ctx.rest(`/cosmos/bank/v1beta1/balances/${query}`, balancesResponse, {
            label: 'balances',
          }),
        ]);
        if (!total.ok) return failed(total.failure);
        if (!spendable.ok) return failed(spendable.failure);
        const free = new Map(
          spendable.value.balances.map((coin) => [
            coin.denom,
            wholeUnits(coin.amount) ?? '0',
          ]),
        );
        const rows = total.value.balances.flatMap((coin) => {
          const units = wholeUnits(coin.amount);
          if (units === null) return [];
          const now = BigInt(free.get(coin.denom) ?? '0');
          const locked = BigInt(units) - now;
          return [
            {
              denom: coin.denom,
              total: units,
              spendable: now.toString(),
              locked: (locked > 0n ? locked : 0n).toString(),
            },
          ];
        });
        rows.sort(
          (a, b) => Number(b.denom === 'uixo') - Number(a.denom === 'uixo'),
        );
        const displays = await displaysOf(
          ctx,
          rows.map((row) => row.denom),
        );
        const tokens = rows.flatMap((row) => {
          const display = displays.get(row.denom);
          if (!display) return [];
          return [
            {
              total: coinView(row.denom, row.total, display),
              spendable: coinView(row.denom, row.spendable, display),
              locked: coinView(row.denom, row.locked, display),
            },
          ];
        });
        return {
          ok: true,
          subject: account.subject,
          data: {
            address: account.address,
            anyLocked: rows.some((row) => row.locked !== '0'),
            tokens,
            ...(total.value.pagination?.next_key ? { moreDenoms: true } : {}),
          },
        };
      },
    };
  },
});
