/**
 * The group actions `create_dao_proposal` builds from a few plain fields
 * (`groupActions`), so the model never writes a contract message. Each is
 * turned into the one action shape the Portal's own proposal builder writes
 * (`buildDaoDaoGroupAction` of `@ixo/ixo-transaction`), with every address
 * and current setting it needs read from the group on chain, never taken
 * from the model:
 *
 * - the group (its core): `proposal_module` of the intake, then `dao` of
 *   that proposal list (or `dao` of the proposal list given);
 * - its member list: `group_contract` of its voting module (`dump_state`);
 * - its governance token and staking contract: `token_contract` and
 *   `staking_contract` of its voting module;
 * - its current details (`config` of the core), voting rules (`config` of
 *   the proposal list) and who may propose (`config` of the intake, whose
 *   code must be the network's 2.0.3 `dao_pre_propose_single`): a change
 *   of one setting carries the others over, as the Portal does.
 *
 * Every read is one bounded chain REST GET (`restJson`) under one budget,
 * each made once per call. A read that fails is a refusal (`retryable` when
 * asking again may help), never a guess.
 */
import {
  DAODAO_CODE_IDS,
  DAODAO_GRANT_DAYS,
  DAODAO_VOTING_PERIOD_SECONDS,
  DaoDaoAnyAddressSchema,
  DaoDaoContractAddressSchema,
  DaoDaoValidatorAddressSchema,
  buildDaoDaoGroupAction,
  describeValidationError,
  type DaoDaoCoreConfig,
  type DaoDaoGroupActionInput,
  type DaoDaoIntakeConfig,
  type DaoDaoProposalAction,
  type DaoDaoProposalConfig,
} from '@ixo/ixo-transaction';
import { z } from 'zod';
import type { RuntimeContext } from '../../plugin-api/types';
import { TOOL_BUDGET_MS, type ChainCall } from '../ixo-chain/http';
import { restJson } from '../ixo-chain/rest';
import { oracleChainCall, smartQueryPath } from './dao-proposal-check';

const TAG = '[ixo-transaction]';

/* ── what the model gives ─────────────────────────────────────────────── */

const address = (what: string) =>
  DaoDaoAnyAddressSchema.describe(
    `${what}: an ixo1… account or contract address, exactly as the user gave it or as chain_lookup shows it. Never guess.`,
  );
const contract = (what: string) =>
  DaoDaoContractAddressSchema.describe(
    `${what}: a contract address, exactly as chain_lookup or the user gave it. Never guess.`,
  );
const validator = (what: string) =>
  DaoDaoValidatorAddressSchema.describe(
    `${what}: an ixovaloper1… address, from chain_lookup validators.`,
  );
const baseUnits = z
  .string()
  .regex(/^[1-9][0-9]{0,38}$/)
  .describe(
    'A whole number of base units, as a string (uixo: 1 IXO = 1000000).',
  );
const denom = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/)
  .default('uixo')
  .describe('The bank denom; uixo unless the user names another token.');
const share = z.union([
  z.strictObject({
    type: z.literal('percent'),
    percent: z.number().gt(0).max(100),
  }),
  z.strictObject({ type: z.literal('majority') }),
]);
const passRule = z
  .union([
    z.strictObject({
      type: z.literal('count'),
      count: z.number().int().min(1).max(1000),
    }),
    share,
  ])
  .describe(
    'How a proposal passes: a count of yes votes (a member-list group), a percent of the votes, or a majority.',
  );
const list = <T extends z.ZodType>(item: T) =>
  z.array(item).max(50).default([]);
const msgTypeUrl = z
  .string()
  .regex(/^\/[A-Za-z0-9.]+\.Msg[A-Za-z0-9]+$/)
  .describe('The message type, e.g. /cosmos.bank.v1beta1.MsgSend.');

