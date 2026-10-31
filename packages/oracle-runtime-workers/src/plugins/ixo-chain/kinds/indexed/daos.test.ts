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
// Recorded on mainnet on Oct 29 2026 (`first: 3`) and again with the
// proposal lists on Oct 31 2026 (the same rows): the user is in no DAO, so
// this is the answer for the staker of the cw20 staker table's first row
// (two cw20 stakes, three of its cw4 groups; no native staker is indexed on
// mainnet).
import recorded from './fixtures/daos.json';

const STAKER = 'ixo1xwn45d6xhe3egcz3nqlfc2elpc3h6usy6yw3uk';
const LISTS =
  'daoProposalModulesByDaoAddress(first: 3, orderBy: PRIMARY_KEY_ASC) { pageInfo { hasNextPage } nodes { address prefix status moduleType proposalCreationPolicy config daoPreProposeModuleByPreProposeModule { depositInfo openProposalSubmission } } }';
const CORES = `daoCoresByVotingModule(first: 1) { nodes { address name description ${LISTS} } }`;

const field = (address: string, first: number) =>
  `r0: query { native: daoNativeStakers(filter: { stakerAddress: { equalTo: "${address}" } }, first: ${first}, orderBy: PRIMARY_KEY_ASC) { pageInfo { hasNextPage } nodes { stakedAmount daoVotingModuleByVotingModuleAddress { address moduleType nativeDenom totalWeight ${CORES} } } } cw20: daoCw20Stakers(filter: { stakerAddress: { equalTo: "${address}" } }, first: ${first}, orderBy: PRIMARY_KEY_ASC) { pageInfo { hasNextPage } nodes { stakedAmount daoCw20StakingContractByStakingContract { daoVotingModulesByStakingContract(first: 3) { nodes { address moduleType tokenAddress totalWeight ${CORES} } } } } } cw4: daoCw4Members(filter: { memberAddress: { equalTo: "${address}" } }, first: ${first}, orderBy: PRIMARY_KEY_ASC) { pageInfo { hasNextPage } nodes { weight daoCw4GroupContractByGroupContractAddress { daoVotingModulesByGroupContractAddress(first: 3) { nodes { address moduleType totalWeight ${CORES} } } } } } }`;

const empty = { pageInfo: { hasNextPage: false }, nodes: [] };
/** A DAO core as the index answers it, with no proposal list. */
const core = (fields: Record<string, unknown>) => ({
  daoProposalModulesByDaoAddress: empty,
  ...fields,
});

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
          // Where it takes new proposals: members only, with a 1 IXO
          // deposit returned only when the proposal passes.
          proposalLists: [
            {
              proposalModule:
                'ixo15sy5qemc86ytfka8xqapvntyjth6vxpan5pvd6k98nt7gn7a4myq9t8qvk',
              prefix: 'A',
              membersOnly: true,
              deposit: {
                denom: 'uixo',
                amountBaseUnits: '1000000',
                symbol: 'IXO',
                amount: '1',
                verified: true,
                refundPolicy: 'only_passed',
              },
              votingTime: '5 days',
              allowRevoting: false,
            },
          ],
        },
        expect.objectContaining({
          name: 'Members Group',
          membership: 'cw20-staked',
          staked: { amountBaseUnits: '1000000' },
          votingPowerShare: '0.90%',
          proposalLists: [
            expect.objectContaining({
              deposit: expect.objectContaining({
                amount: '1000',
                symbol: 'IXO',
                refundPolicy: 'only_passed',
              }),
            }),
          ],
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
          // No deposit.
          proposalLists: [
            {
              proposalModule:
                'ixo1770puc38e2p6cg4shhmum3q70u9jlx5yx3ryvyrhc958694w77rqludyf7',
              prefix: 'A',
              membersOnly: true,
              votingTime: '3 days',
              allowRevoting: false,
            },
          ],
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
                nodes: [core({ address: 'ixo1dao', name: 'Native DAO' })],
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
              daoCoresByVotingModule: { nodes: [core({ address: 'ixo1dao' })] },
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

  it('shows where each DAO takes new proposals: who may propose, the deposit and whether cards can use the list', async () => {
    const list = (fields: Record<string, unknown>) => ({
      address: 'ixo1list',
      prefix: 'A',
      status: 'enabled',
      moduleType: 'dao_proposal_single',
      proposalCreationPolicy: { module: { addr: 'ixo1intake' } },
      config: {
        allow_revoting: true,
        only_members_execute: true,
        max_voting_period: { time: 3_600 },
      },
      daoPreProposeModuleByPreProposeModule: {
        depositInfo: null,
        openProposalSubmission: true,
      },
      ...fields,
    });
    const answer = await answerOf(planOf(daos, {}), {
      native: empty,
      cw20: empty,
      cw4: {
        nodes: [
          {
            weight: 1,
            daoCw4GroupContractByGroupContractAddress: {
              daoVotingModulesByGroupContractAddress: {
                nodes: [
                  {
                    address: 'ixo1module',
                    totalWeight: '2',
                    daoCoresByVotingModule: {
                      nodes: [
                        {
                          address: 'ixo1dao',
                          daoProposalModulesByDaoAddress: {
                            pageInfo: { hasNextPage: true },
                            nodes: [
                              // Open to anyone through the intake, no deposit.
                              list({}),
                              // Straight to the list: anyone, never a deposit.
                              list({
                                address: 'ixo1anyone',
                                prefix: 'B',
                                proposalCreationPolicy: { anyone: {} },
                                config: { max_voting_period: { height: 100 } },
                                daoPreProposeModuleByPreProposeModule: null,
                              }),
                              // A deposit in a cw20 token, a multiple-choice
                              // list and a disabled one: cards cannot use them.
                              list({
                                address: 'ixo1cw20',
                                prefix: 'C',
                                moduleType: 'dao_proposal_multiple',
                                status: 'disabled',
                                daoPreProposeModuleByPreProposeModule: {
                                  depositInfo: {
                                    denom: { cw20: 'ixo1token' },
                                    amount: '5',
                                    refund_policy: 'always',
                                  },
                                  openProposalSubmission: false,
                                },
                              }),
                            ],
                          },
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
    expect(daos.explain).toContain(
      '`disabled: true`: the group switched it off: no new proposals through it, and its proposals with actions can’t be carried out (votes and closes still work).',
    );
    expect(answer.data).toEqual({
      items: [
        expect.objectContaining({
          dao: 'ixo1dao',
          proposalLists: [
            {
              proposalModule: 'ixo1list',
              prefix: 'A',
              votingTime: '1 hour',
              allowRevoting: true,
              membersOnlyCarryOut: true,
            },
            {
              proposalModule: 'ixo1anyone',
              prefix: 'B',
              votingTime: '100 blocks',
            },
            {
              proposalModule: 'ixo1cw20',
              prefix: 'C',
              disabled: true,
              multipleChoice: true,
              membersOnly: true,
              deposit: {
                token: 'ixo1token',
                amountBaseUnits: '5',
                refundPolicy: 'always',
                cardCannotPay: true,
              },
              votingTime: '1 hour',
              allowRevoting: true,
              membersOnlyCarryOut: true,
            },
          ],
          moreProposalLists: true,
        }),
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
                        core({
                          address: 'ixo1dao',
                          name: long(300, 'n'),
                          description: long(1000, 'd'),
                        }),
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
