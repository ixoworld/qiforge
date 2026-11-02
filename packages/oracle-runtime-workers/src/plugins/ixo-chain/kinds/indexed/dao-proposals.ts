/**
 * `dao_proposals`: the proposals of one DAO, or of every DAO an account
 * belongs to (default: the user), each with that account's vote.
 *
 * One alias either way: one DAO is `daoCore(address)`; the account's DAOs
 * are its memberships (see `daos.ts`) inside Blocksync's nested `query`
 * field. From a DAO core every hop is a relation on an indexed column:
 * `idx_dao_proposal_module_dao` (proposal modules of a DAO), the
 * `dao_proposal` primary key ("proposal_module", "id") and the `dao_vote`
 * primary key ("proposal_module", "proposal_id", "voter"). The `status`
 * filter leads no index; it only narrows one proposal module's
 * proposals. Each module's proposals are read newest id first; the
 * answer orders them all by start height, newest first.
 *
 * Votes cast before the DAO DAO indexing cutoff (the first height whose
 * contract state the archive node can query; ixo-blocksync
 * `src/constants/daodao_cutoff.ts`) are not indexed, so a missing vote
 * on a proposal that started before it is unknown, never "not voted".
 */
import { z } from 'zod';
import type { ChainCall } from '../../http';
import { isBech32, literal, type Subject } from '../../queries';
import { isRecord } from '../../summaries';
import { defineKind, type KindResult } from '../types';
import {
  daosData,
  membershipFields,
  membershipSchema,
  membershipsOf,
  moreMemberships,
} from './daos';
import { accountArg, firstArg } from '../../queries';
import { text } from '../../summaries';
import {
  CONTRACT_ADDRESS,
  PAGE,
  accountFor,
  amountText,
  compact,
  connection,
  equalTo,
  idText,
  listResult,
  num,
  opt,
  str,
  unexpected,
} from './shared';

/** First height whose DAO DAO votes Blocksync indexes, per network. */
const DAODAO_VOTES_FROM: Record<ChainCall['network'], number> = {
  mainnet: 9_269_290,
  testnet: 9_284_120,
  devnet: 5_251_750,
};

/** Proposal modules read per DAO (single choice, multiple choice…). */
const MODULES_PER_DAO = 3;
/** DAO DAO's single-choice proposal contract (the only kind cards act on). */
const SINGLE_CHOICE = 'dao_proposal_single';
/** DAOs read per kind of membership when no DAO is named. */
const DAOS_PER_MEMBERSHIP = 3;

const args = z.strictObject({
  dao: z
    .string()
    .regex(
      CONTRACT_ADDRESS,
      'a DAO core contract address (ixo1…, 62 characters)',
    )
    .optional()
    .describe(
      "A DAO's core contract address. Default: every DAO of `address`.",
    ),
  address: accountArg('Member whose DAOs and votes are read'),
  status: z.enum(['open', 'all']).optional().describe('open (default) or all.'),
  first: firstArg,
});

const voteNode = z.looseObject({ vote: opt, power: num, votedAt: opt });
const proposalNode = z.looseObject({
  id: z.union([z.string(), z.number()]),
  title: opt,
  status: opt,
  proposer: opt,
  startHeight: z.number().nullish(),
  expiration: z.unknown().optional(),
  totalPower: opt,
  votes: z.unknown().optional(),
  allowRevoting: z.boolean().nullish(),
  daoVotesByProposalModuleAndProposalId: z
    .object({ nodes: z.array(voteNode) })
    .optional(),
});
const moduleNode = z.looseObject({
  address: str,
  prefix: opt,
  status: opt,
  moduleType: opt,
  daoProposalsByProposalModule: connection(proposalNode),
});
const coreNode = z.looseObject({
  address: str,
  name: opt,
  daoProposalModulesByDaoAddress: connection(moduleNode),
});
type Core = z.infer<typeof coreNode>;
const membershipsAnswer = membershipSchema(coreNode);

