/**
 * The group actions a DAO DAO proposal may hold beyond the catalog
 * messages: each built from plain inputs, validated inside a proposal,
 * encoded exactly as the Portal's own proposal builder
 * (ixo-portal `lib/blocknote/transformActionsToMsgs.ts`) writes it, worded,
 * and refused when it is not that one shape.
 */
import { cosmos, utils } from '@ixo/impactxclient-sdk';
import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';

import {
  buildDaoDaoGroupAction,
  daoDaoGroupActionKind,
  type DaoDaoGroupActionInput,
  type DaoDaoProposalConfig,
} from '../src/daodao-actions.js';
import { buildDaoDaoProposalMessage } from '../src/daodao.js';
import {
  WASM_EXECUTE_TYPE_URL,
  daoDaoProposalActionList,
  type DaoDaoProposalAction,
} from '../src/daodao-schemas.js';
import { describeProposalAction } from '../src/describe.js';
import { toEncodeObject } from '../src/react/proto.js';
import type { ITrxMsg } from '../src/schemas.js';
import {
  describeValidationError,
  validateMessage,
  validateTransactionBatch,
} from '../src/validate.js';
import {
  CORE,
  MEMBER_1,
  MEMBER_2,
  PRE_PROPOSE,
  PROPOSAL_MODULE,
  groupSend,
} from './daodao-fixtures.js';

const contract = (fill: number) =>
  bech32.encodeFromBytes('ixo', new Uint8Array(32).fill(fill));
const validator = (fill: number) =>
  bech32.encodeFromBytes('ixovaloper', new Uint8Array(20).fill(fill));

const CW4 = contract(8);
const TOKEN = contract(9);
const STAKING = contract(10);
const NFTS = contract(11);
const SWAP = contract(12);
const SUB_DAO = contract(13);
const OTHER_GROUP = contract(14);
const VALIDATOR_1 = validator(15);
const VALIDATOR_2 = validator(16);
const EXPIRES = new Date('2027-11-26T10:00:00.123Z');

const PROPOSAL_CONFIG: DaoDaoProposalConfig = {
  threshold: { absolute_count: { threshold: '2' } },
  max_voting_period: { time: 604_800 },
  min_voting_period: null,
  only_members_execute: true,
  allow_revoting: true,
  dao: CORE,
  close_proposal_on_execution_failure: true,
};

/** Base64 of the UTF-8 JSON of a contract message, as the Portal's makeWasmMessage writes it. */
const binary = (msg: unknown) =>
  Buffer.from(JSON.stringify(msg)).toString('base64');
/** The Portal's `makeWasmMessage` of an execute. */
const portalExecute = (
  contractAddr: string,
  msg: unknown,
  funds: unknown[] = [],
) => ({
  wasm: { execute: { contract_addr: contractAddr, funds, msg: binary(msg) } },
});

type Case = {
  name: string;
  input: DaoDaoGroupActionInput;
  kind: string;
  riskLevel: string;
  /** What the Portal's builder writes for the same action, on chain. */
  portal: unknown;
  words: RegExp;
};

