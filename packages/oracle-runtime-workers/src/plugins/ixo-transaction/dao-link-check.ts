/**
 * What `link_dao_group` reads on chain before it shows a link and again
 * right before it is sent: whether the user can change the entity, whether
 * the address is a DAO DAO group, what that group is (name, members, how its
 * proposals pass), and which of the two link messages are still missing.
 * Every read is one bounded chain REST GET (`restJson`: time, size, the
 * ixo-chain retry policy and the user's read permits) under one budget:
 *
 * 1. `/ixo/entity/{did}`: the entity's type and its IID document. The chain
 *    runs `MsgAddLinkedEntity` and `MsgAddController` only for a signer
 *    whose account the document names under `authentication`
 *    (ixo-blockchain `x/iid/keeper/msg_server.go`,
 *    `ExecuteOnDidWithRelationships`; the ante handler's
 *    `authentication`-or-`assertionMethod` check runs first and is
 *    weaker), so that is what is checked here, not the `controller` list.
 * 2. `/cosmwasm/wasm/v1/contract/{core}`: the contract's `code_id` must be
 *    the network's `dao_core`.
 * 3. `dump_state` of the core: the group's name, its voting module, its
 *    proposal lists and whether it is paused.
 * 4. `group_contract` of the voting module, then `list_members` of that
 *    cw4 group (at most {@link MEMBERS_LIMIT}, cw4-group's own cap), and
 *    `config` of each enabled proposal list (at most
 *    {@link PROPOSAL_LISTS_READ}): the members and the pass rules.
 *
 * The entity's name comes from the IXO Names worker when it answers in time
 * (it reads the entity's profile); it is never required.
 *
 * A link already in place is read the way the Portal's Decisions tab reads
 * it (`governingGroupCores`: a `group` linked entity with relationship
 * `governs`, any case, the core after `#`), and the controller as
 * `did:ixo:wasm:<core>` in the document's `controller` list. Adding a linked
 * entity whose id the document already has fails on chain, and adding a
 * controller twice changes nothing, so only the missing message is sent.
 */
import {
  DAODAO_CODE_IDS,
  DaoDaoContractAddressSchema,
  type Network,
} from '@ixo/ixo-transaction';
import { z } from 'zod';
import type { RuntimeContext } from '../../plugin-api/types';
import {
  TOOL_BUDGET_MS,
  type ChainCall,
  type Failure,
} from '../ixo-chain/http';
import {
  listsAccountUnder,
  verificationMethodSchema,
} from '../ixo-chain/iid-signer';
import { namesClientId, namesUrl } from '../ixo-chain/ixo-chain.plugin';
import { resolveNames } from '../ixo-chain/names/client';
import { bech32Bytes } from '../ixo-chain/queries';
import { restJson } from '../ixo-chain/rest';
import { governingGroupCores } from '../ixo-chain/summaries';
import { votingPeriodText } from './dao-group';
import {
  oracleChainCall,
  plainLine,
  smartQueryPath,
  thresholdSchema,
  thresholdText,
} from './dao-proposal-check';

/** The whole check's time: every read below, with their retries. */
const LINK_CHECK_BUDGET_MS = TOOL_BUDGET_MS;
/** cw4-group's `MAX_LIMIT`: the most members one `list_members` answers. */
export const MEMBERS_LIMIT = 30;
/** The most enabled proposal lists whose rules are read. */
export const PROPOSAL_LISTS_READ = 3;
/** The longest the entity's name is waited for. */
const NAME_BUDGET_MS = 3_000;
/** A group's name as shown: DAO DAO does not bound it, the Portal's are at most 64. */
const GROUP_NAME_CHARS = 64;
/** An entity's name as shown (the Names worker's own cap). */
const ENTITY_NAME_CHARS = 120;

/**
 * The entity types the Portal shows a Decisions tab for (its governance
 * views read the governing group of DAOs and PODs only).
 */
export const PORTAL_GOVERNED_TYPES: readonly string[] = [
  'dao',
  'dao/pod',
  'pod',
  'protocol/dao',
  'protocol/pod',
];

const TAG = '[ixo-transaction]';

/** `/ixo/entity/{id}`: the fields the check reads. */
const entityAnswerSchema = z.object({
  entity: z.object({ id: z.string(), type: z.string() }),
  iidDocument: z.object({
    id: z.string(),
    controller: z.array(z.string()).default([]),
    verificationMethod: z.array(verificationMethodSchema).default([]),
    authentication: z.array(z.string()).default([]),
    assertionMethod: z.array(z.string()).default([]),
    linkedEntity: z
      .array(
        z.object({
          id: z.string(),
          type: z.string(),
          relationship: z.string(),
        }),
      )
      .default([]),
  }),
});

