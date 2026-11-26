import type { MessageSpec, RiskLevel } from './catalog.js';
import {
  DAODAO_CW20_STAKE_MSG,
  DAODAO_CW20_SWAP_MSG,
  DAODAO_PROPOSAL_ACTION_ACTORS,
  DaoDaoProposalActionSchema,
  WASM_EXECUTE_TYPE_URL,
  type DaoDaoProposalAction,
} from './daodao-schemas.js';

/**
 * What a DAO DAO group proposal may ask the group's own account to do,
 * beyond the catalog messages of `DAODAO_PROPOSAL_ACTION_ACTORS`: each
 * action in the one shape the Portal's own proposal builder writes
 * (ixo-portal `lib/blocknote/transformActionsToMsgs.ts`), with its plain
 * name, its risks and a builder from plain inputs. The open-ended actions
 * (any contract message, instantiate, migrate, authz exec, admin exec,
 * custom), joining a DAO, accepting to the marketplace, validator actions
 * and sending an NFT to a contract are not among them.
 */

/** Every kind of action a proposal can hold, the catalog messages included. */
export type DaoDaoGroupActionKind =
  | 'catalog'
  | 'send'
  | 'delegate'
  | 'undelegate'
  | 'redelegate'
  | 'withdraw-rewards'
  | 'gov-vote'
  | 'authz-grant'
  | 'authz-revoke'
  | 'update-members'
  | 'update-info'
  | 'update-voting-rules'
  | 'update-submission-rules'
  | 'manage-sub-daos'
  | 'manage-token-list'
  | 'manage-nft-list'
  | 'set-item'
  | 'remove-item'
  | 'send-group-tokens'
  | 'stake-to-group'
  | 'mint-group-tokens'
  | 'transfer-nft'
  | 'burn-nft'
  | 'token-swap-fund'
  | 'token-swap-withdraw'
  | 'update-admin';

type ActionSpec = {
  /** The action in a few plain words. */
  name: string;
  /** The message type the chain runs for it. */
  typeUrl: string;
  riskLevel: RiskLevel;
  risks: string[];
};

const MOVES_TOKENS = 'Transfers tokens to another address.';

const SPECS: Readonly<
  Record<Exclude<DaoDaoGroupActionKind, 'catalog'>, ActionSpec>