const CASES: Case[] = [
  {
    name: 'stake with a validator',
    input: {
      type: 'delegate',
      validator: VALIDATOR_1,
      amount: { amount: '1000000', denom: 'uixo' },
    },
    kind: 'delegate',
    riskLevel: 'medium',
    portal: {
      staking: {
        delegate: {
          amount: { amount: '1000000', denom: 'uixo' },
          validator: VALIDATOR_1,
        },
      },
    },
    words: /^stake 1000000 uixo with validator ixovaloper1/,
  },
  {
    name: 'unstake',
    input: {
      type: 'undelegate',
      validator: VALIDATOR_1,
      amount: { amount: '5', denom: 'uixo' },
    },
    kind: 'undelegate',
    riskLevel: 'medium',
    portal: {
      staking: {
        undelegate: {
          amount: { amount: '5', denom: 'uixo' },
          validator: VALIDATOR_1,
        },
      },
    },
    words: /^unstake 5 uixo/,
  },
  {
    name: 'move stake',
    input: {
      type: 'redelegate',
      fromValidator: VALIDATOR_1,
      toValidator: VALIDATOR_2,
      amount: { amount: '7', denom: 'uixo' },
    },
    kind: 'redelegate',
    riskLevel: 'medium',
    portal: {
      staking: {
        redelegate: {
          amount: { amount: '7', denom: 'uixo' },
          src_validator: VALIDATOR_1,
          dst_validator: VALIDATOR_2,
        },
      },
    },
    words: /^move 7 uixo of stake/,
  },
  {
    name: 'claim rewards',
    input: { type: 'withdraw-rewards', validator: VALIDATOR_1 },
    kind: 'withdraw-rewards',
    riskLevel: 'low',
    portal: {
      distribution: { withdraw_delegator_reward: { validator: VALIDATOR_1 } },
    },
    words: /^claim the staking rewards/,
  },
  {
    name: 'update members',
    input: {
      type: 'update-members',
      cw4Group: CW4,
      add: [{ addr: MEMBER_2, weight: 1 }],
      remove: [MEMBER_1],
    },
    kind: 'update-members',
    riskLevel: 'high',
    portal: portalExecute(CW4, {
      update_members: {
        add: [{ addr: MEMBER_2, weight: 1 }],
        remove: [MEMBER_1],
      },
    }),
    words: /^change the members: add or set .* \(weight 1\); remove /,
  },
  {
    name: 'update info',
    input: {
      type: 'update-info',
      group: CORE,
      current: {
        name: 'River Group',
        description: 'Looks after the river pumps',
        image_url: null,
        automatically_add_cw20s: true,
        automatically_add_cw721s: true,
        dao_uri: null,
      },
      name: 'River Pumps',
      imageUrl: ' https://example.org/pump.png ',
    },
    kind: 'update-info',
    riskLevel: 'medium',
    portal: portalExecute(CORE, {
      update_config: {
        config: {
          name: 'River Pumps',
          description: 'Looks after the river pumps',
          image_url: 'https://example.org/pump.png',
          automatically_add_cw20s: true,
          automatically_add_cw721s: true,
          dao_uri: null,
        },
      },
    }),
    words: /^set the group’s details: name "River Pumps"/,
  },
  {
    name: 'voting rules',
    input: {
      type: 'update-voting-rules',
      proposalModule: PROPOSAL_MODULE,
      current: PROPOSAL_CONFIG,
      passRule: { type: 'percent', percent: 51 },
      quorum: { type: 'majority' },
      votingPeriodSeconds: 86_400 * 3,
      allowRevoting: false,
    },
    kind: 'update-voting-rules',
    riskLevel: 'high',
    portal: portalExecute(PROPOSAL_MODULE, {
      update_config: {
        threshold: {
          threshold_quorum: {
            quorum: { majority: {} },
            threshold: { percent: '0.51' },
          },
        },
        max_voting_period: { time: 259_200 },
        min_voting_period: null,
        only_members_execute: true,
        allow_revoting: false,
        dao: CORE,
        close_proposal_on_execution_failure: true,
      },
    }),
    words:
      /^set the voting rules: a proposal passes with 51% yes of the votes cast, with at least a majority of the voting power voting; voting lasts 3 days; votes cannot be changed/,
  },
  {
    name: 'who can propose',
    input: {
      type: 'update-submission-rules',
      intake: PRE_PROPOSE,
      current: { deposit_info: null, open_proposal_submission: false },
      anyoneCanPropose: true,
      deposit: {
        amount: '1000',
        denom: { token: { denom: { native: 'uixo' } } },
        refund_policy: 'only_passed',
      },
    },
    kind: 'update-submission-rules',
    riskLevel: 'high',
    portal: portalExecute(PRE_PROPOSE, {
      update_config: {
        deposit_info: {
          amount: '1000',
          denom: { token: { denom: { native: 'uixo' } } },
          refund_policy: 'only_passed',
        },
        open_proposal_submission: true,
      },
    }),
    words: /^set who can propose: anyone, with a deposit of 1000 uixo/,
  },
  {
    name: 'sub-DAOs',
    input: {
      type: 'manage-sub-daos',
      group: CORE,
      add: [{ addr: SUB_DAO, charter: 'Runs the pumps' }],
      remove: [],
    },
    kind: 'manage-sub-daos',
    riskLevel: 'medium',
    portal: portalExecute(CORE, {
      update_sub_daos: {
        to_add: [{ addr: SUB_DAO, charter: 'Runs the pumps' }],
        to_remove: [],
      },
    }),
    words: /^change the sub-DAOs: add /,
  },
  {
    name: 'token list',
    input: { type: 'manage-token-list', group: CORE, add: [TOKEN], remove: [] },
    kind: 'manage-token-list',
    riskLevel: 'low',
    portal: portalExecute(CORE, {
      update_cw20_list: { to_add: [TOKEN], to_remove: [] },
    }),
    words: /^change the tracked tokens: add /,
  },
  {
    name: 'NFT list',
    input: { type: 'manage-nft-list', group: CORE, add: [], remove: [NFTS] },
    kind: 'manage-nft-list',
    riskLevel: 'low',
    portal: portalExecute(CORE, {
      update_cw721_list: { to_add: [], to_remove: [NFTS] },
    }),
    words: /^change the tracked NFT collections: remove /,
  },
  {
    name: 'store an item',
    input: { type: 'set-item', group: CORE, key: 'theme', value: 'blue' },
    kind: 'set-item',
    riskLevel: 'medium',
    portal: portalExecute(CORE, { set_item: { key: 'theme', value: 'blue' } }),
    words: /^store "blue" under "theme"/,
  },
  {
    name: 'remove an item',
    input: { type: 'remove-item', group: CORE, key: 'theme' },
    kind: 'remove-item',
    riskLevel: 'medium',
    portal: portalExecute(CORE, { remove_item: { key: 'theme' } }),
    words: /^remove the stored item "theme"/,
  },
  {
    name: 'send group tokens',
    input: {
      type: 'send-group-tokens',
      token: TOKEN,
      recipient: MEMBER_1,
      amount: '250',
    },
    kind: 'send-group-tokens',
    riskLevel: 'high',
    portal: portalExecute(TOKEN, {
      transfer: { recipient: MEMBER_1, amount: '250' },
    }),
    words: /^send 250 base units of token /,
  },
  {
    name: 'stake to group',
    input: {
      type: 'stake-to-group',
      token: TOKEN,
      stakingContract: STAKING,
      amount: '90',
    },
    kind: 'stake-to-group',
    riskLevel: 'medium',
    portal: {
      wasm: {
        execute: {
          contract_addr: TOKEN,
          funds: [],
          msg: binary({
            send: {
              amount: '90',
              contract: STAKING,
              // The Portal: btoa('{"stake": {}}'), with its space.
              msg: btoa('{"stake": {}}'),
            },
          }),
        },
      },
    },
    words: /^stake 90 base units of token /,
  },
  {
    name: 'mint',
    input: {
      type: 'mint-group-tokens',
      token: TOKEN,
      recipient: MEMBER_2,
      amount: '1000',
    },
    kind: 'mint-group-tokens',
    riskLevel: 'high',
    portal: portalExecute(TOKEN, {
      mint: { recipient: MEMBER_2, amount: '1000' },
    }),
    words: /^mint 1000 base units of governance token /,
  },
  {
    name: 'transfer an NFT',
    input: {
      type: 'transfer-nft',
      collection: NFTS,
      recipient: MEMBER_1,
      tokenId: '42',
    },
    kind: 'transfer-nft',
    riskLevel: 'high',
    portal: portalExecute(NFTS, {
      transfer_nft: { recipient: MEMBER_1, token_id: '42' },
    }),
    words: /^give NFT 42 of collection /,
  },
  {
    name: 'burn an NFT',
    input: { type: 'burn-nft', collection: NFTS, tokenId: '42' },
    kind: 'burn-nft',
    riskLevel: 'critical',
    portal: portalExecute(NFTS, { burn: { token_id: '42' } }),
    words: /^burn NFT 42 of collection /,
  },
  {
    name: 'fund a swap with native coins',
    input: {
      type: 'token-swap-fund',
      swapContract: SWAP,
      pay: { native: { amount: '300', denom: 'uixo' } },
    },
    kind: 'token-swap-fund',
    riskLevel: 'high',
    // The Portal: coins(amount, denom) as funds, `{ fund: {} }`.
    portal: portalExecute(SWAP, { fund: {} }, [
      { amount: '300', denom: 'uixo' },
    ]),
    words: /^put 300 uixo into token swap /,
  },
  {
    name: 'fund a swap with a cw20',
    input: {
      type: 'token-swap-fund',
      swapContract: SWAP,
      pay: { cw20: { token: TOKEN, amount: '12' } },
    },
    kind: 'token-swap-fund',
    riskLevel: 'high',
    portal: portalExecute(TOKEN, {
      send: {
        amount: '12',
        contract: SWAP,
        msg: Buffer.from(
          JSON.stringify({ ixo_initiate_token_swap: {} }),
        ).toString('base64'),
      },
    }),
    words: /^put 12 base units of token .* into token swap /,
  },
  {
    name: 'withdraw from a swap',
    input: { type: 'token-swap-withdraw', swapContract: SWAP },
    kind: 'token-swap-withdraw',
    riskLevel: 'medium',
    portal: portalExecute(SWAP, { withdraw: {} }),
    words: /^take the group’s tokens back out of token swap /,
  },
  {
    name: 'change a contract’s admin',
    input: { type: 'update-admin', contract: TOKEN, admin: MEMBER_1 },
    kind: 'update-admin',
    riskLevel: 'critical',
    portal: {
      wasm: { update_admin: { contract_addr: TOKEN, admin: MEMBER_1 } },
    },
    words: /^make .* the admin of contract /,
  },
  {
    name: 'vote on a network proposal',
    input: { type: 'gov-vote', group: CORE, proposalId: '17', option: 'yes' },
    kind: 'gov-vote',
    riskLevel: 'medium',
    // The Portal's stargate MsgVote, with the group as the voter.
    portal: {
      stargate: {
        type_url: '/cosmos.gov.v1beta1.MsgVote',
        value: Buffer.from(
          cosmos.gov.v1beta1.MsgVote.encode(
            // The Portal: `proposalId: Long.fromString(...)`, the vote as its number.
            cosmos.gov.v1beta1.MsgVote.fromJSON({
              proposalId: '17',
              voter: CORE,
              option: 1,
            }),
          ).finish(),
        ).toString('base64'),
      },
    },
    words: /^vote YES on network proposal 17$/,
  },
  {
    name: 'give a permission',
    input: {
      type: 'authz-grant',
      group: CORE,
      grantee: MEMBER_1,
      msgTypeUrl: '/cosmos.bank.v1beta1.MsgSend',
      expiration: EXPIRES,
    },
    kind: 'authz-grant',
    riskLevel: 'critical',
    portal: {
      stargate: {
        type_url: '/cosmos.authz.v1beta1.MsgGrant',
        value: Buffer.from(
          cosmos.authz.v1beta1.MsgGrant.encode(
            cosmos.authz.v1beta1.MsgGrant.fromPartial({
              grant: {
                authorization: {
                  typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
                  value: cosmos.authz.v1beta1.GenericAuthorization.encode({
                    msg: '/cosmos.bank.v1beta1.MsgSend',
                  }).finish(),
                },
                expiration: utils.proto.toTimestamp(EXPIRES),
              },
              grantee: MEMBER_1,
              granter: CORE,
            }),
          ).finish(),
        ).toString('base64'),
      },
    },
    words:
      /^let .* send \/cosmos\.bank\.v1beta1\.MsgSend as the group, without a vote, until 2027-11-26/,
  },
  {
    name: 'take back a permission',
    input: {
      type: 'authz-revoke',
      group: CORE,
      grantee: MEMBER_1,
      msgTypeUrl: '/cosmos.bank.v1beta1.MsgSend',
    },
    kind: 'authz-revoke',
    riskLevel: 'medium',
    portal: {
      stargate: {
        type_url: '/cosmos.authz.v1beta1.MsgRevoke',
        value: Buffer.from(
          cosmos.authz.v1beta1.MsgRevoke.encode(
            cosmos.authz.v1beta1.MsgRevoke.fromPartial({
              msgTypeUrl: '/cosmos.bank.v1beta1.MsgSend',
              grantee: MEMBER_1,
              granter: CORE,
            }),
          ).finish(),
        ).toString('base64'),
      },
    },
    words: /^stop .* sending \/cosmos\.bank\.v1beta1\.MsgSend as the group$/,
  },
];

