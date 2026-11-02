import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountKind, smartAccountKind, spendableKind } from './account';
import accountBase from './fixtures/account-base.json';
import accountContract from './fixtures/account-contract.json';
import accountModule from './fixtures/account-module.json';
import balances from './fixtures/balances.json';
import contractInfo from './fixtures/contract-info.json';
import {
  HTTP_500_FAILURE,
  MICHAEL,
  chainFetch,
  contextOf,
  pathsOf,
  refusal,
  reply,
  resetChainState,
  run,
  upayRoute,
} from './fixtures/context';
import smartAccount from './fixtures/smart-account.json';
import spendable from './fixtures/spendable.json';

const FEE_COLLECTOR = 'ixo17xpfvakm2amg962yls6f84z3kell8c5l0vaj0w';
const CONTRACT =
  'ixo14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9sqa3vn7';
/** A valid address the chain has no account for (recorded mainnet 404). */
const ABSENT = 'ixo1qqgjyv6y24n80zye42aueh0wluqpzg3nyt2qhw';
const accountPath = (address: string) =>
  `/cosmos/auth/v1beta1/accounts/${address}`;
const contractPath = (address: string) =>
  `/cosmwasm/wasm/v1/contract/${address}`;

beforeEach(() => {
  resetChainState();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ now: new Date('2026-10-29T12:00:00Z'), toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('account', () => {
  it('validates its arguments', () => {
    const ctx = contextOf(chainFetch({}));
    expect(refusal(accountKind, { address: FEE_COLLECTOR }, ctx)).toBeNull();
    expect(refusal(accountKind, { addr: MICHAEL }, ctx)).toMatch(
      /^Invalid args for kind "account"/,
    );
    expect(refusal(accountKind, { address: 'IXO1ABC' }, ctx)).toBe(
      'address must be an ixo1… address or a did:ixo:ixo1… DID.',
    );
  });

  it("reads the user's own account without asking the contract route (recorded mainnet answer)", async () => {
    const fetcher = chainFetch({ [accountPath(MICHAEL)]: accountBase });
    expect(await run(accountKind, {}, contextOf(fetcher))).toEqual({
      ok: true,
      subject: 'user',
      data: {
        address: MICHAEL,
        onChain: true,
        type: 'BaseAccount',
        kindLabel: 'regular account (held by a key)',
        accountNumber: '27012',
        sequence: '12',
        publicKey: 'secp256k1',
      },
    });
    expect(pathsOf(fetcher)).toEqual([accountPath(MICHAEL)]);
  });

  it('names a module account (recorded mainnet answer)', async () => {
    const result = await run(
      accountKind,
      { address: FEE_COLLECTOR },
      contextOf(chainFetch({ [accountPath(FEE_COLLECTOR)]: accountModule })),
    );
    expect(result).toEqual({
      ok: true,
      subject: 'other',
      data: {
        address: FEE_COLLECTOR,
        onChain: true,
        type: 'ModuleAccount',
        kindLabel: 'module account "fee_collector"',
        accountNumber: '81',
        sequence: '0',
        publicKey: 'none yet',
        module: { name: 'fee_collector', permissions: [] },
      },
    });
  });

  it('reads a 62-character address as a contract too (recorded mainnet answers)', async () => {
    const fetcher = chainFetch({
      [accountPath(CONTRACT)]: accountContract,
      [contractPath(CONTRACT)]: contractInfo,
    });
    const result = await run(
      accountKind,
      { address: CONTRACT },
      contextOf(fetcher),
    );
    expect(pathsOf(fetcher).sort()).toEqual(
      [accountPath(CONTRACT), contractPath(CONTRACT)].sort(),
    );
    expect(result.ok && result.data).toEqual({
      address: CONTRACT,
      onChain: true,
      type: 'BaseAccount',
      // The label is the instantiator's own text: only in `contract.label`.
      kindLabel: 'smart contract',
      accountNumber: '7532',
      sequence: '0',
      publicKey: 'none yet',
      contract: {
        label: 'initiate_entity_nft_contract',
        codeId: '1',
        creator: 'ixo1vafr2dqhgz8frc7gf22njz8y2u0fue4kuetey6',
        admin: 'ixo1g7xtrvc8ejkenee8a3gryvx6d4n9uu6gpsx63z',
      },
    });
  });

  it('keeps a long address that is no contract a regular account, and marks a failed contract read', async () => {
    const routes = { [accountPath(CONTRACT)]: accountContract };
    const notContract = await run(
      accountKind,
      { address: CONTRACT },
      contextOf(
        chainFetch({ ...routes, [contractPath(CONTRACT)]: reply(404) }),
      ),
    );
    expect(notContract.ok && notContract.data).toMatchObject({
      kindLabel: 'regular account (held by a key)',
    });
    expect(notContract.ok && notContract.data).not.toHaveProperty(
      'contractInfoUnavailable',
    );
    const unread = await run(
      accountKind,
      { address: CONTRACT },
      contextOf(
        chainFetch({ ...routes, [contractPath(CONTRACT)]: reply(500) }),
      ),
    );
    expect(unread.ok && unread.data).toMatchObject({
      onChain: true,
      contractInfoUnavailable: true,
    });
  });

  it('answers a 404 as "not on chain yet", not as a failure (recorded mainnet 404)', async () => {
    const result = await run(
      accountKind,
      { address: ABSENT },
      contextOf(
        chainFetch({
          [accountPath(ABSENT)]: reply(404, {
            code: 5,
            message: `account ${ABSENT} not found`,
            details: [],
          }),
        }),
      ),
    );
    expect(result).toEqual({
      ok: true,
      subject: 'other',
      data: { address: ABSENT, onChain: false },
    });
  });

  it('summarises a vesting schedule', async () => {
    const base = {
      base_account: {
        address: MICHAEL,
        pub_key: null,
        account_number: '9',
        sequence: '0',
      },
      original_vesting: [{ denom: 'uixo', amount: '120000000' }],
      delegated_free: [],
      delegated_vesting: [],
      end_time: '1798761600',
    };
    const continuous = await run(
      accountKind,
      {},
      contextOf(
        chainFetch({
          [accountPath(MICHAEL)]: {
            account: {
              '@type': '/cosmos.vesting.v1beta1.ContinuousVestingAccount',
              base_vesting_account: base,
              start_time: '1767225600',
            },
          },
        }),
      ),
    );
    expect(continuous.ok && continuous.data).toMatchObject({
      type: 'ContinuousVestingAccount',
      kindLabel: 'vesting account (continuous)',
      publicKey: 'none yet',
      vesting: {
        kind: 'continuous',
        coins: [
          {
            amount: '120',
            symbol: 'IXO',
            denom: 'uixo',
            amountBaseUnits: '120000000',
            verified: true,
          },
        ],
        starts: '2026-01-01T00:00:00.000Z',
        ends: '2027-01-01T00:00:00.000Z',
      },
    });
    const delayed = await run(
      accountKind,
      {},
      contextOf(
        chainFetch({
          [accountPath(MICHAEL)]: {
            account: {
              '@type': '/cosmos.vesting.v1beta1.DelayedVestingAccount',
              base_vesting_account: base,
            },
          },
        }),
      ),
    );
    expect(delayed.ok && delayed.data).toMatchObject({
      kindLabel: 'vesting account (delayed)',
      vesting: { kind: 'delayed', unlocksAt: '2027-01-01T00:00:00.000Z' },
    });
  });

  it('passes an upstream failure through', async () => {
    expect(
      await run(
        accountKind,
        {},
        contextOf(chainFetch({ [accountPath(MICHAEL)]: reply(500) })),
      ),
    ).toEqual(HTTP_500_FAILURE);
  });
});

describe('smart_account', () => {
  const path = `/ixo/smartaccount/authenticators/${MICHAEL}`;

  it('validates its arguments', () => {
    const ctx = contextOf(chainFetch({}));
    expect(refusal(smartAccountKind, {}, ctx)).toBeNull();
    expect(refusal(smartAccountKind, { id: '1' }, ctx)).toMatch(
      /^Invalid args for kind "smart_account"/,
    );
  });

  it('shows each authenticator as its tree of types, keys only as fingerprints (recorded mainnet answer)', async () => {
    const fetcher = chainFetch({ [path]: smartAccount });
    const result = await run(smartAccountKind, {}, contextOf(fetcher));
    expect(pathsOf(fetcher)).toEqual([path]);
    expect(result).toEqual({
      ok: true,
      subject: 'user',
      data: {
        address: MICHAEL,
        smartAccount: true,
        authenticators: [
          {
            id: '1155',
            type: 'AllOf',
            kindLabel: 'every listed rule must pass',
            rule: 'AllOf[SignatureVerification(key c77c6aa9), AnyOf[MessageFilter(MsgAddAuthenticator), MessageFilter(MsgRemoveAuthenticator)]]',
          },
          {
            id: '1156',
            type: 'SignatureVerification',
            kindLabel: 'signs with an extra key',
            rule: 'SignatureVerification(key 9d33acc2)',
          },
        ],
      },
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('Am7qryqDT');
    expect(text).not.toContain('A8ug6Nm');
  });

  it('answers a 404 or an empty list as no smart account', async () => {
    for (const answer of [reply(404), { account_authenticators: [] }])
      expect(
        await run(
          smartAccountKind,
          {},
          contextOf(chainFetch({ [path]: answer })),
        ),
      ).toEqual({
        ok: true,
        subject: 'user',
        data: { address: MICHAEL, smartAccount: false, authenticators: [] },
      });
  });

  it('stops reading a composite rule once its node budget is spent', async () => {
    const encode = (value: unknown) => btoa(JSON.stringify(value));
    const body = {
      account_authenticators: [
        {
          id: '1',
          type: 'AnyOf',
          config: encode(
            Array.from({ length: 40 }, () => ({ type: 'X', config: '' })),
          ),
        },
      ],
    };
    const result = await run(
      smartAccountKind,
      {},
      contextOf(chainFetch({ [path]: body })),
    );
    // The top rule and 15 sub-rules use the 16 nodes; the other 25 are one "…".
    expect(result.ok && result.data).toMatchObject({
      authenticators: [
        {
          rule: `AnyOf[${[...Array.from({ length: 15 }, () => 'X'), '…'].join(', ')}]`,
        },
      ],
    });
  });

  it('reads passkeys, contract rules and message fields, and names what it cannot decode', async () => {
    const encode = (value: unknown) => btoa(JSON.stringify(value));
    const body = {
      account_authenticators: [
        { id: '1', type: 'AuthnVerification', config: btoa('passkey-bytes') },
        {
          id: '2',
          type: 'PartitionedAnyOf',
          config: encode([
            {
              type: 'CosmwasmAuthenticatorV1',
              config: encode({ contract: 'ixo1contract', params: '' }),
            },
            {
              type: 'MessageFilter',
              config: encode({
                '@type': '/cosmos.bank.v1beta1.MsgSend',
                to_address: 'ixo1x',
              }),
            },
          ]),
        },
        { id: '3', type: 'AllOf', config: '%%not base64%%' },
        { id: '4', type: 'FutureAuthenticator', config: '' },
      ],
    };
    const result = await run(
      smartAccountKind,
      {},
      contextOf(chainFetch({ [path]: body })),
    );
    expect(result.ok && result.data).toMatchObject({
      authenticators: [
        {
          type: 'AuthnVerification',
          kindLabel: 'signs with a passkey (WebAuthn)',
          rule: expect.stringMatching(/^AuthnVerification\(key [0-9a-f]{8}\)$/),
        },
        {
          type: 'PartitionedAnyOf',
          rule: 'PartitionedAnyOf[CosmwasmAuthenticatorV1(contract ixo1contract), MessageFilter(MsgSend; fields to_address)]',
        },
        { type: 'AllOf', rule: 'AllOf(unreadable config)' },
        {
          type: 'FutureAuthenticator',
          kindLabel: 'an authenticator type this reader does not know',
          rule: 'FutureAuthenticator',
        },
      ],
    });
  });

  it('passes an upstream failure through', async () => {
    expect(
      await run(
        smartAccountKind,
        {},
        contextOf(chainFetch({ [path]: reply(500) })),
      ),
    ).toEqual(HTTP_500_FAILURE);
  });
});

/** A spendable row: each amount as a coin of `token`, `[amount, amountBaseUnits]`. */
const row = (
  token: { denom: string; symbol: string; verified: boolean; origin?: string },
  total: [string, string],
  spendableNow: [string, string],
  locked: [string, string],
) => {
  const coin = ([amount, amountBaseUnits]: [string, string]) => ({
    ...token,
    amount,
    amountBaseUnits,
  });
  return {
    total: coin(total),
    spendable: coin(spendableNow),
    locked: coin(locked),
  };
};

describe('spendable', () => {
  const query = `${MICHAEL}?pagination.limit=50`;
  const spendablePath = `/cosmos/bank/v1beta1/spendable_balances/${query}`;
  const balancesPath = `/cosmos/bank/v1beta1/balances/${query}`;

  it('validates its arguments', () => {
    expect(
      refusal(spendableKind, { denom: 'uixo' }, contextOf(chainFetch({}))),
    ).toMatch(/^Invalid args for kind "spendable"/);
  });

  it('shows total, spendable and locked per token, IXO first (recorded mainnet answers)', async () => {
    const fetcher = chainFetch({
      [spendablePath]: spendable,
      [balancesPath]: balances,
      ...upayRoute,
    });
    const result = await run(spendableKind, {}, contextOf(fetcher));
    expect(pathsOf(fetcher).slice(0, 2).sort()).toEqual(
      [balancesPath, spendablePath].sort(),
    );
    expect(result).toEqual({
      ok: true,
      subject: 'user',
      data: {
        address: MICHAEL,
        anyLocked: false,
        tokens: [
          row(
            { denom: 'uixo', symbol: 'IXO', verified: true },
            ['9', '9000000'],
            ['9', '9000000'],
            ['0', '0'],
          ),
          row(
            {
              denom:
                'ibc/6BBE9BD4246F8E04948D5A4EEE7164B2630263B9EBB5E7DC5F0A46C62A2FF97B',
              symbol: 'USDC',
              verified: true,
              origin: 'noble-1',
            },
            ['25.069999', '25069999'],
            ['25.069999', '25069999'],
            ['0', '0'],
          ),
          row(
            {
              denom:
                'ibc/77C12480BD8C29BF0ACEC2143736C15BAF8CD232CA27BAE09336677B828955E6',
              symbol: 'USDC',
              verified: true,
              origin: 'injective-1',
            },
            ['2.199004', '2199004'],
            ['2.199004', '2199004'],
            ['0', '0'],
          ),
          row(
            { denom: 'upay', symbol: 'PAY', verified: true },
            ['5.74', '5740000'],
            ['5.74', '5740000'],
            ['0', '0'],
          ),
        ],
      },
    });
  });

  it('counts what is not spendable as locked', async () => {
    const result = await run(
      spendableKind,
      {},
      contextOf(
        chainFetch({
          [spendablePath]: { balances: [{ denom: 'uixo', amount: '4000000' }] },
          [balancesPath]: {
            balances: [
              { denom: 'uixo', amount: '10000000' },
              { denom: 'uother', amount: '7' },
            ],
            pagination: { next_key: 'more' },
          },
          '/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=uother':
            reply(404),
        }),
      ),
    );
    expect(result.ok && result.data).toMatchObject({
      anyLocked: true,
      moreDenoms: true,
      tokens: [
        {
          total: { denom: 'uixo', amount: '10', amountBaseUnits: '10000000' },
          spendable: { amount: '4', amountBaseUnits: '4000000' },
          locked: { amount: '6', amountBaseUnits: '6000000' },
        },
        row(
          { denom: 'uother', symbol: 'uother', verified: false },
          ['7', '7'],
          ['0', '0'],
          ['7', '7'],
        ),
      ],
    });
  });

  it('answers an empty account with no tokens, and passes a failure of either read through', async () => {
    const empty = { balances: [], pagination: { next_key: null } };
    expect(
      await run(
        spendableKind,
        {},
        contextOf(
          chainFetch({ [spendablePath]: empty, [balancesPath]: empty }),
        ),
      ),
    ).toEqual({
      ok: true,
      subject: 'user',
      data: { address: MICHAEL, anyLocked: false, tokens: [] },
    });
    for (const broken of [spendablePath, balancesPath])
      expect(
        await run(
          spendableKind,
          {},
          contextOf(
            chainFetch({
              [spendablePath]: empty,
              [balancesPath]: empty,
              [broken]: reply(500),
            }),
          ),
        ),
      ).toEqual(HTTP_500_FAILURE);
  });
});
