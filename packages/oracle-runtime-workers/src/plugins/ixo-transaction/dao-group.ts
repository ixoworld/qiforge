/**
 * What a new DAO DAO group is, shared by the two tools that create one in
 * the user's Portal wallet: the POD Creator's `create_pod_group` (a POD's
 * governance group) and this plugin's `create_dao_group` (a group of its
 * own). Both build the same `MsgInstantiateContract` with
 * `buildDaoDaoGroupInstantiate`; here are the bounds and words of their
 * inputs, the group in plain words for the summary the wallet shows, and
 * the read-back of the signed transaction.
 *
 * Read-back: the wallet answers with the hash only, so the transaction is
 * looked up on chain REST (`lookupTransaction`, bounded). It must carry
 * exactly one `MsgInstantiateContract` of the network's `dao_core` from the
 * user's account with the name, members, threshold and voting rules sent;
 * the group's core is the `_contract_address` of its `dao_core`
 * `instantiate` event (`findDaoDaoCoreAddress`). The same transaction
 * instantiates the group's proposal module and its intake (pre-propose),
 * each with its own `instantiate` event and code id, so their addresses are
 * read from it too, without another chain read.
 */
import {
  DAODAO_CODE_IDS,
  DAODAO_DEFAULT_ALLOW_REVOTING,
  DAODAO_VOTING_PERIOD_SECONDS,
  DaoDaoAccountAddressSchema,
  WASM_INSTANTIATE_TYPE_URL,
  findDaoDaoCoreAddress,
  type Network,
} from '@ixo/ixo-transaction';
import { z } from 'zod';
import { base64ToBytes } from '../base64';
import type { ChainCall } from '../ixo-chain/http';
import {
  lookupTransaction,
  type Tx,
  type TxEvent,
  type TxLookupOptions,
} from '../ixo-chain/tx-lookup';

/**
 * The most members a group created from the chat starts with: every
 * address is quoted in the summary the wallet shows, which holds at most
 * 1000 characters. Members join a bigger group later by its own proposals.
 */
export const MAX_DAO_GROUP_MEMBERS = 12;

/** A group as the user chose it, and as its transaction must show it. */
export interface DaoGroupSpec {
  /** The group's name (1 to 64 characters, one line). */
  name: string;
  /** The members' `ixo1…` account addresses, each with one vote, in order. */
  members: string[];
  /** How many yes votes pass a proposal. */
  threshold: number;
  /** How long each proposal is open for votes, in seconds. */
  votingPeriodSeconds: number;
  /** Whether members may change their vote until voting closes. */
  allowRevoting: boolean;
}

/**
 * What a group creation transaction says. `found`: it created the group
 * sent, at `coreAddress`, with its proposal module and intake when the
 * transaction names exactly one of each; `pending`: not on chain (or not
 * indexed) within the lookup's time; `failed`: it failed, or it is not that
 * group; `unavailable`: the chain could not be read.
 */
export type DaoGroupLookup =
  | {
      status: 'found';
      coreAddress: string;
      /** The group's `dao_proposal_single`: `proposalModule` of the vote, carry-out and close tools. */
      proposalModule?: string;
      /** Its `dao_pre_propose_single`: the `intake` new proposals are sent to. */
      intake?: string;
    }
  | { status: 'failed'; message: string; retryable: false }
  | {
      status: 'pending' | 'unavailable';
      message: string;
      retryable: boolean;
    };

/* ── the inputs ───────────────────────────────────────────────────────── */

/** The members, 1 to {@link MAX_DAO_GROUP_MEMBERS} checksummed account addresses. */
export const groupMembersField = (description: string) =>
  z
    .array(DaoDaoAccountAddressSchema)
    .min(1)
    .max(MAX_DAO_GROUP_MEMBERS)
    .describe(description);

export const groupThresholdField = z
  .number()
  .int()
  .min(1)
  .max(MAX_DAO_GROUP_MEMBERS)
  .describe(
    'How many yes votes pass a proposal: 1 to the number of members, as the user chose it.',
  );