function propose(actions: ReadonlyArray<ITrxMsg | DaoDaoProposalAction>) {
  return buildDaoDaoProposalMessage({
    action: 'propose',
    sender: MEMBER_1,
    contract: PRE_PROPOSE,
    title: 'Group business',
    description: 'What the group does next',
    actions,
  });
}

/** The proposal's actions as the contract reads them, from the Portal encoder's bytes. */
function chainActions(message: ITrxMsg): unknown[] {
  const encoded = toEncodeObject(message).value as { msg: Uint8Array };
  const msg = JSON.parse(new TextDecoder().decode(encoded.msg)) as {
    propose: { msg: { propose: { msgs: unknown[] } } };
  };
  return msg.propose.msg.propose.msgs;
}

/** A propose message whose actions are given in their decoded form, unchecked. */
function rawPropose(msgs: unknown[]): ITrxMsg {
  return {
    typeUrl: WASM_EXECUTE_TYPE_URL,
    value: {
      sender: MEMBER_1,
      contract: PRE_PROPOSE,
      msg: {
        propose: {
          msg: {
            propose: {
              title: 'Group business',
              description: 'What the group does next',
              msgs,
            },
          },
        },
      },
      funds: [],
    },
  };
}

function refusal(message: ITrxMsg): string {
  try {
    validateMessage(message);
    return 'accepted';
  } catch (error) {
    return describeValidationError(error);
  }
}