> = {
  send: {
    name: 'send funds',
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    riskLevel: 'high',
    risks: [MOVES_TOKENS],
  },
  delegate: {
    name: 'stake with a validator',
    typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
    riskLevel: 'medium',
    risks: [
      'Stakes the group’s tokens with a validator: they earn rewards but can be slashed if the validator misbehaves, and take 21 days to unstake.',
    ],
  },
  undelegate: {
    name: 'unstake from a validator',
    typeUrl: '/cosmos.staking.v1beta1.MsgUndelegate',
    riskLevel: 'medium',
    risks: [
      'Unstakes the group’s tokens: they earn nothing and cannot be moved for 21 days.',
    ],
  },
  redelegate: {
    name: 'move stake to another validator',
    typeUrl: '/cosmos.staking.v1beta1.MsgBeginRedelegate',
    riskLevel: 'medium',
    risks: [
      'Moves the group’s stake to another validator, which can then slash it if it misbehaves.',
    ],
  },
  'withdraw-rewards': {
    name: 'claim staking rewards',
    typeUrl: '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
    riskLevel: 'low',
    risks: [],
  },
  'gov-vote': {
    name: 'vote on a network proposal',
    typeUrl: '/cosmos.gov.v1beta1.MsgVote',
    riskLevel: 'medium',
    risks: [
      'Votes on a network governance proposal with the group’s staked tokens.',
    ],
  },
  'authz-grant': {
    name: 'give a permission',
    typeUrl: '/cosmos.authz.v1beta1.MsgGrant',
    riskLevel: 'critical',
    risks: [
      'Lets another account send that kind of message as the group, without a vote, for a year or until the permission is taken back.',
    ],
  },
  'authz-revoke': {
    name: 'take back a permission',
    typeUrl: '/cosmos.authz.v1beta1.MsgRevoke',
    riskLevel: 'medium',
    risks: ['Takes back a permission another account has to act as the group.'],
  },
  'update-members': {
    name: 'change the members',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'high',
    risks: ['Changes who can vote in the group and how much each vote counts.'],
  },
  'update-info': {
    name: 'change the group’s name and details',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'medium',
    risks: ['Changes the group’s public name, description or image.'],
  },
  'update-voting-rules': {
    name: 'change the voting rules',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'high',
    risks: [
      'Changes how the group’s proposals pass: how many votes they need, how long voting lasts and who can carry them out.',
    ],
  },
  'update-submission-rules': {
    name: 'change who can propose',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'high',
    risks: [
      'Changes who can make proposals to the group and the deposit a proposal costs.',
    ],
  },
  'manage-sub-daos': {
    name: 'change the sub-DAOs',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'medium',
    risks: ['Changes which DAOs the group lists as its sub-DAOs.'],
  },
  'manage-token-list': {
    name: 'change the tracked tokens',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'low',
    risks: ['Changes which cw20 tokens the group’s treasury shows.'],
  },
  'manage-nft-list': {
    name: 'change the tracked NFT collections',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'low',
    risks: ['Changes which NFT collections the group’s treasury shows.'],
  },
  'set-item': {
    name: 'store an item',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'medium',
    risks: [
      'Writes a value into the group’s storage, which apps may read as its settings.',
    ],
  },
  'remove-item': {
    name: 'remove a stored item',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'medium',
    risks: [
      'Removes a value from the group’s storage, which apps may read as its settings.',
    ],
  },
  'send-group-tokens': {
    name: 'send cw20 tokens',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'high',
    risks: [MOVES_TOKENS],
  },
  'stake-to-group': {
    name: 'stake cw20 tokens in the group',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'medium',
    risks: [
      'Stakes the group’s own tokens in its staking contract, which changes voting power.',
    ],
  },
  'mint-group-tokens': {
    name: 'mint governance tokens',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'high',
    risks: [
      'Creates new governance tokens, which changes who holds voting power.',
    ],
  },
  'transfer-nft': {
    name: 'give away an NFT',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'high',
    risks: ['Transfers an NFT the group owns to another address.'],
  },
  'burn-nft': {
    name: 'burn an NFT',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'critical',
    risks: ['Destroys an NFT the group owns for good.'],
  },
  'token-swap-fund': {
    name: 'fund a token swap',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'high',
    risks: [
      'Puts the group’s tokens into a token swap contract, which trades them once the other side pays in.',
    ],
  },
  'token-swap-withdraw': {
    name: 'withdraw from a token swap',
    typeUrl: WASM_EXECUTE_TYPE_URL,
    riskLevel: 'medium',
    risks: [
      'Takes the group’s tokens back out of a token swap, which then does not happen.',
    ],
  },
  'update-admin': {
    name: 'change a contract’s admin',
    typeUrl: '/cosmwasm.wasm.v1.MsgUpdateAdmin',
    riskLevel: 'critical',
    risks: [
      'Gives another address control of the contract: it can replace the contract’s code without a vote.',
    ],
  },
};

