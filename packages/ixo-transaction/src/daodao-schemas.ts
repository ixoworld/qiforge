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
 * object, and a proposal action is a cw `CosmosMsg` as the Portal writes it:
 * `{ stargate: { type_url, value } }` with `value` the proto-JSON of that
 * message, `bank`, `staking`, `distribution`, or `wasm` (`execute` with its
 * contract message as JSON, or `update_admin`). The Portal's encoder
 * (`@ixo/ixo-transaction/react`) encodes each of them — a nested contract
 * message as base64 of its UTF-8 JSON, a stargate action as base64 of its
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

/**
 * A value that is an object with exactly one key among `shapes`, parsed by
 * that key's schema: a cw enum variant (`{ delegate: {...} }`). Picked
 * before parsing, so a refusal names the field instead of every variant.
 */
function variant<T extends Record<string, z.ZodType>>(
  what: string,
  shapes: T,
): z.ZodType<
  { [K in keyof T]: { [P in K]: z.output<T[K]> } }[keyof T],
  unknown
> {
  return z.unknown().transform((value, ctx) => {
    const keys = isPlainRecord(value) ? Object.keys(value) : [];
    const [key] = keys;
    if (
      !isPlainRecord(value) ||
      keys.length !== 1 ||
      key === undefined ||
      !Object.hasOwn(shapes, key)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `${what}: exactly one of ${Object.keys(shapes).join(', ')}`,
      });
      return z.NEVER;
    }
    const parsed = (shapes[key] as z.ZodType).safeParse(value[key]);
    if (!parsed.success) {
      for (const failure of parsed.error.issues) {
        ctx.addIssue({
          code: 'custom',
          message: failure.message,
          path: [key, ...failure.path.map((part) => part as string | number)],
        });
      }
      return z.NEVER;
    }
    return { [key]: parsed.data } as {
      [K in keyof T]: { [P in K]: z.output<T[K]> };
    }[keyof T];
  });
}

function isBech32Of(
  value: string,
  prefix: string,
  lengths: readonly number[],
): boolean {
  try {
    const decoded = bech32.decodeToBytes(value);
    return (
      decoded.prefix === prefix &&
      lengths.includes(decoded.bytes.length) &&
      bech32.encodeFromBytes(prefix, decoded.bytes) === value
    );
  } catch {
    return false;
  }
}

/** An account or a contract: a 20- or 32-byte `ixo1…` address with a valid checksum. */
export const DaoDaoAnyAddressSchema = z
  .string()
  .max(90)
  .refine(
    (value) => isBech32Of(value, 'ixo', [20, 32]),
    'Expected a lowercase ixo1… account or contract address with a valid checksum',
  );

/** A validator's operator address: `ixovaloper1…`, 20 bytes, valid checksum. */
export const DaoDaoValidatorAddressSchema = z
  .string()
  .max(100)
  .refine(
    (value) => isBech32Of(value, 'ixovaloper', [20]),
    'Expected a lowercase ixovaloper1… validator address with a valid checksum',
  );

/** A whole number of base units, more than 0 (a cw `Uint128`). */
const BaseUnitsSchema = z
  .string()
  .regex(
    /^[1-9][0-9]{0,38}$/,
    'A whole number of base units greater than 0, as a string',
  );

/** A bank denom (the Cosmos SDK pattern). */
const DenomSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/, 'Expected a bank denom');

/** A cw `Coin`, in the order the Portal writes it. */
const ActionCoinSchema = z.strictObject({
  amount: BaseUnitsSchema,
  denom: DenomSchema,
});

/** Short text a group stores on chain: one line, no hidden characters. */
const storedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => !HIDDEN_CHARACTERS.test(value),
      'Plain text: no hidden characters',
    );

const MsgTypeUrlSchema = z
  .string()
  .max(200)
  .regex(
    /^\/[A-Za-z0-9.]+\.Msg[A-Za-z0-9]+$/,
    'Expected a Msg type url, e.g. /cosmos.bank.v1beta1.MsgSend',
  );

/**
 * The `msg` a group's cw20 `send` carries: base64 of the exact JSON the
 * Portal writes, staking (`{"stake": {}}`, with its space) or funding a
 * token swap (`{"ixo_initiate_token_swap":{}}`).
 */
export const DAODAO_CW20_STAKE_MSG = btoa('{"stake": {}}');
export const DAODAO_CW20_SWAP_MSG = btoa('{"ixo_initiate_token_swap":{}}');

