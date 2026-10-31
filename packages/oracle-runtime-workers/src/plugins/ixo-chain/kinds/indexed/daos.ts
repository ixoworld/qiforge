/**
 * `daos`: the DAO DAO DAOs an account belongs to, through each kind of
 * membership the index keeps: native-token staking, cw20 staking and cw4
 * group membership, as one alias holding one sub-field per kind of
 * membership (Blocksync's `query` field nests the root query type). Each
 * reaches its DAO through relations, so one document answers it.
 *
 * Index (ixo-blocksync main, `20250611142429900_daodao_epochs.sql`):
 * `idx_dao_native_staker_address`, `idx_dao_cw20_staker_address` and
 * `idx_dao_cw4_member_address` serve the account; the voting module is a
 * primary key, `idx_dao_voting_module_staking_contract` serves cw20,
 * `idx_dao_core_voting_module` the DAO. A cw4 group's voting modules are
 * found by `dao_voting_module.group_contract_address`, which no index
 * leads; that table holds one row per DAO, and a member of three groups
 * answered in 0.27 s on mainnet on Oct 29 2026. cw721 (NFT) staking is not read.
 * Each list is ordered by its primary key (voting module or contract
 * address). The `daos` kind also reads each DAO's first three proposal
 * lists (`idx_dao_proposal_module_dao`) with their intake (a primary key),
 * for new proposals.
 */
import { z } from 'zod';
import { displayCoin } from '../coins';
import { defineKind, type KindContext, type KindResult } from '../types';
import { accountArg, firstArg } from '../../queries';
import { isRecord, text } from '../../summaries';
import {
  PAGE,
  accountFor,
  amountText,
  chainCoin,
  compact,
  connection,
  equalTo,
  idText,
  listResult,
  longText,
  nonEmpty,
  num,
  opt,
  str,
  unexpected,
} from './shared';

/** Voting modules read per cw4 group or cw20 staking contract (several DAOs can share one). */
const MODULES_PER_CONTRACT = 3;

const args = z.strictObject({
  address: accountArg('Member'),
  first: firstArg,
});

/**
 * The membership sub-fields of `address`, `perList` rows each, with
 * `core` as the selection set of each DAO core reached.
 */
export function membershipFields(
  address: string,
  perList: number,
  core: string,
): string {
  const cores = `daoCoresByVotingModule(first: 1) { nodes { ${core} } }`;
  const staker = equalTo('stakerAddress', address);
  const member = equalTo('memberAddress', address);
  const modules = (relation: string, fields: string) =>
    `${relation}(first: ${MODULES_PER_CONTRACT}) { nodes { ${fields} ${cores} } }`;
  return [
    `native: daoNativeStakers(filter: ${staker}, first: ${perList}, orderBy: PRIMARY_KEY_ASC) { ${PAGE} nodes { stakedAmount daoVotingModuleByVotingModuleAddress { address moduleType nativeDenom totalWeight ${cores} } } }`,
    `cw20: daoCw20Stakers(filter: ${staker}, first: ${perList}, orderBy: PRIMARY_KEY_ASC) { ${PAGE} nodes { stakedAmount daoCw20StakingContractByStakingContract { ${modules('daoVotingModulesByStakingContract', 'address moduleType tokenAddress totalWeight')} } } }`,
    `cw4: daoCw4Members(filter: ${member}, first: ${perList}, orderBy: PRIMARY_KEY_ASC) { ${PAGE} nodes { weight daoCw4GroupContractByGroupContractAddress { ${modules('daoVotingModulesByGroupContractAddress', 'address moduleType totalWeight')} } } }`,
  ].join(' ');
}

const moduleNode = <T extends z.ZodType>(core: T) =>
  z.looseObject({
    address: str,
    moduleType: opt,
    nativeDenom: opt,
    tokenAddress: opt,
    totalWeight: num,
    daoCoresByVotingModule: z.object({ nodes: z.array(core) }),
  });

/** The answer of {@link membershipFields} with `core` as each DAO core's shape. */
export function membershipSchema<T extends z.ZodType>(core: T) {
  const module = moduleNode(core);
  const modules = z.object({ nodes: z.array(module) });
  return z.looseObject({
    native: connection(
      z.looseObject({
        stakedAmount: num,
        daoVotingModuleByVotingModuleAddress: module.nullish(),
      }),
    ),
    cw20: connection(
      z.looseObject({
        stakedAmount: num,
        daoCw20StakingContractByStakingContract: z
          .looseObject({ daoVotingModulesByStakingContract: modules })
          .nullish(),
      }),
    ),
    cw4: connection(
      z.looseObject({
        weight: z.number().nullish(),
        daoCw4GroupContractByGroupContractAddress: z
          .looseObject({ daoVotingModulesByGroupContractAddress: modules })
          .nullish(),
      }),
    ),
  });
}

