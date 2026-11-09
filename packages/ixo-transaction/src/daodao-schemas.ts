import { bech32 } from '@scure/base';
import { z } from 'zod';

import { UintSchema, type ITrxMsg, type Network } from './schemas.js';

/**
 * DAO DAO (v2.0.3) on the IXO chain: the one governance-group shape the
 * catalog signs (a membership group: `dao_core` with a `dao_voting_cw4`
 * voting module over a `cw4_group` member list, and one
 * `dao_proposal_single` proposal module behind a `dao_pre_propose_single`
 * intake), and the four proposal steps on such a group. Native Cosmos
 * `x/group` is never used.
 *
 * In the catalog form of these messages every CosmWasm `Binary` field holds
 * its decoded content, so the user reviewing it can read every member, the
 * threshold and every proposal action: a nested contract message is a JSON
 * object, and a proposal action is `{ stargate: { type_url, value } }` with
 * `value` the catalogued proto-JSON of that message. The Portal's encoder
 * (`@ixo/ixo-transaction/react`) encodes each of them — a nested contract
 * message as base64 of its UTF-8 JSON, a proposal action as base64 of its
 * protobuf — and the top-level `msg` to UTF-8 JSON bytes once.
 */

export const WASM_INSTANTIATE_TYPE_URL =
  '/cosmwasm.wasm.v1.MsgInstantiateContract';
export const WASM_EXECUTE_TYPE_URL = '/cosmwasm.wasm.v1.MsgExecuteContract';

export const DAODAO_CONTRACTS = [
  'dao_core',
  'dao_voting_cw4',
  'cw4_group',
  'dao_proposal_single',
  'dao_pre_propose_single',
] as const;
export type DaoDaoContract = (typeof DAODAO_CONTRACTS)[number];

/**
 * The code id of each contract per network: the DAO DAO v2.0.3 uploads, as
 * `customQueries.contract.getContractCode(network, name)` of
 * `@ixo/impactxclient-sdk@3.0.0` gives them (the Portal creates its groups
 * with the same lookup; `tests/daodao.test.ts` checks this table against
 * the SDK). Kept here rather than imported: the oracle side of this package
 * does not load the SDK.
 */
export const DAODAO_CODE_IDS: Readonly<
  Record<Network, Readonly<Record<DaoDaoContract, number>>>
> = {
  devnet: {
    dao_core: 3,
    dao_voting_cw4: 20,
    cw4_group: 24,
    dao_proposal_single: 16,
    dao_pre_propose_single: 13,
  },
  testnet: {
    dao_core: 3,
    dao_voting_cw4: 20,
    cw4_group: 24,
    dao_proposal_single: 16,
    dao_pre_propose_single: 13,
  },
  mainnet: {
    dao_core: 3,
    dao_voting_cw4: 20,
    cw4_group: 24,
    dao_proposal_single: 16,
    dao_pre_propose_single: 13,
  },
};

/**
 * How long a new group's proposals stay open for votes (DAO DAO's
 * `max_voting_period`), in seconds. The default is the Portal's multisig: 7
 * days. DAO DAO takes any positive time; a group created here is bounded to
 * 1 hour (a proposal should not close before members can open their wallets
 * to vote) and 30 days (a group whose members may change their votes can
 * carry a proposal out only once voting closes; a longer wait is far more
 * likely a typo than a choice).
 */
export const DAODAO_VOTING_PERIOD_SECONDS = {
  default: 604_800,
  min: 3_600,
  max: 2_592_000,
} as const;
/**
 * Whether a new group lets members change their vote until voting closes
 * (DAO DAO's `allow_revoting`): yes by default, as the Portal creates its
 * multisig. DAO DAO then decides a proposal only when voting closes, even
 * once enough members voted yes.
 */