const DurationSchema = variant('A duration', {
  time: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  height: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

/** A DAO DAO `PercentageThreshold`: a majority, or a decimal share in (0, 1]. */
const PercentageThresholdSchema = variant('A share of the votes', {
  majority: z.strictObject({}),
  percent: z
    .string()
    .regex(/^(0\.[0-9]{1,18}|1(\.0{1,18})?)$/, 'A decimal share from 0 to 1')
    .refine((value) => Number(value) > 0, 'A share greater than 0'),
});

const ThresholdSchema = variant('A pass rule', {
  absolute_percentage: z.strictObject({
    percentage: PercentageThresholdSchema,
  }),
  // The Portal writes the quorum first.
  threshold_quorum: z.strictObject({
    quorum: PercentageThresholdSchema,
    threshold: PercentageThresholdSchema,
  }),
  absolute_count: z.strictObject({
    threshold: z
      .string()
      .regex(/^[1-9][0-9]{0,9}$/, 'A whole number of yes votes from 1'),
  }),
});

const VetoSchema = z.strictObject({
  vetoer: DaoDaoAnyAddressSchema,
  timelock_duration: DurationSchema,
  early_execute: z.boolean(),
  veto_before_passed: z.boolean(),
});

/** `dao-dao-core` `update_config`: the whole config (2.0.3 fields, in its order). */
const CoreConfigSchema = z.strictObject({
  name: storedText(200),
  description: z
    .string()
    .max(5000)
    .refine(
      (value) => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/\n/g, '')),
      'Plain text: no hidden characters',
    ),
  image_url: z
    .url({ protocol: /^https?$/ })
    .max(1000)
    .nullable(),
  automatically_add_cw20s: z.boolean(),
  automatically_add_cw721s: z.boolean(),
  dao_uri: z.string().max(1000).nullable(),
});

/** `dao-proposal-single` `update_config`: the whole config, in the Portal's order. */
const ProposalConfigUpdateSchema = z.strictObject({
  threshold: ThresholdSchema,
  max_voting_period: DurationSchema,
  min_voting_period: DurationSchema.nullable(),
  only_members_execute: z.boolean(),
  allow_revoting: z.boolean(),
  dao: DaoDaoContractAddressSchema,
  close_proposal_on_execution_failure: z.boolean(),
  /** 2.4+ only; a 2.0.3 module refuses the field. */
  veto: VetoSchema.nullable().optional(),
});

/** `dao-pre-propose-single` 2.0.3 `update_config`. */
const PreProposeConfigUpdateSchema = z.strictObject({
  deposit_info: z
    .strictObject({
      amount: BaseUnitsSchema,
      denom: variant('A deposit token', {
        voting_module_token: z.strictObject({}),
        token: z.strictObject({
          denom: variant('A token', {
            native: DenomSchema,
            cw20: DaoDaoContractAddressSchema,
          }),
        }),
      }),
      refund_policy: z.enum(['always', 'only_passed', 'never']),
    })
    .nullable(),
  open_proposal_submission: z.boolean(),
});

const CoreConfigUpdateSchema = z.strictObject({ config: CoreConfigSchema });

/** The three `update_config`s, told apart by their fields. */
const UpdateConfigSchema = z.unknown().transform((value, ctx) => {
  const schema = !isPlainRecord(value)
    ? undefined
    : 'config' in value
      ? CoreConfigUpdateSchema
      : 'threshold' in value
        ? ProposalConfigUpdateSchema
        : 'deposit_info' in value
          ? PreProposeConfigUpdateSchema
          : undefined;
  if (schema === undefined) {
    ctx.addIssue({
      code: 'custom',
      message:
        'update_config: the group’s ({ config }), its proposal list’s ({ threshold, … }) or its intake’s ({ deposit_info, open_proposal_submission })',
    });
    return z.NEVER;
  }
  const parsed = (schema as z.ZodType).safeParse(value);
  if (!parsed.success) {
    for (const failure of parsed.error.issues) {
      ctx.addIssue({
        code: 'custom',
        message: failure.message,
        path: failure.path.map((part) => part as string | number),
      });
    }
    return z.NEVER;
  }
  return parsed.data as
    | z.output<typeof CoreConfigUpdateSchema>
    | z.output<typeof ProposalConfigUpdateSchema>
    | z.output<typeof PreProposeConfigUpdateSchema>;
});

const MAX_LIST = 50;
const AddRemoveSchema = <T extends z.ZodType>(item: T) =>
  z
    .strictObject({
      to_add: z.array(item).max(MAX_LIST),
      to_remove: z.array(DaoDaoContractAddressSchema).max(MAX_LIST),
    })
    .refine(
      (value) => value.to_add.length + value.to_remove.length > 0,
      'Add or remove at least one',
    );

