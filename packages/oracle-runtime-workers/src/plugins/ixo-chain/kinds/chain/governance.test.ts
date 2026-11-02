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
import passed from './fixtures/gov-passed.json';
import tallyParams from './fixtures/gov-tally-params.json';
import tally from './fixtures/gov-tally.json';
import voting from './fixtures/gov-voting.json';
import stakingPool from './fixtures/staking-pool.json';
import { GOV_TTL_MS, TALLY_RULES_TTL_MS, govProposalsKind } from './governance';

const list = (filter: string, first: number) =>
  `/cosmos/gov/v1/proposals?${filter}pagination.limit=${first}&pagination.reverse=true`;
const VOTING = list('proposal_status=PROPOSAL_STATUS_VOTING_PERIOD&', 10);
/** Another mainnet account (a validator's own). */
const OTHER = 'ixo1qeex565vg4uu7zwudh9ff2dauxptqf72eg6wds';
const tallyPath = (id: string) => `/cosmos/gov/v1/proposals/${id}/tally`;
const votePath = (id: string, voter = MICHAEL) =>
  `/cosmos/gov/v1/proposals/${id}/votes/${voter}`;
/** What mainnet answered for Michael on proposal 506 (he had not voted). */
const NOT_VOTED = reply(400, {
  code: 3,
  message: `voter: ${MICHAEL} not found for proposal: 506`,
  details: [],
});
const PARAMS = '/cosmos/gov/v1/params/tallying';
const POOL = '/cosmos/staking/v1beta1/pool';
/** What deciding a proposal in voting reads besides its tally (recorded mainnet answers). */
const DECIDING = { [PARAMS]: tallyParams, [POOL]: stakingPool };
const ixoCoin = (amount: string, amountBaseUnits: string) => ({
  amount,
  symbol: 'IXO',
  denom: 'uixo',
  amountBaseUnits,
  verified: true,
});
const ZERO = { coin: ixoCoin('0', '0'), percent: '0%' };
const LIVE_TALLY = {
  yes: { coin: ixoCoin('750036.000011', '750036000011'), percent: '100%' },
  no: ZERO,
  abstain: ZERO,
  noWithVeto: ZERO,
  total: ixoCoin('750036.000011', '750036000011'),
  yesShare: '100%',
  vetoShare: '0%',
  // 750,036 of 51,213,697 bonded IXO.
  turnout: '1.46%',
};
const RULES = {
  quorum: '33.4%',
  threshold: '50%',
  vetoThreshold: '33.4%',
  expeditedThreshold: '66.7%',
};

