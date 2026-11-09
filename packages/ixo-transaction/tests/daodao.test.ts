/**
 * The DAO DAO routes: the code ids against the SDK, the group the Portal
 * builds, the four proposal steps, what is refused, the Portal encoder's
 * bytes, and reading the group's address from the transaction's events.
 */
import { cosmos, cosmwasm, customQueries, utils } from '@ixo/impactxclient-sdk';
import { describe, expect, it } from 'vitest';

import {
  buildSignTransactionActionArgs,
  signIxoTransactionWithWallet,
} from '../src/action.js';
import { classifyIntent, resolveIntent } from '../src/intent.js';
import {
  buildDaoDaoGroupInstantiate,
  buildDaoDaoGroupLinkMessages,
  buildDaoDaoProposalMessage,
  findDaoDaoCoreAddress,
} from '../src/daodao.js';
import {
  DAODAO_CODE_IDS,
  DAODAO_CONTRACTS,
  DAODAO_DEFAULT_ALLOW_REVOTING,
  DAODAO_VOTING_PERIOD_SECONDS,
  DaoDaoContractAddressSchema,
} from '../src/daodao-schemas.js';
import { toEncodeObject } from '../src/react/proto.js';
import type { ITrxMsg, Network } from '../src/schemas.js';
import {
  describeValidationError,
  validateMessage,
  validateTransactionBatch,
  validateTransactionDraft,
} from '../src/validate.js';
import {
  describeDaoDaoProposalAction,
  describeMessageValues,
} from '../src/describe.js';
import { findMessageByRoute } from '../src/catalog.js';
import { daoDaoProposalActions } from '../src/daodao-schemas.js';
import {
  CORE,
  MEMBER_1,
  MEMBER_2,
  MEMBER_3,
  PRE_PROPOSE,
  PROPOSAL_MODULE,
  SENDER,
  groupMessage,
  groupSend,
} from './daodao-fixtures.js';
import { acceptAllRisks } from './fixtures.js';