export const DAODAO_DEFAULT_ALLOW_REVOTING = true;
/** The most members a new group is created with (one review, one tx). */
export const DAODAO_MAX_MEMBERS = 100;
/** A group name, short enough that every module label stays within 128. */
export const DAODAO_MAX_NAME_LENGTH = 64;
/** The Auth Hub's limits for text published with a group step. */
export const DAODAO_MAX_DESCRIPTION_LENGTH = 300;
export const DAODAO_MAX_TITLE_LENGTH = 100;
export const DAODAO_MAX_RATIONALE_LENGTH = 300;
/** The most actions one proposal carries (the Auth Hub's group bound). */
export const DAODAO_MAX_PROPOSAL_ACTIONS = 4;
/** wasmd's limit on a contract label. */
const MAX_LABEL_LENGTH = 128;

export const DAODAO_VOTE_OPTIONS = ['yes', 'no', 'abstain'] as const;
export type DaoDaoVoteOption = (typeof DAODAO_VOTE_OPTIONS)[number];

/** The execute steps, each named by its message's one top-level key. */
export const DAODAO_EXECUTE_ACTIONS = [
  'propose',
  'vote',
  'execute',
  'close',
] as const;
export type DaoDaoExecuteAction = (typeof DAODAO_EXECUTE_ACTIONS)[number];

/**
 * What a proposal may ask the group's own account to do: the catalogued
 * messages among the Auth Hub's group actions that the group sends itself
 * (no grant), each with the field that names the group as the actor.
 */
export const DAODAO_PROPOSAL_ACTION_ACTORS = {
  '/cosmos.bank.v1beta1.MsgSend': 'fromAddress',
  '/ixo.token.v1beta1.MsgTransferToken': 'owner',
  '/ixo.token.v1beta1.MsgRetireToken': 'owner',
  '/ixo.claims.v1beta1.MsgCreateCollection': 'signer',
  '/ixo.entity.v1beta1.MsgCreateEntityAccount': 'ownerAddress',
  '/ixo.entity.v1beta1.MsgRevokeEntityAccountAuthz': 'ownerAddress',
} as const satisfies Record<string, string>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIxoBech32(value: string, length: 20 | 32): boolean {
  try {
    const decoded = bech32.decodeToBytes(value);
    return (
      decoded.prefix === 'ixo' &&
      decoded.bytes.length === length &&
      bech32.encodeFromBytes('ixo', decoded.bytes) === value
    );
  } catch {
    return false;
  }
}

/** A 20-byte `ixo1…` account address with a valid checksum. */
export const DaoDaoAccountAddressSchema = z
  .string()
  .max(90)
  .refine(
    (value) => isIxoBech32(value, 20),
    'Expected a lowercase 20-byte ixo1… account address with a valid checksum',
  );

/** A 32-byte `ixo1…` contract address with a valid checksum. */
export const DaoDaoContractAddressSchema = z
  .string()
  .max(90)
  .refine(
    (value) => isIxoBech32(value, 32),
    'Expected a lowercase 32-byte ixo1… contract address with a valid checksum',
  );

/** Control, format (zero-width, text direction) and line/paragraph separators. */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Text published on chain with a group: one line, not blank, no hidden
 * characters, single spaces and none at either end.
 */
const publishedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        !HIDDEN_CHARACTERS.test(value) &&
        value.trim() === value &&
        !/\s{2}/.test(value),
      'Plain text on one line: no hidden characters, single spaces and none at either end',
    );

/** A proposal's number: a JSON number from 1 (DAO DAO reads a `u64`). */
const ProposalIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** No `funds`: a DAO DAO step here never pays a contract. */
const NoFundsSchema = z
  .array(z.unknown())
  .max(0, 'A DAO DAO message here sends no funds')
  .optional();

const CORE_MODULE_ADMIN = z.strictObject({
  core_module: z.strictObject({}),
});
const CodeIdSchema = z.number().int().positive();

const PreProposeMsgSchema = z.strictObject({
  deposit_info: z.null(),
  extension: z.strictObject({}),
  open_proposal_submission: z.literal(false),
});