const contractInfoSchema = z.object({
  contract_info: z.object({ code_id: z.string() }),
});

const contractAddress = z.string().pipe(DaoDaoContractAddressSchema);

/** `dao-dao-core` 2.0.3 `dump_state`: the fields the check reads. */
const dumpStateSchema = z.object({
  data: z.object({
    config: z.object({ name: z.string() }),
    pause_info: z.union([
      z.object({ unpaused: z.object({}) }),
      z.object({ paused: z.unknown() }),
    ]),
    voting_module: contractAddress,
    proposal_modules: z.array(
      z.object({
        address: contractAddress,
        prefix: z.string(),
        status: z.string(),
      }),
    ),
  }),
});

const addressAnswerSchema = z.object({ data: contractAddress });

const membersAnswerSchema = z.object({
  data: z.object({
    members: z.array(
      z.object({ addr: z.string(), weight: z.number().int().nonnegative() }),
    ),
  }),
});

/** `dao-proposal-single` 2.0.3 `config`: the fields the pass rule reads. */
const proposalConfigSchema = z.object({
  data: z.object({
    threshold: thresholdSchema,
    max_voting_period: z.union([
      z.object({ time: z.number().int().nonnegative() }),
      z.object({ height: z.number().int().nonnegative() }),
    ]),
    allow_revoting: z.boolean(),
    only_members_execute: z.boolean(),
  }),
});

type ProposalConfig = z.infer<typeof proposalConfigSchema>['data'];

/** A member of the group's cw4 list. */
export interface GroupMember {
  addr: string;
  weight: number;
}

/** What will govern the entity, and what is still to be sent. */
export interface GroupLinkPlan {
  entity: {
    did: string;
    /** The entity's type on chain, e.g. `pod`. */
    type: string;
    /** Its name, when the Names worker answered in time. */
    name?: string;
  };
  group: {
    coreAddress: string;
    /** As the group's `config` names it, one line, clipped. */
    name: string;
    /** Its cw4 members; undefined when its votes do not come from a member list. */
    members?: GroupMember[];
    /** True when there may be more members than {@link MEMBERS_LIMIT}. */
    moreMembers: boolean;
    /** How a proposal passes, one sentence per enabled proposal list. */
    rules: string[];
  };
  /** Whether the user's account is a member; undefined when the members are not known. */
  userIsMember?: boolean;
  /** The two link messages: which are still missing on chain. */
  missing: { linkedEntity: boolean; controller: boolean };
  /** What the user must hear before agreeing (each a full sentence). */
  notes: string[];
}

export type GroupLinkCheck =
  | ({ ok: true } & GroupLinkPlan)
  | { ok: false; retryable: boolean; message: string };

const refusal = (message: string, retryable = false) => ({
  ok: false as const,
  retryable,
  message: `Nothing was sent: ${message}`,
});

/** A read that failed, in the words of the refusal that stops the link. */
function readRefusal(what: string, failure: Failure) {
  return refusal(
    `${what} could not be read from the chain (${failure.detail}).${failure.retryable ? ' Try again in a moment.' : ''}`,
    failure.retryable,
  );
}

/** How proposals of one list pass, in plain words. */
function ruleText(prefix: string, config: ProposalConfig): string {
  const period =
    'time' in config.max_voting_period
      ? votingPeriodText(config.max_voting_period.time)
      : `${config.max_voting_period.height} blocks`;
  const revoting = config.allow_revoting
    ? 'votes can be changed until voting closes, so a proposal is decided only then'
    : 'a proposal passes as soon as it has enough yes votes, and votes cannot be changed';
  const runs = config.only_members_execute
    ? 'only members carry out a passed proposal'
    : 'anyone can carry out a passed proposal';
  return `Proposals${prefix ? ` (list ${prefix})` : ''}: ${thresholdText(config.threshold)}; voting lasts ${period}; ${revoting}; ${runs}.`;
}

/** The entity's name from the IXO Names worker, if it answers in time; never a failure. */
async function entityName(
  ctx: RuntimeContext,
  call: ChainCall,
  did: string,
): Promise<string | undefined> {
  if (ctx.config.IXO_NAMES === 'off') return undefined;
  const deadline = Math.min(Date.now() + NAME_BUDGET_MS, call.deadline);
  if (deadline <= Date.now()) return undefined;
  const names = await resolveNames([did], {
    network: call.network,
    baseUrl: namesUrl(ctx.config),
    clientId: namesClientId(ctx.config),
    fetch: call.fetch,
    deadline,
    signal: call.signal,
  });
  const name = names[did]?.name;
  return name ? plainLine(name, ENTITY_NAME_CHARS) : undefined;
}

/**
 * The group's members (its voting module's cw4 group, one bounded page) or
 * why they cannot be listed: `undefined` members with a note when its votes
 * do not come from a member list; a refusal when a read failed.
 */