/** One group action as the model asks for it, by `type`. */
export const GroupActionRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.enum(['delegate', 'undelegate']),
    validator: validator('The validator'),
    amount: baseUnits,
    denom,
  }),
  z.strictObject({
    type: z.literal('redelegate'),
    fromValidator: validator('Where the stake is now'),
    toValidator: validator('Where it moves'),
    amount: baseUnits,
    denom,
  }),
  z.strictObject({
    type: z.literal('withdraw-rewards'),
    validator: validator('The validator the group staked with'),
  }),
  z.strictObject({
    type: z.literal('gov-vote'),
    proposalId: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .describe(
        'The network proposal number, from chain_lookup gov_proposals.',
      ),
    vote: z.enum(['yes', 'no', 'abstain', 'no_with_veto']),
  }),
  z.strictObject({
    type: z.literal('update-members'),
    add: list(
      z.strictObject({
        address: address('A member to add, or whose weight changes'),
        weight: z.number().int().min(0).max(1_000_000).default(1),
      }),
    ),
    remove: list(address('A member to remove')),
  }),
  z.strictObject({
    type: z.literal('update-info'),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    imageUrl: z
      .url({ protocol: /^https?$/ })
      .max(1000)
      .nullable()
      .optional()
      .describe('A new image link, or null for none.'),
  }),
  z.strictObject({
    type: z.literal('update-voting-rules'),
    passRule: passRule.optional(),
    quorum: share
      .nullable()
      .optional()
      .describe(
        'With a percent or majority rule: the share of the voting power that must vote at all; null for none.',
      ),
    votingPeriodSeconds: z
      .number()
      .int()
      .min(DAODAO_VOTING_PERIOD_SECONDS.min)
      .max(DAODAO_VOTING_PERIOD_SECONDS.max)
      .optional(),
    allowRevoting: z.boolean().optional(),
    onlyMembersExecute: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('update-submission-rules'),
    anyoneCanPropose: z.boolean().optional(),
    deposit: z
      .strictObject({
        amount: baseUnits,
        token: z.union([
          z.strictObject({ native: denom }),
          z.strictObject({ cw20: contract('The deposit token') }),
          z.strictObject({ governanceToken: z.literal(true) }),
        ]),
        refundPolicy: z.enum(['always', 'only_passed', 'never']),
      })
      .nullable()
      .optional()
      .describe(
        'A new proposal deposit, or null for none; left out keeps the current one.',
      ),
  }),
  z.strictObject({
    type: z.literal('manage-sub-daos'),
    add: list(
      z.strictObject({
        address: contract('A sub-DAO to add'),
        charter: z.string().trim().min(1).max(1000).optional(),
      }),
    ),
    remove: list(contract('A sub-DAO to remove')),
  }),
  z.strictObject({
    type: z.enum(['manage-token-list', 'manage-nft-list']),
    add: list(contract('A token (cw20) or NFT collection (cw721) to track')),
    remove: list(contract('One to stop tracking')),
  }),
  z.strictObject({
    type: z.literal('set-item'),
    key: z.string().trim().min(1).max(128),
    value: z.string().min(1).max(1000),
  }),
  z.strictObject({
    type: z.literal('remove-item'),
    key: z.string().trim().min(1).max(128),
  }),
  z.strictObject({
    type: z.literal('send-group-tokens'),
    token: contract('The cw20 token'),
    recipient: address('Who receives them'),
    amount: baseUnits,
  }),
  z.strictObject({
    type: z.literal('stake-to-group'),
    amount: baseUnits.describe(
      'Base units of the group’s own governance token to stake.',
    ),
  }),
  z.strictObject({
    type: z.literal('mint-group-tokens'),
    recipient: address('Who receives the new tokens'),
    amount: baseUnits,
  }),
  z.strictObject({
    type: z.literal('transfer-nft'),
    collection: contract('The NFT collection'),
    recipient: address('Who receives it'),
    tokenId: z.string().min(1).max(256),
  }),
  z.strictObject({
    type: z.literal('burn-nft'),
    collection: contract('The NFT collection'),
    tokenId: z.string().min(1).max(256),
  }),
  z.strictObject({
    type: z.literal('token-swap-fund'),
    swapContract: contract('The token swap'),
    native: z.strictObject({ amount: baseUnits, denom }).optional(),
    cw20: z
      .strictObject({ token: contract('The cw20 token'), amount: baseUnits })
      .optional(),
  }),
  z.strictObject({
    type: z.literal('token-swap-withdraw'),
    swapContract: contract('The token swap'),
  }),
  z.strictObject({
    type: z.enum(['authz-grant', 'authz-revoke']),
    grantee: address('Who gets (or loses) the permission'),
    msgTypeUrl,
  }),
  z.strictObject({
    type: z.literal('update-admin'),
    contract: contract('The contract whose admin changes'),
    admin: address('The new admin'),
  }),
]);
export type GroupActionRequest = z.infer<typeof GroupActionRequestSchema>;

/**
 * When a permission the group gives ends: the Portal's year, from the
 * start of today (UTC), so the preview and the signing call build the same
 * message.
 */
export function grantExpiration(now: number): Date {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return new Date(day.getTime() + DAODAO_GRANT_DAYS * 86_400_000);
}

/* ── what is read on chain ────────────────────────────────────────────── */

const contractAddress = z.string().pipe(DaoDaoContractAddressSchema);
const addressAnswer = z.object({ data: contractAddress });

