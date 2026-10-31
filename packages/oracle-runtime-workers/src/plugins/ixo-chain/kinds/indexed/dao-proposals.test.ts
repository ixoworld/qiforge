import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daoProposals, daosWithOpenProposals } from './dao-proposals';
import { daos } from './daos';
import { INDEXED_KINDS } from '.';
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
// Recorded on mainnet on Oct 29 2026 (`first: 3`, `status: all`): the user
// is in no DAO, so this is the answer for the staker of the cw20 staker
// table's first row, trimmed to its first two cw4 groups.
import recorded from './fixtures/dao-proposals.json';

const STAKER = 'ixo1xwn45d6xhe3egcz3nqlfc2elpc3h6usy6yw3uk';
const DAO = 'ixo14g47ggcgge3xgmzddenqzsgr26ckk854gfngz4g908wc29drwussp0k66n';
const MODULE = 'ixo1zxmee4zshr3sjfssau8q54rsvm0n6yd0tasr96c3366sjht67l7s08kq6a';

const core = (first: number, open: boolean, voter?: string) =>
  `address name daoProposalModulesByDaoAddress(first: 3, orderBy: PRIMARY_KEY_ASC) { pageInfo { hasNextPage } nodes { address prefix status moduleType daoProposalsByProposalModule(${open ? 'filter: { status: { equalTo: "open" } }, ' : ''}first: ${first}, orderBy: PRIMARY_KEY_DESC) { pageInfo { hasNextPage } nodes { id title status proposer startHeight expiration totalPower votes allowRevoting${voter ? ` daoVotesByProposalModuleAndProposalId(filter: { voter: { equalTo: "${voter}" } }, first: 1) { nodes { vote power votedAt } }` : ''} } } } }`;