/** What kind of action a (decoded, valid) proposal action is. */
export function daoDaoGroupActionKind(
  action: DaoDaoProposalAction,
): DaoDaoGroupActionKind | undefined {
  if ('stargate' in action) {
    switch (action.stargate.type_url) {
      case '/cosmos.gov.v1beta1.MsgVote':
        return 'gov-vote';
      case '/cosmos.authz.v1beta1.MsgGrant':
        return 'authz-grant';
      case '/cosmos.authz.v1beta1.MsgRevoke':
        return 'authz-revoke';
      default:
        return Object.hasOwn(
          DAODAO_PROPOSAL_ACTION_ACTORS,
          action.stargate.type_url,
        )
          ? 'catalog'
          : undefined;
    }
  }
  if ('bank' in action) return 'send';
  if ('staking' in action) {
    const { staking } = action;
    return 'delegate' in staking
      ? 'delegate'
      : 'undelegate' in staking
        ? 'undelegate'
        : 'redelegate';
  }
  if ('distribution' in action) return 'withdraw-rewards';
  if ('update_admin' in action.wasm) return 'update-admin';
  const { msg } = action.wasm.execute;
  if ('update_members' in msg) return 'update-members';
  if ('update_config' in msg) {
    const config = msg.update_config;
    return 'config' in config
      ? 'update-info'
      : 'threshold' in config
        ? 'update-voting-rules'
        : 'update-submission-rules';
  }
  if ('update_sub_daos' in msg) return 'manage-sub-daos';
  if ('update_cw20_list' in msg) return 'manage-token-list';
  if ('update_cw721_list' in msg) return 'manage-nft-list';
  if ('set_item' in msg) return 'set-item';
  if ('remove_item' in msg) return 'remove-item';
  if ('transfer' in msg) return 'send-group-tokens';
  if ('send' in msg)
    return msg.send.msg === DAODAO_CW20_STAKE_MSG
      ? 'stake-to-group'
      : 'token-swap-fund';
  if ('mint' in msg) return 'mint-group-tokens';
  if ('transfer_nft' in msg) return 'transfer-nft';
  if ('burn' in msg) return 'burn-nft';
  if ('fund' in msg) return 'token-swap-fund';
  return 'token-swap-withdraw';
}

/**
 * The catalog-style entry of a non-catalog proposal action kind: its name,
 * the message type the chain runs and its risks. Not a signable route
 * (`module` is `daodao-action`): only a proposal holds these.
 */
export function daoDaoGroupActionSpec(
  kind: Exclude<DaoDaoGroupActionKind, 'catalog'>,
): MessageSpec {
  const spec = SPECS[kind];
  return {
    module: 'daodao-action',
    action: kind,
    messageName: spec.name,
    typeUrl: spec.typeUrl,
    fields: [],
    riskLevel: spec.riskLevel,
    risks: [...spec.risks],
  };
}

/** Every non-catalog kind with its plain name, for tool descriptions. */
export const DAODAO_GROUP_ACTION_NAMES: Readonly<
  Record<Exclude<DaoDaoGroupActionKind, 'catalog'>, string>
> = Object.fromEntries(
  Object.entries(SPECS).map(([kind, spec]) => [kind, spec.name]),
) as Record<Exclude<DaoDaoGroupActionKind, 'catalog'>, string>;

// ---------------------------------------------------------------------------
// Builders: plain inputs to the decoded action, validated.
// ---------------------------------------------------------------------------

export type DaoDaoCoin = { amount: string; denom: string };

/** A pass rule as a person states it. */
export type DaoDaoPassRule =
  | { type: 'count'; count: number }
  | { type: 'percent'; percent: number }
  | { type: 'majority' };

/** `dao-dao-core` 2.0.3 `config`, as the group answers it. */
export type DaoDaoCoreConfig = {
  name: string;
  description: string;
  image_url: string | null;
  automatically_add_cw20s: boolean;
  automatically_add_cw721s: boolean;
  dao_uri: string | null;
};

type Duration = { time: number } | { height: number };
type PercentageThreshold =
  | { majority: Record<string, never> }
  | { percent: string };

/** `dao-proposal-single` `config`, as the proposal list answers it. */
export type DaoDaoProposalConfig = {
  threshold:
    | { absolute_percentage: { percentage: PercentageThreshold } }
    | {
        threshold_quorum: {
          threshold: PercentageThreshold;
          quorum: PercentageThreshold;
        };
      }
    | { absolute_count: { threshold: string } };
  max_voting_period: Duration;
  min_voting_period: Duration | null;
  only_members_execute: boolean;
  allow_revoting: boolean;
  dao: string;
  close_proposal_on_execution_failure: boolean;
  veto?: {
    vetoer: string;
    timelock_duration: Duration;
    early_execute: boolean;
    veto_before_passed: boolean;
  } | null;
};

/** A proposal deposit, as `update_config` of the intake takes it. */
export type DaoDaoDeposit = {
  amount: string;
  denom:
    | { voting_module_token: Record<string, never> }
    | { token: { denom: { native: string } | { cw20: string } } };
  refund_policy: 'always' | 'only_passed' | 'never';
};