const ProposalModuleMsgSchema = z.strictObject({
  allow_revoting: z.boolean(),
  close_proposal_on_execution_failure: z.literal(true),
  max_voting_period: z.strictObject({
    time: z
      .number()
      .int('Voting time is a whole number of seconds')
      .min(
        DAODAO_VOTING_PERIOD_SECONDS.min,
        `Voting lasts at least 1 hour (${DAODAO_VOTING_PERIOD_SECONDS.min} seconds)`,
      )
      .max(
        DAODAO_VOTING_PERIOD_SECONDS.max,
        `Voting lasts at most 30 days (${DAODAO_VOTING_PERIOD_SECONDS.max} seconds)`,
      ),
  }),
  min_voting_period: z.null(),
  only_members_execute: z.literal(true),
  pre_propose_info: z.strictObject({
    module_may_propose: z.strictObject({
      info: z.strictObject({
        admin: CORE_MODULE_ADMIN,
        code_id: CodeIdSchema,
        label: z.string(),
        msg: PreProposeMsgSchema,
      }),
    }),
  }),
  threshold: z.strictObject({
    absolute_count: z.strictObject({
      threshold: z.string().regex(/^[1-9][0-9]{0,2}$/),
    }),
  }),
});

const VotingModuleMsgSchema = z.strictObject({
  cw4_group_code_id: CodeIdSchema,
  initial_members: z
    .array(
      z.strictObject({
        addr: DaoDaoAccountAddressSchema,
        weight: z.literal(1),
      }),
    )
    .min(1, 'A group needs at least one member')
    .max(DAODAO_MAX_MEMBERS),
});

/** The `dao_core` instantiate message of a membership group (decoded form). */
export const DaoDaoCoreInstantiateMsgSchema = z.strictObject({
  admin: z.null(),
  automatically_add_cw20s: z.literal(true),
  automatically_add_cw721s: z.literal(true),
  // The Portal creates a POD's group with an empty description.
  description: z.union([
    z.literal(''),
    publishedText(DAODAO_MAX_DESCRIPTION_LENGTH),
  ]),
  name: publishedText(DAODAO_MAX_NAME_LENGTH),
  proposal_modules_instantiate_info: z
    .array(
      z.strictObject({
        admin: CORE_MODULE_ADMIN,
        code_id: CodeIdSchema,
        label: z.string(),
        msg: ProposalModuleMsgSchema,
      }),
    )
    .length(1, 'A group has exactly one proposal module'),
  voting_module_instantiate_info: z.strictObject({
    admin: CORE_MODULE_ADMIN,
    code_id: CodeIdSchema,
    label: z.string(),
    msg: VotingModuleMsgSchema,
  }),
});
export type DaoDaoCoreInstantiateMsg = z.infer<
  typeof DaoDaoCoreInstantiateMsgSchema
>;

/** The value of the `create-group` `MsgInstantiateContract` (catalog form). */
export const DaoDaoInstantiateValueSchema = z.strictObject({
  sender: DaoDaoAccountAddressSchema,
  /** The wasm admin, which can migrate the group without a vote: the sender, or "" for none. */
  admin: z.string().optional(),
  codeId: UintSchema,
  label: publishedText(MAX_LABEL_LENGTH),
  msg: DaoDaoCoreInstantiateMsgSchema,
  funds: NoFundsSchema,
});
export type DaoDaoInstantiateValue = z.infer<
  typeof DaoDaoInstantiateValueSchema
>;

/** One proposal action in its decoded form (`value` is proto-JSON). */
export const DaoDaoProposalActionSchema = z.strictObject({
  stargate: z.strictObject({
    type_url: z.string(),
    value: z.record(z.string(), z.unknown()),
  }),
});
export type DaoDaoProposalAction = z.infer<typeof DaoDaoProposalActionSchema>;

const ProposalContentSchema = {
  title: publishedText(DAODAO_MAX_TITLE_LENGTH),
  description: publishedText(DAODAO_MAX_DESCRIPTION_LENGTH),
  msgs: z.array(DaoDaoProposalActionSchema).max(DAODAO_MAX_PROPOSAL_ACTIONS),
};