/** One DAO reached through one membership. */
interface Membership<C> {
  core: C;
  membership: 'native-staked' | 'cw20-staked' | 'cw4-member';
  votingModule: string;
  moduleType?: string;
  /** Staked base units (native or cw20), or the cw4 weight. */
  weight?: string;
  nativeDenom?: string;
  tokenAddress?: string;
  totalWeight?: string;
}

type Page = { pageInfo?: { hasNextPage: boolean } };
type Amount = string | number | null | undefined;
interface ModuleRow<C> {
  address: string;
  moduleType?: string | null;
  nativeDenom?: string | null;
  tokenAddress?: string | null;
  totalWeight?: Amount;
  daoCoresByVotingModule: { nodes: C[] };
}
/** The parsed answer of {@link membershipFields} (see {@link membershipSchema}). */
export interface MembershipRows<C> {
  native: Page & {
    nodes: {
      stakedAmount?: Amount;
      daoVotingModuleByVotingModuleAddress?: ModuleRow<C> | null;
    }[];
  };
  cw20: Page & {
    nodes: {
      stakedAmount?: Amount;
      daoCw20StakingContractByStakingContract?: {
        daoVotingModulesByStakingContract: { nodes: ModuleRow<C>[] };
      } | null;
    }[];
  };
  cw4: Page & {
    nodes: {
      weight?: number | null;
      daoCw4GroupContractByGroupContractAddress?: {
        daoVotingModulesByGroupContractAddress: { nodes: ModuleRow<C>[] };
      } | null;
    }[];
  };
}

/** Every DAO the memberships reach, native stakes first, then cw20 stakes, then cw4 groups. */
export function membershipsOf<C>(answer: MembershipRows<C>): Membership<C>[] {
  const out: Membership<C>[] = [];
  const add = (
    membership: Membership<C>['membership'],
    module: ModuleRow<C>,
    weight: Amount,
  ) => {
    for (const core of module.daoCoresByVotingModule.nodes)
      out.push({
        core,
        membership,
        votingModule: module.address,
        moduleType: module.moduleType ?? undefined,
        weight: amountText(weight),
        nativeDenom: module.nativeDenom ?? undefined,
        tokenAddress: module.tokenAddress ?? undefined,
        totalWeight: amountText(module.totalWeight),
      });
  };
  for (const row of answer.native.nodes)
    if (row.daoVotingModuleByVotingModuleAddress)
      add(
        'native-staked',
        row.daoVotingModuleByVotingModuleAddress,
        row.stakedAmount,
      );
  for (const row of answer.cw20.nodes)
    for (const module of row.daoCw20StakingContractByStakingContract
      ?.daoVotingModulesByStakingContract.nodes ?? [])
      add('cw20-staked', module, row.stakedAmount);
  for (const row of answer.cw4.nodes)
    for (const module of row.daoCw4GroupContractByGroupContractAddress
      ?.daoVotingModulesByGroupContractAddress.nodes ?? [])
      add('cw4-member', module, row.weight);
  return out;
}

/** Whether any membership list holds rows past those read. */
export function moreMemberships<C>(answer: MembershipRows<C>): boolean {
  return [answer.native, answer.cw20, answer.cw4].some(
    (list) => list.pageInfo?.hasNextPage === true,
  );
}

const DIGITS = /^\d+$/;

/** `part / whole` as a percentage with two decimals, rounded down; undefined unless both are whole numbers. */
function shareOf(part?: string, whole?: string): string | undefined {
  if (!part || !whole || !DIGITS.test(part) || !DIGITS.test(whole))
    return undefined;
  const total = BigInt(whole);
  if (total === 0n) return undefined;
  const basisPoints = (BigInt(part) * 10_000n) / total;
  return `${basisPoints / 100n}.${String(basisPoints % 100n).padStart(2, '0')}%`;
}

const coreNode = z.looseObject({
  address: str,
  name: opt,
  description: opt,
});

/** Proposal lists read per DAO (single choice, multiple choice…). */
const LISTS_PER_DAO = 3;

/**
 * A DAO's proposal lists: what a new proposal needs (who may propose, the
 * deposit, the voting time) and whether cards can use the list. The
 * `config`, `proposalCreationPolicy` and `depositInfo` columns hold the
 * contracts' own query answers (DAO DAO v2: `{ allow_revoting,
 * only_members_execute, max_voting_period, … }`, `{ anyone: {} }` or
 * `{ module: { addr } }`, `{ denom: { native } | { cw20 }, amount,
 * refund_policy }`).
 */
