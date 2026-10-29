import { describe, expect, it } from 'vitest';
import { daos } from './daos';
import {
  ADDRESS,
  INJECTION,
  NO_ADDRESS,
  answerOf,
  contextOf,
  failureOf,
  long,
  planOf,
  refusalOf,
} from './fixtures/context';
// Recorded on mainnet on Oct 29 2026 (`first: 3`): the user is in no DAO,
// so this is the answer for the staker of the cw20 staker table's first
// row (two cw20 stakes, three of its cw4 groups; no native staker is
// indexed on mainnet).
import recorded from './fixtures/daos.json';

const STAKER = 'ixo1xwn45d6xhe3egcz3nqlfc2elpc3h6usy6yw3uk';
const CORES =
  'daoCoresByVotingModule(first: 1) { nodes { address name description } }';

const field = (address: string, first: number) =>
  `r0: query { native: daoNativeStakers(filter: { stakerAddress: { equalTo: "${address}" } }, first: ${first}, orderBy: PRIMARY_KEY_ASC) { pageInfo { hasNextPage } nodes { stakedAmount daoVotingModuleByVotingModuleAddress { address moduleType nativeDenom totalWeight ${CORES} } } } cw20: daoCw20Stakers(filter: { stakerAddress: { equalTo: "${address}" } }, first: ${first}, orderBy: PRIMARY_KEY_ASC) { pageInfo { hasNextPage } nodes { stakedAmount daoCw20StakingContractByStakingContract { daoVotingModulesByStakingContract(first: 3) { nodes { address moduleType tokenAddress totalWeight ${CORES} } } } } } cw4: daoCw4Members(filter: { memberAddress: { equalTo: "${address}" } }, first: ${first}, orderBy: PRIMARY_KEY_ASC) { pageInfo { hasNextPage } nodes { weight daoCw4GroupContractByGroupContractAddress { daoVotingModulesByGroupContractAddress(first: 3) { nodes { address moduleType totalWeight ${CORES} } } } } } }`;

const empty = { pageInfo: { hasNextPage: false }, nodes: [] };