/** `dao-pre-propose-single` 2.0.3 `config`, as the intake answers it. */
export type DaoDaoIntakeConfig = {
  deposit_info: {
    amount: string;
    denom: { native: string } | { cw20: string };
    refund_policy: 'always' | 'only_passed' | 'never';
  } | null;
  open_proposal_submission: boolean;
};

/**
 * One action, with every address it needs already known: the group's core
 * (`group`), its member list (`cw4Group`), its proposal list or intake with
 * their current config, its governance token. The oracle reads those on
 * chain; the user's own words give the rest.
 */
export type DaoDaoGroupActionInput =
  | { type: 'delegate' | 'undelegate'; validator: string; amount: DaoDaoCoin }
  | {
      type: 'redelegate';
      fromValidator: string;
      toValidator: string;
      amount: DaoDaoCoin;
    }
  | { type: 'withdraw-rewards'; validator: string }
  | {
      type: 'gov-vote';
      group: string;
      proposalId: string;
      option: 'yes' | 'no' | 'abstain' | 'no_with_veto';
    }
  | {
      type: 'update-members';
      cw4Group: string;
      add: ReadonlyArray<{ addr: string; weight: number }>;
      remove: readonly string[];
    }
  | {
      type: 'update-info';
      group: string;
      current: DaoDaoCoreConfig;
      name?: string;
      description?: string;
      imageUrl?: string | null;
    }
  | {
      type: 'update-voting-rules';
      proposalModule: string;
      current: DaoDaoProposalConfig;
      passRule?: DaoDaoPassRule;
      /** With a share-of-votes rule: the share that must vote at all; null for none. */
      quorum?: Exclude<DaoDaoPassRule, { type: 'count' }> | null;
      votingPeriodSeconds?: number;
      allowRevoting?: boolean;
      onlyMembersExecute?: boolean;
    }
  | {
      type: 'update-submission-rules';
      intake: string;
      current: DaoDaoIntakeConfig;
      anyoneCanPropose?: boolean;
      /** A new deposit, or null for none; the current one when left out. */
      deposit?: DaoDaoDeposit | null;
    }
  | {
      type: 'manage-sub-daos';
      group: string;
      add: ReadonlyArray<{ addr: string; charter?: string | null }>;
      remove: readonly string[];
    }
  | {
      type: 'manage-token-list' | 'manage-nft-list';
      group: string;
      add: readonly string[];
      remove: readonly string[];
    }
  | { type: 'set-item'; group: string; key: string; value: string }
  | { type: 'remove-item'; group: string; key: string }
  | {
      type: 'send-group-tokens';
      token: string;
      recipient: string;
      amount: string;
    }
  | {
      type: 'stake-to-group';
      token: string;
      stakingContract: string;
      amount: string;
    }
  | {
      type: 'mint-group-tokens';
      token: string;
      recipient: string;
      amount: string;
    }
  | {
      type: 'transfer-nft';
      collection: string;
      recipient: string;
      tokenId: string;
    }
  | { type: 'burn-nft'; collection: string; tokenId: string }
  | {
      type: 'token-swap-fund';
      swapContract: string;
      /** The group's side: native coins, or a cw20 token's base units. */
      pay: { native: DaoDaoCoin } | { cw20: { token: string; amount: string } };
    }
  | { type: 'token-swap-withdraw'; swapContract: string }
  | {
      type: 'authz-grant';
      group: string;
      grantee: string;
      msgTypeUrl: string;
      /** When the permission ends; the Portal gives a year. */
      expiration: Date;
    }
  | { type: 'authz-revoke'; group: string; grantee: string; msgTypeUrl: string }
  | { type: 'update-admin'; contract: string; admin: string };

/** The Portal's permission length: a year from now. */
export const DAODAO_GRANT_DAYS = 365;

const VOTE_OPTIONS = {
  yes: 'VOTE_OPTION_YES',
  no: 'VOTE_OPTION_NO',
  abstain: 'VOTE_OPTION_ABSTAIN',
  no_with_veto: 'VOTE_OPTION_NO_WITH_VETO',
} as const;

