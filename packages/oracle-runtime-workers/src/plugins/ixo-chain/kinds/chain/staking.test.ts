import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
} from './fixtures/context';
import emptyDelegations from './fixtures/staking-empty-delegations.json';
import emptyRewards from './fixtures/staking-empty-rewards.json';
import delegations from './fixtures/staking-delegations.json';
import rewards from './fixtures/staking-rewards.json';
import emptyUnbonding from './fixtures/staking-unbonding-empty.json';
import validator from './fixtures/validator.json';
import { MONIKER_TTL_MS, stakingKind } from './staking';

/** A bonded mainnet validator and its own (self-delegating) account. */
const VALOPER = 'ixovaloper1qeex565vg4uu7zwudh9ff2dauxptqf72nf2l44';
const DELEGATOR = 'ixo1qeex565vg4uu7zwudh9ff2dauxptqf72eg6wds';
const MONIKER = 'Alex (Bambarello) Validator';

const paths = (address: string) => ({
  delegations: `/cosmos/staking/v1beta1/delegations/${address}?pagination.limit=50`,
  unbonding: `/cosmos/staking/v1beta1/delegators/${address}/unbonding_delegations?pagination.limit=50`,
  rewards: `/cosmos/distribution/v1beta1/delegators/${address}/rewards`,
});
const validatorPath = (valoper: string) =>
  `/cosmos/staking/v1beta1/validators/${valoper}`;
const ixoCoin = (amount: string, amountBaseUnits: string) => ({
  amount,
  symbol: 'IXO',
  denom: 'uixo',
  amountBaseUnits,
  verified: true,
});

function delegatorRoutes(overrides: Record<string, unknown> = {}) {
  const at = paths(DELEGATOR);
  return {
    [at.delegations]: delegations,
    [at.unbonding]: emptyUnbonding,
    [at.rewards]: rewards,
    [validatorPath(VALOPER)]: validator,
    ...overrides,
  };
}

