import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chainFetch,
  contextOf,
  pathsOf,
  refusal,
  reply,
  resetChainState,
  run,
} from './fixtures/context';
import {
  VALIDATORS_PAGE,
  VALIDATORS_TTL_MS,
  validatorsKind,
} from './validators';

const PATH = `/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=${VALIDATORS_PAGE}`;
const ALEX = 'ixovaloper1qeex565vg4uu7zwudh9ff2dauxptqf72nf2l44';
const BO = 'ixovaloper1qgpqyqszqgpqyqszqgpqyqszqgpqyqszrh8mx2';
const CHAIN = 'ixovaloper1ztwvpazsujtpusj5g7whlsarcjtz3azzdghr6n';

/** A validator as the LCD answers it (the fields the kind reads, plus some it ignores). */
function validator(
  operator: string,
  moniker: string,
  tokens: string,
  rate: string,
  jailed = false,
) {
  return {
    operator_address: operator,
    consensus_pubkey: { '@type': '/cosmos.crypto.ed25519.PubKey', key: 'k' },
    jailed,
    status: 'BOND_STATUS_BONDED',
    tokens,
    delegator_shares: `${tokens}.000000000000000000`,
    description: { moniker, identity: '', website: '', details: '' },
    commission: {
      commission_rates: {
        rate,
        max_rate: '0.200000000000000000',
        max_change_rate: '0.010000000000000000',
      },
    },
  };
}

const bonded = {
  validators: [
    validator(BO, 'Bo Staking', '5000000', '0.100000000000000000'),
    validator(
      ALEX,
      'Alex (Bambarello) Validator',
      '820213801049',
      '0.050000000000000000',
    ),
    validator(CHAIN, 'chain-4', '1000000', '0.075500000000000000', true),
  ],
  pagination: { next_key: null, total: '0' },
};

beforeEach(() => {
  resetChainState();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z'), toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('validators', () => {
  it('validates its arguments', () => {
    const ctx = contextOf(chainFetch({}));
    expect(refusal(validatorsKind, {}, ctx)).toBeNull();
    expect(refusal(validatorsKind, { name: 'alex', first: 5 }, ctx)).toBeNull();
    for (const args of [{ name: '' }, { name: 'x'.repeat(71) }, { all: true }])
      expect(refusal(validatorsKind, args, ctx)).toMatch(
        /^Invalid args for kind "validators"/,
      );
  });

  it('reads the bonded set once, with a fixed page, largest stake first', async () => {
    const fetcher = chainFetch({ [PATH]: bonded });
    const result = await run(validatorsKind, {}, contextOf(fetcher));
    expect(pathsOf(fetcher)).toEqual([PATH]);
    expect(result).toMatchObject({
      ok: true,
      data: {
        matched: 3,
        validators: [
          {
            moniker: 'Alex (Bambarello) Validator',
            validator: ALEX,
            commissionPercent: '5',
            active: true,
            staked: { amount: '820213.801049', symbol: 'IXO' },
          },
          {
            moniker: 'Bo Staking',
            validator: BO,
            commissionPercent: '10',
            active: true,
          },
          // A jailed validator earns nothing for its stakers.
          {
            moniker: 'chain-4',
            validator: CHAIN,
            commissionPercent: '7.55',
            active: false,
          },
        ],
      },
    });
    expect(result).not.toHaveProperty('data.moreValidators');
  });

  it('finds a validator by part of its name, in any case, and honours first', async () => {
    const fetcher = chainFetch({ [PATH]: bonded });
    const byName = await run(
      validatorsKind,
      { name: 'BAMBARELLO' },
      contextOf(fetcher),
    );
    expect(byName).toMatchObject({
      ok: true,
      data: { matched: 1, validators: [{ validator: ALEX }] },
    });
    const one = await run(validatorsKind, {}, contextOf(fetcher, { first: 1 }));
    expect(one).toMatchObject({
      ok: true,
      data: { matched: 3, validators: [{ validator: ALEX }] },
    });
    expect(
      await run(validatorsKind, { name: 'nobody' }, contextOf(fetcher)),
    ).toMatchObject({ ok: true, data: { matched: 0, validators: [] } });
    // One read served all three.
    expect(pathsOf(fetcher)).toEqual([PATH]);
  });

  it('keeps the set for 10 minutes, says when there are more, and fails without caching', async () => {
    const fetcher = chainFetch({
      [PATH]: { ...bonded, pagination: { next_key: 'next' } },
    });
    expect(await run(validatorsKind, {}, contextOf(fetcher))).toMatchObject({
      ok: true,
      data: { moreValidators: true },
    });
    vi.setSystemTime(Date.now() + VALIDATORS_TTL_MS + 1);
    await run(validatorsKind, {}, contextOf(fetcher));
    expect(pathsOf(fetcher)).toEqual([PATH, PATH]);

    resetChainState();
    const down = chainFetch({ [PATH]: reply(500) });
    expect(await run(validatorsKind, {}, contextOf(down))).toMatchObject({
      ok: false,
    });
  });
});