const durationSchema = z.union([
  z.object({ time: z.number().int() }),
  z.object({ height: z.number().int() }),
]);
const percentageSchema = z.union([
  z.object({ majority: z.object({}) }),
  z.object({ percent: z.string() }),
]);

/** `dao-proposal-single` `config`: every field `update_config` replaces. */
const proposalConfigAnswer = z.object({
  data: z.object({
    threshold: z.union([
      z.object({
        absolute_percentage: z.object({ percentage: percentageSchema }),
      }),
      z.object({
        threshold_quorum: z.object({
          threshold: percentageSchema,
          quorum: percentageSchema,
        }),
      }),
      z.object({ absolute_count: z.object({ threshold: z.string() }) }),
    ]),
    max_voting_period: durationSchema,
    min_voting_period: durationSchema.nullable().optional(),
    only_members_execute: z.boolean(),
    allow_revoting: z.boolean(),
    dao: contractAddress,
    close_proposal_on_execution_failure: z.boolean(),
    veto: z
      .object({
        vetoer: z.string(),
        timelock_duration: durationSchema,
        early_execute: z.boolean(),
        veto_before_passed: z.boolean(),
      })
      .nullable()
      .optional(),
  }),
});

const coreConfigAnswer = z.object({
  data: z.object({
    name: z.string(),
    description: z.string(),
    image_url: z.string().nullable().optional(),
    automatically_add_cw20s: z.boolean(),
    automatically_add_cw721s: z.boolean(),
    dao_uri: z.string().nullable().optional(),
  }),
});

const intakeConfigAnswer = z.object({
  data: z.object({
    deposit_info: z
      .object({
        amount: z.string(),
        denom: z.union([
          z.object({ native: z.string() }),
          z.object({ cw20: z.string() }),
        ]),
        refund_policy: z.enum(['always', 'only_passed', 'never']),
      })
      .nullable(),
    open_proposal_submission: z.boolean(),
  }),
});

const contractInfoAnswer = z.object({
  contract_info: z.object({ code_id: z.string() }),
});

const votingModuleAnswer = z.object({
  data: z.object({ voting_module: contractAddress }),
});

export type GroupActionsResult =
  | { ok: true; actions: DaoDaoProposalAction[] }
  | { ok: false; retryable: boolean; message: string };

class Refusal extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** One read per value per call: the group's addresses and settings. */
class GroupReads {
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(
    private readonly call: ChainCall,
    readonly target: { intake?: string; proposalModule?: string },
  ) {}