export const groupVotingPeriodField = z
  .number()
  .int()
  .min(DAODAO_VOTING_PERIOD_SECONDS.min)
  .max(DAODAO_VOTING_PERIOD_SECONDS.max)
  .optional()
  .describe(
    `How long each proposal is open for votes, in seconds, as the user chose it: from 1 hour (${DAODAO_VOTING_PERIOD_SECONDS.min}) to 30 days (${DAODAO_VOTING_PERIOD_SECONDS.max}); 1 day = 86400. Default 7 days (${DAODAO_VOTING_PERIOD_SECONDS.default}), as the Portal creates groups.`,
  );

export const groupAllowRevotingField = z
  .boolean()
  .optional()
  .describe(
    `Whether members may change their vote until voting closes, as the user chose it. Default ${DAODAO_DEFAULT_ALLOW_REVOTING}, as the Portal creates groups. true: a proposal is decided only when voting closes, even once enough members voted yes. false: it passes as soon as enough members vote yes, and a vote cannot be changed.`,
  );

/**
 * What the model asks before it creates a group, in a tool's description:
 * the two voting rules and their trade-off.
 */
export const GROUP_VOTING_RULES_GUIDANCE =
  'Before the first call, ask the user two voting rules (or tell them the defaults and let them change them): how long voting on a proposal lasts (`votingPeriodSeconds`, 1 hour to 30 days, default 7 days) and whether members may change their vote (`allowRevoting`, default yes). The trade-off: if votes can be changed, a proposal passes only when voting closes, even once enough members voted yes, so it can be carried out only then; if not, it passes as soon as enough members vote yes and can be carried out at once, but nobody can change a vote.';

/* ── the group in plain words ─────────────────────────────────────────── */

/**
 * A voting time in plain words, in its largest whole unit: `7 days`,
 * `36 hours`, `90 minutes`; short enough for the wallet's summary.
 */
export function votingPeriodText(seconds: number): string {
  const [unit, size] =
    (
      [
        ['day', 86_400],
        ['hour', 3_600],
        ['minute', 60],
      ] as const
    ).find(([, length]) => seconds % length === 0) ?? (['second', 1] as const);
  const count = seconds / size;
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** How a proposal passes, with the group's voting rules, in plain words. */
export function passRuleText(group: DaoGroupSpec): string {
  const votes = `${group.threshold} yes vote${group.threshold === 1 ? '' : 's'}`;
  const period = votingPeriodText(group.votingPeriodSeconds);
  return group.allowRevoting
    ? `A proposal needs ${votes}; voting lasts ${period}. Votes can be changed until it ends, so a proposal passes only then.`
    : `A proposal needs ${votes}; voting lasts ${period}. It passes as soon as it has them, and votes cannot be changed.`;
}

/** The members in plain words: how many, one vote each, every address. */
export function membersText(members: readonly string[]): string {
  const count = members.length;
  return `a DAO DAO multisig of ${count} member${count === 1 ? '' : 's'}, one vote each: ${members.join(', ')}`;
}

/* ── the read-back ────────────────────────────────────────────────────── */

/** A CosmWasm `Binary` holding JSON, as chain REST shows a nested contract message (base64). */
const binaryJson = z.string().transform((value, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(value)));
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not base64 JSON' });
    return z.NEVER;
  }
  return parsed;
});

/**
 * A group's `MsgInstantiateContract` as chain REST shows it in a
 * transaction body: the top-level `msg` as JSON, each module's own `msg` as
 * base64 of its JSON.
 */
const groupInstantiateBodySchema = z.object({
  sender: z.string(),
  code_id: z.string(),
  msg: z.object({
    name: z.string(),
    voting_module_instantiate_info: z.object({
      msg: binaryJson.pipe(
        z.object({
          initial_members: z.array(
            z.object({ addr: z.string(), weight: z.number() }),
          ),
        }),
      ),
    }),
    proposal_modules_instantiate_info: z
      .array(
        z.object({
          msg: binaryJson.pipe(
            z.object({
              threshold: z.object({
                absolute_count: z.object({ threshold: z.string() }),
              }),
              max_voting_period: z.object({ time: z.number() }),
              allow_revoting: z.boolean(),
            }),
          ),
        }),
      )
      .length(1),
  }),
});