async function readMembers(
  call: ChainCall,
  votingModule: string,
): Promise<
  | { ok: true; members?: GroupMember[]; moreMembers: boolean; note?: string }
  | ReturnType<typeof refusal>
> {
  const group = await restJson(
    call,
    smartQueryPath(votingModule, { group_contract: {} }),
    addressAnswerSchema,
    { label: 'dao voting module', tag: TAG, contractQuery: true },
  );
  if (!group.ok) {
    if (group.failure.reason === 'invalid_input')
      return {
        ok: true,
        moreMembers: false,
        note: 'Its votes do not come from a member list (its voting module is not a DAO DAO multisig), so its members are not listed here: the user should check who holds its voting power in the Portal before linking.',
      };
    return readRefusal('The group’s voting module', group.failure);
  }
  const list = await restJson(
    call,
    smartQueryPath(group.value.data, {
      list_members: { limit: MEMBERS_LIMIT },
    }),
    membersAnswerSchema,
    { label: 'dao members', tag: TAG, contractQuery: true },
  );
  if (!list.ok) return readRefusal('The group’s members', list.failure);
  const { members } = list.value.data;
  // A full page: there may be more than one page holds.
  const moreMembers = members.length >= MEMBERS_LIMIT;
  return {
    ok: true,
    members,
    moreMembers,
    ...(moreMembers
      ? {
          note: `It has ${MEMBERS_LIMIT} members or more; only the first ${MEMBERS_LIMIT} are listed here.`,
        }
      : {}),
  };
}

/** The pass rule of each enabled proposal list (at most {@link PROPOSAL_LISTS_READ}), or a refusal. */
async function readRules(
  call: ChainCall,
  lists: ReadonlyArray<{ address: string; prefix: string; status: string }>,
): Promise<{ ok: true; rules: string[] } | ReturnType<typeof refusal>> {
  const enabled = lists.filter((list) => list.status === 'enabled');
  const reads = await Promise.all(
    enabled.slice(0, PROPOSAL_LISTS_READ).map(async (list) => ({
      list,
      read: await restJson(
        call,
        smartQueryPath(list.address, { config: {} }),
        proposalConfigSchema,
        { label: 'dao proposal module', tag: TAG, contractQuery: true },
      ),
    })),
  );
  const rules: string[] = [];
  for (const { list, read } of reads) {
    if (read.ok) {
      rules.push(ruleText(list.prefix, read.value.data));
      continue;
    }
    if (read.failure.retryable)
      return readRefusal('The group’s proposal rules', read.failure);
    rules.push(
      `Proposals (list ${list.prefix}): its rules could not be read (it is not a single-choice proposal list these tools read).`,
    );
  }
  if (enabled.length > PROPOSAL_LISTS_READ)
    rules.push(
      `And ${enabled.length - PROPOSAL_LISTS_READ} more proposal lists, not read here.`,
    );
  return { ok: true, rules };
}

/**
 * Read the entity and the group on chain and decide whether `coreAddress`
 * can be linked to `entityDid` from `sender`'s account, and which messages
 * are still missing. Refusals say why, in words for the user; a read that
 * failed is a refusal (`retryable` when asking again may help), never a
 * guess.
 */