const execute = (
  contract: string,
  msg: Record<string, unknown>,
  funds: DaoDaoCoin[] = [],
): unknown => ({ wasm: { execute: { contract_addr: contract, funds, msg } } });

function percentageThreshold(
  rule: Exclude<DaoDaoPassRule, { type: 'count' }>,
): PercentageThreshold {
  if (rule.type === 'majority') return { majority: {} };
  if (!Number.isFinite(rule.percent) || rule.percent <= 0 || rule.percent > 100)
    throw new Error(
      `A share of votes is more than 0% and at most 100% (got ${rule.percent})`,
    );
  // As the Portal writes it: the share as a decimal string.
  return { percent: (rule.percent / 100).toString() };
}

function threshold(
  passRule: DaoDaoPassRule | undefined,
  quorum: Exclude<DaoDaoPassRule, { type: 'count' }> | null | undefined,
  current: DaoDaoProposalConfig['threshold'],
): DaoDaoProposalConfig['threshold'] {
  if (passRule === undefined && quorum === undefined) return current;
  const rule =
    passRule ??
    ('absolute_percentage' in current
      ? current.absolute_percentage.percentage
      : 'threshold_quorum' in current
        ? current.threshold_quorum.threshold
        : undefined);
  if (rule === undefined)
    throw new Error(
      'The group passes proposals by a count of yes votes, which has no quorum: give the new pass rule too',
    );
  if ('type' in rule && rule.type === 'count') {
    if (quorum) throw new Error('A count of yes votes takes no quorum');
    if (!Number.isInteger(rule.count) || rule.count < 1)
      throw new Error('A count of yes votes is a whole number from 1');
    return { absolute_count: { threshold: String(rule.count) } };
  }
  const share = 'type' in rule ? percentageThreshold(rule) : rule;
  const currentQuorum =
    'threshold_quorum' in current ? current.threshold_quorum.quorum : null;
  const newQuorum =
    quorum === undefined
      ? currentQuorum
      : quorum === null
        ? null
        : percentageThreshold(quorum);
  return newQuorum === null
    ? { absolute_percentage: { percentage: share } }
    : { threshold_quorum: { threshold: share, quorum: newQuorum } };
}

/** The intake's current deposit as `update_config` takes it back. */
function uncheckedDeposit(
  deposit: DaoDaoIntakeConfig['deposit_info'],
): DaoDaoDeposit | null {
  if (deposit === null) return null;
  return {
    amount: deposit.amount,
    denom: { token: { denom: deposit.denom } },
    refund_policy: deposit.refund_policy,
  };
}