const LIST_FIELDS = `daoProposalModulesByDaoAddress(first: ${LISTS_PER_DAO}, orderBy: PRIMARY_KEY_ASC) { ${PAGE} nodes { address prefix status moduleType proposalCreationPolicy config daoPreProposeModuleByPreProposeModule { depositInfo openProposalSubmission } } }`;
const listNode = z.looseObject({
  address: str,
  prefix: opt,
  status: opt,
  moduleType: opt,
  proposalCreationPolicy: z.unknown().optional(),
  config: z.unknown().optional(),
  daoPreProposeModuleByPreProposeModule: z
    .looseObject({
      depositInfo: z.unknown().optional(),
      openProposalSubmission: z.boolean().nullish(),
    })
    .nullish(),
});
const coreWithLists = coreNode.extend({
  daoProposalModulesByDaoAddress: connection(listNode),
});
type CoreWithLists = z.infer<typeof coreWithLists>;

/** DAO DAO's single-choice proposal contract (the only kind cards vote on). */
const SINGLE_CHOICE = 'dao_proposal_single';
const REFUND_POLICIES = ['always', 'only_passed', 'never'] as const;

/** cw-utils `Duration` as words: `{ time: s }` or `{ height: n }`. */
function durationText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const count = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (typeof value.time === 'number' && Number.isSafeInteger(value.time)) {
    const s = value.time;
    if (s > 0 && s % 86_400 === 0) return count(s / 86_400, 'day');
    if (s > 0 && s % 3_600 === 0) return count(s / 3_600, 'hour');
    if (s > 0 && s % 60 === 0) return count(s / 60, 'minute');
    return count(s, 'second');
  }
  if (typeof value.height === 'number' && Number.isSafeInteger(value.height))
    return count(value.height, 'block');
  return undefined;
}

/**
 * A proposal deposit (`CheckedDepositInfo`): a bank coin as shown, or a
 * cw20 amount with `cardCannotPay` (cards pay bank coins only), each with
 * its refund rule; undefined when there is none or it is unreadable.
 */
async function depositOf(ctx: KindContext, value: unknown) {
  if (!isRecord(value) || !isRecord(value.denom)) return undefined;
  const refundPolicy = REFUND_POLICIES.find(
    (policy) => policy === value.refund_policy,
  );
  if (typeof value.denom.native === 'string') {
    const coin = chainCoin({ denom: value.denom.native, amount: value.amount });
    const shown = coin ? await displayCoin(ctx, coin) : null;
    return shown ? compact({ ...shown, refundPolicy }) : undefined;
  }
  const amountBaseUnits = amountText(value.amount);
  return typeof value.denom.cw20 === 'string' && amountBaseUnits
    ? compact({
        token: idText(value.denom.cw20),
        amountBaseUnits,
        refundPolicy,
        cardCannotPay: true,
      })
    : undefined;
}

/** One proposal list of a DAO as the `daos` answer shows it. */
async function proposalListOf(
  ctx: KindContext,
  list: z.infer<typeof listNode>,
) {
  const config = isRecord(list.config) ? list.config : {};
  const policy = isRecord(list.proposalCreationPolicy)
    ? list.proposalCreationPolicy
    : {};
  const intake = list.daoPreProposeModuleByPreProposeModule;
  // `anyone`: proposals go straight to the list, from anyone, without a
  // deposit; `module`: through the list's intake, which holds both rules.
  const viaIntake = isRecord(policy.module);
  return compact({
    proposalModule: idText(list.address),
    prefix: text(list.prefix, 20),
    disabled: list.status === 'disabled' ? true : undefined,
    multipleChoice:
      list.moduleType && list.moduleType !== SINGLE_CHOICE ? true : undefined,
    membersOnly:
      viaIntake && intake?.openProposalSubmission === false ? true : undefined,
    deposit: viaIntake ? await depositOf(ctx, intake?.depositInfo) : undefined,
    votingTime: durationText(config.max_voting_period),
    allowRevoting:
      typeof config.allow_revoting === 'boolean'
        ? config.allow_revoting
        : undefined,
    membersOnlyCarryOut:
      config.only_members_execute === true ? true : undefined,
  });
}

/** What a DAO row shows of its core. */
type CoreText = {
  address: string;
  name?: string | null;
  description?: string | null;
};

async function daoOf<C extends CoreText>(
  ctx: KindContext,
  entry: Membership<C>,
  extra?: (core: C) => Promise<Record<string, unknown>>,
) {
  const native =
    entry.membership === 'native-staked' && entry.nativeDenom
      ? chainCoin({ denom: entry.nativeDenom, amount: entry.weight })
      : undefined;
  const staked = native
    ? ((await displayCoin(ctx, native)) ?? undefined)
    : entry.membership === 'cw20-staked' && entry.weight
      ? compact({
          token: idText(entry.tokenAddress),
          amountBaseUnits: entry.weight,
        })
      : undefined;
  const name = text(entry.core.name);
  const description = longText(entry.core.description);
  const cw4 = entry.membership === 'cw4-member';
  return compact({
    dao: idText(entry.core.address),
    name,
    description,
    nameIsSelfChosen: name || description ? true : undefined,
    membership: entry.membership,
    // A cw4 group's admin adds members without their consent.
    addedByGroupAdmin: cw4 ? true : undefined,
    staked,
    weight: cw4 ? entry.weight : undefined,
    votingPowerShare: shareOf(entry.weight, entry.totalWeight),
    votingModule: idText(entry.votingModule),
    moduleType: text(entry.moduleType, 80),
    ...(extra ? await extra(entry.core) : {}),
  });
}