const proposal = (overrides: Record<string, unknown>) => ({
  id: '4',
  title: 'Fund the garden',
  status: 'open',
  proposer: STAKER,
  startHeight: 19_000_000,
  expiration: { at_time: '1793277600000000000' },
  totalPower: '10',
  votes: { yes: '6', no: '1', abstain: '0' },
  daoVotesByProposalModuleAndProposalId: { nodes: [] },
  ...overrides,
});
const daoAnswer = (proposals: unknown[], hasNextPage = false) => ({
  address: DAO,
  name: 'Test',
  daoProposalModulesByDaoAddress: {
    nodes: [
      {
        address: MODULE,
        prefix: 'A',
        daoProposalsByProposalModule: {
          pageInfo: { hasNextPage },
          nodes: proposals,
        },
      },
    ],
  },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('dao_proposals', () => {
  it('reads one DAO’s open proposals with the user’s vote', () => {
    expect(planOf(daoProposals, { dao: DAO }).field('r0')).toBe(
      `r0: daoCore(address: "${DAO}") { ${core(10, true, ADDRESS)} }`,
    );
    expect(planOf(daoProposals, { dao: DAO, status: 'all' }).field('r0')).toBe(
      `r0: daoCore(address: "${DAO}") { ${core(10, false, ADDRESS)} }`,
    );
  });

  it('reads one DAO without votes for a user with no account', () => {
    expect(
      planOf(daoProposals, { dao: DAO }, contextOf(NO_ADDRESS)).field('r0'),
    ).toBe(`r0: daoCore(address: "${DAO}") { ${core(10, true)} }`);
  });

  it("reads the user's DAOs through their memberships by default", () => {
    const c = core(10, true, ADDRESS);
    const cores = `daoCoresByVotingModule(first: 1) { nodes { ${c} } }`;
    expect(planOf(daoProposals, {}).field('r0')).toBe(
      `r0: query { native: daoNativeStakers(filter: { stakerAddress: { equalTo: "${ADDRESS}" } }, first: 3, orderBy: PRIMARY_KEY_ASC) { pageInfo { hasNextPage } nodes { stakedAmount daoVotingModuleByVotingModuleAddress { address moduleType nativeDenom totalWeight ${cores} } } } cw20: daoCw20Stakers(filter: { stakerAddress: { equalTo: "${ADDRESS}" } }, first: 3, orderBy: PRIMARY_KEY_ASC) { pageInfo { hasNextPage } nodes { stakedAmount daoCw20StakingContractByStakingContract { daoVotingModulesByStakingContract(first: 3) { nodes { address moduleType tokenAddress totalWeight ${cores} } } } } } cw4: daoCw4Members(filter: { memberAddress: { equalTo: "${ADDRESS}" } }, first: 3, orderBy: PRIMARY_KEY_ASC) { pageInfo { hasNextPage } nodes { weight daoCw4GroupContractByGroupContractAddress { daoVotingModulesByGroupContractAddress(first: 3) { nodes { address moduleType totalWeight ${cores} } } } } } }`,
    );
  });

  it('validates its arguments', () => {
    // The message names the length the pattern takes: `ixo1` and 58.
    expect(DAO).toHaveLength(62);
    expect(refusalOf(daoProposals, { dao: ADDRESS })).toMatch(
      /dao: a DAO core contract address \(ixo1…, 62 characters\)/,
    );
    expect(refusalOf(daoProposals, { dao: `${DAO}q` })).toMatch(
      /62 characters/,
    );
    // The right length, one character off: its checksum does not match.
    expect(refusalOf(daoProposals, { dao: `${DAO.slice(0, -1)}7` })).toBe(
      'dao is not a valid ixo1… address: its checksum does not match. Check it for a typo.',
    );
    expect(refusalOf(daoProposals, { status: 'closed' })).toMatch(/status:/);
    expect(refusalOf(daoProposals, { voter: ADDRESS })).toMatch(/voter/);
    expect(refusalOf(daoProposals, {}, contextOf(NO_ADDRESS))).toBe(
      'The user has no IXO account address; give one.',
    );
  });

  it('refuses values carrying GraphQL syntax and uses no containment', () => {
    expect(refusalOf(daoProposals, { dao: `${DAO}"` })).toMatch(/dao:/);
    expect(refusalOf(daoProposals, { address: INJECTION })).toMatch(
      /address must be/,
    );
    expect(planOf(daoProposals, {}).field('r0')).not.toContain('contains');
    expect(planOf(daoProposals, { dao: DAO }).field('r0')).not.toContain(
      'contains',
    );
  });

  it('reads the call’s clamped row count per proposal module', () => {
    expect(
      planOf(
        daoProposals,
        { dao: DAO, first: 20 },
        contextOf(undefined, 5),
      ).field('r0'),
    ).toBe(`r0: daoCore(address: "${DAO}") { ${core(5, true, ADDRESS)} }`);
  });

  it('shapes a recorded answer newest start first, with what is known of the vote', async () => {
    const plan = planOf(
      daoProposals,
      { address: STAKER, status: 'all' },
      contextOf(undefined, 3),
    );
    const answer = await answerOf(plan, recorded);
    expect(answer.subject).toBe('other');
    expect(answer.data).toEqual({
      more: true,
      items: [
        {
          dao: 'ixo1paa5dm2glgmets9yxafa4w68w5hymthh0as8em80684ntmd930jqcp0xey',
          daoName: 'Administration',
          id: '3',
          label: 'A3',
          proposalModule:
            'ixo1770puc38e2p6cg4shhmum3q70u9jlx5yx3ryvyrhc958694w77rqludyf7',
          title: 'Manage members of the group',
          status: 'open',
          votingEndsAt: '2025-03-14T13:25:45.893Z',
          votingEnded: true,
          // Voting ended while the index still says open: it may have
          // passed or not (Auth Hub reads the real result).
          canRun: true,
          canClose: true,
          proposer: STAKER,
          tally: { yes: '0', no: '0', abstain: '0' },
          totalPower: '2',
          notVoted: true,
        },
        expect.objectContaining({
          daoName: 'Test',
          label: 'A1',
          status: 'executed',
          voteUnknown: true,
        }),
        expect.objectContaining({
          daoName: 'Members Group',
          label: 'A18',
          title:
            'Cosmos for Humanity application to join the Impacts DAO Cooperative',
          voteUnknown: true,
        }),
      ],
    });
  });

  it('shapes the user’s vote and an expiration by height or never', async () => {
    const plan = planOf(daoProposals, { dao: DAO });
    const answer = await answerOf(
      plan,
      daoAnswer([
        proposal({
          daoVotesByProposalModuleAndProposalId: {
            nodes: [
              { vote: 'yes', power: '3', votedAt: '2026-10-28T10:00:00.000' },
            ],
          },
        }),
        proposal({
          id: '3',
          startHeight: 18_000_000,
          expiration: { at_height: 19_500_000 },
        }),
        proposal({
          id: '2',
          startHeight: null,
          expiration: { never: {} },
          votes: { vote_weights: ['1'] },
        }),
      ]),
    );
    expect(answer.subject).toBe('user');
    expect(answer.data).toEqual({
      items: [
        {
          dao: DAO,
          daoName: 'Test',
          id: '4',
          label: 'A4',
          proposalModule: MODULE,
          title: 'Fund the garden',
          status: 'open',
          votingEndsAt: '2026-10-29T12:40:00.000Z',
          proposer: STAKER,
          tally: { yes: '6', no: '1', abstain: '0' },
          totalPower: '10',
          yourVote: {
            vote: 'yes',
            power: '3',
            votedAt: '2026-10-28T10:00:00.000',
          },
        },
        expect.objectContaining({
          id: '3',
          votingEndsAtHeight: 19_500_000,
          notVoted: true,
        }),
        {
          dao: DAO,
          daoName: 'Test',
          id: '2',
          label: 'A2',
          proposalModule: MODULE,
          title: 'Fund the garden',
          status: 'open',
          votingEndsAt: 'never',
          proposer: STAKER,
          totalPower: '10',
          voteUnknown: true,
        },
      ],
    });
  });

  it('says which proposals a card can carry out or close, and whether a vote can change', async () => {
    const plan = planOf(daoProposals, { dao: DAO, status: 'all' });
    const items = async (module: Record<string, unknown>) =>
      (
        (
          await answerOf(plan, {
            ...daoAnswer([]),
            daoProposalModulesByDaoAddress: {
              nodes: [
                {
                  address: MODULE,
                  prefix: 'A',
                  status: 'enabled',
                  moduleType: 'dao_proposal_single',
                  ...module,
                  daoProposalsByProposalModule: {
                    nodes: [
                      proposal({
                        id: '9',
                        status: 'passed',
                        allowRevoting: true,
                      }),
                      proposal({
                        id: '8',
                        status: 'rejected',
                        allowRevoting: false,
                      }),
                      proposal({ id: '7', status: 'executed' }),
                      proposal({ id: '6', status: 'open' }),
                    ],
                  },
                },
              ],
            },
          })
        ).data as { items: Record<string, unknown>[] }
      ).items.map(
        ({
          id,
          canRun,
          canClose,
          allowRevoting,
          multipleChoice,
          listDisabled,
        }) => ({
          id,
          canRun,
          canClose,
          allowRevoting,
          multipleChoice,
          listDisabled,
        }),
      );
    expect(await items({})).toEqual([
      { id: '9', canRun: true, allowRevoting: true },
      { id: '8', canClose: true, allowRevoting: false },
      // Carried out, or still being voted on: neither.
      { id: '7' },
      { id: '6' },
    ]);
    // A multiple-choice or disabled list: no card can act on it.
    expect(await items({ moduleType: 'dao_proposal_multiple' })).toEqual([
      { id: '9', allowRevoting: true, multipleChoice: true },
      { id: '8', allowRevoting: false, multipleChoice: true },
      { id: '7', multipleChoice: true },
      { id: '6', multipleChoice: true },
    ]);
    expect(await items({ status: 'disabled' })).toEqual([
      { id: '9', allowRevoting: true, listDisabled: true },
      { id: '8', allowRevoting: false, listDisabled: true },
      { id: '7', listDisabled: true },
      { id: '6', listDisabled: true },
    ]);
  });

  it('judges a missing vote by the network’s vote-indexing height', async () => {
    const raw = daoAnswer([proposal({ startHeight: 6_000_000 })]);
    const mainnet = await answerOf(planOf(daoProposals, { dao: DAO }), raw);
    expect(mainnet.data).toMatchObject({ items: [{ voteUnknown: true }] });
    const devnet = await answerOf(
      planOf(daoProposals, { dao: DAO }, contextOf(undefined, 10, 'devnet')),
      raw,
    );
    expect(devnet.data).toMatchObject({ items: [{ notVoted: true }] });
  });

  it('says nothing of votes when no account was read', async () => {
    const plan = planOf(daoProposals, { dao: DAO }, contextOf(NO_ADDRESS));
    const answer = await answerOf(plan, daoAnswer([proposal({})], true));
    expect(answer.subject).toBeUndefined();
    expect(answer.data).toEqual({
      more: true,
      items: [
        {
          dao: DAO,
          daoName: 'Test',
          id: '4',
          label: 'A4',
          proposalModule: MODULE,
          title: 'Fund the garden',
          status: 'open',
          votingEndsAt: '2026-10-29T12:40:00.000Z',
          proposer: STAKER,
          tally: { yes: '6', no: '1', abstain: '0' },
          totalPower: '10',
        },
      ],
    });
  });

  it('answers not_found for an unknown DAO, no proposals, and an unexpected shape', async () => {
    const plan = planOf(daoProposals, { dao: DAO });
    expect(await failureOf(plan, null)).toEqual({
      ok: false,
      reason: 'not_found',
      detail: 'No DAO with that address is indexed.',
      retryable: false,
    });
    expect((await answerOf(plan, daoAnswer([]))).data).toEqual({ items: [] });
    expect(await failureOf(plan, { address: DAO })).toMatchObject({
      reason: 'unavailable',
    });
    const empty = { pageInfo: { hasNextPage: false }, nodes: [] };
    const mine = planOf(daoProposals, {});
    expect(
      (await answerOf(mine, { native: empty, cw20: empty, cw4: empty })).data,
    ).toEqual({ items: [] });
    expect(await failureOf(mine, null)).toMatchObject({
      reason: 'unavailable',
    });
  });

  it('clips long index strings', async () => {
    const answer = await answerOf(
      planOf(daoProposals, { dao: DAO }, contextOf(NO_ADDRESS)),
      daoAnswer([
        proposal({
          title: long(500, 't'),
          status: long(100, 's'),
          proposer: long(200, 'p'),
        }),
      ]),
    );
    expect(answer.data).toMatchObject({
      items: [
        {
          title: `${long(199, 't')}…`,
          status: `${long(39, 's')}…`,
          proposer: `${long(119, 'p')}…`,
        },
      ],
    });
  });

  describe('daosWithOpenProposals', () => {
    it('reads the memberships once, each DAO core with its description and open proposals', () => {
      const field = planOf(
        daosWithOpenProposals,
        {},
        contextOf(undefined, 3),
      ).field('r0');
      const c = core(3, true, ADDRESS).replace(
        'address name ',
        'address name description ',
      );
      expect(field).toBe(
        planOf(daoProposals, {}, contextOf(undefined, 3))
          .field('r0')
          .replaceAll(core(3, true, ADDRESS), c),
      );
      for (const root of [
        'daoNativeStakers(',
        'daoCw20Stakers(',
        'daoCw4Members(',
      ])
        expect(field.split(root)).toHaveLength(2);
      expect(INDEXED_KINDS).not.toContain(daosWithOpenProposals);
    });

    it('answers the DAOs and the open proposals as the two kinds do', async () => {
      const ctx = contextOf(undefined, 3);
      const both = await answerOf(
        planOf(daosWithOpenProposals, { address: STAKER }, ctx),
        recorded,
      );
      const daoList = await answerOf(
        planOf(daos, { address: STAKER }, ctx),
        recorded,
      );
      const proposals = await answerOf(
        planOf(daoProposals, { address: STAKER }, ctx),
        recorded,
      );
      // The overview leaves out where each DAO takes new proposals (the
      // `daos` kind's proposal lists): it is for what is going on, not for
      // making a proposal.
      const { items, ...rest } = daoList.data as {
        items: Record<string, unknown>[];
      };
      expect(items.every((item) => Array.isArray(item.proposalLists))).toBe(
        true,
      );
      expect(both).toEqual({
        ok: true,
        subject: 'other',
        first: 3,
        data: {
          daos: {
            ...rest,
            items: items.map(
              ({ proposalLists: _lists, moreProposalLists: _more, ...dao }) =>
                dao,
            ),
          },
          proposals: proposals.data,
        },
      });
    });

    it('refuses an unexpected shape', async () => {
      expect(
        await failureOf(planOf(daosWithOpenProposals, {}), { native: null }),
      ).toMatchObject({ reason: 'unavailable' });
    });
  });
});