function rawAction(input: DaoDaoGroupActionInput): unknown {
  switch (input.type) {
    case 'delegate':
    case 'undelegate':
      return {
        staking: {
          [input.type]: { amount: input.amount, validator: input.validator },
        },
      };
    case 'redelegate':
      return {
        staking: {
          redelegate: {
            amount: input.amount,
            src_validator: input.fromValidator,
            dst_validator: input.toValidator,
          },
        },
      };
    case 'withdraw-rewards':
      return {
        distribution: {
          withdraw_delegator_reward: { validator: input.validator },
        },
      };
    case 'gov-vote':
      return {
        stargate: {
          type_url: '/cosmos.gov.v1beta1.MsgVote',
          value: {
            proposalId: input.proposalId,
            voter: input.group,
            option: VOTE_OPTIONS[input.option],
          },
        },
      };
    case 'update-members':
      return execute(input.cw4Group, {
        update_members: {
          add: input.add.map(({ addr, weight }) => ({ addr, weight })),
          remove: [...input.remove],
        },
      });
    case 'update-info': {
      const { current } = input;
      const image =
        input.imageUrl === undefined ? current.image_url : input.imageUrl;
      return execute(input.group, {
        update_config: {
          config: {
            name: input.name ?? current.name,
            description: input.description ?? current.description,
            image_url: image?.trim() || null,
            automatically_add_cw20s: current.automatically_add_cw20s,
            automatically_add_cw721s: current.automatically_add_cw721s,
            dao_uri: current.dao_uri,
          },
        },
      });
    }
    case 'update-voting-rules': {
      const { current } = input;
      return execute(input.proposalModule, {
        // A full replace: what the user does not change is carried over
        // from the list's current config (its group, close-on-failure, the
        // minimum voting time and, on a 2.4+ list, its veto).
        update_config: {
          threshold: threshold(input.passRule, input.quorum, current.threshold),
          max_voting_period:
            input.votingPeriodSeconds === undefined
              ? current.max_voting_period
              : { time: input.votingPeriodSeconds },
          min_voting_period: current.min_voting_period,
          only_members_execute:
            input.onlyMembersExecute ?? current.only_members_execute,
          allow_revoting: input.allowRevoting ?? current.allow_revoting,
          dao: current.dao,
          close_proposal_on_execution_failure:
            current.close_proposal_on_execution_failure,
          ...(current.veto !== undefined ? { veto: current.veto } : {}),
        },
      });
    }
    case 'update-submission-rules':
      return execute(input.intake, {
        update_config: {
          deposit_info:
            input.deposit === undefined
              ? uncheckedDeposit(input.current.deposit_info)
              : input.deposit,
          open_proposal_submission:
            input.anyoneCanPropose ?? input.current.open_proposal_submission,
        },
      });
    case 'manage-sub-daos':
      return execute(input.group, {
        update_sub_daos: {
          to_add: input.add.map(({ addr, charter }) => ({
            addr,
            charter: charter ?? null,
          })),
          to_remove: [...input.remove],
        },
      });
    case 'manage-token-list':
    case 'manage-nft-list':
      return execute(input.group, {
        [input.type === 'manage-token-list'
          ? 'update_cw20_list'
          : 'update_cw721_list']: {
          to_add: [...input.add],
          to_remove: [...input.remove],
        },
      });
    case 'set-item':
      return execute(input.group, {
        set_item: { key: input.key, value: input.value },
      });
    case 'remove-item':
      return execute(input.group, { remove_item: { key: input.key } });
    case 'send-group-tokens':
      return execute(input.token, {
        transfer: { recipient: input.recipient, amount: input.amount },
      });
    case 'stake-to-group':
      return execute(input.token, {
        send: {
          amount: input.amount,
          contract: input.stakingContract,
          msg: DAODAO_CW20_STAKE_MSG,
        },
      });
    case 'mint-group-tokens':
      return execute(input.token, {
        mint: { recipient: input.recipient, amount: input.amount },
      });
    case 'transfer-nft':
      return execute(input.collection, {
        transfer_nft: { recipient: input.recipient, token_id: input.tokenId },
      });
    case 'burn-nft':
      return execute(input.collection, { burn: { token_id: input.tokenId } });
    case 'token-swap-fund':
      return 'native' in input.pay
        ? execute(input.swapContract, { fund: {} }, [
            { amount: input.pay.native.amount, denom: input.pay.native.denom },
          ])
        : execute(input.pay.cw20.token, {
            send: {
              amount: input.pay.cw20.amount,
              contract: input.swapContract,
              msg: DAODAO_CW20_SWAP_MSG,
            },
          });
    case 'token-swap-withdraw':
      return execute(input.swapContract, { withdraw: {} });
    case 'authz-grant':
      return {
        stargate: {
          type_url: '/cosmos.authz.v1beta1.MsgGrant',
          value: {
            granter: input.group,
            grantee: input.grantee,
            grant: {
              authorization: {
                typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
                value: { msg: input.msgTypeUrl },
              },
              expiration: input.expiration.toISOString(),
            },
          },
        },
      };
    case 'authz-revoke':
      return {
        stargate: {
          type_url: '/cosmos.authz.v1beta1.MsgRevoke',
          value: {
            granter: input.group,
            grantee: input.grantee,
            msgTypeUrl: input.msgTypeUrl,
          },
        },
      };
    case 'update-admin':
      return {
        wasm: {
          update_admin: { contract_addr: input.contract, admin: input.admin },
        },
      };
  }
}