const NETWORKS: readonly Network[] = ['devnet', 'testnet', 'mainnet'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The refusal `validateMessage` gives, or 'accepted'. */
function refusal(
  message: unknown,
  context: { network?: Network } = { network: 'testnet' },
) {
  try {
    validateMessage(message, context);
  } catch (error) {
    return describeValidationError(error);
  }
  return 'accepted';
}

type Path = readonly (string | number)[];

function child(node: unknown, segment: string | number): unknown {
  if (Array.isArray(node) && typeof segment === 'number') return node[segment];
  if (isRecord(node) && typeof segment === 'string') return node[segment];
  throw new Error(`No ${String(segment)} in the message`);
}

/** The sample group message with the value at `path` replaced. */
function editedGroup(path: Path, update: (old: unknown) => unknown): ITrxMsg {
  const message = structuredClone(groupMessage());
  const parent = path.slice(0, -1).reduce<unknown>(child, message.value);
  const last = path.at(-1);
  if (Array.isArray(parent) && typeof last === 'number') {
    parent[last] = update(parent[last]);
  } else if (isRecord(parent) && typeof last === 'string') {
    parent[last] = update(parent[last]);
  } else {
    throw new Error(`Cannot set ${path.join('.')}`);
  }
  return message;
}

const VOTING = ['msg', 'voting_module_instantiate_info'] as const;
const MEMBERS = [...VOTING, 'msg', 'initial_members'] as const;
const MODULE = ['msg', 'proposal_modules_instantiate_info', 0] as const;
const MODULE_MSG = [...MODULE, 'msg'] as const;
const INTAKE = [
  ...MODULE_MSG,
  'pre_propose_info',
  'module_may_propose',
  'info',
] as const;
const to = (value: unknown) => () => value;

function utf8Json(bytes: unknown): unknown {
  if (!(bytes instanceof Uint8Array)) throw new Error('msg is not bytes');
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe('DAO DAO code ids', () => {
  it.each(NETWORKS)('match the SDK getContractCode on %s', (network) => {
    for (const name of DAODAO_CONTRACTS) {
      const code = customQueries.contract.getContractCode(network, name);
      expect(code).toBeGreaterThan(0);
      expect(DAODAO_CODE_IDS[network][name]).toBe(code);
    }
  });
});

describe('create-group', () => {
  it.each(NETWORKS)(
    'builds and validates a membership group with the %s code ids',
    (network) => {
      const codes = DAODAO_CODE_IDS[network];
      const message = buildDaoDaoGroupInstantiate(network, {
        sender: SENDER,
        members: [MEMBER_1, MEMBER_2],
        threshold: 2,
        name: 'River Group',
        description: 'Looks after the river pumps',
      });
      expect(message).toEqual({
        typeUrl: '/cosmwasm.wasm.v1.MsgInstantiateContract',
        value: {
          sender: SENDER,
          admin: SENDER,
          codeId: String(codes.dao_core),
          label: `did:ixo:${SENDER}contract${codes.dao_core}`,
          funds: [],
          msg: {
            admin: null,
            automatically_add_cw20s: true,
            automatically_add_cw721s: true,
            description: 'Looks after the river pumps',
            name: 'River Group',
            proposal_modules_instantiate_info: [
              {
                admin: { core_module: {} },
                code_id: codes.dao_proposal_single,
                label: 'DAO_River Group_DaoProposalSingle',
                msg: {
                  allow_revoting: true,
                  close_proposal_on_execution_failure: true,
                  max_voting_period: { time: 604800 },
                  min_voting_period: null,
                  only_members_execute: true,
                  pre_propose_info: {
                    module_may_propose: {
                      info: {
                        admin: { core_module: {} },
                        code_id: codes.dao_pre_propose_single,
                        label: 'DAO_River Group_pre-propose-DaoProposalSingle',
                        msg: {
                          deposit_info: null,
                          extension: {},
                          open_proposal_submission: false,
                        },
                      },
                    },
                  },
                  threshold: { absolute_count: { threshold: '2' } },
                },
              },
            ],
            voting_module_instantiate_info: {
              admin: { core_module: {} },
              code_id: codes.dao_voting_cw4,
              label: 'DAO_River Group_DaoVotingCw4',
              msg: {
                cw4_group_code_id: codes.cw4_group,
                initial_members: [
                  { addr: MEMBER_1, weight: 1 },
                  { addr: MEMBER_2, weight: 1 },
                ],
              },
            },
          },
        },
      });

      expect(validateMessage(message, { network })).toEqual(message);
    },
  );

  it('builds no wasm admin when asked for none', () => {
    const message = buildDaoDaoGroupInstantiate('testnet', {
      sender: SENDER,
      members: [MEMBER_1],
      threshold: 1,
      name: 'Solo',
      description: 'One member',
      admin: 'none',
    });
    expect(message.value.admin).toBe('');
  });

  it('builds the voting time and vote changes the user chose, at both bounds', () => {
    const rules = (votingPeriodSeconds: number, allowRevoting: boolean) => {
      const message = buildDaoDaoGroupInstantiate('testnet', {
        sender: SENDER,
        members: [MEMBER_1, MEMBER_2],
        threshold: 1,
        name: 'Quick Group',
        description: 'Decides fast',
        votingPeriodSeconds,
        allowRevoting,
      });
      expect(validateMessage(message, { network: 'testnet' })).toEqual(message);
      const msg = message.value.msg;
      if (
        !isRecord(msg) ||
        !Array.isArray(msg.proposal_modules_instantiate_info)
      )
        throw new Error('no proposal module');
      const [module] = msg.proposal_modules_instantiate_info;
      if (!isRecord(module)) throw new Error('no proposal module');
      return module.msg;
    };
    expect(rules(DAODAO_VOTING_PERIOD_SECONDS.min, false)).toMatchObject({
      allow_revoting: false,
      max_voting_period: { time: 3_600 },
    });
    expect(rules(DAODAO_VOTING_PERIOD_SECONDS.max, true)).toMatchObject({
      allow_revoting: true,
      max_voting_period: { time: 2_592_000 },
    });
    expect(DAODAO_VOTING_PERIOD_SECONDS.default).toBe(604_800);
    expect(DAODAO_DEFAULT_ALLOW_REVOTING).toBe(true);
  });

  it.each([
    [DAODAO_VOTING_PERIOD_SECONDS.min - 1, /Voting lasts at least 1 hour/],
    [DAODAO_VOTING_PERIOD_SECONDS.max + 1, /Voting lasts at most 30 days/],
    [3_600.5, /whole number of seconds/],
  ])(
    'refuses builder input with a voting time of %s seconds',
    (seconds, expected) => {
      expect(() =>
        buildDaoDaoGroupInstantiate('testnet', {
          sender: SENDER,
          members: [MEMBER_1],
          threshold: 1,
          name: 'Odd Group',
          description: 'Voting time out of bounds',
          votingPeriodSeconds: seconds,
        }),
      ).toThrow(expected);
    },
  );

  it('refuses a group without the network to check its code ids against', () => {
    expect(refusal(groupMessage(), {})).toMatch(/network is required/);
  });

  it.each([
    [
      'a dao_core code id that is not the network’s',
      ['codeId'],
      to('4'),
      /^codeId: Expected the testnet dao_core code id 3/,
    ],
    [
      'a voting module code id',
      [...VOTING, 'code_id'],
      to(21),
      /voting_module_instantiate_info\.code_id: Expected the testnet dao_voting_cw4 code id 20/,
    ],
    [
      'a member list code id',
      [...VOTING, 'msg', 'cw4_group_code_id'],
      to(1),
      /cw4_group_code_id: Expected the testnet cw4_group code id 24/,
    ],
    [
      'a proposal module code id',
      [...MODULE, 'code_id'],
      to(15),
      /proposal_modules_instantiate_info\.0\.code_id: Expected the testnet dao_proposal_single code id 16/,
    ],
    [
      'an intake code id',
      [...INTAKE, 'code_id'],
      to(12),
      /info\.code_id: Expected the testnet dao_pre_propose_single code id 13/,
    ],
    [
      'a second proposal module',
      ['msg', 'proposal_modules_instantiate_info'],
      (old: unknown) =>
        Array.isArray(old) ? [...old, structuredClone(old[0])] : old,
      /exactly one proposal module/,
    ],
    [
      'funds',
      ['funds'],
      to([{ denom: 'uixo', amount: '1' }]),
      /^funds: A DAO DAO message here sends no funds/,
    ],
    [
      'a duplicate member',
      [...MEMBERS, 1, 'addr'],
      to(MEMBER_1),
      /initial_members\.1\.addr: Each member is listed once/,
    ],
    [
      'a member address with a bad checksum',
      [...MEMBERS, 0, 'addr'],
      to(`${MEMBER_1.slice(0, -1)}${MEMBER_1.endsWith('q') ? 'p' : 'q'}`),
      /initial_members\.0\.addr: Expected a lowercase 20-byte/,
    ],
    [
      'a contract as a member',
      [...MEMBERS, 0, 'addr'],
      to(CORE),
      /initial_members\.0\.addr: Expected a lowercase 20-byte/,
    ],
    ['no members', MEMBERS, to([]), /at least one member/],
    [
      'a member weight other than 1',
      [...MEMBERS, 0, 'weight'],
      to(5),
      /initial_members\.0\.weight/,
    ],
    [
      'a threshold above the number of members',
      [...MODULE_MSG, 'threshold', 'absolute_count', 'threshold'],
      to('4'),
      /threshold: The threshold is at most the number of members \(3\)/,
    ],
    [
      'a threshold of 0',
      [...MODULE_MSG, 'threshold', 'absolute_count', 'threshold'],
      to('0'),
      /absolute_count\.threshold/,
    ],
    [
      'a percentage threshold',
      [...MODULE_MSG, 'threshold'],
      to({ absolute_percentage: { percentage: { majority: {} } } }),
      /threshold/,
    ],
    [
      'a voting time under 1 hour',
      [...MODULE_MSG, 'max_voting_period', 'time'],
      to(3_599),
      /max_voting_period\.time: Voting lasts at least 1 hour \(3600 seconds\)/,
    ],
    [
      'a voting time over 30 days',
      [...MODULE_MSG, 'max_voting_period', 'time'],
      to(2_592_001),
      /max_voting_period\.time: Voting lasts at most 30 days \(2592000 seconds\)/,
    ],
    [
      'a voting time in blocks',
      [...MODULE_MSG, 'max_voting_period'],
      to({ height: 1000 }),
      /max_voting_period/,
    ],
    [
      'vote changes that are not a yes or no',
      [...MODULE_MSG, 'allow_revoting'],
      to('yes'),
      /allow_revoting/,
    ],
    [
      'a minimum voting time',
      [...MODULE_MSG, 'min_voting_period'],
      to({ time: 3_600 }),
      /min_voting_period/,
    ],
    [
      'a proposal deposit',
      [...INTAKE, 'msg', 'deposit_info'],
      to({
        amount: '1000000',
        denom: { token: { denom: { native: 'uixo' } } },
        refund_policy: 'only_passed',
      }),
      /deposit_info/,
    ],
    [
      'proposals from anyone',
      [...MODULE_MSG, 'pre_propose_info'],
      to({ anyone: {} }),
      /pre_propose_info/,
    ],
    [
      'an unknown key',
      ['msg', 'dao_uri'],
      to('https://example.org'),
      /dao_uri/,
    ],
    [
      'another wasm admin',
      ['admin'],
      to(MEMBER_2),
      /^admin: The wasm admin can migrate the group without a vote/,
    ],
    ['a core admin', ['msg', 'admin'], to(MEMBER_2), /^msg\.admin/],
    [
      'a module label that does not follow the name',
      [...VOTING, 'label'],
      to('DAO_Other_DaoVotingCw4'),
      /voting_module_instantiate_info\.label: Expected DAO_River Group_DaoVotingCw4/,
    ],
    [
      'a name on two lines',
      ['msg', 'name'],
      to('River\nGroup'),
      /^msg\.name: Plain text on one line/,
    ],
    [
      'a name longer than 64',
      ['msg', 'name'],
      to('n'.repeat(65)),
      /^msg\.name/,
    ],
    [
      'a description with a zero-width character',
      ['msg', 'description'],
      to('Looks after\u200b the pumps'),
      /^msg\.description: Plain text on one line/,
    ],
  ] as const)('refuses %s', (_name, path, update, expected) => {
    expect(refusal(editedGroup(path, update))).toMatch(expected);
  });

  it('refuses builder input it would not sign', () => {
    expect(() =>
      buildDaoDaoGroupInstantiate('testnet', {
        sender: SENDER,
        members: [MEMBER_1, MEMBER_1],
        threshold: 1,
        name: 'Twice',
        description: 'Same member twice',
      }),
    ).toThrow(/Each member is listed once/);
    expect(() =>
      buildDaoDaoGroupInstantiate('testnet', {
        sender: SENDER,
        members: [MEMBER_1],
        threshold: 2,
        name: 'Too high',
        description: 'Threshold above members',
      }),
    ).toThrow(/at most the number of members/);
    expect(() =>
      buildDaoDaoGroupInstantiate('testnet', {
        sender: SENDER,
        members: [MEMBER_1],
        threshold: 1.5,
        name: 'Fraction',
        description: 'Not a whole number',
      }),
    ).toThrow(/threshold/);
  });

  it('encodes exactly the bytes of the Portal’s multisig group message', () => {
    const codes = DAODAO_CODE_IDS.testnet;
    const members = [MEMBER_1, MEMBER_2, MEMBER_3].map((addr) => ({
      addr,
      weight: 1,
    }));
    // `createMultisigGroupMessage` of ixo-portal (origin/main), verbatim,
    // for these inputs.
    const portalMsg = {
      admin: null,
      automatically_add_cw20s: true,
      automatically_add_cw721s: true,
      description: 'Looks after the river pumps',
      image_url: undefined,
      name: 'River Group',
      proposal_modules_instantiate_info: [
        {
          admin: { core_module: {} },
          code_id: codes.dao_proposal_single,
          label: 'DAO_River Group_DaoProposalSingle',
          msg: utils.conversions.jsonToBase64({
            allow_revoting: true,
            close_proposal_on_execution_failure: true,
            max_voting_period: { time: 604800 },
            min_voting_period: null,
            only_members_execute: true,
            pre_propose_info: {
              module_may_propose: {
                info: {
                  admin: { core_module: {} },
                  code_id: codes.dao_pre_propose_single,
                  label: 'DAO_River Group_pre-propose-DaoProposalSingle',
                  msg: utils.conversions.jsonToBase64({
                    deposit_info: null,
                    extension: {},
                    open_proposal_submission: false,
                  }),
                },
              },
            },
            threshold: { absolute_count: { threshold: '2' } },
          }),
        },
      ],
      voting_module_instantiate_info: {
        admin: { core_module: {} },
        code_id: codes.dao_voting_cw4,
        label: 'DAO_River Group_DaoVotingCw4',
        msg: utils.conversions.jsonToBase64({
          cw4_group_code_id: codes.cw4_group,
          initial_members: members,
        }),
      },
    };
    const codec = cosmwasm.wasm.v1.MsgInstantiateContract;
    const portal = codec.fromPartial({
      admin: SENDER,
      // `Long.fromNumber(daoCoreContractCode)` in the Portal.
      codeId: codec.fromJSON({ codeId: String(codes.dao_core) }).codeId,
      funds: [],
      label: `did:ixo:${SENDER}contract${codes.dao_core}`,
      msg: utils.conversions.JsonToArray(JSON.stringify(portalMsg)),
      sender: SENDER,
    });

    const encoded = toEncodeObject(
      validateMessage(groupMessage(), { network: 'testnet' }),
    );
    expect(encoded.typeUrl).toBe('/cosmwasm.wasm.v1.MsgInstantiateContract');
    const encoder: { encode(message: unknown): { finish(): Uint8Array } } =
      codec;
    expect(encoder.encode(encoded.value).finish()).toEqual(
      codec.encode(portal).finish(),
    );

    // The module messages are JSON the contracts read, as Binary (base64).
    const value = encoded.value;
    if (!isRecord(value)) throw new Error('no value');
    const json = utf8Json(value.msg);
    if (!isRecord(json)) throw new Error('msg is not a JSON object');
    const voting = json.voting_module_instantiate_info;
    if (!isRecord(voting) || typeof voting.msg !== 'string') {
      throw new Error('voting module msg is not a Binary');
    }
    expect(JSON.parse(atob(voting.msg))).toEqual({
      cw4_group_code_id: 24,
      initial_members: members,
    });
  });
});

describe('proposal steps', () => {
  it('builds each step in the shapes the Portal and the Auth Hub send', () => {
    expect(
      buildDaoDaoProposalMessage({
        action: 'vote',
        sender: MEMBER_1,
        proposalModule: PROPOSAL_MODULE,
        proposalId: 3,
        vote: 'no',
        rationale: 'Too expensive',
      }).value,
    ).toEqual({
      sender: MEMBER_1,
      contract: PROPOSAL_MODULE,
      msg: { vote: { proposal_id: 3, vote: 'no', rationale: 'Too expensive' } },
      funds: [],
    });
    expect(
      buildDaoDaoProposalMessage({
        action: 'vote',
        sender: MEMBER_1,
        proposalModule: PROPOSAL_MODULE,
        proposalId: 3,
        vote: 'abstain',
      }).value.msg,
    ).toEqual({ vote: { proposal_id: 3, vote: 'abstain', rationale: null } });
    expect(
      buildDaoDaoProposalMessage({
        action: 'execute',
        sender: MEMBER_1,
        proposalModule: PROPOSAL_MODULE,
        proposalId: 7,
      }).value.msg,
    ).toEqual({ execute: { proposal_id: 7 } });
    expect(
      buildDaoDaoProposalMessage({
        action: 'close',
        sender: MEMBER_1,
        proposalModule: PROPOSAL_MODULE,
        proposalId: 7,
      }).value.msg,
    ).toEqual({ close: { proposal_id: 7 } });
    expect(
      buildDaoDaoProposalMessage({
        action: 'propose',
        sender: MEMBER_1,
        contract: PRE_PROPOSE,
        title: 'Agree the plan',
        description: 'Agreement only',
      }).value,
    ).toEqual({
      sender: MEMBER_1,
      contract: PRE_PROPOSE,
      msg: {
        propose: {
          msg: {
            propose: {
              title: 'Agree the plan',
              description: 'Agreement only',
              msgs: [],
            },
          },
        },
      },
      funds: [],
    });
    expect(
      buildDaoDaoProposalMessage({
        action: 'propose',
        via: 'proposal-module',
        sender: MEMBER_1,
        contract: PROPOSAL_MODULE,
        title: 'Agree the plan',
        description: 'Agreement only',
        actions: [groupSend()],
      }).value.msg,
    ).toEqual({
      propose: {
        title: 'Agree the plan',
        description: 'Agreement only',
        msgs: [
          {
            stargate: {
              type_url: groupSend().typeUrl,
              value: groupSend().value,
            },
          },
        ],
        proposer: null,
      },
    });
  });

  it.each([
    ['propose', '/ixo daodao propose'],
    ['vote', '/ixo daodao vote'],
    ['execute', '/ixo daodao execute'],
    ['close', '/ixo group close'],
  ] as const)('validates %s as its own route', (action, command) => {
    const message = buildDaoDaoProposalMessage(
      action === 'propose'
        ? {
            action,
            sender: MEMBER_1,
            contract: PRE_PROPOSE,
            title: 'Pay the repairer',
            description: 'The group sends 500 IXO',
            actions: [groupSend()],
          }
        : action === 'vote'
          ? {
              action,
              sender: MEMBER_1,
              proposalModule: PROPOSAL_MODULE,
              proposalId: 1,
              vote: 'yes',
            }
          : {
              action,
              sender: MEMBER_1,
              proposalModule: PROPOSAL_MODULE,
              proposalId: 1,
            },
    );
    const validated = validateTransactionDraft({
      command,
      value: message.value,
      network: 'testnet',
    });
    expect(validated.intent.action).toBe(action);
    expect(validated.message).toEqual(message);
    // The proposal carries a MsgSend of the group's funds (high).
    expect(validated.riskLevel).toBe(
      action === 'execute' || action === 'propose' ? 'high' : 'medium',
    );
  });

  const execute = (msg: unknown, contract: string = PROPOSAL_MODULE) => ({
    typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
    value: { sender: MEMBER_1, contract, msg, funds: [] },
  });
  const propose = (content: Record<string, unknown>) =>
    execute(
      {
        propose: {
          msg: {
            propose: {
              title: 'Pay the repairer',
              description: 'The group sends 500 IXO',
              msgs: [],
              ...content,
            },
          },
        },
      },
      PRE_PROPOSE,
    );

  it.each([
    [
      'an arbitrary contract message',
      execute({ transfer: { recipient: MEMBER_2, amount: '1' } }),
      /msg must have exactly one of propose, vote, execute, close/,
    ],
    [
      'a message with two steps',
      execute({ execute: { proposal_id: 1 }, close: { proposal_id: 1 } }),
      /msg must have exactly one of/,
    ],
    [
      'an account as the contract',
      execute({ execute: { proposal_id: 1 } }, MEMBER_2),
      /^contract: Expected a lowercase 32-byte/,
    ],
    [
      'funds',
      {
        ...execute({ close: { proposal_id: 1 } }),
        value: {
          sender: MEMBER_1,
          contract: PROPOSAL_MODULE,
          msg: { close: { proposal_id: 1 } },
          funds: [{ denom: 'uixo', amount: '1000000' }],
        },
      },
      /^funds: A DAO DAO message here sends no funds/,
    ],
    [
      'a vote option DAO DAO does not have',
      execute({ vote: { proposal_id: 1, vote: 'veto', rationale: null } }),
      /^msg\.vote\.vote/,
    ],
    [
      'a vote without its rationale key',
      execute({ vote: { proposal_id: 1, vote: 'yes' } }),
      /^msg\.vote\.rationale/,
    ],
    [
      'a rationale on two lines',
      execute({ vote: { proposal_id: 1, vote: 'yes', rationale: 'a\nb' } }),
      /^msg\.vote\.rationale: Plain text on one line/,
    ],
    [
      'proposal id 0',
      execute({ execute: { proposal_id: 0 } }),
      /^msg\.execute\.proposal_id/,
    ],
    [
      'a proposal id as text',
      execute({ close: { proposal_id: '3' } }),
      /^msg\.close\.proposal_id/,
    ],
    [
      'an extra key in a step',
      execute({ execute: { proposal_id: 1, force: true } }),
      /force/,
    ],
    ['a title longer than 100', propose({ title: 't'.repeat(101) }), /title/],
    [
      'a description longer than 300',
      propose({ description: 'd'.repeat(301) }),
      /description/,
    ],
    [
      'an action type a group proposal cannot hold',
      propose({
        msgs: [
          {
            stargate: {
              type_url: '/ixo.token.v1beta1.MsgMintToken',
              value: {},
            },
          },
        ],
      }),
      /msgs\.0\.stargate\.type_url: A proposal can only hold these actions/,
    ],
    [
      'an action that is not a valid catalog message',
      propose({
        msgs: [
          {
            stargate: {
              type_url: '/cosmos.bank.v1beta1.MsgSend',
              value: {
                fromAddress: CORE,
                toAddress: MEMBER_1,
                amount: [{ denom: 'uixo', amount: '1.5' }],
              },
            },
          },
        ],
      }),
      /msgs\.0\.stargate\.value: amount\.0\.amount/,
    ],
    [
      'an action from a person’s account instead of the group',
      propose({
        msgs: [
          {
            stargate: {
              type_url: groupSend().typeUrl,
              value: groupSend(MEMBER_1).value,
            },
          },
        ],
      }),
      /msgs\.0\.stargate\.value\.fromAddress: The group itself carries out the action/,
    ],
    [
      'actions from two different groups',
      propose({
        msgs: [
          {
            stargate: {
              type_url: groupSend().typeUrl,
              value: groupSend().value,
            },
          },
          {
            stargate: {
              type_url: groupSend().typeUrl,
              value: groupSend(PROPOSAL_MODULE).value,
            },
          },
        ],
      }),
      /msgs\.1\.stargate\.value\.fromAddress: Every action of a proposal names the same group/,
    ],
    [
      'more than 4 actions',
      propose({
        msgs: Array.from({ length: 5 }, () => ({
          stargate: { type_url: groupSend().typeUrl, value: groupSend().value },
        })),
      }),
      /msgs/,
    ],
    [
      'an encoded (opaque) action',
      propose({
        msgs: [
          { stargate: { type_url: groupSend().typeUrl, value: 'CgIveA==' } },
        ],
      }),
      /msgs\.0\.stargate\.value/,
    ],
    [
      'a proposer on a proposal through the intake',
      execute(
        {
          propose: {
            msg: {
              propose: {
                title: 'Pay the repairer',
                description: 'The group sends 500 IXO',
                msgs: [],
                proposer: MEMBER_1,
              },
            },
          },
        },
        PRE_PROPOSE,
      ),
      /proposer/,
    ],
  ] as const)('refuses %s', (_name, message, expected) => {
    expect(refusal(message)).toMatch(expected);
  });

  it('refuses a draft whose message is another step than its route', () => {
    const message = buildDaoDaoProposalMessage({
      action: 'execute',
      sender: MEMBER_1,
      proposalModule: PROPOSAL_MODULE,
      proposalId: 1,
    });
    expect(() =>
      validateTransactionDraft({
        command: '/ixo daodao vote',
        value: message.value,
        network: 'testnet',
      }),
    ).toThrow(/vote/);
  });

  it('encodes the step as the UTF-8 JSON the contract reads, no funds', () => {
    const vote = toEncodeObject(
      buildDaoDaoProposalMessage({
        action: 'vote',
        sender: MEMBER_1,
        proposalModule: PROPOSAL_MODULE,
        proposalId: 3,
        vote: 'yes',
      }),
    ).value;
    if (!isRecord(vote) || !(vote.msg instanceof Uint8Array)) {
      throw new Error('no msg bytes');
    }
    expect(new TextDecoder().decode(vote.msg)).toBe(
      '{"vote":{"proposal_id":3,"vote":"yes","rationale":null}}',
    );
    expect(vote.funds).toEqual([]);
    expect(vote.sender).toBe(MEMBER_1);
    expect(vote.contract).toBe(PROPOSAL_MODULE);
  });

  it('encodes each proposal action as a stargate message of its protobuf', () => {
    const encoded = toEncodeObject(
      buildDaoDaoProposalMessage({
        action: 'propose',
        sender: MEMBER_1,
        contract: PRE_PROPOSE,
        title: 'Pay the repairer',
        description: 'The group sends 500 IXO',
        actions: [groupSend()],
      }),
    ).value;
    if (!isRecord(encoded)) throw new Error('no value');
    const send = cosmos.bank.v1beta1.MsgSend;
    expect(utf8Json(encoded.msg)).toEqual({
      propose: {
        msg: {
          propose: {
            title: 'Pay the repairer',
            description: 'The group sends 500 IXO',
            msgs: [
              {
                stargate: {
                  type_url: '/cosmos.bank.v1beta1.MsgSend',
                  value: utils.conversions.Uint8ArrayTob64(
                    send.encode(send.fromJSON(groupSend().value)).finish(),
                  ),
                },
              },
            ],
          },
        },
      },
    });
  });
});

describe('the Portal handler and the batch path', () => {
  it('signs a group with the network the request names', async () => {
    const message = groupMessage();
    const args = buildSignTransactionActionArgs({
      command: '/ixo daodao create-group',
      value: message.value,
      network: 'testnet',
      riskConfirmation: acceptAllRisks('/ixo daodao create-group'),
    });
    const signed: ITrxMsg[][] = [];
    const result = await signIxoTransactionWithWallet(
      args,
      async (messages) => {
        signed.push([...messages]);
        return { code: 0, transactionHash: 'A'.repeat(64) };
      },
      { walletChainId: 'pandora-8' },
    );
    expect(result).toEqual({
      success: true,
      code: 0,
      transactionHash: 'A'.repeat(64),
    });
    expect(signed).toEqual([[message]]);
  });

  it('refuses a request whose intent names another step than its message', async () => {
    const args = buildSignTransactionActionArgs({
      command: '/ixo daodao execute',
      value: buildDaoDaoProposalMessage({
        action: 'execute',
        sender: MEMBER_1,
        proposalModule: PROPOSAL_MODULE,
        proposalId: 1,
      }).value,
      network: 'testnet',
      riskConfirmation: acceptAllRisks('/ixo daodao execute'),
    });
    const tampered = { ...args, intent: { ...args.intent, action: 'vote' } };
    let called = false;
    const result = await signIxoTransactionWithWallet(
      tampered,
      async () => {
        called = true;
        return { code: 0 };
      },
      { walletChainId: 'pandora-8' },
    );
    expect(called).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(
      /is \/ixo daodao execute, but the request names \/ixo daodao vote/,
    );
  });

  it('validates a batch with the batch’s network and per-route risks', () => {
    const validated = validateTransactionBatch(
      {
        messages: [groupMessage()],
        summary: 'Create the River Group',
        network: 'devnet',
      },
      {},
    );
    expect(validated.routes).toEqual([
      {
        module: 'daodao',
        action: 'create-group',
        messageName: 'MsgInstantiateContract',
        typeUrl: '/cosmwasm.wasm.v1.MsgInstantiateContract',
      },
    ]);
    expect(validated.riskLevel).toBe('high');
  });
});

describe('routing', () => {
  it('resolves the routes by slash command and alias', () => {
    expect(resolveIntent({ command: '/ixo daodao create-group' }).typeUrl).toBe(
      '/cosmwasm.wasm.v1.MsgInstantiateContract',
    );
    expect(resolveIntent({ command: '/ixo group vote' }).action).toBe('vote');
    expect(
      resolveIntent({ messageType: 'daodao', action: 'close' }).action,
    ).toBe('close');
  });

  it('names the routes for a typeUrl they share instead of picking one', () => {
    expect(() =>
      resolveIntent({ typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract' }),
    ).toThrow(
      /used by several routes: name one of \/ixo daodao propose, \/ixo daodao vote, \/ixo daodao execute, \/ixo daodao close/,
    );
    expect(() => classifyIntent('MsgExecuteContract')).toThrow();
    expect(
      resolveIntent({ typeUrl: '/cosmwasm.wasm.v1.MsgInstantiateContract' })
        .action,
    ).toBe('create-group');
  });

  it('routes plain requests, and refuses one two routes fit', () => {
    expect(classifyIntent('create a new multisig group').action).toBe(
      'create-group',
    );
    expect(classifyIntent('vote yes on proposal 3').action).toBe('vote');
    expect(classifyIntent('carry out the proposal').action).toBe('execute');
    expect(classifyIntent('close proposal 4').action).toBe('close');
    expect(classifyIntent('make a proposal to pay Thandi').action).toBe(
      'propose',
    );
    expect(() => classifyIntent('create a dao group')).toThrow(
      /Ambiguous IXO transaction intent/,
    );
  });
});

describe('findDaoDaoCoreAddress', () => {
  const instantiate = (address: string, codeId: number) => ({
    type: 'instantiate',
    attributes: [
      { key: '_contract_address', value: address },
      { key: 'code_id', value: String(codeId) },
      { key: 'msg_index', value: '0' },
    ],
  });
  const codes = DAODAO_CODE_IDS.testnet;

  it('reads the dao_core instantiate among the modules it made', () => {
    expect(
      findDaoDaoCoreAddress('testnet', {
        events: [
          {
            type: 'message',
            attributes: [
              {
                key: 'action',
                value: '/cosmwasm.wasm.v1.MsgInstantiateContract',
              },
            ],
          },
          instantiate(CORE, codes.dao_core),
          instantiate(PROPOSAL_MODULE, codes.dao_proposal_single),
          instantiate(PRE_PROPOSE, codes.dao_pre_propose_single),
          instantiate(MEMBER_1, codes.dao_voting_cw4),
          instantiate(MEMBER_2, codes.cw4_group),
        ],
      }),
    ).toBe(CORE);
  });

  it('reads an older response’s logs', () => {
    expect(
      findDaoDaoCoreAddress('mainnet', {
        logs: [
          { events: [instantiate(CORE, DAODAO_CODE_IDS.mainnet.dao_core)] },
        ],
      }),
    ).toBe(CORE);
  });

  it('is undefined without a dao_core instantiate, and refuses two groups', () => {
    expect(
      findDaoDaoCoreAddress('testnet', {
        events: [instantiate(PROPOSAL_MODULE, codes.dao_proposal_single)],
      }),
    ).toBeUndefined();
    expect(() =>
      findDaoDaoCoreAddress('testnet', {
        events: [
          instantiate(CORE, codes.dao_core),
          instantiate(PRE_PROPOSE, codes.dao_core),
        ],
      }),
    ).toThrow(/made 2 DAO DAO groups/);
  });
});

describe('buildDaoDaoGroupLinkMessages', () => {
  const ENTITY = 'did:ixo:entity:0123456789abcdef0123456789abcdef';

  it('links the group to the entity and makes it a controller, as the Portal does', () => {
    expect(buildDaoDaoGroupLinkMessages(ENTITY, CORE, SENDER)).toEqual([
      {
        typeUrl: '/ixo.iid.v1beta1.MsgAddLinkedEntity',
        value: {
          id: ENTITY,
          linkedEntity: {
            id: `{id}#${CORE}`,
            type: 'group',
            relationship: 'governs',
            service: '',
          },
          signer: SENDER,
        },
      },
      {
        typeUrl: '/ixo.iid.v1beta1.MsgAddController',
        value: {
          id: ENTITY,
          controllerDid: `did:ixo:wasm:${CORE}`,
          signer: SENDER,
        },
      },
    ]);
  });

  it('refuses an account as the group, and a linked {id}# that is no address', () => {
    expect(() =>
      buildDaoDaoGroupLinkMessages(ENTITY, MEMBER_1, SENDER),
    ).toThrow(/32-byte/);
    expect(
      refusal({
        typeUrl: '/ixo.iid.v1beta1.MsgAddLinkedEntity',
        value: {
          id: ENTITY,
          linkedEntity: {
            id: '{id}#somewhere',
            type: 'group',
            relationship: 'governs',
          },
          signer: SENDER,
        },
      }),
    ).toMatch(/^linkedEntity\.id/);
  });
});

describe('a POD’s group', () => {
  it('may have an empty description, as the Portal creates it', () => {
    const message = buildDaoDaoGroupInstantiate('devnet', {
      sender: SENDER,
      members: [SENDER],
      threshold: 1,
      name: 'Clean Water POD',
      description: '',
    });
    expect(message.value.msg).toMatchObject({ description: '' });
  });
});

describe('a live group creation', () => {
  it('reads the core from the events of devnet tx 79D0A70C… (height 16223733)', () => {
    // The instantiate events of that transaction, as the devnet LCD
    // returned them on 2026-11-09 (the creation was the tx's second message).
    const event = (address: string, codeId: string) => ({
      type: 'instantiate',
      attributes: [
        { key: '_contract_address', value: address },
        { key: 'code_id', value: codeId },
        { key: 'msg_index', value: '1' },
      ],
    });
    const core =
      'ixo12x96f89g2xgzlrtue6kmj6zgw9gpr3qssu7nq29szsyrphvlpetqrjt035';
    const events = [
      event(core, '3'),
      event(
        'ixo1set5zk9xj69s2t9zgqtx9y9xydkygp78fx7scu64fken74wqcz6q4d0cjz',
        '20',
      ),
      event(
        'ixo1kptpwzq8y4zcugnp6n925a4q2ndlepmyxgrv02jhh5zs2qphwmtqmh23fx',
        '24',
      ),
      event(
        'ixo1eta7p0f80rjtcv0qd29gjk8pkndrs6v258z7j2f6mr46zzj3arvstf3knm',
        '16',
      ),
      event(
        'ixo1wh436y9u9zwr3pp5wn7antfzwzc0kmwnq2vkjyds08k94u0vm32qexs27e',
        '13',
      ),
    ];
    expect(findDaoDaoCoreAddress('devnet', { events })).toBe(core);
    for (const { attributes } of events) {
      const address = attributes[0]?.value ?? '';
      expect(DaoDaoContractAddressSchema.safeParse(address).success).toBe(true);
    }
  });
});

describe('accepting the risks of a group word for word', () => {
  const risks = acceptAllRisks('/ixo daodao create-group').acceptedRisks;
  const groupDraft = (acceptedRisks: string[]) => ({
    command: '/ixo daodao create-group',
    value: groupMessage().value,
    network: 'testnet' as const,
    riskConfirmation: { confirmed: true, acceptedRisks },
  });

  it('reads typographic apostrophes and spacing as their plain forms', () => {
    expect(risks.some((risk) => risk.includes('’'))).toBe(true);
    const plain = risks.map((risk) =>
      risk.replace(/’/g, "'").replace(/ /g, '  '),
    );
    expect(() =>
      validateTransactionDraft(groupDraft(plain), {
        requireRiskConfirmation: true,
      }),
    ).not.toThrow();
  });

  it('still refuses a risk quoted with other words', () => {
    const changed = risks.map((risk) =>
      risk.replace('every member address', 'the member addresses'),
    );
    expect(() =>
      validateTransactionDraft(groupDraft(changed), {
        requireRiskConfirmation: true,
      }),
    ).toThrow(/word for word/);
  });
});

describe('a proposal discloses what its actions do', () => {
  const retire: ITrxMsg = {
    typeUrl: '/ixo.token.v1beta1.MsgRetireToken',
    value: {
      owner: CORE,
      tokens: [{ id: 'CARBON-1', amount: '10' }],
      jurisdiction: 'ZA',
      reason: 'Offset the 2026 pump diesel',
    },
  };
  const proposal = (actions: ITrxMsg[], via?: 'proposal-module') =>
    buildDaoDaoProposalMessage({
      action: 'propose',
      sender: MEMBER_1,
      contract: via ? PROPOSAL_MODULE : PRE_PROPOSE,
      ...(via ? { via } : {}),
      title: 'Pay and offset',
      description: 'The group pays the repairer and retires credits',
      actions,
    });
  const risksOf = (module: string, action: string) => {
    const spec = findMessageByRoute(module, action);
    if (!spec) throw new Error(`no /ixo ${module} ${action}`);
    return spec.risks;
  };
  const PROPOSE = risksOf('daodao', 'propose');
  const SEND = risksOf('bank', 'send');
  const RETIRE = risksOf('token', 'retire');

  it('reads the actions of either propose shape, and none of any other message', () => {
    for (const via of [undefined, 'proposal-module'] as const)
      expect(
        daoDaoProposalActions(proposal([groupSend(), retire], via)),
      ).toEqual([groupSend(), retire]);
    expect(daoDaoProposalActions(proposal([]))).toEqual([]);
    expect(daoDaoProposalActions(groupSend())).toEqual([]);
    expect(
      daoDaoProposalActions(
        buildDaoDaoProposalMessage({
          action: 'execute',
          sender: MEMBER_1,
          proposalModule: PROPOSAL_MODULE,
          proposalId: 3,
        }),
      ),
    ).toEqual([]);
  });

  it('adds each action’s risks and the highest level to a batch', () => {
    const validated = validateTransactionBatch({
      messages: [proposal([groupSend(), retire])],
      summary: 'Propose a payment and a retirement',
      network: 'testnet',
    });
    expect(validated.risks).toEqual([...PROPOSE, ...SEND, ...RETIRE]);
    expect(validated.riskLevel).toBe('critical');
    expect(validated.requiresConfirmation).toBe(true);
    // The routes stay the batch's own messages.
    expect(validated.routes.map((route) => route.action)).toEqual(['propose']);

    const agreement = validateTransactionBatch({
      messages: [proposal([])],
      summary: 'Ask for agreement',
      network: 'testnet',
    });
    expect(agreement.risks).toEqual(PROPOSE);
    expect(agreement.riskLevel).toBe('medium');
  });

  it('signs a proposal only once every action’s risk is accepted word for word', () => {
    const batch = (acceptedRisks: string[]) => ({
      messages: [proposal([groupSend(), retire])],
      summary: 'Propose a payment and a retirement',
      network: 'testnet' as const,
      riskConfirmation: { confirmed: true, acceptedRisks },
    });
    expect(() =>
      validateTransactionBatch(batch([...PROPOSE, ...SEND]), {
        requireRiskConfirmation: true,
      }),
    ).toThrow(
      `Risk confirmation required before signing the batch of 1 message: the user must accept, word for word, ${JSON.stringify(RETIRE[0])}`,
    );
    expect(() =>
      validateTransactionBatch(batch([...PROPOSE, ...SEND, ...RETIRE]), {
        requireRiskConfirmation: true,
      }),
    ).not.toThrow();

    const draft = (acceptedRisks: string[]) => ({
      command: '/ixo daodao propose',
      value: proposal([retire]).value,
      network: 'testnet' as const,
      riskConfirmation: { confirmed: true, acceptedRisks },
    });
    expect(() =>
      validateTransactionDraft(draft(PROPOSE), {
        requireRiskConfirmation: true,
      }),
    ).toThrow(/word for word, "Permanently retires \(burns\) impact credits/);
    const signed = validateTransactionDraft(draft([...PROPOSE, ...RETIRE]), {
      requireRiskConfirmation: true,
    });
    expect(signed.risks).toEqual([...PROPOSE, ...RETIRE]);
    expect(signed.riskLevel).toBe('critical');
  });

  it('words each action with its catalog values, the group’s own field left out', () => {
    expect(describeDaoDaoProposalAction(groupSend())).toBe(
      `MsgSend (to address ${MEMBER_1}, amount 500000000 uixo)`,
    );
    expect(describeDaoDaoProposalAction(retire)).toBe(
      'MsgRetireToken (tokens 10 of token CARBON-1, jurisdiction ZA, reason Offset the 2026 pump diesel)',
    );
    // Without `omit`, every catalog field; several coins joined.
    expect(
      describeMessageValues({
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: CORE,
          toAddress: MEMBER_1,
          amount: [
            { denom: 'uixo', amount: '5' },
            { denom: 'ibc/ABC', amount: '7' },
          ],
        },
      }),
    ).toBe(
      `MsgSend (from address ${CORE}, to address ${MEMBER_1}, amount 5 uixo + 7 ibc/ABC)`,
    );
    // A long value is clipped; a message the catalog lacks is its type url.
    expect(
      describeDaoDaoProposalAction({
        ...retire,
        value: { ...retire.value, reason: 'r'.repeat(500) },
      }),
    ).toMatch(/reason r{119}…\)$/);
    expect(describeMessageValues({ typeUrl: '/x.y.MsgZ', value: {} })).toBe(
      '/x.y.MsgZ',
    );
  });
});