/**
 * The `daos` answer's data from the membership answer: the first `n`
 * DAOs, and `more` when the index holds further memberships. `extra` adds
 * fields read with each DAO core (the `daos` kind's proposal lists).
 */
export async function daosData<C extends CoreText>(
  ctx: KindContext,
  answer: MembershipRows<C>,
  n: number,
  extra?: (core: C) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const all = membershipsOf(answer);
  return compact({
    items: await Promise.all(
      all.slice(0, n).map((entry) => daoOf(ctx, entry, extra)),
    ),
    more: all.length > n || moreMemberships(answer) ? true : undefined,
  });
}

/** A DAO core's proposal lists, and `moreProposalLists` past those read. */
async function listsOf(ctx: KindContext, core: CoreWithLists) {
  const lists = core.daoProposalModulesByDaoAddress;
  return {
    proposalLists: nonEmpty(
      await Promise.all(lists.nodes.map((list) => proposalListOf(ctx, list))),
    ),
    moreProposalLists: lists.pageInfo?.hasNextPage ? true : undefined,
  };
}

const answerSchema = membershipSchema(coreWithLists);

export const daos = defineKind({
  name: 'daos',
  summary:
    'DAOs an account (default: the user) is a member of, how, its share of the voting power, and where each takes new proposals.',
  explain: [
    'A DAO (DAO DAO on the IXO chain) decides by proposals and votes; its voting module sets who votes and with what weight.',
    '`membership`: `cw4-member` (a group member with a fixed `weight`), `cw20-staked` (voting power from cw20 tokens staked in the DAO, `staked.amountBaseUnits` of the `staked.token` contract) or `native-staked` (from staked bank tokens, e.g. IXO; `staked` is a bank coin, `amount` in display units beside `symbol`).',
    '`votingPowerShare` is the account’s weight or stake over the voting module’s total, rounded down; staked tokens count only while staked, and unstaking may take a waiting period.',
    'Each: dao (the DAO core contract address), name, description, membership, staked or weight, votingPowerShare, votingModule.',
    '`addedByGroupAdmin: true` (every cw4-member row): a cw4 group’s admin can add any address to the group without its consent, so membership alone does not mean the account joined, agreed or knows of the DAO.',
    '`nameIsSelfChosen: true`: the name and description are whatever the DAO set for itself, never a verified identity or an endorsement; say so before relying on them.',
    '`dao` is also the group’s own account: what the group holds (chain_lookup balances with that address) and what acts when one of its proposals passes.',
    '`proposalLists` (at most 3; `moreProposalLists: true` past them): where the DAO takes proposals, each `proposalModule` (its address), `prefix` (the letter before proposal numbers, A in A3), `votingTime`, `allowRevoting` (whether a vote can be changed until voting closes), `membersOnly: true` (only members may propose), `membersOnlyCarryOut: true` (only members may carry out a passed proposal), and `deposit` when proposing takes one: a bank coin (`amount` beside `symbol`) or a cw20 amount with `cardCannotPay: true`, with `refundPolicy` (`only_passed`: back only if it passes and is carried out, `always`: back when carried out or closed, `never`: not back). `multipleChoice: true` or `disabled: true`: Auth Hub cards cannot use that list.',
    'NFT (cw721) staking is not indexed here. Ask `dao_proposals` for what the DAOs are voting on.',
  ].join(' '),
  source: 'blocksync',
  list: true,
  args,
  example: {},
  plan(input, ctx) {
    const member = accountFor(input.address, ctx.identity, 'address');
    if ('invalid' in member) return member;
    const n = ctx.first;
    const subfields = membershipFields(
      member.address,
      n,
      `address name description ${LIST_FIELDS}`,
    );
    return {
      source: 'blocksync',
      field: (alias) => `${alias}: query { ${subfields} }`,
      async shape(raw): Promise<KindResult> {
        const parsed = answerSchema.safeParse(raw);
        if (!parsed.success) return { ok: false, ...unexpected };
        return listResult(
          await daosData(ctx, parsed.data, n, (core) => listsOf(ctx, core)),
          n,
          member.subject,
        );
      },
    };
  },
});