export async function checkGroupLink(
  ctx: RuntimeContext,
  input: {
    entityDid: string;
    coreAddress: string;
    sender: string;
    network: Network;
  },
): Promise<GroupLinkCheck> {
  const { entityDid, coreAddress: core, sender, network } = input;
  const call = oracleChainCall(ctx, LINK_CHECK_BUDGET_MS);
  const accountBytes = bech32Bytes(sender, 'ixo');
  if (!accountBytes)
    return refusal(`your account ${sender} is not a valid ixo address.`);
  const [entityRead, contractRead] = await Promise.all([
    restJson(call, `/ixo/entity/${entityDid}`, entityAnswerSchema, {
      label: 'entity to govern',
      tag: TAG,
      noneOn: [404],
    }),
    restJson(call, `/cosmwasm/wasm/v1/contract/${core}`, contractInfoSchema, {
      label: 'dao contract',
      tag: TAG,
      contractQuery: true,
    }),
  ]);

  if (!entityRead.ok)
    return readRefusal(`The entity ${entityDid}`, entityRead.failure);
  if ('absent' in entityRead)
    return refusal(
      `the chain has no entity ${entityDid} on ${network}. Check the DID (chain_lookup entity).`,
    );
  const { entity, iidDocument: doc } = entityRead.value;
  if (!listsAccountUnder(doc, sender, accountBytes, ['authentication']))
    return refusal(
      `your account ${sender} cannot change ${entityDid}: the entity’s identity document does not list your account under authentication, and the chain adds a linked entity or a controller only for such an account. Only someone who controls the entity can link a group to it: ask them to do it, or to add your account to it first.`,
    );
  const governing = governingGroupCores(doc.linkedEntity);
  const others = [...governing].filter((other) => other !== core);
  if (others.length > 0)
    return refusal(
      `${entityDid} is already governed by the DAO DAO group ${others.join(', ')}. Replacing the group that governs an entity is a separate, deliberate change (the old group’s link and its control of the entity are removed, then the new one is added), which this tool does not make; the entity’s owner can change its governance in the Portal, in the entity’s settings.`,
    );
  const linkedEntity = !governing.has(core);
  // The chain refuses a linked entity whose id the document already has.
  const sameId = doc.linkedEntity.find((link) => link.id === `{id}#${core}`);
  if (linkedEntity && sameId)
    return refusal(
      `${entityDid} already links ${core} as a "${plainLine(sameId.type, 40)}" with relationship "${plainLine(sameId.relationship, 40)}", not as the group that governs it, and the chain takes one link per id. That link has to be removed first, in the Portal.`,
    );
  const controller = !doc.controller.includes(`did:ixo:wasm:${core}`);
  if (!linkedEntity && !controller)
    return refusal(
      `the DAO DAO group ${core} already governs ${entityDid}: it is linked as its governing group and is a controller of its identity, so there is nothing to link.`,
    );

  if (!contractRead.ok) {
    if (contractRead.failure.reason === 'invalid_input')
      return refusal(
        `there is no contract at ${core} on ${network}, so it is not a DAO DAO group. Copy the group’s address exactly: \`dao\` in chain_lookup daos, or the coreAddress create_dao_group returned.`,
      );
    return readRefusal(`The contract ${core}`, contractRead.failure);
  }
  const coreCode = DAODAO_CODE_IDS[network].dao_core;
  const codeId = contractRead.value.contract_info.code_id;
  if (codeId !== String(coreCode))
    return refusal(
      `${core} is a contract of code ${plainLine(codeId, 20)}, not a DAO DAO group: a group’s address is its core contract (code ${coreCode} on ${network}). Give the group’s own address (\`dao\` in chain_lookup daos), not one of its modules (its proposal list, intake or voting module).`,
    );

  const state = await restJson(
    call,
    smartQueryPath(core, { dump_state: {} }),
    dumpStateSchema,
    { label: 'dao state', tag: TAG, contractQuery: true },
  );
  if (!state.ok) return readRefusal(`The DAO DAO group ${core}`, state.failure);
  const dao = state.value.data;
  const [membersRead, rulesRead, name] = await Promise.all([
    readMembers(call, dao.voting_module),
    readRules(call, dao.proposal_modules),
    entityName(ctx, call, entityDid),
  ]);
  if (!membersRead.ok) return membersRead;
  if (!rulesRead.ok) return rulesRead;

  const notes: string[] = [];
  if (!PORTAL_GOVERNED_TYPES.includes(entity.type))
    notes.push(
      `The entity is of type "${plainLine(entity.type, 40)}": the Portal shows a Decisions tab only for DAOs and PODs (${PORTAL_GOVERNED_TYPES.join(', ')}), so it may not show this group’s proposals for it. The link itself is made on chain all the same.`,
    );
  const { members } = membersRead;
  const userIsMember = members?.some(
    (member) => member.addr === sender && member.weight > 0,
  );
  if (userIsMember === false)
    notes.push(
      `Your account ${sender} is not a member of this group: once it governs the entity, you cannot propose or vote on what the group decides for it; only its members can.`,
    );
  if (membersRead.note) notes.push(membersRead.note);
  if (dao.proposal_modules.every((list) => list.status !== 'enabled'))
    notes.push(
      'The group has no proposal list that takes proposals, so it cannot decide anything for the entity until one is added.',
    );
  if ('paused' in dao.pause_info)
    notes.push('The group is paused: it takes no new proposals right now.');
  if (!linkedEntity)
    notes.push(
      'The group is already linked as the entity’s governing group; only its controller entry is missing, so only that is sent.',
    );
  if (!controller)
    notes.push(
      'The group is already a controller of the entity’s identity; only the governing-group link is missing, so only that is sent.',
    );

  return {
    ok: true,
    entity: {
      did: entityDid,
      type: plainLine(entity.type, 40),
      ...(name !== undefined ? { name } : {}),
    },
    group: {
      coreAddress: core,
      name: plainLine(dao.config.name, GROUP_NAME_CHARS) || '(no name)',
      ...(members !== undefined ? { members } : {}),
      moreMembers: membersRead.moreMembers,
      rules: rulesRead.rules,
    },
    ...(userIsMember !== undefined ? { userIsMember } : {}),
    missing: { linkedEntity, controller },
    notes,
  };
}
