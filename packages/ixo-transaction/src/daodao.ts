import {
  DaoDaoContractAddressSchema,
  DAODAO_CODE_IDS,
  DAODAO_DEFAULT_ALLOW_REVOTING,
  DAODAO_VOTING_PERIOD_SECONDS,
  WASM_EXECUTE_TYPE_URL,
  WASM_INSTANTIATE_TYPE_URL,
  daoDaoModuleLabels,
  type DaoDaoCoreInstantiateMsg,
  type DaoDaoProposalAction,
  type DaoDaoVoteOption,
} from './daodao-schemas.js';
import type { ITrxMsg, Network } from './schemas.js';
import { validateMessage } from './validate.js';

export type DaoDaoGroupInstantiateInput = {
  /** The creating wallet: signs, pays the fee and is the default wasm admin. */
  sender: string;
  /** The members' 20-byte `ixo1…` account addresses, each with one vote. */
  members: readonly string[];
  /** How many yes votes pass a proposal: 1 to the number of members. */
  threshold: number;
  name: string;
  description: string;
  /**
   * The wasm admin of the group's core contract, which can migrate it
   * without a vote: `'sender'` (the Portal's choice, the default) or
   * `'none'`.
   */
  admin?: 'sender' | 'none';
  /**
   * How long each proposal is open for votes, in whole seconds, from
   * `DAODAO_VOTING_PERIOD_SECONDS.min` (1 hour) to `.max` (30 days).
   * Default 7 days, the Portal's.
   */
  votingPeriodSeconds?: number;
  /**
   * Whether members may change their vote until voting closes. Default
   * true, the Portal's: a proposal is then decided only when voting
   * closes. False: it passes (or fails) as soon as enough members voted,
   * and a vote cannot be changed.
   */
  allowRevoting?: boolean;
};

/**
 * The `create-group` message (catalog form) the Portal builds for a
 * multisig group (`lib/daodao/createMultisigGroupMessage.ts`): one
 * `dao_core` instantiate with a `dao_voting_cw4` voting module over a
 * `cw4_group` of the members (weight 1 each) and a `dao_proposal_single`
 * module (an absolute count of yes votes, 7 days to vote and vote changes
 * allowed unless the input chooses otherwise, only members carry out, a
 * failed carry-out closes the proposal) behind a `dao_pre_propose_single`
 * intake (members only, no deposit), with the network's code ids and no
 * funds. Validated before it is returned; throws when the input is refused
 * (a voting time out of bounds included).
 */
export function buildDaoDaoGroupInstantiate(
  network: Network,
  input: DaoDaoGroupInstantiateInput,
): ITrxMsg {
  const codes = DAODAO_CODE_IDS[network];
  const labels = daoDaoModuleLabels(input.name);
  const msg: DaoDaoCoreInstantiateMsg = {
    admin: null,
    automatically_add_cw20s: true,
    automatically_add_cw721s: true,
    description: input.description,
    name: input.name,
    proposal_modules_instantiate_info: [
      {
        admin: { core_module: {} },
        code_id: codes.dao_proposal_single,
        label: labels.proposal,
        msg: {
          allow_revoting: input.allowRevoting ?? DAODAO_DEFAULT_ALLOW_REVOTING,
          close_proposal_on_execution_failure: true,
          max_voting_period: {
            time:
              input.votingPeriodSeconds ?? DAODAO_VOTING_PERIOD_SECONDS.default,
          },
          min_voting_period: null,
          only_members_execute: true,
          pre_propose_info: {
            module_may_propose: {
              info: {
                admin: { core_module: {} },
                code_id: codes.dao_pre_propose_single,
                label: labels.prePropose,
                msg: {
                  deposit_info: null,
                  extension: {},
                  open_proposal_submission: false,
                },
              },
            },
          },
          threshold: {
            absolute_count: { threshold: String(input.threshold) },
          },
        },
      },
    ],
    voting_module_instantiate_info: {
      admin: { core_module: {} },
      code_id: codes.dao_voting_cw4,
      label: labels.voting,
      msg: {
        cw4_group_code_id: codes.cw4_group,
        initial_members: input.members.map((addr) => ({ addr, weight: 1 })),
      },
    },
  };
  return validateMessage(
    {
      typeUrl: WASM_INSTANTIATE_TYPE_URL,
      value: {
        sender: input.sender,
        admin: (input.admin ?? 'sender') === 'sender' ? input.sender : '',
        codeId: String(codes.dao_core),
        // The Portal's label: the creator's DID, "contract", the code id.
        label: `did:ixo:${input.sender}contract${codes.dao_core}`,
        msg,
        funds: [],
      },
    },
    { network },
  );
}