describe('group actions', () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s: built, validated in a proposal, of its kind and risk',
    (_name, c) => {
      const action = buildDaoDaoGroupAction(c.input);
      expect(daoDaoGroupActionKind(action)).toBe(c.kind);
      const message = propose([action]);
      expect(validateMessage(message)).toEqual(message);
      expect(daoDaoProposalActionList(message)).toEqual([action]);
      const batch = validateTransactionBatch({
        network: 'testnet',
        summary: 'A group proposal',
        messages: [message],
      });
      const levels = ['low', 'medium', 'high', 'critical'];
      // The proposal is medium; the action's level wins when it is higher.
      expect(batch.riskLevel).toBe(
        levels[Math.max(1, levels.indexOf(c.riskLevel))],
      );
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s: encoded exactly as the Portal writes it',
    (_name, c) => {
      const [chain] = chainActions(propose([buildDaoDaoGroupAction(c.input)]));
      expect(JSON.stringify(chain)).toBe(JSON.stringify(c.portal));
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s: worded with its values',
    (_name, c) => {
      expect(describeProposalAction(buildDaoDaoGroupAction(c.input))).toMatch(
        c.words,
      );
    },
  );

  it('holds catalog and group actions together, in order, all naming one group', () => {
    const message = propose([
      groupSend(),
      buildDaoDaoGroupAction({
        type: 'set-item',
        group: CORE,
        key: 'a',
        value: 'b',
      }),
      buildDaoDaoGroupAction({
        type: 'gov-vote',
        group: CORE,
        proposalId: '3',
        option: 'no',
      }),
    ]);
    expect(refusal(message)).toBe('accepted');
    const chain = chainActions(message);
    expect(Object.keys(chain[0] as object)).toEqual(['stargate']);
    expect(Object.keys(chain[1] as object)).toEqual(['wasm']);
    const batch = validateTransactionBatch({
      network: 'testnet',
      summary: 'A group proposal',
      messages: [message],
    });
    expect(batch.risks).toEqual(
      expect.arrayContaining([
        'Transfers tokens to another address.',
        'Writes a value into the group’s storage, which apps may read as its settings.',
        'Votes on a network governance proposal with the group’s staked tokens.',
      ]),
    );
  });

  it('keeps a voting rule it is not asked to change, and a 2.4+ list’s veto', () => {
    const veto = {
      vetoer: MEMBER_2,
      timelock_duration: { time: 3600 },
      early_execute: false,
      veto_before_passed: true,
    };
    const action = buildDaoDaoGroupAction({
      type: 'update-voting-rules',
      proposalModule: PROPOSAL_MODULE,
      current: { ...PROPOSAL_CONFIG, veto },
      passRule: { type: 'count', count: 3 },
    });
    expect(action).toEqual({
      wasm: {
        execute: {
          contract_addr: PROPOSAL_MODULE,
          funds: [],
          msg: {
            update_config: {
              ...PROPOSAL_CONFIG,
              threshold: { absolute_count: { threshold: '3' } },
              veto,
            },
          },
        },
      },
    });
  });

  it('keeps the intake’s deposit when only who can propose changes', () => {
    const action = buildDaoDaoGroupAction({
      type: 'update-submission-rules',
      intake: PRE_PROPOSE,
      current: {
        deposit_info: {
          amount: '5',
          denom: { cw20: TOKEN },
          refund_policy: 'always',
        },
        open_proposal_submission: true,
      },
      anyoneCanPropose: false,
    });
    expect(action).toMatchObject({
      wasm: {
        execute: {
          msg: {
            update_config: {
              deposit_info: {
                amount: '5',
                denom: { token: { denom: { cw20: TOKEN } } },
                refund_policy: 'always',
              },
              open_proposal_submission: false,
            },
          },
        },
      },
    });
  });
});