const TokenIdSchema = storedText(256);

/**
 * The contract messages a group's proposal may send (`wasm.execute`), each
 * the one shape the Portal writes: to the group itself, its member list,
 * its proposal list or intake, a cw20 token, an NFT collection or a token
 * swap. Never an arbitrary contract message.
 */
const GroupContractMsgSchema = variant('A group contract message', {
  update_members: z
    .strictObject({
      add: z
        .array(
          z.strictObject({
            addr: DaoDaoAnyAddressSchema,
            weight: z.number().int().min(0).max(1_000_000),
          }),
        )
        .max(MAX_LIST),
      remove: z.array(DaoDaoAnyAddressSchema).max(MAX_LIST),
    })
    .superRefine((value, ctx) => {
      if (value.add.length + value.remove.length === 0)
        ctx.addIssue({
          code: 'custom',
          message: 'Add or remove at least one member',
        });
      const seen = new Set<string>();
      for (const addr of [...value.add.map((m) => m.addr), ...value.remove]) {
        if (seen.has(addr))
          ctx.addIssue({
            code: 'custom',
            message: `${addr} is listed twice: add or remove each member once`,
          });
        seen.add(addr);
      }
    }),
  update_config: UpdateConfigSchema,
  update_sub_daos: AddRemoveSchema(
    z.strictObject({
      addr: DaoDaoContractAddressSchema,
      charter: storedText(1000).nullable(),
    }),
  ),
  update_cw20_list: AddRemoveSchema(DaoDaoContractAddressSchema),
  update_cw721_list: AddRemoveSchema(DaoDaoContractAddressSchema),
  set_item: z.strictObject({ key: storedText(128), value: storedText(1000) }),
  remove_item: z.strictObject({ key: storedText(128) }),
  transfer: z.strictObject({
    recipient: DaoDaoAnyAddressSchema,
    amount: BaseUnitsSchema,
  }),
  send: z.strictObject({
    amount: BaseUnitsSchema,
    contract: DaoDaoContractAddressSchema,
    msg: z.enum([DAODAO_CW20_STAKE_MSG, DAODAO_CW20_SWAP_MSG], {
      message:
        'A cw20 send here only stakes in the group or funds a token swap',
    }),
  }),
  mint: z.strictObject({
    recipient: DaoDaoAnyAddressSchema,
    amount: BaseUnitsSchema,
  }),
  transfer_nft: z.strictObject({
    recipient: DaoDaoAnyAddressSchema,
    token_id: TokenIdSchema,
  }),
  burn: z.strictObject({ token_id: TokenIdSchema }),
  fund: z.strictObject({}),
  withdraw: z.strictObject({}),
});

const WasmExecuteActionSchema = z
  .strictObject({
    contract_addr: DaoDaoContractAddressSchema,
    funds: z.array(ActionCoinSchema).max(1),
    msg: GroupContractMsgSchema,
  })
  .superRefine((value, ctx) => {
    const funding = 'fund' in value.msg;
    if (funding && value.funds.length !== 1)
      ctx.addIssue({
        code: 'custom',
        path: ['funds'],
        message: 'Funding a token swap sends exactly one coin',
      });
    if (!funding && value.funds.length > 0)
      ctx.addIssue({
        code: 'custom',
        path: ['funds'],
        message: 'Only funding a token swap sends funds with the message',
      });
  });

/** A stargate action: `value` the message's proto-JSON (checked by its type). */
const StargateActionSchema = z.strictObject({
  type_url: z.string(),
  value: z.record(z.string(), z.unknown()),
});

/**
 * One proposal action in its decoded (readable) form: a cw `CosmosMsg` as
 * the Portal writes it — `stargate` (`value` proto-JSON), `bank`,
 * `staking`, `distribution`, or `wasm` (`execute` with its contract
 * message as JSON, or `update_admin`).
 */