/** Through the group's intake (pre-propose-single): it fills in the proposer. */
const ProposeViaIntakeMsgSchema = z.strictObject({
  propose: z.strictObject({
    msg: z.strictObject({ propose: z.strictObject(ProposalContentSchema) }),
  }),
});
/** Straight to a proposal module that takes proposals from anyone. */
const ProposeToModuleMsgSchema = z.strictObject({
  propose: z.strictObject({ ...ProposalContentSchema, proposer: z.null() }),
});
const ProposeMsgSchema = z.union([
  ProposeViaIntakeMsgSchema,
  ProposeToModuleMsgSchema,
]);

/**
 * The propose shape a message means: through the intake when `propose`
 * holds a `msg`. Picked before parsing, so a refusal names the field.
 */
function proposeMsgSchema(
  value: unknown,
): typeof ProposeViaIntakeMsgSchema | typeof ProposeToModuleMsgSchema {
  const propose =
    isPlainRecord(value) && isPlainRecord(value.msg)
      ? value.msg.propose
      : undefined;
  return isPlainRecord(propose) && 'msg' in propose
    ? ProposeViaIntakeMsgSchema
    : ProposeToModuleMsgSchema;
}
const VoteMsgSchema = z.strictObject({
  vote: z.strictObject({
    proposal_id: ProposalIdSchema,
    vote: z.enum(DAODAO_VOTE_OPTIONS),
    rationale: publishedText(DAODAO_MAX_RATIONALE_LENGTH).nullable(),
  }),
});
const ExecuteMsgSchema = z.strictObject({
  execute: z.strictObject({ proposal_id: ProposalIdSchema }),
});
const CloseMsgSchema = z.strictObject({
  close: z.strictObject({ proposal_id: ProposalIdSchema }),
});

const STEP_MSG_SCHEMAS = {
  vote: VoteMsgSchema,
  execute: ExecuteMsgSchema,
  close: CloseMsgSchema,
} as const satisfies Record<
  Exclude<DaoDaoExecuteAction, 'propose'>,
  z.ZodObject
>;

const executeValueSchema = <Msg extends z.ZodTypeAny>(msg: Msg) =>
  z.strictObject({
    sender: DaoDaoAccountAddressSchema,
    contract: DaoDaoContractAddressSchema,
    msg,
    funds: NoFundsSchema,
  });

/** The value of any DAO DAO `MsgExecuteContract` (catalog form). */
export const DaoDaoExecuteValueSchema = executeValueSchema(
  z.union([ProposeMsgSchema, VoteMsgSchema, ExecuteMsgSchema, CloseMsgSchema]),
);
export type DaoDaoExecuteValue = z.infer<typeof DaoDaoExecuteValueSchema>;

/** The labels the Portal gives a group's modules, from the group's name. */
export function daoDaoModuleLabels(name: string): {
  proposal: string;
  prePropose: string;
  voting: string;
} {
  return {
    proposal: `DAO_${name}_DaoProposalSingle`,
    prePropose: `DAO_${name}_pre-propose-DaoProposalSingle`,
    voting: `DAO_${name}_DaoVotingCw4`,
  };
}

/**
 * The execute step a `MsgExecuteContract` value's `msg` names (its one
 * top-level key), or undefined when it is not one of them.
 */
export function daoDaoExecuteAction(
  value: Record<string, unknown>,
): DaoDaoExecuteAction | undefined {
  const msg = value.msg;
  if (!isPlainRecord(msg)) return undefined;
  const keys = Object.keys(msg);
  const [key] = keys;
  return keys.length === 1
    ? DAODAO_EXECUTE_ACTIONS.find((action) => action === key)
    : undefined;
}

export type DaoDaoValidationContext = {
  /**
   * Checks one proposal action as a catalog message (the caller's own
   * strict validation): why it is refused, or undefined when it is valid.
   */
  actionProblem: (message: ITrxMsg) => string | undefined;
};

function issue(
  ctx: z.RefinementCtx,
  path: (string | number)[],
  message: string,
) {
  ctx.addIssue({ code: 'custom', path, message });
}