beforeEach(() => {
  resetChainState();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ now: new Date('2026-10-29T12:00:00Z'), toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('gov_proposals', () => {
  it('validates its arguments', () => {
    const ctx = contextOf(chainFetch({}));
    expect(refusal(govProposalsKind, {}, ctx)).toBeNull();
    expect(
      refusal(govProposalsKind, { status: 'all', first: 3 }, ctx),
    ).toBeNull();
    expect(refusal(govProposalsKind, { status: 'open' }, ctx)).toMatch(
      /^Invalid args for kind "gov_proposals" \(status: /,
    );
    expect(refusal(govProposalsKind, { first: 0 }, ctx)).toMatch(/first: /);
    expect(refusal(govProposalsKind, { voter: OTHER }, ctx)).toBeNull();
    expect(refusal(govProposalsKind, { voter: 'ixovaloper1x' }, ctx)).toBe(
      'address must be an ixo1… address or a did:ixo:ixo1… DID.',
    );
  });

  it("reads proposals in voting with the live tally and the user's not-voted answer (recorded mainnet answers)", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = chainFetch({
      [VOTING]: voting,
      [tallyPath('506')]: tally,
      [votePath('506')]: NOT_VOTED,
      ...DECIDING,
    });
    const result = await run(govProposalsKind, {}, contextOf(fetcher));
    expect(pathsOf(fetcher).sort()).toEqual(
      [VOTING, tallyPath('506'), votePath('506'), PARAMS, POOL].sort(),
    );
    // "Not voted" is an answer: neither retried nor logged.
    expect(warn).not.toHaveBeenCalled();
    const proposal = voting.proposals[0];
    expect(result).toEqual({
      ok: true,
      subject: 'user',
      first: 10,
      data: {
        status: 'voting',
        more: false,
        proposals: [
          {
            id: '506',
            title:
              'Signal support for x/usdcmigration in a future ixo (Impacthub) software upgrade (Noble USDC wind-down)',
            summary: `${proposal?.summary.slice(0, 239)}…`,
            status: 'voting',
            messages: [],
            submittedAt: '2026-10-26T16:36:01.734241053Z',
            votingEndsAt: '2026-10-31T16:36:01.734241053Z',
            tally: LIVE_TALLY,
            tallyLive: true,
            // Turnout 1.46% is below the 33.4% quorum.
            passingNow: false,
            notVoted: true,
          },
        ],
        tallyRules: RULES,
      },
    });
  });

  it("decides `passingNow` by the chain's rule: quorum, all abstaining, veto, then threshold", async () => {
    const BONDED = '1000000';
    const decide = async (
      counts: { yes?: string; no?: string; abstain?: string; veto?: string },
      expedited = false,
    ) => {
      resetChainState();
      const result = await run(
        govProposalsKind,
        {},
        contextOf(
          chainFetch({
            [VOTING]: {
              ...voting,
              proposals: [{ ...voting.proposals[0], expedited }],
            },
            [tallyPath('506')]: {
              tally: {
                yes_count: counts.yes ?? '0',
                abstain_count: counts.abstain ?? '0',
                no_count: counts.no ?? '0',
                no_with_veto_count: counts.veto ?? '0',
              },
            },
            [votePath('506')]: NOT_VOTED,
            [PARAMS]: tallyParams,
            [POOL]: { pool: { not_bonded_tokens: '0', bonded_tokens: BONDED } },
          }),
        ),
      );
      if (!result.ok) throw new Error(result.detail);
      return result.data;
    };
    const passing = (value: boolean) => ({
      proposals: [{ passingNow: value }],
    });
    expect(await decide({ yes: '600000', no: '400000' })).toMatchObject(
      passing(true),
    );
    // Exactly the quorum is enough (the chain fails only below it) …
    expect(await decide({ yes: '334000' })).toMatchObject(passing(true));
    // … one uixo less is not.
    expect(await decide({ yes: '333999' })).toMatchObject(passing(false));
    // Everyone abstaining fails.
    expect(await decide({ abstain: '500000' })).toMatchObject(passing(false));
    // Veto above 33.4% of all votes fails, whatever the yes share.
    expect(await decide({ yes: '660000', veto: '340000' })).toMatchObject(
      passing(false),
    );
    // Abstain counts toward turnout, not toward the yes share.
    expect(
      await decide({ yes: '200000', no: '100000', abstain: '400000' }),
    ).toMatchObject({
      proposals: [
        { passingNow: true, tally: { yesShare: '66.66%', turnout: '70%' } },
      ],
    });
    // Yes must be above the threshold: exactly half fails.
    expect(await decide({ yes: '500000', no: '500000' })).toMatchObject(
      passing(false),
    );
    // An expedited proposal needs 66.7%.
    expect(await decide({ yes: '600000', no: '400000' }, true)).toMatchObject({
      proposals: [{ expedited: true, passingNow: false }],
    });
    expect(await decide({ yes: '700000', no: '300000' }, true)).toMatchObject({
      proposals: [{ expedited: true, passingNow: true }],
    });
  });

  it('says nothing of passing when the rules or the bonded total cannot be read', async () => {
    for (const broken of [PARAMS, POOL]) {
      resetChainState();
      const result = await run(
        govProposalsKind,
        {},
        contextOf(
          chainFetch({
            [VOTING]: voting,
            [tallyPath('506')]: tally,
            [votePath('506')]: NOT_VOTED,
            ...DECIDING,
            [broken]: reply(500),
          }),
        ),
      );
      expect(result).toMatchObject({
        ok: true,
        data: { proposals: [{ tally: { yesShare: '100%' }, notVoted: true }] },
      });
      expect(JSON.stringify(result)).not.toContain('passingNow');
    }
  });

  it('keeps the list, the tallies and the rules per isolate for every user; reads each vote every time', async () => {
    const fetcher = chainFetch({
      [VOTING]: voting,
      [tallyPath('506')]: tally,
      [votePath('506')]: NOT_VOTED,
      [votePath('506', OTHER)]: NOT_VOTED,
      ...DECIDING,
    });
    const count = (path: string) =>
      pathsOf(fetcher).filter((seen) => seen === path).length;
    await run(govProposalsKind, {}, contextOf(fetcher));
    await run(govProposalsKind, {}, contextOf(fetcher, { address: OTHER }));
    expect([VOTING, tallyPath('506'), PARAMS, POOL].map(count)).toEqual([
      1, 1, 1, 1,
    ]);
    expect([votePath('506'), votePath('506', OTHER)].map(count)).toEqual([
      1, 1,
    ]);
    vi.setSystemTime(Date.now() + GOV_TTL_MS + 1);
    await run(govProposalsKind, {}, contextOf(fetcher));
    expect([VOTING, tallyPath('506'), PARAMS, POOL].map(count)).toEqual([
      2, 2, 1, 2,
    ]);
    vi.setSystemTime(Date.now() + TALLY_RULES_TTL_MS);
    await run(govProposalsKind, {}, contextOf(fetcher));
    expect(count(PARAMS)).toBe(2);
    expect(count(votePath('506'))).toBe(3);
  });

  it('reads no rules or bonded total when no proposal is in voting', async () => {
    const path = list('proposal_status=PROPOSAL_STATUS_PASSED&', 2);
    const fetcher = chainFetch({ [path]: passed });
    await run(
      govProposalsKind,
      { status: 'passed' },
      contextOf(fetcher, { first: 2 }),
    );
    expect(pathsOf(fetcher)).toEqual([path]);
  });

  it('shows the vote of a user who voted, and says when the vote or tally could not be read', async () => {
    const voted = await run(
      govProposalsKind,
      {},
      contextOf(
        chainFetch({
          [VOTING]: voting,
          [tallyPath('506')]: tally,
          ...DECIDING,
          [votePath('506')]: {
            vote: {
              proposal_id: '506',
              voter: MICHAEL,
              options: [
                { option: 'VOTE_OPTION_YES', weight: '0.700000000000000000' },
                {
                  option: 'VOTE_OPTION_ABSTAIN',
                  weight: '0.300000000000000000',
                },
              ],
              metadata: '',
            },
          },
        }),
      ),
    );
    expect(voted.ok && voted.data).toMatchObject({
      proposals: [
        {
          yourVote: [
            { option: 'yes', weight: '70%' },
            { option: 'abstain', weight: '30%' },
          ],
        },
      ],
    });
    // gRPC NotFound (a 404) is "not voted" too.
    resetChainState();
    const notFound = await run(
      govProposalsKind,
      {},
      contextOf(
        chainFetch({
          [VOTING]: voting,
          [tallyPath('506')]: tally,
          [votePath('506')]: reply(404, { code: 5 }),
        }),
      ),
    );
    expect(notFound.ok && notFound.data).toMatchObject({
      proposals: [{ notVoted: true }],
    });
    resetChainState();
    const broken = await run(
      govProposalsKind,
      {},
      contextOf(
        chainFetch({
          [VOTING]: voting,
          [tallyPath('506')]: reply(500),
          [votePath('506')]: reply(500),
          ...DECIDING,
        }),
      ),
    );
    expect(broken.ok && broken.data).toMatchObject({
      proposals: [{ tallyUnavailable: true, voteUnavailable: true }],
    });
    expect(JSON.stringify(broken)).not.toContain('notVoted');
    // A 400 without gRPC InvalidArgument or NotFound is a failure, not "not voted".
    resetChainState();
    const odd = await run(
      govProposalsKind,
      {},
      contextOf(
        chainFetch({
          [VOTING]: voting,
          [tallyPath('506')]: tally,
          [votePath('506')]: reply(400, { code: 13, message: 'internal' }),
          ...DECIDING,
        }),
      ),
    );
    expect(odd.ok && odd.data).toMatchObject({
      proposals: [{ voteUnavailable: true }],
    });
    expect(JSON.stringify(odd)).not.toContain('notVoted');
  });

  it("reads another voter's vote and says whose it is", async () => {
    const fetcher = chainFetch({
      [VOTING]: voting,
      [tallyPath('506')]: tally,
      [votePath('506', OTHER)]: NOT_VOTED,
      ...DECIDING,
    });
    const result = await run(
      govProposalsKind,
      { voter: `did:ixo:${OTHER}` },
      contextOf(fetcher),
    );
    expect(pathsOf(fetcher)).toContain(votePath('506', OTHER));
    expect(pathsOf(fetcher)).not.toContain(votePath('506'));
    expect(result).toMatchObject({
      ok: true,
      subject: 'other',
      data: { proposals: [{ notVoted: true }] },
    });
  });

  it('reads no votes for a user without an account', async () => {
    const fetcher = chainFetch({
      [VOTING]: voting,
      [tallyPath('506')]: tally,
      ...DECIDING,
    });
    const result = await run(
      govProposalsKind,
      {},
      contextOf(fetcher, { address: null }),
    );
    expect(pathsOf(fetcher).sort()).toEqual(
      [VOTING, tallyPath('506'), PARAMS, POOL].sort(),
    );
    expect(JSON.stringify(result)).not.toMatch(/yourVote|notVoted/);
  });

  it('shows closed proposals with their final tally and what they execute, without further reads (recorded mainnet answer)', async () => {
    const path = list('proposal_status=PROPOSAL_STATUS_PASSED&', 2);
    const fetcher = chainFetch({ [path]: passed });
    const result = await run(
      govProposalsKind,
      { status: 'passed' },
      contextOf(fetcher, { first: 2 }),
    );
    expect(pathsOf(fetcher)).toEqual([path]);
    // A final tally has no turnout: the bonded total then is not known.
    const final = {
      yes: {
        coin: ixoCoin('40567456.716924', '40567456716924'),
        percent: '100%',
      },
      no: ZERO,
      abstain: ZERO,
      noWithVeto: ZERO,
      total: ixoCoin('40567456.716924', '40567456716924'),
      yesShare: '100%',
      vetoShare: '0%',
    };
    expect(result).toMatchObject({
      ok: true,
      first: 2,
      data: {
        status: 'passed',
        more: true,
        proposals: [
          {
            id: '505',
            title: 'Create the PAY Liquid Staking Pool',
            status: 'passed',
            messages: ['MsgCreatePool'],
            votingEndsAt: '2026-08-03T14:20:16.490715076Z',
            tally: final,
          },
          {
            id: '504',
            status: 'passed',
            messages: ['MsgStoreCode'],
            tally: final,
          },
        ],
      },
    });
    // The wasm a MsgStoreCode carries never reaches the answer.
    expect(JSON.stringify(result)).not.toContain('wasm_byte_code');
  });

  it('reads every status with `all`, caps the rows at 10 and the per-proposal reads with them', async () => {
    const proposals = Array.from({ length: 12 }, (_, index) => ({
      ...voting.proposals[0],
      id: String(600 + index),
    }));
    const routes: Record<string, unknown> = {
      [list('', 10)]: { proposals, pagination: { next_key: 'x' } },
      ...DECIDING,
    };
    for (const { id } of proposals) {
      routes[tallyPath(id)] = tally;
      routes[votePath(id)] = NOT_VOTED;
    }
    const fetcher = chainFetch(routes);
    const result = await run(
      govProposalsKind,
      { status: 'all' },
      contextOf(fetcher, { first: 20 }),
    );
    expect(result).toMatchObject({ ok: true, first: 10 });
    expect(result.ok && result.data).toMatchObject({ more: true });
    expect(pathsOf(fetcher)[0]).toBe(list('', 10));
    // One list read, the rules and the bonded total once, and two reads
    // for each of the 10 proposals kept.
    expect(pathsOf(fetcher)).toHaveLength(1 + 2 + 2 * 10);
  });

  it('shows a proposal in its deposit period with the deposit so far', async () => {
    const path = list('proposal_status=PROPOSAL_STATUS_DEPOSIT_PERIOD&', 10);
    const proposal = {
      ...voting.proposals[0],
      status: 'PROPOSAL_STATUS_DEPOSIT_PERIOD',
      voting_start_time: null,
      voting_end_time: null,
    };
    const result = await run(
      govProposalsKind,
      { status: 'deposit' },
      contextOf(chainFetch({ [path]: { proposals: [proposal] } })),
    );
    expect(result.ok && result.data).toMatchObject({
      proposals: [
        {
          status: 'deposit',
          depositEndsAt: '2026-10-28T16:36:01.734241053Z',
          deposit: [
            {
              amount: '10000',
              symbol: 'IXO',
              denom: 'uixo',
              amountBaseUnits: '10000000000',
              verified: true,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('tally');
  });

  it('reads a list larger than the default REST cap (proposals carry contract wasm)', async () => {
    const big = {
      proposals: [
        {
          ...passed.proposals[1],
          messages: [
            {
              '@type': '/cosmwasm.wasm.v1.MsgStoreCode',
              wasm_byte_code: 'A'.repeat(700 * 1024),
            },
          ],
        },
      ],
    };
    const path = list('proposal_status=PROPOSAL_STATUS_PASSED&', 10);
    const result = await run(
      govProposalsKind,
      { status: 'passed' },
      contextOf(chainFetch({ [path]: big })),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('answers no proposals with an empty list, and passes a list failure through', async () => {
    expect(
      await run(
        govProposalsKind,
        {},
        contextOf(
          chainFetch({ [VOTING]: { proposals: [], pagination: null } }),
        ),
      ),
    ).toEqual({
      ok: true,
      subject: 'user',
      first: 10,
      data: { status: 'voting', proposals: [], more: false },
    });
    // The empty list is kept for 60 s like any answer; a failure never is.
    resetChainState();
    const broken = chainFetch({ [VOTING]: reply(500) });
    for (let n = 0; n < 2; n++)
      expect(await run(govProposalsKind, {}, contextOf(broken))).toEqual(
        HTTP_500_FAILURE,
      );
    expect(broken).toHaveBeenCalledTimes(2);
  });
});