export const DaoDaoProposalActionSchema = variant('A proposal action', {
  stargate: StargateActionSchema,
  bank: variant('A bank action', {
    send: z.strictObject({
      amount: z.array(ActionCoinSchema).min(1).max(10),
      to_address: DaoDaoAnyAddressSchema,
    }),
  }),
  staking: variant('A staking action', {
    delegate: z.strictObject({
      amount: ActionCoinSchema,
      validator: DaoDaoValidatorAddressSchema,
    }),
    undelegate: z.strictObject({
      amount: ActionCoinSchema,
      validator: DaoDaoValidatorAddressSchema,
    }),
    redelegate: z
      .strictObject({
        amount: ActionCoinSchema,
        src_validator: DaoDaoValidatorAddressSchema,
        dst_validator: DaoDaoValidatorAddressSchema,
      })
      .refine(
        (value) => value.src_validator !== value.dst_validator,
        'Move the stake to another validator',
      ),
  }),
  distribution: variant('A distribution action', {
    withdraw_delegator_reward: z.strictObject({
      validator: DaoDaoValidatorAddressSchema,
    }),
  }),
  wasm: variant('A wasm action', {
    execute: WasmExecuteActionSchema,
    update_admin: z.strictObject({
      contract_addr: DaoDaoContractAddressSchema,
      admin: DaoDaoAnyAddressSchema,
    }),
  }),
});
export type DaoDaoProposalAction = z.output<typeof DaoDaoProposalActionSchema>;
export type DaoDaoGroupContractMsg = z.output<typeof GroupContractMsgSchema>;

/**
 * The stargate actions only a group proposal holds (they are no catalog
 * route of their own): a network vote, and a permission the group gives
 * or takes back. Each with the field that names the group, and its exact
 * proto-JSON shape.
 */
export const DAODAO_GROUP_STARGATE_ACTIONS = {
  '/cosmos.gov.v1beta1.MsgVote': {
    actor: 'voter',
    schema: z.strictObject({
      proposalId: z
        .string()
        .regex(/^[1-9][0-9]{0,19}$/, 'A network proposal number from 1'),
      voter: DaoDaoContractAddressSchema,
      option: z.enum([
        'VOTE_OPTION_YES',
        'VOTE_OPTION_ABSTAIN',
        'VOTE_OPTION_NO',
        'VOTE_OPTION_NO_WITH_VETO',
      ]),
    }),
  },
  '/cosmos.authz.v1beta1.MsgGrant': {
    actor: 'granter',
    schema: z
      .strictObject({
        granter: DaoDaoContractAddressSchema,
        grantee: DaoDaoAnyAddressSchema,
        grant: z.strictObject({
          authorization: z.strictObject({
            typeUrl: z.literal('/cosmos.authz.v1beta1.GenericAuthorization'),
            value: z.strictObject({ msg: MsgTypeUrlSchema }),
          }),
          expiration: z.iso.datetime({ offset: true }),
        }),
      })
      .refine(
        (value) => value.grantee !== value.granter,
        'The group cannot give a permission to itself',
      ),
  },
  '/cosmos.authz.v1beta1.MsgRevoke': {
    actor: 'granter',
    schema: z.strictObject({
      granter: DaoDaoContractAddressSchema,
      grantee: DaoDaoAnyAddressSchema,
      msgTypeUrl: MsgTypeUrlSchema,
    }),
  },
} as const;
export type DaoDaoGroupStargateTypeUrl =
  keyof typeof DAODAO_GROUP_STARGATE_ACTIONS;

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
 * The stargate actions a DAO DAO `propose` message (catalog form, through
 * the intake or straight to the module) asks the group's own account to do
 * if the proposal passes, each as the message `{ typeUrl, value }` it
 * holds; none for any other message ({@link daoDaoProposalActionList} has
 * every form). Reads the shape without validating it: `validateMessage` is
 * what proves each action is allowed.
 */
export function daoDaoProposalActions(message: {
  typeUrl: string;
  value: unknown;
}): ITrxMsg[] {
  return daoDaoProposalActionList(message).flatMap((action): ITrxMsg[] =>
    'stargate' in action
      ? [{ typeUrl: action.stargate.type_url, value: action.stargate.value }]
      : [],
  );
}

/**
 * Every action a DAO DAO `propose` message (catalog form) holds, in its
 * decoded form (`DaoDaoProposalActionSchema`); none for any other message,
 * and an action that is not one of those forms is left out. Reads the
 * shape without validating the proposal: `validateMessage` is what proves
 * each action is allowed.
 */
export function daoDaoProposalActionList(message: {
  typeUrl: string;
  value: unknown;
}): DaoDaoProposalAction[] {
  if (message.typeUrl !== WASM_EXECUTE_TYPE_URL) return [];
  const msg = isPlainRecord(message.value) ? message.value.msg : undefined;
  const propose = isPlainRecord(msg) ? msg.propose : undefined;
  if (!isPlainRecord(propose)) return [];
  const content =
    isPlainRecord(propose.msg) && isPlainRecord(propose.msg.propose)
      ? propose.msg.propose
      : propose;
  const msgs = Array.isArray(content.msgs) ? content.msgs : [];
  return msgs.flatMap((action: unknown): DaoDaoProposalAction[] => {
    const parsed = DaoDaoProposalActionSchema.safeParse(action);
    return parsed.success ? [parsed.data] : [];
  });
}