function checkInstantiate(
  value: DaoDaoInstantiateValue,
  network: Network,
  ctx: z.RefinementCtx,
): void {
  const codes = DAODAO_CODE_IDS[network];
  if (BigInt(value.codeId) !== BigInt(codes.dao_core)) {
    issue(
      ctx,
      ['codeId'],
      `Expected the ${network} dao_core code id ${codes.dao_core}`,
    );
  }
  if (
    value.admin !== undefined &&
    value.admin !== '' &&
    value.admin !== value.sender
  ) {
    issue(
      ctx,
      ['admin'],
      'The wasm admin can migrate the group without a vote: only the sender or "" (none)',
    );
  }
  const msg = value.msg;
  const labels = daoDaoModuleLabels(msg.name);
  const voting = msg.voting_module_instantiate_info;
  if (voting.code_id !== codes.dao_voting_cw4) {
    issue(
      ctx,
      ['msg', 'voting_module_instantiate_info', 'code_id'],
      `Expected the ${network} dao_voting_cw4 code id ${codes.dao_voting_cw4}`,
    );
  }
  if (voting.label !== labels.voting) {
    issue(
      ctx,
      ['msg', 'voting_module_instantiate_info', 'label'],
      `Expected ${labels.voting}`,
    );
  }
  if (voting.msg.cw4_group_code_id !== codes.cw4_group) {
    issue(
      ctx,
      ['msg', 'voting_module_instantiate_info', 'msg', 'cw4_group_code_id'],
      `Expected the ${network} cw4_group code id ${codes.cw4_group}`,
    );
  }
  const members = voting.msg.initial_members;
  const seen = new Set<string>();
  members.forEach((member, index) => {
    if (seen.has(member.addr)) {
      issue(
        ctx,
        [
          'msg',
          'voting_module_instantiate_info',
          'msg',
          'initial_members',
          index,
          'addr',
        ],
        'Each member is listed once',
      );
    }
    seen.add(member.addr);
  });

  msg.proposal_modules_instantiate_info.forEach((module, index) => {
    const path = ['msg', 'proposal_modules_instantiate_info', index];
    if (module.code_id !== codes.dao_proposal_single) {
      issue(
        ctx,
        [...path, 'code_id'],
        `Expected the ${network} dao_proposal_single code id ${codes.dao_proposal_single}`,
      );
    }
    if (module.label !== labels.proposal) {
      issue(ctx, [...path, 'label'], `Expected ${labels.proposal}`);
    }
    const threshold = Number(module.msg.threshold.absolute_count.threshold);
    if (threshold > members.length) {
      issue(
        ctx,
        [...path, 'msg', 'threshold', 'absolute_count', 'threshold'],
        `The threshold is at most the number of members (${members.length})`,
      );
    }
    const info = module.msg.pre_propose_info.module_may_propose.info;
    const infoPath = [
      ...path,
      'msg',
      'pre_propose_info',
      'module_may_propose',
      'info',
    ];
    if (info.code_id !== codes.dao_pre_propose_single) {
      issue(
        ctx,
        [...infoPath, 'code_id'],
        `Expected the ${network} dao_pre_propose_single code id ${codes.dao_pre_propose_single}`,
      );
    }
    if (info.label !== labels.prePropose) {
      issue(ctx, [...infoPath, 'label'], `Expected ${labels.prePropose}`);
    }
  });
}

function proposalActions(value: DaoDaoExecuteValue): {
  msgs: DaoDaoProposalAction[];
  path: (string | number)[];
} {
  if (!('propose' in value.msg)) return { msgs: [], path: [] };
  const propose = value.msg.propose;
  return 'msg' in propose
    ? {
        msgs: propose.msg.propose.msgs,
        path: ['msg', 'propose', 'msg', 'propose', 'msgs'],
      }
    : { msgs: propose.msgs, path: ['msg', 'propose', 'msgs'] };
}

/**
 * The actions a DAO DAO `propose` message (catalog form, through the intake
 * or straight to the module) asks the group's own account to do if the
 * proposal passes, each as the catalog message `{ typeUrl, value }` it
 * holds; none for any other message. Reads the shape without validating it:
 * `validateMessage` is what proves each action is an allowed catalog
 * message.
 */