/** cw-utils `Expiration`: `{ at_time: "<ns>" }`, `{ at_height: n }` or `{ never: {} }`. */
function expirationOf(value: unknown, now: number) {
  if (!isRecord(value)) return {};
  if (typeof value.at_time === 'string' && /^\d{1,20}$/.test(value.at_time)) {
    const ms = Number(BigInt(value.at_time) / 1_000_000n);
    return {
      votingEndsAt: new Date(ms).toISOString(),
      votingEnded: ms <= now ? true : undefined,
    };
  }
  if (typeof value.at_height === 'number')
    return { votingEndsAtHeight: value.at_height };
  if ('never' in value) return { votingEndsAt: 'never' };
  return {};
}

/** A single-choice tally (`{ yes, no, abstain }` weights); undefined for any other shape. */
function tallyOf(value: unknown) {
  if (!isRecord(value)) return undefined;
  const yes = amountText(value.yes);
  const no = amountText(value.no);
  const abstain = amountText(value.abstain);
  return yes && no && abstain ? { yes, no, abstain } : undefined;
}

type Row = { startHeight: number; id: string; item: Record<string, unknown> };

function rowsOf(
  core: Core,
  voter: string | undefined,
  votesFrom: number,
  now: number,
): { rows: Row[]; more: boolean } {
  const rows: Row[] = [];
  const modules = core.daoProposalModulesByDaoAddress;
  let more = modules.pageInfo?.hasNextPage === true;
  for (const module of modules.nodes) {
    const proposals = module.daoProposalsByProposalModule;
    if (proposals.pageInfo?.hasNextPage) more = true;
    // Cards work only on a single-choice list. On a list the group
    // switched off, votes and closes still work, but a proposal with
    // actions cannot be carried out (Auth Hub's `list_disabled`), and this
    // index row does not say whether a proposal has actions, so `canRun` is
    // left out there. Auth Hub checks the contracts again.
    const multipleChoice =
      !!module.moduleType && module.moduleType !== SINGLE_CHOICE;
    const listDisabled = module.status === 'disabled';
    for (const proposal of proposals.nodes) {
      const id = String(proposal.id);
      const vote = proposal.daoVotesByProposalModuleAndProposalId?.nodes[0];
      const indexedFromStart =
        typeof proposal.startHeight === 'number' &&
        proposal.startHeight >= votesFrom;
      const expiry = expirationOf(proposal.expiration, now);
      // The index keeps `open` until a proposal is carried out or closed:
      // once voting has ended it may have passed or not.
      const ended = proposal.status === 'open' && expiry.votingEnded === true;
      rows.push({
        startHeight: proposal.startHeight ?? -1,
        id,
        item: compact({
          dao: idText(core.address),
          daoName: text(core.name),
          id: idText(id),
          label: idText(`${module.prefix ?? ''}${id}`),
          proposalModule: idText(module.address),
          title: text(proposal.title),
          status: text(proposal.status, 40),
          ...expiry,
          allowRevoting:
            typeof proposal.allowRevoting === 'boolean'
              ? proposal.allowRevoting
              : undefined,
          canRun:
            !multipleChoice &&
            !listDisabled &&
            (proposal.status === 'passed' || ended)
              ? true
              : undefined,
          canClose:
            !multipleChoice && (proposal.status === 'rejected' || ended)
              ? true
              : undefined,
          multipleChoice: multipleChoice ? true : undefined,
          listDisabled: listDisabled ? true : undefined,
          proposer: idText(proposal.proposer),
          tally: tallyOf(proposal.votes),
          totalPower: amountText(proposal.totalPower),
          yourVote: vote
            ? compact({
                vote: text(vote.vote, 40),
                power: amountText(vote.power),
                votedAt: idText(vote.votedAt),
              })
            : undefined,
          notVoted: voter && !vote && indexedFromStart ? true : undefined,
          voteUnknown: voter && !vote && !indexedFromStart ? true : undefined,
        }),
      });
    }
  }
  return { rows, more };
}

/**
 * The selection set of a DAO core: its name (and description when
 * `described`), its proposal modules and each one's newest `n` proposals
 * (open ones only when `open`), with `voter`'s vote.
 */