/**
 * The proposal action for `input`, in its decoded form, checked against its
 * one shape (a group-only stargate action's value too). Throws when the
 * input is refused. The proposal it joins is checked again as a whole
 * (`validateMessage`): every action names the same group.
 */
export function buildDaoDaoGroupAction(
  input: DaoDaoGroupActionInput,
): DaoDaoProposalAction {
  return DaoDaoProposalActionSchema.parse(rawAction(input));
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/** The most characters one value takes in a description. */
const VALUE_MAX = 120;

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= VALUE_MAX ? line : `${line.slice(0, VALUE_MAX - 1)}…`;
}

const coinText = (coin: { amount: string; denom: string }) =>
  `${coin.amount} ${clip(coin.denom)}`;

function shareText(share: PercentageThreshold): string {
  return 'majority' in share ? 'a majority' : `${Number(share.percent) * 100}%`;
}

function ruleText(rule: DaoDaoProposalConfig['threshold']): string {
  if ('absolute_count' in rule)
    return `${rule.absolute_count.threshold} yes votes`;
  if ('absolute_percentage' in rule)
    return `${shareText(rule.absolute_percentage.percentage)} of the voting power voting yes`;
  return `${shareText(rule.threshold_quorum.threshold)} yes of the votes cast, with at least ${shareText(rule.threshold_quorum.quorum)} of the voting power voting`;
}

function durationText(duration: Duration): string {
  if ('height' in duration) return `${duration.height} blocks`;
  const { time } = duration;
  if (time % 86_400 === 0) return `${time / 86_400} days`;
  if (time % 3_600 === 0) return `${time / 3_600} hours`;
  return `${time} seconds`;
}

const listText = (verb: string, items: readonly string[]) =>
  items.length > 0 ? `${verb} ${items.map(clip).join(', ')}` : undefined;

const joined = (parts: ReadonlyArray<string | undefined>) =>
  parts.filter((part): part is string => part !== undefined).join('; ');

const VOTE_WORDS: Readonly<Record<string, string>> = {
  VOTE_OPTION_YES: 'YES',
  VOTE_OPTION_NO: 'NO',
  VOTE_OPTION_ABSTAIN: 'ABSTAIN',
  VOTE_OPTION_NO_WITH_VETO: 'NO WITH VETO',
};

/**
 * A non-catalog proposal action in plain words, with its values (each
 * clipped to 120 characters): what the group's own account does.
 * Undefined for a catalog stargate action (`describeDaoDaoProposalAction`
 * words those).
 */