function isActionTypeUrl(
  typeUrl: string,
): typeUrl is keyof typeof DAODAO_PROPOSAL_ACTION_ACTORS {
  return Object.hasOwn(DAODAO_PROPOSAL_ACTION_ACTORS, typeUrl);
}

function isGroupStargateTypeUrl(
  typeUrl: string,
): typeUrl is DaoDaoGroupStargateTypeUrl {
  return Object.hasOwn(DAODAO_GROUP_STARGATE_ACTIONS, typeUrl);
}

/**
 * Where an action names the group that carries it out, with the path of
 * that field: a stargate action's actor field, the group's own contract
 * for a message to the group itself (`update_config` of its config, its
 * sub-DAOs, token and NFT lists, items), and `dao` of its proposal list's
 * config. Undefined for an action that does not name the group.
 */
function namedGroup(
  action: DaoDaoProposalAction,
): { address: unknown; path: (string | number)[] } | undefined {
  if ('stargate' in action) {
    const typeUrl = action.stargate.type_url;
    const field = isActionTypeUrl(typeUrl)
      ? DAODAO_PROPOSAL_ACTION_ACTORS[typeUrl]
      : isGroupStargateTypeUrl(typeUrl)
        ? DAODAO_GROUP_STARGATE_ACTIONS[typeUrl].actor
        : undefined;
    return field === undefined
      ? undefined
      : {
          address: action.stargate.value[field],
          path: ['stargate', 'value', field],
        };
  }
  if (!('wasm' in action) || !('execute' in action.wasm)) return undefined;
  const { contract_addr, msg } = action.wasm.execute;
  if ('update_config' in msg) {
    const config = msg.update_config;
    if ('config' in config)
      return {
        address: contract_addr,
        path: ['wasm', 'execute', 'contract_addr'],
      };
    if ('dao' in config)
      return {
        address: config.dao,
        path: ['wasm', 'execute', 'msg', 'update_config', 'dao'],
      };
    return undefined;
  }
  return 'update_sub_daos' in msg ||
    'update_cw20_list' in msg ||
    'update_cw721_list' in msg ||
    'set_item' in msg ||
    'remove_item' in msg
    ? { address: contract_addr, path: ['wasm', 'execute', 'contract_addr'] }
    : undefined;
}

/**
 * Each proposal action is an allowed one: a catalog message of an allowed
 * type or a group-only stargate message, each checked strictly, or one of
 * the decoded cw forms (already parsed by the action schema). Every action
 * that names the group names the same group contract.
 */
function checkProposalActions(
  value: DaoDaoExecuteValue,
  context: DaoDaoValidationContext,
  ctx: z.RefinementCtx,
): void {
  const { msgs, path } = proposalActions(value);
  let actor: string | undefined;
  msgs.forEach((action, index) => {
    if ('stargate' in action) {
      const at = [...path, index, 'stargate'];
      const typeUrl = action.stargate.type_url;
      if (isGroupStargateTypeUrl(typeUrl)) {
        const parsed = DAODAO_GROUP_STARGATE_ACTIONS[typeUrl].schema.safeParse(
          action.stargate.value,
        );
        if (!parsed.success) {
          for (const failure of parsed.error.issues)
            issue(
              ctx,
              [
                ...at,
                'value',
                ...failure.path.map((part) => part as string | number),
              ],
              failure.message,
            );
          return;
        }
      } else if (!isActionTypeUrl(typeUrl)) {
        issue(
          ctx,
          [...at, 'type_url'],
          `A proposal can only hold these actions: ${[...Object.keys(DAODAO_PROPOSAL_ACTION_ACTORS), ...Object.keys(DAODAO_GROUP_STARGATE_ACTIONS)].join(', ')} as stargate messages, and the group actions in bank, staking, distribution and wasm form`,
        );
        return;
      } else {
        const problem = context.actionProblem({
          typeUrl,
          value: action.stargate.value,
        });
        if (problem !== undefined) {
          issue(ctx, [...at, 'value'], problem);
          return;
        }
      }
    }
    const group = namedGroup(action);
    if (group === undefined) return;
    const at = [...path, index, ...group.path];
    if (
      typeof group.address !== 'string' ||
      !DaoDaoContractAddressSchema.safeParse(group.address).success
    ) {
      issue(
        ctx,
        at,
        'The group itself carries out the action: its own (32-byte contract) address',
      );
      return;
    }
    if (actor !== undefined && actor !== group.address) {
      issue(ctx, at, 'Every action of a proposal names the same group');
    }
    actor ??= group.address;
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