const sameMembers = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * The one contract of `codeId` the transaction instantiated; undefined
 * when it instantiated none or several.
 */
function instantiatedOnce(
  events: readonly TxEvent[],
  codeId: number,
): string | undefined {
  const addresses = new Set<string>();
  for (const event of events) {
    if (event.type !== 'instantiate') continue;
    const value = (key: string) =>
      event.attributes.find((entry) => entry.key === key)?.value;
    const address = value('_contract_address');
    if (value('code_id') === String(codeId) && address) addresses.add(address);
  }
  const [address] = addresses;
  return addresses.size === 1 ? address : undefined;
}

/**
 * What `tx` says about `group`: found when it carries exactly one
 * `dao_core` instantiate from `sender` with the sent name, members (one
 * vote each), threshold, voting time and vote-change rule, and its events
 * name the new group's core; else why it is not. `what` names the group in
 * the answer (`the governance group`, `the group`).
 */
export function groupOfTransaction(
  tx: Tx,
  input: { sender: string; group: DaoGroupSpec; network: Network },
  what: string,
): DaoGroupLookup {
  const { sender, group, network } = input;
  const notOurs: DaoGroupLookup = {
    status: 'failed',
    retryable: false,
    message: `That transaction is not ${what} this conversation sent for signing (another contract, account, name, members, threshold or voting rules). Check the transaction hash.`,
  };
  const result = tx.tx_response;
  if (result.code !== 0)
    return {
      status: 'failed',
      retryable: false,
      message: `That transaction failed on chain (code ${result.code}${result.codespace ? ` in ${result.codespace}` : ''}), so no group was created: ${result.raw_log.slice(0, 300)}`,
    };
  const instantiates = tx.tx.body.messages.filter(
    (message) => message['@type'] === WASM_INSTANTIATE_TYPE_URL,
  );
  const body =
    instantiates.length === 1
      ? groupInstantiateBodySchema.safeParse(instantiates[0])
      : null;
  if (!body?.success) return notOurs;
  const codes = DAODAO_CODE_IDS[network];
  const { sender: from, code_id: codeId, msg } = body.data;
  const voting = msg.voting_module_instantiate_info.msg;
  const rules = msg.proposal_modules_instantiate_info[0]?.msg;
  if (
    from !== sender ||
    codeId !== String(codes.dao_core) ||
    msg.name !== group.name ||
    voting.initial_members.some((member) => member.weight !== 1) ||
    !sameMembers(
      voting.initial_members.map((member) => member.addr),
      group.members,
    ) ||
    rules?.threshold.absolute_count.threshold !== String(group.threshold) ||
    rules.max_voting_period.time !== group.votingPeriodSeconds ||
    rules.allow_revoting !== group.allowRevoting
  )
    return notOurs;
  let coreAddress: string | undefined;
  try {
    coreAddress = findDaoDaoCoreAddress(network, { events: result.events });
  } catch {
    return notOurs;
  }
  if (!coreAddress)
    return {
      status: 'failed',
      retryable: false,
      message:
        'That transaction names no new group contract in its events, so the group’s address cannot be read from it.',
    };
  const proposalModule = instantiatedOnce(
    result.events,
    codes.dao_proposal_single,
  );
  const intake = instantiatedOnce(result.events, codes.dao_pre_propose_single);
  return {
    status: 'found',
    coreAddress,
    ...(proposalModule !== undefined ? { proposalModule } : {}),
    ...(intake !== undefined ? { intake } : {}),
  };
}

/**
 * Look the group's transaction up (bounded by `call`'s deadline) and read
 * the group from it ({@link groupOfTransaction}).
 */
export async function findDaoGroup(
  call: ChainCall,
  input: {
    txHash: string;
    sender: string;
    group: DaoGroupSpec;
    network: Network;
  },
  options: TxLookupOptions & { what: string },
): Promise<DaoGroupLookup> {
  const found = await lookupTransaction(call, input.txHash, options);
  if (found.status !== 'found') return found;
  return groupOfTransaction(found.tx, input, options.what);
}