export function describeDaoDaoGroupAction(
  action: DaoDaoProposalAction,
): string | undefined {
  if ('stargate' in action) {
    const value = action.stargate.value;
    const text = (key: string) => clip(String(value[key] ?? ''));
    switch (action.stargate.type_url) {
      case '/cosmos.gov.v1beta1.MsgVote':
        return `vote ${VOTE_WORDS[String(value.option)] ?? text('option')} on network proposal ${text('proposalId')}`;
      case '/cosmos.authz.v1beta1.MsgGrant': {
        const grant = value.grant as {
          authorization: { value: { msg: string } };
          expiration: string;
        };
        return `let ${text('grantee')} send ${clip(grant.authorization.value.msg)} as the group, without a vote, until ${clip(grant.expiration)}`;
      }
      case '/cosmos.authz.v1beta1.MsgRevoke':
        return `stop ${text('grantee')} sending ${text('msgTypeUrl')} as the group`;
      default:
        return undefined;
    }
  }
  if ('bank' in action)
    return `send ${action.bank.send.amount.map(coinText).join(' + ')} to ${clip(action.bank.send.to_address)}`;
  if ('staking' in action) {
    const { staking } = action;
    if ('delegate' in staking)
      return `stake ${coinText(staking.delegate.amount)} with validator ${clip(staking.delegate.validator)}`;
    if ('undelegate' in staking)
      return `unstake ${coinText(staking.undelegate.amount)} from validator ${clip(staking.undelegate.validator)} (21 days before it can be moved)`;
    return `move ${coinText(staking.redelegate.amount)} of stake from validator ${clip(staking.redelegate.src_validator)} to ${clip(staking.redelegate.dst_validator)}`;
  }
  if ('distribution' in action)
    return `claim the staking rewards from validator ${clip(action.distribution.withdraw_delegator_reward.validator)}`;
  if ('update_admin' in action.wasm)
    return `make ${clip(action.wasm.update_admin.admin)} the admin of contract ${clip(action.wasm.update_admin.contract_addr)}, which can replace its code`;
  const { contract_addr: contract, msg, funds } = action.wasm.execute;
  if ('update_members' in msg) {
    const { add, remove } = msg.update_members;
    return `change the members: ${joined([
      listText(
        'add or set',
        add.map((member) => `${member.addr} (weight ${member.weight})`),
      ),
      listText('remove', remove),
    ])}`;
  }
  if ('update_config' in msg) {
    const config = msg.update_config;
    if ('config' in config) {
      const c = config.config;
      return `set the group’s details: name "${clip(c.name)}", description "${clip(c.description)}", image ${c.image_url ? clip(c.image_url) : 'none'}`;
    }
    if ('threshold' in config)
      return `set the voting rules: a proposal passes with ${ruleText(config.threshold)}; voting lasts ${durationText(config.max_voting_period)}; ${config.allow_revoting ? 'votes can be changed until voting closes' : 'votes cannot be changed'}; ${config.only_members_execute ? 'only members' : 'anyone'} can carry out a passed proposal`;
    const deposit = config.deposit_info;
    const depositText =
      deposit === null
        ? 'no deposit'
        : `a deposit of ${deposit.amount} ${
            'voting_module_token' in deposit.denom
              ? 'governance tokens'
              : 'native' in deposit.denom.token.denom
                ? clip(deposit.denom.token.denom.native)
                : `of token ${clip(deposit.denom.token.denom.cw20)}`
          } (refunded: ${deposit.refund_policy.replace('_', ' ')})`;
    return `set who can propose: ${config.open_proposal_submission ? 'anyone' : 'members only'}, with ${depositText}`;
  }
  if ('update_sub_daos' in msg)
    return `change the sub-DAOs: ${joined([
      listText(
        'add',
        msg.update_sub_daos.to_add.map((sub) => sub.addr),
      ),
      listText('remove', msg.update_sub_daos.to_remove),
    ])}`;
  if ('update_cw20_list' in msg)
    return `change the tracked tokens: ${joined([
      listText('add', msg.update_cw20_list.to_add),
      listText('remove', msg.update_cw20_list.to_remove),
    ])}`;
  if ('update_cw721_list' in msg)
    return `change the tracked NFT collections: ${joined([
      listText('add', msg.update_cw721_list.to_add),
      listText('remove', msg.update_cw721_list.to_remove),
    ])}`;
  if ('set_item' in msg)
    return `store "${clip(msg.set_item.value)}" under "${clip(msg.set_item.key)}"`;
  if ('remove_item' in msg)
    return `remove the stored item "${clip(msg.remove_item.key)}"`;
  if ('transfer' in msg)
    return `send ${msg.transfer.amount} base units of token ${clip(contract)} to ${clip(msg.transfer.recipient)}`;
  if ('send' in msg)
    return msg.send.msg === DAODAO_CW20_STAKE_MSG
      ? `stake ${msg.send.amount} base units of token ${clip(contract)} in ${clip(msg.send.contract)}`
      : `put ${msg.send.amount} base units of token ${clip(contract)} into token swap ${clip(msg.send.contract)}`;
  if ('mint' in msg)
    return `mint ${msg.mint.amount} base units of governance token ${clip(contract)} to ${clip(msg.mint.recipient)}`;
  if ('transfer_nft' in msg)
    return `give NFT ${clip(msg.transfer_nft.token_id)} of collection ${clip(contract)} to ${clip(msg.transfer_nft.recipient)}`;
  if ('burn' in msg)
    return `burn NFT ${clip(msg.burn.token_id)} of collection ${clip(contract)}`;
  if ('fund' in msg)
    return `put ${funds.map(coinText).join(' + ')} into token swap ${clip(contract)}`;
  return `take the group’s tokens back out of token swap ${clip(contract)}`;
}