  private once<T>(key: string, read: () => Promise<T>): Promise<T> {
    let pending = this.memo.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = read();
      this.memo.set(key, pending);
    }
    return pending;
  }

  private async query<S extends z.ZodType>(
    what: string,
    contractAddr: string,
    query: unknown,
    schema: S,
  ): Promise<z.infer<S>> {
    const read = await restJson(
      this.call,
      smartQueryPath(contractAddr, query),
      schema,
      { label: `dao ${what}`, tag: TAG, contractQuery: true },
    );
    if (read.ok) return read.value;
    if (read.failure.reason === 'invalid_input')
      throw new Refusal(
        `${what} could not be read from ${contractAddr} (${read.failure.detail}): it may not be the DAO DAO contract it should be.`,
        false,
      );
    throw new Refusal(
      `${what} could not be read from the chain (${read.failure.detail}).${read.failure.retryable ? ' Try again in a moment.' : ''}`,
      read.failure.retryable,
    );
  }

  /** The proposal list proposals go to. */
  proposalModule(): Promise<string> {
    return this.once('proposal-module', async () => {
      if (this.target.proposalModule) return this.target.proposalModule;
      const intake = this.target.intake ?? '';
      return (
        await this.query(
          'The intake’s proposal list',
          intake,
          { proposal_module: {} },
          addressAnswer,
        )
      ).data;
    });
  }

  proposalConfig(): Promise<DaoDaoProposalConfig> {
    return this.once('proposal-config', async () => {
      const module = await this.proposalModule();
      const { data } = await this.query(
        'The proposal list’s rules',
        module,
        { config: {} },
        proposalConfigAnswer,
      );
      return {
        threshold: data.threshold,
        max_voting_period: data.max_voting_period,
        min_voting_period: data.min_voting_period ?? null,
        only_members_execute: data.only_members_execute,
        allow_revoting: data.allow_revoting,
        dao: data.dao,
        close_proposal_on_execution_failure:
          data.close_proposal_on_execution_failure,
        ...(data.veto !== undefined ? { veto: data.veto } : {}),
      };
    });
  }

  /** The group's own address (its core). */
  async group(): Promise<string> {
    return (await this.proposalConfig()).dao;
  }

  coreConfig(): Promise<DaoDaoCoreConfig> {
    return this.once('core-config', async () => {
      const { data } = await this.query(
        'The group’s details',
        await this.group(),
        { config: {} },
        coreConfigAnswer,
      );
      return {
        name: data.name,
        description: data.description,
        image_url: data.image_url ?? null,
        automatically_add_cw20s: data.automatically_add_cw20s,
        automatically_add_cw721s: data.automatically_add_cw721s,
        dao_uri: data.dao_uri ?? null,
      };
    });
  }

  votingModule(): Promise<string> {
    return this.once('voting-module', async () => {
      const { data } = await this.query(
        'The group’s voting module',
        await this.group(),
        { dump_state: {} },
        votingModuleAnswer,
      );
      return data.voting_module;
    });
  }

  /** An address the voting module answers, or why the group has none. */
  votingModuleAddress(
    query: 'group_contract' | 'token_contract' | 'staking_contract',
    none: string,
  ): Promise<string> {
    return this.once(query, async () => {
      const module = await this.votingModule();
      try {
        return (await this.query(none, module, { [query]: {} }, addressAnswer))
          .data;
      } catch (error) {
        if (error instanceof Refusal && !error.retryable)
          throw new Refusal(none, false);
        throw error;
      }
    });
  }

  intakeConfig(network: ChainCall['network']): Promise<DaoDaoIntakeConfig> {
    return this.once('intake-config', async () => {
      const intake = this.target.intake;
      if (!intake)
        throw new Refusal(
          'Changing who can propose is made through the group’s intake: give `intake` (from chain_lookup daos), not `proposalModule`.',
          false,
        );
      const info = await restJson(
        this.call,
        `/cosmwasm/wasm/v1/contract/${intake}`,
        contractInfoAnswer,
        { label: 'dao intake', tag: TAG, contractQuery: true },
      );
      if (!info.ok)
        throw new Refusal(
          `The intake ${intake} could not be read from the chain (${info.failure.detail}).`,
          info.failure.retryable,
        );
      const code = DAODAO_CODE_IDS[network].dao_pre_propose_single;
      if (info.value.contract_info.code_id !== String(code))
        throw new Refusal(
          `The group’s intake runs code ${info.value.contract_info.code_id}, not the DAO DAO 2.0.3 intake (code ${code} on ${network}) whose rules this tool changes: change who can propose in the Portal instead.`,
          false,
        );
      return (
        await this.query(
          'Who can propose now',
          intake,
          { config: {} },
          intakeConfigAnswer,
        )
      ).data;
    });
  }
}