export function daoDaoProposalActions(message: {
  typeUrl: string;
  value: unknown;
}): ITrxMsg[] {
  if (message.typeUrl !== WASM_EXECUTE_TYPE_URL) return [];
  const msg = isPlainRecord(message.value) ? message.value.msg : undefined;
  const propose = isPlainRecord(msg) ? msg.propose : undefined;
  if (!isPlainRecord(propose)) return [];
  const content =
    isPlainRecord(propose.msg) && isPlainRecord(propose.msg.propose)
      ? propose.msg.propose
      : propose;
  const msgs = Array.isArray(content.msgs) ? content.msgs : [];
  return msgs.flatMap((action: unknown): ITrxMsg[] => {
    const stargate = isPlainRecord(action) ? action.stargate : undefined;
    return isPlainRecord(stargate) &&
      typeof stargate.type_url === 'string' &&
      isPlainRecord(stargate.value)
      ? [{ typeUrl: stargate.type_url, value: stargate.value }]
      : [];
  });
}

function isActionTypeUrl(
  typeUrl: string,
): typeUrl is keyof typeof DAODAO_PROPOSAL_ACTION_ACTORS {
  return Object.hasOwn(DAODAO_PROPOSAL_ACTION_ACTORS, typeUrl);
}

/**
 * Each proposal action is a valid catalog message of an allowed type, and
 * every action names the same group contract as its actor.
 */
function checkProposalActions(
  value: DaoDaoExecuteValue,
  context: DaoDaoValidationContext,
  ctx: z.RefinementCtx,
): void {
  const { msgs, path } = proposalActions(value);
  let actor: string | undefined;
  msgs.forEach((action, index) => {
    const at = [...path, index, 'stargate'];
    const typeUrl = action.stargate.type_url;
    if (!isActionTypeUrl(typeUrl)) {
      issue(
        ctx,
        [...at, 'type_url'],
        `A proposal can only hold these actions: ${Object.keys(DAODAO_PROPOSAL_ACTION_ACTORS).join(', ')}`,
      );
      return;
    }
    const problem = context.actionProblem({
      typeUrl,
      value: action.stargate.value,
    });
    if (problem !== undefined) {
      issue(ctx, [...at, 'value'], problem);
      return;
    }
    const field = DAODAO_PROPOSAL_ACTION_ACTORS[typeUrl];
    const actorAddress = action.stargate.value[field];
    if (
      typeof actorAddress !== 'string' ||
      !DaoDaoContractAddressSchema.safeParse(actorAddress).success
    ) {
      issue(
        ctx,
        [...at, 'value', field],
        'The group itself carries out the action: its own (32-byte contract) address',
      );
      return;
    }
    if (actor !== undefined && actor !== actorAddress) {
      issue(
        ctx,
        [...at, 'value', field],
        'Every action of a proposal names the same group',
      );
    }
    actor ??= actorAddress;
  });
}

/** Strictly parse the `create-group` value: shape, code ids, labels, members, admin. */
export function parseDaoDaoInstantiateValue(
  value: unknown,
  network: Network | undefined,
): DaoDaoInstantiateValue {
  return DaoDaoInstantiateValueSchema.superRefine((parsed, ctx) => {
    if (network === undefined) {
      issue(
        ctx,
        [],
        'A DAO DAO group is checked against the code ids of its network: the network is required',
      );
      return;
    }
    checkInstantiate(parsed, network, ctx);
  }).parse(value);
}

/** Strictly parse one execute step's value: exactly that step's message. */
export function parseDaoDaoExecuteValue(
  action: DaoDaoExecuteAction,
  value: unknown,
  context: DaoDaoValidationContext,
): DaoDaoExecuteValue {
  return executeValueSchema(
    action === 'propose' ? proposeMsgSchema(value) : STEP_MSG_SCHEMAS[action],
  )
    .superRefine((parsed, ctx) => checkProposalActions(parsed, context, ctx))
    .parse(value);
}