describe('group actions it refuses', () => {
  const execute = (
    contractAddr: string,
    msg: unknown,
    funds: unknown[] = [],
  ) => ({
    wasm: { execute: { contract_addr: contractAddr, funds, msg } },
  });

  it.each([
    [
      'any other contract message',
      execute(CORE, { execute_admin_msgs: { msgs: [] } }),
      /A group contract message: exactly one of update_members/,
    ],
    [
      'sending an NFT to a contract',
      execute(NFTS, {
        send_nft: { contract: SWAP, token_id: '1', msg: 'e30=' },
      }),
      /exactly one of/,
    ],
    [
      'a migrate',
      { wasm: { migrate: { contract_addr: TOKEN, new_code_id: 3, msg: {} } } },
      /A wasm action: exactly one of execute, update_admin/,
    ],
    [
      'an instantiate',
      { wasm: { instantiate: { code_id: 3, msg: {}, label: 'x', funds: [] } } },
      /A wasm action/,
    ],
    [
      'a cw20 send with any other message',
      execute(TOKEN, {
        send: { amount: '1', contract: SWAP, msg: btoa('{"anything":{}}') },
      }),
      /only stakes in the group or funds a token swap/,
    ],
    [
      'funds on a message that is not funding a swap',
      execute(TOKEN, { transfer: { recipient: MEMBER_1, amount: '1' } }, [
        { amount: '1', denom: 'uixo' },
      ]),
      /Only funding a token swap sends funds/,
    ],
    [
      'funding a swap without funds',
      execute(SWAP, { fund: {} }),
      /exactly one coin/,
    ],
    [
      'a member with a fractional weight',
      execute(CW4, {
        update_members: { add: [{ addr: MEMBER_1, weight: 1.5 }], remove: [] },
      }),
      /update_members\.add\.0\.weight/,
    ],
    [
      'a member listed twice',
      execute(CW4, {
        update_members: {
          add: [{ addr: MEMBER_1, weight: 1 }],
          remove: [MEMBER_1],
        },
      }),
      /listed twice/,
    ],
    [
      'a staking amount of 0',
      {
        staking: {
          delegate: {
            amount: { amount: '0', denom: 'uixo' },
            validator: VALIDATOR_1,
          },
        },
      },
      /greater than 0/,
    ],
    [
      'an account where a validator goes',
      {
        staking: {
          delegate: {
            amount: { amount: '1', denom: 'uixo' },
            validator: MEMBER_1,
          },
        },
      },
      /ixovaloper1/,
    ],
    [
      'a 2.0.3 intake config with a submission policy',
      execute(PRE_PROPOSE, {
        update_config: {
          deposit_info: null,
          submission_policy: { anyone: { denylist: [] } },
        },
      }),
      /submission_policy/,
    ],
    [
      'a permission the group gives itself',
      {
        stargate: {
          type_url: '/cosmos.authz.v1beta1.MsgGrant',
          value: {
            granter: CORE,
            grantee: CORE,
            grant: {
              authorization: {
                typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
                value: { msg: '/cosmos.bank.v1beta1.MsgSend' },
              },
              expiration: EXPIRES.toISOString(),
            },
          },
        },
      },
      /cannot give a permission to itself/,
    ],
    [
      'a send authorization (only a generic one)',
      {
        stargate: {
          type_url: '/cosmos.authz.v1beta1.MsgGrant',
          value: {
            granter: CORE,
            grantee: MEMBER_1,
            grant: {
              authorization: {
                typeUrl: '/cosmos.bank.v1beta1.SendAuthorization',
                value: { spendLimit: [{ denom: 'uixo', amount: '1' }] },
              },
              expiration: EXPIRES.toISOString(),
            },
          },
        },
      },
      /authorization\.typeUrl/,
    ],
    [
      'a network vote from an account',
      {
        stargate: {
          type_url: '/cosmos.gov.v1beta1.MsgVote',
          value: {
            proposalId: '1',
            voter: MEMBER_1,
            option: 'VOTE_OPTION_YES',
          },
        },
      },
      /voter/,
    ],
  ])('refuses %s', (_name, action, pattern) => {
    expect(refusal(rawPropose([action]))).toMatch(pattern);
  });

  it('refuses actions that name two different groups', () => {
    const message = rawPropose([
      execute(CORE, { set_item: { key: 'a', value: 'b' } }),
      {
        stargate: {
          type_url: '/cosmos.gov.v1beta1.MsgVote',
          value: {
            proposalId: '1',
            voter: OTHER_GROUP,
            option: 'VOTE_OPTION_YES',
          },
        },
      },
    ]);
    expect(refusal(message)).toMatch(
      /msgs\.1\.stargate\.value\.voter: Every action of a proposal names the same group/,
    );
  });

  it('refuses a voting-rules change for another group', () => {
    const rules = buildDaoDaoGroupAction({
      type: 'update-voting-rules',
      proposalModule: PROPOSAL_MODULE,
      current: { ...PROPOSAL_CONFIG, dao: OTHER_GROUP },
      allowRevoting: false,
    });
    let refused = 'accepted';
    try {
      propose([groupSend(), rules]);
    } catch (error) {
      refused = describeValidationError(error);
    }
    expect(refused).toMatch(
      /update_config\.dao: Every action of a proposal names the same group/,
    );
  });

  it('refuses builder input it would not sign', () => {
    expect(() =>
      buildDaoDaoGroupAction({
        type: 'update-voting-rules',
        proposalModule: PROPOSAL_MODULE,
        current: PROPOSAL_CONFIG,
        quorum: { type: 'majority' },
      }),
    ).toThrow(/count of yes votes, which has no quorum/);
    expect(() =>
      buildDaoDaoGroupAction({
        type: 'update-voting-rules',
        proposalModule: PROPOSAL_MODULE,
        current: PROPOSAL_CONFIG,
        passRule: { type: 'percent', percent: 0 },
      }),
    ).toThrow(/more than 0%/);
    expect(() =>
      buildDaoDaoGroupAction({
        type: 'update-members',
        cw4Group: CW4,
        add: [],
        remove: [],
      }),
    ).toThrow(/Add or remove at least one member/);
  });
});