/** A group proposal step on a DAO DAO group, by `action`. */
export type DaoDaoProposalMessageInput =
  | {
      action: 'propose';
      sender: string;
      /**
       * The contract that takes the proposal: the group's intake
       * (pre-propose-single) for `via: 'pre-propose'`, the proposal module
       * itself for `via: 'proposal-module'` (a module without an intake).
       */
      contract: string;
      /** Default `'pre-propose'`: every group `create-group` makes has one. */
      via?: 'pre-propose' | 'proposal-module';
      title: string;
      description: string;
      /**
       * What the group's own account does if the proposal passes, as
       * catalog messages (`DAODAO_PROPOSAL_ACTION_ACTORS` lists the types);
       * none for a proposal that only asks for agreement.
       */
      actions?: readonly ITrxMsg[];
    }
  | {
      action: 'vote';
      sender: string;
      /** The proposal module the proposal is in. */
      proposalModule: string;
      proposalId: number;
      vote: DaoDaoVoteOption;
      /** Published with the vote; none when omitted. */
      rationale?: string;
    }
  | {
      action: 'execute' | 'close';
      sender: string;
      proposalModule: string;
      proposalId: number;
    };

function proposalStep(input: DaoDaoProposalMessageInput): {
  contract: string;
  msg: Record<string, unknown>;
} {
  switch (input.action) {
    case 'propose': {
      const content = {
        title: input.title,
        description: input.description,
        msgs: (input.actions ?? []).map(
          (action): DaoDaoProposalAction => ({
            stargate: { type_url: action.typeUrl, value: action.value },
          }),
        ),
      };
      return {
        contract: input.contract,
        msg:
          (input.via ?? 'pre-propose') === 'pre-propose'
            ? { propose: { msg: { propose: content } } }
            : { propose: { ...content, proposer: null } },
      };
    }
    case 'vote':
      return {
        contract: input.proposalModule,
        msg: {
          vote: {
            proposal_id: input.proposalId,
            vote: input.vote,
            rationale: input.rationale ?? null,
          },
        },
      };
    case 'execute':
      return {
        contract: input.proposalModule,
        msg: { execute: { proposal_id: input.proposalId } },
      };
    case 'close':
      return {
        contract: input.proposalModule,
        msg: { close: { proposal_id: input.proposalId } },
      };
  }
}

/**
 * The `MsgExecuteContract` (catalog form) of one proposal step — the
 * shapes the Portal and the Auth Hub send (`propose` through the intake or
 * straight to the module, `vote` with its rationale or null, `execute`,
 * `close`), no funds. Validated before it is returned (route `/ixo daodao
 * <action>`); throws when the input is refused.
 */
export function buildDaoDaoProposalMessage(
  input: DaoDaoProposalMessageInput,
): ITrxMsg {
  const { contract, msg } = proposalStep(input);
  return validateMessage({
    typeUrl: WASM_EXECUTE_TYPE_URL,
    value: { sender: input.sender, contract, msg, funds: [] },
  });
}

/**
 * The two messages that tie a new group to the entity it governs, signed
 * together after `create-group`, as the Portal does when it provisions a
 * POD (`lib/pods/provisionPodGroup.ts`): link the group's core contract to
 * the entity (`{id}#<core>`, type `group`, relationship `governs`) and make
 * the group a controller of the entity's identity
 * (`did:ixo:wasm:<core>`). `signer` is a controller of the entity today.
 * Validated before they are returned; throws when the input is refused.
 */
export function buildDaoDaoGroupLinkMessages(
  entityDid: string,
  coreAddress: string,
  signer: string,
): [linkedEntity: ITrxMsg, controller: ITrxMsg] {
  const core = DaoDaoContractAddressSchema.parse(coreAddress);
  return [
    validateMessage({
      typeUrl: '/ixo.iid.v1beta1.MsgAddLinkedEntity',
      value: {
        id: entityDid,
        linkedEntity: {
          id: `{id}#${core}`,
          type: 'group',
          relationship: 'governs',
          service: '',
        },
        signer,
      },
    }),
    validateMessage({
      typeUrl: '/ixo.iid.v1beta1.MsgAddController',
      value: {
        id: entityDid,
        controllerDid: `did:ixo:wasm:${core}`,
        signer,
      },
    }),
  ];
}

/** A Cosmos event as a tx response (cosmos-sdk 0.50) carries it. */
export type TxEvent = {
  type: string;
  attributes: ReadonlyArray<{ key: string; value: string }>;
};

/**
 * The address of the group a `create-group` transaction made: the
 * `_contract_address` of the `instantiate` event whose `code_id` is the
 * network's `dao_core` (the modules it instantiates have other code ids).
 * Reads the response's `events` and, for an older response, its
 * `logs[].events`. Undefined when there is no such event; throws when
 * there are several (a transaction that made more than one group).
 */
export function findDaoDaoCoreAddress(
  network: Network,
  response: {
    events?: readonly TxEvent[];
    logs?: ReadonlyArray<{ events: readonly TxEvent[] }>;
  },
): string | undefined {
  const coreCodeId = String(DAODAO_CODE_IDS[network].dao_core);
  const events = [
    ...(response.events ?? []),
    ...(response.logs ?? []).flatMap((log) => log.events),
  ];
  const addresses = new Set<string>();
  for (const event of events) {
    if (event.type !== 'instantiate') continue;
    const attribute = (key: string) =>
      event.attributes.find((entry) => entry.key === key)?.value;
    const address = attribute('_contract_address');
    if (attribute('code_id') === coreCodeId && address) addresses.add(address);
  }
  if (addresses.size > 1) {
    throw new Error(
      `The transaction made ${addresses.size} DAO DAO groups: ${[...addresses].join(', ')}`,
    );
  }
  const [address] = addresses;
  return address;
}