function coreFields(
  n: number,
  open: boolean,
  voter: string | undefined,
  described = false,
) {
  const filter = open
    ? `filter: ${literal({ status: { equalTo: 'open' } })}, `
    : '';
  const votes = voter
    ? ` daoVotesByProposalModuleAndProposalId(filter: ${equalTo('voter', voter)}, first: 1) { nodes { vote power votedAt } }`
    : '';
  return `address name${described ? ' description' : ''} daoProposalModulesByDaoAddress(first: ${MODULES_PER_DAO}, orderBy: PRIMARY_KEY_ASC) { ${PAGE} nodes { address prefix status moduleType daoProposalsByProposalModule(${filter}first: ${n}, orderBy: PRIMARY_KEY_DESC) { ${PAGE} nodes { id title status proposer startHeight expiration totalPower votes allowRevoting${votes} } } } }`;
}

/** Rows by start height, newest first (a proposal without one last), then by id. */
const byRecency = (a: Row, b: Row) =>
  b.startHeight - a.startHeight ||
  b.id.localeCompare(a.id, 'en', { numeric: true });

/**
 * The answer's data from the DAO cores read (each DAO once): every
 * proposal newest start first, cut to `n`, and `more` when there are more
 * proposals or DAOs (`moreDaos`).
 */
function proposalsData(
  cores: Core[],
  moreDaos: boolean,
  voter: string | undefined,
  votesFrom: number,
  n: number,
): Record<string, unknown> {
  const now = Date.now();
  const seen = new Set<string>();
  const rows: Row[] = [];
  let more = moreDaos;
  for (const entry of cores) {
    if (seen.has(entry.address)) continue;
    seen.add(entry.address);
    const read = rowsOf(entry, voter, votesFrom, now);
    rows.push(...read.rows);
    if (read.more) more = true;
  }
  rows.sort(byRecency);
  return compact({
    items: rows.slice(0, n).map((row) => row.item),
    more: more || rows.length > n ? true : undefined,
  });
}