beforeEach(() => {
  resetChainState();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ now: new Date('2026-10-29T12:00:00Z'), toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('staking', () => {
  it('validates its arguments', () => {
    const ctx = contextOf(chainFetch({}));
    expect(refusal(stakingKind, { address: DELEGATOR }, ctx)).toBeNull();
    expect(refusal(stakingKind, { validator: VALOPER }, ctx)).toMatch(
      /^Invalid args for kind "staking"/,
    );
    expect(refusal(stakingKind, { address: VALOPER }, ctx)).toBe(
      'address must be an ixo1… address or a did:ixo:ixo1… DID.',
    );
  });

  it('reads delegations, unbonding and rewards at once and names the validator (recorded mainnet answers)', async () => {
    const fetcher = chainFetch(delegatorRoutes());
    const result = await run(
      stakingKind,
      { address: DELEGATOR },
      contextOf(fetcher),
    );
    const at = paths(DELEGATOR);
    expect(pathsOf(fetcher)).toEqual([
      at.delegations,
      at.unbonding,
      at.rewards,
      validatorPath(VALOPER),
    ]);
    const named = { validator: VALOPER, moniker: MONIKER };
    expect(result).toEqual({
      ok: true,
      subject: 'other',
      data: {
        address: DELEGATOR,
        staking: true,
        delegations: [{ ...named, coin: ixoCoin('1', '1000000') }],
        unbonding: [],
        rewards: {
          // A DecCoin's fraction of a base unit is dropped.
          total: [ixoCoin('0.570925', '570925')],
          byValidator: [{ ...named, coins: [ixoCoin('0.570925', '570925')] }],
        },
        totals: {
          delegated: ixoCoin('1', '1000000'),
          unbonding: ixoCoin('0', '0'),
        },
      },
    });
  });

  it('keeps a moniker for 10 minutes, then reads it again', async () => {
    const fetcher = chainFetch(delegatorRoutes());
    const monikerReads = () =>
      pathsOf(fetcher).filter((path) => path === validatorPath(VALOPER)).length;
    await run(stakingKind, { address: DELEGATOR }, contextOf(fetcher));
    await run(stakingKind, { address: DELEGATOR }, contextOf(fetcher));
    expect(monikerReads()).toBe(1);
    vi.setSystemTime(Date.now() + MONIKER_TTL_MS + 1);
    await run(stakingKind, { address: DELEGATOR }, contextOf(fetcher));
    expect(monikerReads()).toBe(2);
  });

  it('shows a validator the chain does not know by address, and an unbonding entry', async () => {
    const at = paths(DELEGATOR);
    const fetcher = chainFetch(
      delegatorRoutes({
        [validatorPath(VALOPER)]: reply(404),
        [at.unbonding]: {
          unbonding_responses: [
            {
              delegator_address: DELEGATOR,
              validator_address: VALOPER,
              entries: [
                {
                  creation_height: '19000000',
                  completion_time: '2026-11-19T12:00:00Z',
                  initial_balance: '2000000',
                  balance: '2000000',
                  unbonding_id: '7',
                  unbonding_on_hold_ref_count: '0',
                },
              ],
            },
          ],
          pagination: { next_key: null, total: '0' },
        },
      }),
    );
    const result = await run(
      stakingKind,
      { address: DELEGATOR },
      contextOf(fetcher),
    );
    expect(result.ok && result.data).toMatchObject({
      delegations: [{ validator: VALOPER, coin: ixoCoin('1', '1000000') }],
      unbonding: [
        {
          validator: VALOPER,
          coin: ixoCoin('2', '2000000'),
          completesAt: '2026-11-19T12:00:00Z',
        },
      ],
      totals: { unbonding: ixoCoin('2', '2000000') },
    });
    expect(JSON.stringify(result)).not.toContain('moniker');
  });

  it('answers an account that does not stake as "not staking" (recorded mainnet answers)', async () => {
    const at = paths(MICHAEL);
    const fetcher = chainFetch({
      [at.delegations]: emptyDelegations,
      [at.unbonding]: emptyUnbonding,
      [at.rewards]: emptyRewards,
    });
    expect(await run(stakingKind, {}, contextOf(fetcher))).toEqual({
      ok: true,
      subject: 'user',
      data: {
        address: MICHAEL,
        staking: false,
        delegations: [],
        unbonding: [],
        rewards: { total: 'none', byValidator: [] },
        totals: { delegated: ixoCoin('0', '0'), unbonding: ixoCoin('0', '0') },
      },
    });
    expect(pathsOf(fetcher)).toHaveLength(3);
  });

  it('keeps the delegations when the rewards cannot be read', async () => {
    const at = paths(DELEGATOR);
    const result = await run(
      stakingKind,
      { address: DELEGATOR },
      contextOf(chainFetch(delegatorRoutes({ [at.rewards]: reply(500) }))),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        staking: true,
        delegations: [{ moniker: MONIKER, coin: ixoCoin('1', '1000000') }],
        rewardsUnavailable: true,
        totals: { delegated: ixoCoin('1', '1000000') },
      },
    });
    expect(JSON.stringify(result)).not.toContain('"rewards"');
  });

  it('says a validator with no rewards yet has none', async () => {
    const result = await run(
      stakingKind,
      { address: DELEGATOR },
      contextOf(
        chainFetch(
          delegatorRoutes({
            [paths(DELEGATOR).rewards]: {
              rewards: [{ validator_address: VALOPER, reward: [] }],
              total: [],
            },
          }),
        ),
      ),
    );
    expect(result.ok && result.data).toMatchObject({
      rewards: {
        total: 'none',
        byValidator: [{ moniker: MONIKER, coins: 'none' }],
      },
    });
  });

  it('points to liquid staking in its explanation', () => {
    expect(stakingKind.explain).toMatch(/Liquid staking is staking too/);
    expect(stakingKind.explain).toContain('`liquid_staking`');
  });

  it('passes a failure of its delegations or unbonding reads through', async () => {
    const at = paths(DELEGATOR);
    for (const broken of [at.delegations, at.unbonding])
      expect(
        await run(
          stakingKind,
          { address: DELEGATOR },
          contextOf(chainFetch(delegatorRoutes({ [broken]: reply(500) }))),
        ),
      ).toEqual(HTTP_500_FAILURE);
  });
});