/** The builder input of one request, with what it needs read from the group. */
async function actionInput(
  request: GroupActionRequest,
  reads: GroupReads,
  network: ChainCall['network'],
  now: number,
): Promise<DaoDaoGroupActionInput> {
  switch (request.type) {
    case 'delegate':
    case 'undelegate':
      return {
        type: request.type,
        validator: request.validator,
        amount: { amount: request.amount, denom: request.denom },
      };
    case 'redelegate':
      return {
        type: 'redelegate',
        fromValidator: request.fromValidator,
        toValidator: request.toValidator,
        amount: { amount: request.amount, denom: request.denom },
      };
    case 'withdraw-rewards':
      return request;
    case 'gov-vote':
      return {
        type: 'gov-vote',
        group: await reads.group(),
        proposalId: request.proposalId,
        option: request.vote,
      };
    case 'update-members':
      return {
        type: 'update-members',
        cw4Group: await reads.votingModuleAddress(
          'group_contract',
          'The group’s votes do not come from a member list, so members cannot be added or removed by a proposal here.',
        ),
        add: request.add.map(({ address: addr, weight }) => ({ addr, weight })),
        remove: request.remove,
      };
    case 'update-info':
      return {
        type: 'update-info',
        group: await reads.group(),
        current: await reads.coreConfig(),
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.description !== undefined
          ? { description: request.description }
          : {}),
        ...(request.imageUrl !== undefined
          ? { imageUrl: request.imageUrl }
          : {}),
      };
    case 'update-voting-rules':
      return {
        type: 'update-voting-rules',
        proposalModule: await reads.proposalModule(),
        current: await reads.proposalConfig(),
        ...(request.passRule !== undefined
          ? { passRule: request.passRule }
          : {}),
        ...(request.quorum !== undefined ? { quorum: request.quorum } : {}),
        ...(request.votingPeriodSeconds !== undefined
          ? { votingPeriodSeconds: request.votingPeriodSeconds }
          : {}),
        ...(request.allowRevoting !== undefined
          ? { allowRevoting: request.allowRevoting }
          : {}),
        ...(request.onlyMembersExecute !== undefined
          ? { onlyMembersExecute: request.onlyMembersExecute }
          : {}),
      };
    case 'update-submission-rules': {
      const current = await reads.intakeConfig(network);
      const deposit = request.deposit;
      return {
        type: 'update-submission-rules',
        // Read above: intakeConfig refuses a call without one.
        intake: reads.target.intake ?? '',
        current,
        ...(request.anyoneCanPropose !== undefined
          ? { anyoneCanPropose: request.anyoneCanPropose }
          : {}),
        ...(deposit !== undefined
          ? {
              deposit:
                deposit === null
                  ? null
                  : {
                      amount: deposit.amount,
                      denom:
                        'governanceToken' in deposit.token
                          ? { voting_module_token: {} }
                          : { token: { denom: deposit.token } },
                      refund_policy: deposit.refundPolicy,
                    },
            }
          : {}),
      };
    }
    case 'manage-sub-daos':
      return {
        type: 'manage-sub-daos',
        group: await reads.group(),
        add: request.add.map(({ address: addr, charter }) => ({
          addr,
          charter: charter ?? null,
        })),
        remove: request.remove,
      };
    case 'manage-token-list':
    case 'manage-nft-list':
      return {
        type: request.type,
        group: await reads.group(),
        add: request.add,
        remove: request.remove,
      };
    case 'set-item':
      return { ...request, group: await reads.group() };
    case 'remove-item':
      return { ...request, group: await reads.group() };
    case 'send-group-tokens':
    case 'transfer-nft':
    case 'burn-nft':
    case 'token-swap-withdraw':
    case 'update-admin':
      return request;
    case 'stake-to-group': {
      const none =
        'The group has no governance token staked in a staking contract (its votes do not come from staked cw20 tokens), so there is nothing to stake into.';
      return {
        type: 'stake-to-group',
        token: await reads.votingModuleAddress('token_contract', none),
        stakingContract: await reads.votingModuleAddress(
          'staking_contract',
          none,
        ),
        amount: request.amount,
      };
    }
    case 'mint-group-tokens':
      return {
        type: 'mint-group-tokens',
        token: await reads.votingModuleAddress(
          'token_contract',
          'The group has no governance token (its votes do not come from a cw20 token), so there is nothing to mint.',
        ),
        recipient: request.recipient,
        amount: request.amount,
      };
    case 'token-swap-fund': {
      if ((request.native === undefined) === (request.cw20 === undefined))
        throw new Refusal(
          'Funding a token swap pays with exactly one of `native` (coins) or `cw20` (a token).',
          false,
        );
      return {
        type: 'token-swap-fund',
        swapContract: request.swapContract,
        pay: request.native
          ? { native: request.native }
          : { cw20: request.cw20 as { token: string; amount: string } },
      };
    }
    case 'authz-grant':
      return {
        type: 'authz-grant',
        group: await reads.group(),
        grantee: request.grantee,
        msgTypeUrl: request.msgTypeUrl,
        expiration: grantExpiration(now),
      };
    case 'authz-revoke':
      return {
        type: 'authz-revoke',
        group: await reads.group(),
        grantee: request.grantee,
        msgTypeUrl: request.msgTypeUrl,
      };
  }
}

/**
 * The proposal actions for `requests`, in order, each read and built for
 * the group behind `target` (its intake or proposal list), or why not:
 * a read that failed or a group that has no such part (no member list, no
 * governance token, an intake of another version), or an action its one
 * shape refuses. Nothing is sent either way.
 */
export async function resolveGroupActions(
  ctx: RuntimeContext,
  target: { intake?: string; proposalModule?: string },
  requests: readonly GroupActionRequest[],
): Promise<GroupActionsResult> {
  if (requests.length === 0) return { ok: true, actions: [] };
  const call = oracleChainCall(ctx, TOOL_BUDGET_MS);
  const reads = new GroupReads(call, target);
  const now = Date.now();
  const actions: DaoDaoProposalAction[] = [];
  for (const [index, request] of requests.entries()) {
    try {
      actions.push(
        buildDaoDaoGroupAction(
          await actionInput(request, reads, call.network, now),
        ),
      );
    } catch (error) {
      const message =
        error instanceof Refusal
          ? error.message
          : describeValidationError(error);
      return {
        ok: false,
        retryable: error instanceof Refusal ? error.retryable : false,
        message: `Nothing was sent: groupActions.${index} (${request.type}): ${message}`,
      };
    }
  }
  return { ok: true, actions };
}