describe('daos', () => {
  it('reads every kind of membership in one alias', () => {
    expect(planOf(daos, {}).field('r0')).toBe(field(ADDRESS, 10));
  });

  it('validates its arguments', () => {
    expect(refusalOf(daos, { dao: ADDRESS })).toMatch(/dao/);
    expect(refusalOf(daos, { first: 0 })).toMatch(/first:/);
    expect(refusalOf(daos, {}, contextOf(NO_ADDRESS))).toBe(
      'The user has no IXO account address; give one.',
    );
  });

  it('refuses an address carrying GraphQL syntax and uses no containment', () => {
    expect(refusalOf(daos, { address: INJECTION })).toMatch(/address must be/);
    expect(planOf(daos, { address: `did:ixo:${STAKER}` }).field('r0')).toBe(
      field(STAKER, 10),
    );
    expect(planOf(daos, {}).field('r0')).not.toContain('contains');
  });

  it('reads the call’s clamped row count', () => {
    expect(
      planOf(daos, { first: 20 }, contextOf(undefined, 5)).field('r0'),
    ).toBe(field(ADDRESS, 5));
  });

  it('shapes a recorded answer: stakes first, then groups, with voting power', async () => {
    const plan = planOf(daos, { address: STAKER }, contextOf(undefined, 3));
    const answer = await answerOf(plan, recorded);
    expect(answer.subject).toBe('other');
    expect(answer.first).toBe(3);
    expect(answer.data).toEqual({
      more: true,
      items: [
        {
          dao: 'ixo16z0mp6hq24uzct8snu940gkz8kt7vssw0hq2wmxpmgpvjg0zrvmskqem5e',
          name: 'Staking Group',
          description:
            'The ReFi Cape Town community members staking group to submit and vote on governance proposals surrounding the strategic direction of ReFi Cape Town.',
          // The DAO named itself: never an endorsement.
          nameIsSelfChosen: true,
          membership: 'cw20-staked',
          staked: { amountBaseUnits: '100000000' },
          votingPowerShare: '100.00%',
          votingModule:
            'ixo17yw4nya4kmqgn0aw4xfecrwc098260n6cnqz72afnmhqxrjp6j3s8h4fpp',
          moduleType: 'dao_voting_cw20_staked',
        },
        expect.objectContaining({
          name: 'Members Group',
          membership: 'cw20-staked',
          staked: { amountBaseUnits: '1000000' },
          votingPowerShare: '0.90%',
        }),
        expect.objectContaining({
          name: 'Administration',
          nameIsSelfChosen: true,
          membership: 'cw4-member',
          // A group admin adds members without their consent.
          addedByGroupAdmin: true,
          weight: '1',
          votingPowerShare: '50.00%',
          moduleType: 'dao_voting_cw4',
        }),
      ],
    });
  });

  it('shapes a native stake as a bank coin', async () => {
    const answer = await answerOf(planOf(daos, {}), {
      native: {
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            stakedAmount: '2500000',
            daoVotingModuleByVotingModuleAddress: {
              address: 'ixo1module',
              moduleType: 'dao_voting_token_staked',
              nativeDenom: 'uixo',
              totalWeight: null,
              daoCoresByVotingModule: {
                nodes: [{ address: 'ixo1dao', name: 'Native DAO' }],
              },
            },
          },
        ],
      },
      cw20: empty,
      cw4: empty,
    });
    expect(answer.data).toEqual({
      items: [
        {
          dao: 'ixo1dao',
          name: 'Native DAO',
          nameIsSelfChosen: true,
          membership: 'native-staked',
          staked: {
            denom: 'uixo',
            amountBaseUnits: '2500000',
            symbol: 'IXO',
            amount: '2.5',
            verified: true,
          },
          votingModule: 'ixo1module',
          moduleType: 'dao_voting_token_staked',
        },
      ],
    });
  });

  it('labels neither a nameless DAO nor a stake as self-chosen or admin-added', async () => {
    const answer = await answerOf(planOf(daos, {}), {
      native: {
        nodes: [
          {
            stakedAmount: '1',
            daoVotingModuleByVotingModuleAddress: {
              address: 'ixo1module',
              nativeDenom: 'uixo',
              daoCoresByVotingModule: { nodes: [{ address: 'ixo1dao' }] },
            },
          },
        ],
      },
      cw20: empty,
      cw4: empty,
    });
    expect(answer.data).toEqual({
      items: [
        {
          dao: 'ixo1dao',
          membership: 'native-staked',
          staked: expect.objectContaining({ amountBaseUnits: '1' }),
          votingModule: 'ixo1module',
        },
      ],
    });
  });

  it('answers no memberships and refuses an unexpected shape', async () => {
    const plan = planOf(daos, {});
    expect(
      (await answerOf(plan, { native: empty, cw20: empty, cw4: empty })).data,
    ).toEqual({ items: [] });
    expect(await failureOf(plan, null)).toMatchObject({
      reason: 'unavailable',
    });
    expect(await failureOf(plan, { native: empty })).toMatchObject({
      reason: 'unavailable',
    });
  });

  it('clips long index strings', async () => {
    const answer = await answerOf(planOf(daos, {}), {
      native: empty,
      cw20: empty,
      cw4: {
        nodes: [
          {
            weight: 3,
            daoCw4GroupContractByGroupContractAddress: {
              daoVotingModulesByGroupContractAddress: {
                nodes: [
                  {
                    address: 'ixo1module',
                    totalWeight: '4',
                    daoCoresByVotingModule: {
                      nodes: [
                        {
                          address: 'ixo1dao',
                          name: long(300, 'n'),
                          description: long(1000, 'd'),
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    });
    expect(answer.data).toEqual({
      items: [
        {
          dao: 'ixo1dao',
          name: `${long(199, 'n')}…`,
          description: `${long(239, 'd')}…`,
          nameIsSelfChosen: true,
          membership: 'cw4-member',
          addedByGroupAdmin: true,
          weight: '3',
          votingPowerShare: '75.00%',
          votingModule: 'ixo1module',
        },
      ],
    });
  });
});