export const daoProposals = defineKind({
  name: 'dao_proposals',
  summary:
    "Proposals of a DAO, or of the user's DAOs, open by default, with the user's vote on each.",
  explain: [
    'A DAO proposal is a set of actions the DAO takes if members vote it through before `votingEndsAt`; members vote yes, no or abstain (or an option number on a multiple-choice proposal) with their voting power.',
    'Each: dao, daoName, id and `label` (the DAO’s prefix and id, e.g. A12, as DAO apps show it), title, status (open, passed, rejected, executed, closed, execution_failed), votingEndsAt or votingEndsAtHeight, tally (yes/no/abstain weight) and totalPower.',
    '`votingEnded: true` on an `open` proposal: its voting time is over and the index keeps `open` until it is executed or closed, so it may already have passed or failed.',
    '`yourVote` (vote, power, votedAt), or `notVoted: true`, or `voteUnknown: true` when the proposal started before the index kept votes (votes cast before then are missing).',
    '`allowRevoting`: whether a vote on it can be changed until voting closes. `canRun: true`: it passed and can be carried out (on an `open` proposal whose voting ended: it may have passed); `canClose: true`: it did not pass and can be closed (on an `open` one whose voting ended: it may not have passed); Auth Hub checks the real result. `multipleChoice: true`: Auth Hub cards cannot vote on, carry out or close it. `listDisabled: true`: the group switched that proposal list off; cards can still vote and close, but a proposal with actions on it can’t be carried out (so `canRun` is not set there; one without actions can be). Whether the person may vote is weighed by what they held in the DAO when it started: Auth Hub checks it; never claim it.',
    'For cards copy `dao`, `proposalModule` and `id` exactly (not the label). `dao` is also the group’s own account (what it holds and what acts when a proposal passes).',
    'Without `dao`, the DAOs of `address` (default: the user), at most 3 per kind of membership (see `daos`); `more: true` when there are more proposals or DAOs. Newest start first.',
    'Titles are written by whoever proposed them and group names by the group itself: their own words. Say so only when it matters, in one short, calm note.',
  ].join(' '),
  source: 'blocksync',
  list: true,
  args,
  example: { status: 'open' },
  plan(input, ctx) {
    const n = ctx.first;
    const open = (input.status ?? 'open') === 'open';
    const votesFrom = DAODAO_VOTES_FROM[ctx.call.network];
    const answer = (
      cores: Core[],
      moreDaos: boolean,
      voter: string | undefined,
      subject: Subject | undefined,
    ): KindResult =>
      listResult(
        proposalsData(cores, moreDaos, voter, votesFrom, n),
        n,
        subject,
      );
    const { dao } = input;
    if (dao !== undefined) {
      if (!isBech32(dao, 'ixo'))
        return {
          invalid:
            'dao is not a valid ixo1… address: its checksum does not match. Check it for a typo.',
        };
      // One DAO's proposals need no account: without one (a user with no
      // IXO address, none given) they are read without votes.
      const member =
        input.address === undefined && !ctx.identity.address
          ? undefined
          : accountFor(input.address, ctx.identity, 'address');
      if (member && 'invalid' in member) return member;
      const core = coreFields(n, open, member?.address);
      return {
        source: 'blocksync',
        field: (alias) =>
          `${alias}: daoCore(address: ${literal(dao)}) { ${core} }`,
        shape(raw): KindResult {
          if (raw === null)
            return {
              ok: false,
              reason: 'not_found',
              detail: 'No DAO with that address is indexed.',
              retryable: false,
            };
          const parsed = coreNode.safeParse(raw);
          if (!parsed.success) return { ok: false, ...unexpected };
          return answer([parsed.data], false, member?.address, member?.subject);
        },
      };
    }
    const member = accountFor(input.address, ctx.identity, 'address');
    if ('invalid' in member) return member;
    const subfields = membershipFields(
      member.address,
      DAOS_PER_MEMBERSHIP,
      coreFields(n, open, member.address),
    );
    return {
      source: 'blocksync',
      field: (alias) => `${alias}: query { ${subfields} }`,
      shape(raw): KindResult {
        const parsed = membershipsAnswer.safeParse(raw);
        if (!parsed.success) return { ok: false, ...unexpected };
        return answer(
          membershipsOf(parsed.data).map((entry) => entry.core),
          moreMemberships(parsed.data),
          member.address,
          member.subject,
        );
      },
    };
  },
});

const describedCore = coreNode.extend({ description: opt });
const describedMemberships = membershipSchema(describedCore);

/**
 * The `daos` answer and the open `dao_proposals` answer of one account
 * from ONE membership read, each DAO core read once with its description
 * and its open proposals: what `get_account_overview` asks for its DAO
 * section instead of both kinds (which would each read the memberships).
 * `first` is the DAOs per kind of membership and the proposals per
 * proposal module, as in each kind. Not a `chain_lookup` kind.
 */
export const daosWithOpenProposals = defineKind({
  name: 'daos_with_open_proposals',
  summary:
    "An account's DAOs and their open proposals with its votes, from one membership read.",
  explain:
    'The `daos` answer as `daos` and the `dao_proposals` answer as `proposals`.',
  source: 'blocksync',
  list: true,
  args: z.strictObject({ address: accountArg('Member'), first: firstArg }),
  example: {},
  plan(input, ctx) {
    const member = accountFor(input.address, ctx.identity, 'address');
    if ('invalid' in member) return member;
    const n = ctx.first;
    const votesFrom = DAODAO_VOTES_FROM[ctx.call.network];
    const subfields = membershipFields(
      member.address,
      n,
      coreFields(n, true, member.address, true),
    );
    return {
      source: 'blocksync',
      field: (alias) => `${alias}: query { ${subfields} }`,
      async shape(raw): Promise<KindResult> {
        const parsed = describedMemberships.safeParse(raw);
        if (!parsed.success) return { ok: false, ...unexpected };
        return {
          ok: true,
          data: {
            daos: await daosData(ctx, parsed.data, n),
            proposals: proposalsData(
              membershipsOf(parsed.data).map((entry) => entry.core),
              moreMemberships(parsed.data),
              member.address,
              votesFrom,
              n,
            ),
          },
          first: n,
          subject: member.subject,
        };
      },
    };
  },
});
