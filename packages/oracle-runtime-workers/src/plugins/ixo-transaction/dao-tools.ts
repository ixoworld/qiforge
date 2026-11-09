/**
 * DAO DAO groups from a Portal chat, as five thin tools. `create_dao_group`
 * creates a group of its own (a POD's governance group is the POD
 * Creator's `create_pod_group`): one `MsgInstantiateContract` built with
 * `buildDaoDaoGroupInstantiate`, the user's own account among its members,
 * the new group's addresses read back from the signed transaction
 * (`dao-group.ts`). The proposal steps create a proposal, vote on one,
 * carry out a passed one and close a rejected one, each one
 * `MsgExecuteContract` built with `buildDaoDaoProposalMessage`. Every tool
 * builds its message from a few fields (the nested contract message is
 * never written by the model) and sends it to the user's Portal wallet as a
 * one-message batch whose summary says exactly what it does — the same
 * `sign_transaction` contract and the same signing path as
 * `sign_ixo_transaction`.
 *
 * Consent: a call without `riskConfirmation` sends nothing and answers the
 * summary and every risk (`status: 'confirm'`): the step's catalog risks
 * and those of each action a proposal holds (a proposal's from its fields,
 * a carry-out's read from the proposal on chain). The summary names each
 * action with its values. The call that signs quotes every risk the user
 * accepted word for word, carries the same fields as a preview made in an
 * earlier request of this conversation, and spends that preview
 * (`dao-confirmations.ts`); the user then reviews and signs in their own
 * wallet. A group is sent once per conversation: the same group again is
 * refused while it is being signed, once created, and after a lost answer
 * until its transaction is read back.
 *
 * Network: the oracle's chain network (`NETWORK`, as `chain_lookup` reads
 * it), so the group and proposal addresses found there are on the network
 * signed for. Mainnet needs `IXO_TRANSACTION_ALLOW_MAINNET=true`; there is
 * no testnet receipt, since a group and its proposals exist on one network
 * only.
 *
 * Before a vote, carry-out or close is shown and again right before it is
 * sent, the proposal is read from its proposal module (one smart query,
 * `dao-proposal-check.ts`): a step the proposal's state rules out (voting
 * closed, not passed, not rejected) or a proposal that cannot be read is
 * `refused` with the reason, the tally and the deadline, and nothing is
 * sent. The chain still checks who may propose, vote, carry out or close: a
 * step it refuses comes back `failed` or `error` with the chain's words
 * and, for the common refusals, a plain `hint`.
 */
import {
  DAODAO_DEFAULT_ALLOW_REVOTING,
  DAODAO_MAX_DESCRIPTION_LENGTH,
  DAODAO_MAX_NAME_LENGTH,
  DAODAO_MAX_PROPOSAL_ACTIONS,
  DAODAO_MAX_RATIONALE_LENGTH,
  DAODAO_MAX_TITLE_LENGTH,
  DAODAO_VOTE_OPTIONS,
  DAODAO_VOTING_PERIOD_SECONDS,
  DaoDaoContractAddressSchema,
  ITrxMsgSchema,
  MAX_BATCH_SUMMARY_LENGTH,
  RiskConfirmationSchema,
  SIGN_TRANSACTION_ACTION_NAME,
  buildBatchSignTransactionActionArgs,
  buildDaoDaoGroupInstantiate,
  buildDaoDaoProposalMessage,
  describeDaoDaoProposalAction,
  describeValidationError,
  riskTextKey,
  validateTransactionBatch,
  type DaoDaoExecuteAction,
  type DaoDaoProposalMessageInput,
  type ITrxMsg,
  type Network,
  type RiskConfirmation,
} from '@ixo/ixo-transaction';
import { z } from 'zod';
import { operationKey } from '../../core/middlewares/tool-execution';
import { ixoAddressOf } from '../../core/user-identity';
import { tool } from '../../plugin-api/tool-helper';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';
import { TOOL_BUDGET_MS } from '../ixo-chain/http';
import { networkOf } from '../ixo-chain/ixo-chain.plugin';
import { TX_HASH_PATTERN } from '../ixo-chain/tx-lookup';
import { logActionToMatrix } from '../portal/action-log';
import {
  GROUP_VOTING_RULES_GUIDANCE,
  MAX_DAO_GROUP_MEMBERS,
  findDaoGroup,
  groupAllowRevotingField,
  groupMembersField,
  groupThresholdField,
  groupVotingPeriodField,
  membersText,
  passRuleText,
  type DaoGroupLookup,
  type DaoGroupSpec,
} from './dao-group';
import {
  GROUP_ATTEMPT_HOLD_MS,
  KvDaoConfirmationStore,
  type GroupAttempt,
  type GroupSettlement,
} from './dao-confirmations';
import {
  checkDaoProposal,
  oracleChainCall,
  proposalNamed,
} from './dao-proposal-check';
import type { ProposalAction } from './proposal-actions';
import type { IxoTransactionToolOptions } from './tools';
import {
  requestWalletSignature,
  walletUnavailableReason,
  type WalletSignatureOutcome,
} from './wallet-signing';

/** What a DAO DAO step tool returns to the model. */
export type DaoProposalStepResult =
  | {
      /** Nothing was sent: show the summary and risks, then call again with `riskConfirmation`. */
      status: 'confirm';
      network: Network;
      summary: string;
      risks: string[];
      /** The proposal's state as read now (vote, carry out, close): tell the user. */
      proposal?: string;
      /** A carry-out's: every action of the proposal, in its order, as the user is shown it. */
      actions?: string[];
      message: string;
    }
  | {
      /**
       * Nothing was sent: the proposal's state rules the step out, or the
       * proposal could not be read (`retryable`: ask again later).
       */
      status: 'refused';
      step: DaoDaoExecuteAction;
      retryable: boolean;
      message: string;
    }
  | {
      status: 'signed';
      step: DaoDaoExecuteAction;
      network: Network;
      chainId: string;
      transactionHash?: string;
      code?: number;
      height?: string | number;
      message: string;
    }
  | {
      /** Included in a block but failed: the hash and code are real. */
      status: 'failed';
      step: DaoDaoExecuteAction;
      network: Network;
      chainId: string;
      code: number;
      transactionHash?: string;
      height?: string | number;
      error: string;
      hint?: string;
      message: string;
    }
  | {
      status: 'rejected' | 'error';
      step: DaoDaoExecuteAction;
      network: Network;
      error: string;
      hint?: string;
      message: string;
    }
  | {
      status: 'timeout';
      /** The wallet may still sign after the oracle stopped waiting. */
      outcome: 'unknown';
      step: DaoDaoExecuteAction;
      network: Network;
      error: string;
    }
  | { status: 'validation_error' | 'unavailable'; error: string };

const contract = (what: string) =>
  DaoDaoContractAddressSchema.describe(
    `${what} Copy it exactly from chain_lookup; never guess it.`,
  );

const proposalModule = contract(
  'The proposal list the proposal is in: `proposalModule` in chain_lookup dao_proposals (not the group’s `dao` address).',
);

const proposalId = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER)
  .describe(
    'The proposal number: `id` in chain_lookup dao_proposals, without the list’s letter (3 for A3).',
  );

export const riskConfirmation = RiskConfirmationSchema.optional().describe(
  'Leave out on the first call: it sends nothing and returns the summary and risks to show the user. Once the user agreed in their own words, call again with every risk quoted exactly and confirmed: true.',
);

/** One line of plain text, as the contracts publish it. */
const publishedText = (max: number, what: string) =>
  z.string().trim().min(1).max(max).describe(what);

const proposeSchema = z
  .strictObject({
    intake: contract(
      'The group’s intake for new proposals: `intake` of the proposal list in chain_lookup daos.',
    ).optional(),
    proposalModule: contract(
      'Only for a proposal list without an intake (it takes proposals straight from anyone): its `proposalModule` in chain_lookup daos.',
    ).optional(),
    title: publishedText(
      DAODAO_MAX_TITLE_LENGTH,
      'The proposal’s title, as the user wants it published (one line).',
    ),
    description: publishedText(
      DAODAO_MAX_DESCRIPTION_LENGTH,
      'What the proposal asks, as the user wants it published (one line, plain text).',
    ),
    actions: z
      .array(ITrxMsgSchema)
      .max(DAODAO_MAX_PROPOSAL_ACTIONS)
      .optional()
      .describe(
        'What the group’s own account does if the proposal passes: catalog messages (proto-JSON `{ typeUrl, value }`) whose actor is the group (`dao`), e.g. a MsgSend with fromAddress = the group. Leave out for a proposal that only asks for agreement.',
      ),
    riskConfirmation,
  })
  .refine(
    (input) =>
      (input.intake === undefined) !== (input.proposalModule === undefined),
    {
      message:
        'Give exactly one of `intake` (the usual way) or `proposalModule` (a list without an intake).',
      path: ['intake'],
    },
  );

const voteSchema = z.strictObject({
  proposalModule,
  proposalId,
  vote: z
    .enum(DAODAO_VOTE_OPTIONS)
    .describe('How the user votes, in their own words: yes, no or abstain.'),
  rationale: publishedText(
    DAODAO_MAX_RATIONALE_LENGTH,
    'Optional: the user’s reason, published with the vote, exactly as they said it (one line).',
  ).optional(),
  riskConfirmation,
});

const proposalStepSchema = z.strictObject({
  proposalModule,
  proposalId,
  riskConfirmation,
});

/** The proposal a vote, carry-out or close acts on, as read on chain. */
type ProposalSeen = { title: string; actions: ProposalAction[] };

type DaoStep = {
  step: DaoDaoExecuteAction;
  input: DaoDaoProposalMessageInput;
  /** The proposal a vote, carry-out or close acts on: checked on chain first. */
  target?: {
    step: Exclude<DaoDaoExecuteAction, 'propose'>;
    proposalModule: string;
    proposalId: number;
  };
  /**
   * What the user approves, in plain words, with every value the message
   * carries; `proposal` is the one acted on, as read on chain. Throws when
   * it does not fit the wallet's summary.
   */
  summary: (proposal?: ProposalSeen) => string;
  riskConfirmation?: RiskConfirmation;
};

/** The first of `candidates` (most complete first) that fits the wallet's summary. */
export function fittedSummary(
  candidates: readonly string[],
  tooLong: string,
): string {
  const fits = candidates.find(
    (summary) => summary.length <= MAX_BATCH_SUMMARY_LENGTH,
  );
  if (fits === undefined) throw new Error(tooLong);
  return fits;
}

function proposeStep(args: unknown, sender: string, network: Network): DaoStep {
  const input = proposeSchema.parse(args);
  const actions = input.actions ?? [];
  const via = input.intake ? 'pre-propose' : 'proposal-module';
  const target = input.intake ?? input.proposalModule ?? '';
  const does =
    actions.length === 0
      ? 'nothing: it only asks for agreement'
      : actions.map(describeDaoDaoProposalAction).join('; ');
  const summary = (description: string) =>
    `Create a group proposal on ${network} through ${via === 'pre-propose' ? 'the group’s intake' : 'the proposal list'} ${target}, from your account ${sender}: title "${input.title}"; ${description}. If it passes, the group’s own account does ${does}.`;
  return {
    step: 'propose',
    input: {
      action: 'propose',
      sender,
      contract: target,
      via,
      title: input.title,
      description: input.description,
      actions,
    },
    // Every action with its values; the description gives way first when
    // they do not fit together (the wallet's details show it).
    summary: () =>
      fittedSummary(
        [
          summary(`description "${input.description}"`),
          summary('the description is in the wallet’s details'),
        ],
        `The proposal’s actions, with their values, are longer than the wallet’s summary (${MAX_BATCH_SUMMARY_LENGTH} characters) can show: propose fewer actions at once.`,
      ),
    ...(input.riskConfirmation
      ? { riskConfirmation: input.riskConfirmation }
      : {}),
  };
}

function voteStep(args: unknown, sender: string, network: Network): DaoStep {
  const input = voteSchema.parse(args);
  return {
    step: 'vote',
    input: {
      action: 'vote',
      sender,
      proposalModule: input.proposalModule,
      proposalId: input.proposalId,
      vote: input.vote,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
    },
    target: {
      step: 'vote',
      proposalModule: input.proposalModule,
      proposalId: input.proposalId,
    },
    summary: (proposal) =>
      `Vote ${input.vote.toUpperCase()} on ${proposalNamed(input.proposalId, proposal?.title)} of the group proposal list ${input.proposalModule} on ${network}, from your account ${sender}${input.rationale !== undefined ? `, with the reason "${input.rationale}"` : ', with no reason'}.`,
    ...(input.riskConfirmation
      ? { riskConfirmation: input.riskConfirmation }
      : {}),
  };
}

function settleStep(
  step: 'execute' | 'close',
  args: unknown,
  sender: string,
  network: Network,
): DaoStep {
  const input = proposalStepSchema.parse(args);
  const what =
    step === 'execute' ? 'Carry out the passed' : 'Close the rejected';
  const head = (proposal?: ProposalSeen) =>
    `${what} ${proposalNamed(input.proposalId, proposal?.title)} of the group proposal list ${input.proposalModule} on ${network}, from your account ${sender}: `;
  return {
    step,
    input: {
      action: step,
      sender,
      proposalModule: input.proposalModule,
      proposalId: input.proposalId,
    },
    target: {
      step,
      proposalModule: input.proposalModule,
      proposalId: input.proposalId,
    },
    summary: (proposal) =>
      step === 'close'
        ? `${head(proposal)}none of its actions will happen.`
        : executeSummary(head(proposal), proposal?.actions),
    ...(input.riskConfirmation
      ? { riskConfirmation: input.riskConfirmation }
      : {}),
  };
}

/**
 * What carrying a proposal out does, action by action, after `head`. When
 * every action does not fit the wallet's summary, the first ones that do
 * are named and the rest counted (the preview's `actions` lists them all).
 */
function executeSummary(
  head: string,
  actions: readonly ProposalAction[] | undefined,
): string {
  if (actions === undefined)
    return `${head}the group’s own account does every action in it.`;
  if (actions.length === 0)
    return `${head}it holds no actions, so carrying it out only marks it carried out.`;
  const all =
    actions.length === 1 ? 'its one action' : `its ${actions.length} actions`;
  const listed = (count: number) => {
    if (count === 0)
      return `${head}the group’s own account does ${all}, too long to list here: see the proposal in the Portal’s Decisions tab.`;
    const named = actions
      .slice(0, count)
      .map((action, index) => `${index + 1}) ${action.text}`)
      .join('; ');
    const rest = actions.length - count;
    const more =
      rest === 0
        ? ''
        : `; and ${rest} more (see the proposal in the Portal’s Decisions tab)`;
    return `${head}the group’s own account does ${all}: ${named}${more}.`;
  };
  return fittedSummary(
    actions.map((_, index) => listed(actions.length - index)).concat(listed(0)),
    'The proposal’s summary does not fit the wallet’s summary.',
  );
}

/**
 * The refusals of DAO DAO 2.0.3 that people run into, each as the
 * contract words it (`#[error(...)]` of `ContractError` in
 * `contracts/proposal/dao-proposal-single/src/error.rs` and of
 * `PreProposeError` in `packages/dao-pre-propose-base/src/error.rs`, tag
 * v2.0.3 of DA0-DA0/dao-contracts) and its plain reason.
 */
const DAO_REFUSALS: ReadonlyArray<{
  words: RegExp;
  hint: (step: DaoDaoExecuteAction) => string;
}> = [
  {
    // `NotRegistered`: a vote from an account without voting power at the
    // proposal's start height.
    words:
      /not registered to vote \(no voting power\) at time of proposal creation/i,
    hint: () =>
      'Only members of the group vote, with the voting power they had when the proposal opened: this wallet’s account had none on this proposal.',
  },
  {
    // `PreProposeError::NotMember`: a proposal from a non-member.
    words:
      /you must be a member of this dao \(have voting power\) to create a proposal/i,
    hint: () =>
      'Only members of the group can create proposals, and this wallet’s account is not one.',
  },
  {
    // `AlreadyVoted`: a second vote where vote changes are off.
    words: /already voted\. this proposal does not support revoting/i,
    hint: () =>
      'This account already voted on the proposal, and the group does not let a vote be changed.',
  },
  {
    // `AlreadyCast`: the same vote again where vote changes are on.
    words: /already cast a vote with that option/i,
    hint: () =>
      'This account already cast this same vote; to change it, vote another way.',
  },
  {
    // `Expired`: a vote after the voting time.
    words: /proposal \(\d+\) is expired/i,
    hint: () =>
      'The proposal’s voting time is over, so it can no longer be voted on.',
  },
  {
    // `NotPassed`: carrying out a proposal that is not `passed` now.
    words: /proposal is not in 'passed' state/i,
    hint: () =>
      'Only a proposal that passed can be carried out: this one is still open (a group that lets members change votes decides only when voting closes), did not pass, or was already carried out.',
  },
  {
    // `WrongCloseStatus`: closing a proposal that is not `rejected` now.
    words: /only rejected proposals may be closed/i,
    hint: () =>
      'Only a proposal that did not pass can be closed: this one is still open, passed, or is already closed or carried out.',
  },
  {
    // `Unauthorized`: carrying out by a non-member when only members may.
    // Only the contract's (wasmd wraps it "<error>: execute wasm contract
    // failed"), never the SDK's own `unauthorized` (a bad signature).
    words: /\bunauthorized: execute wasm contract failed/i,
    hint: (step) =>
      step === 'execute'
        ? 'Only members of the group can carry out its proposals, and this wallet’s account had no voting power when the proposal opened.'
        : 'The group does not let this wallet’s account do this.',
  },
  {
    // `NoSuchProposal`, and the storage miss of `close` on an unknown id.
    words: /no such proposal \(\d+\)|SingleChoiceProposal not found/i,
    hint: () =>
      'The group has no proposal with that number in that proposal list: check proposalModule and the id with chain_lookup dao_proposals.',
  },
  {
    // `InactiveDao`: a proposal while the group is paused.
    words: /the dao is currently inactive, you cannot create proposals/i,
    hint: () => 'The group is paused, so it takes no new proposals right now.',
  },
];

/**
 * The plain reason behind a DAO DAO contract's refusal, from the chain's or
 * the wallet simulation's words; undefined for any other error.
 */
export function daoStepHint(
  step: DaoDaoExecuteAction,
  error: string,
): string | undefined {
  return DAO_REFUSALS.find(({ words }) => words.test(error))?.hint(step);
}

const NEXT_STEP: Record<DaoDaoExecuteAction, string> = {
  propose:
    'The proposal was created. Its number is assigned on chain: read it with chain_lookup dao_proposals (the index is seconds behind) before telling the user.',
  vote: 'The vote was recorded. chain_lookup dao_proposals shows the new tally once indexed (seconds behind).',
  execute:
    'The proposal was carried out. Check its status with chain_lookup dao_proposals before saying its actions happened: a failed run marks it execution_failed.',
  close: 'The proposal was closed.',
};

/** A refusal before anything is built: no account, or mainnet off. */
export type NotSignable = {
  status: 'validation_error' | 'unavailable';
  error: string;
};

/**
 * Who signs a DAO DAO step and on which network: the user's own account,
 * on the oracle's chain network; refused for a DID that is not an IXO
 * account, and on mainnet unless the oracle allows it.
 */
export function daoSigner(
  ctx: RuntimeContext,
  options: IxoTransactionToolOptions,
  where: string,
): { ok: true; sender: string; network: Network } | NotSignable {
  const sender = ixoAddressOf(ctx.user.did);
  if (!sender) {
    return {
      status: 'unavailable',
      error:
        'Your identity is not an IXO account (did:ixo:ixo1…), so there is no wallet account to act in a group from.',
    };
  }
  const network = networkOf(ctx.config);
  if (network === 'mainnet' && !options.allowMainnet) {
    return {
      status: 'validation_error',
      error: `This oracle works with groups on mainnet, but signing mainnet transactions is turned off here (IXO_TRANSACTION_ALLOW_MAINNET). Nothing was sent; ${where}`,
    };
  }
  return { ok: true, sender, network };
}

/** A wallet answer other than `signed`, as a DAO DAO tool returns it (no `step`). */
export type UnsignedResult =
  | {
      status: 'failed';
      network: Network;
      chainId: string;
      code: number;
      transactionHash?: string;
      height?: string | number;
      error: string;
      hint?: string;
      message: string;
    }
  | {
      status: 'rejected' | 'error';
      network: Network;
      error: string;
      hint?: string;
      message: string;
    }
  | {
      status: 'timeout';
      outcome: 'unknown';
      network: Network;
      error: string;
    }
  | { status: 'unavailable'; error: string };

/**
 * Map a wallet answer other than `signed` for the model; `hintOf` gives
 * the plain reason of a refusal it recognises.
 */
export function unsignedResult(
  outcome: Exclude<WalletSignatureOutcome, { status: 'signed' }>,
  network: Network,
  chainId: string,
  tool: string,
  hintOf: (error: string) => string | undefined,
): UnsignedResult {
  const again = `If they want to try again, call ${tool} again without riskConfirmation, show them the summary and wait for their answer in a new message: every signing needs a preview of its own.`;
  switch (outcome.status) {
    case 'failed': {
      const hint = hintOf(outcome.error);
      return {
        ...outcome,
        network,
        chainId,
        ...(hint ? { hint } : {}),
        message:
          'The transaction was included in a block but failed (the chain’s reason is in `error`, with a `hint` when it is a common group refusal), so nothing changed; only the network fee was paid. Tell the user why, in plain words.',
      };
    }
    case 'rejected':
      return {
        ...outcome,
        network,
        message: `The user declined it in the Portal or their wallet, so nothing was signed. ${again}`,
      };
    case 'error': {
      const hint = hintOf(outcome.error);
      return {
        ...outcome,
        network,
        ...(hint ? { hint } : {}),
        message: `Nothing was signed or sent: the wallet refused to send it. \`error\` is its reason — usually the chain refusing the step when the wallet simulated it — with a \`hint\` when it is a common group refusal. Tell the user that reason in plain words, not only that it failed. ${again}`,
      };
    }
    case 'timeout':
      return { ...outcome, network };
    case 'unavailable':
      return outcome;
  }
}

/** What the wallet was asked, and its answer, in the user's room. */
export function logSigning(
  ctx: RuntimeContext,
  signArgs: ReturnType<typeof buildBatchSignTransactionActionArgs>,
  result: { status: string; error?: string },
): void {
  logActionToMatrix(ctx, {
    name: SIGN_TRANSACTION_ACTION_NAME,
    args: signArgs,
    result,
    success: result.status === 'signed' || result.status === 'created',
    ...(result.error !== undefined ? { error: result.error } : {}),
  });
}

/**
 * The user's record of DAO DAO previews and group attempts for this
 * session, or why there is none (a host without `ctx.kv`: nothing can be
 * confirmed across messages, so nothing is signed).
 */
export function confirmationsOf(
  ctx: RuntimeContext,
): { ok: true; store: KvDaoConfirmationStore } | NotSignable {
  if (!ctx.kv)
    return {
      status: 'unavailable',
      error:
        'This oracle keeps no per-user store (ctx.kv), so a group step cannot be shown in one message and confirmed in the next; nothing was sent.',
    };
  return { ok: true, store: new KvDaoConfirmationStore(ctx.kv) };
}

/** The risks among `risks` the confirmation does not quote word for word. */
function unaccepted(
  risks: readonly string[],
  confirmation: RiskConfirmation,
): string[] {
  const accepted = new Set(confirmation.acceptedRisks.map(riskTextKey));
  return risks.filter((risk) => !accepted.has(riskTextKey(risk)));
}

const uniqueRisks = (...lists: ReadonlyArray<readonly string[]>): string[] => [
  ...new Set(lists.flat()),
];

/** The catalog risks of every action of the proposal that could be read. */
const actionRisks = (proposal: ProposalSeen | undefined): string[] =>
  uniqueRisks(
    ...(proposal?.actions ?? []).map((action) =>
      action.decoded ? action.risks : [],
    ),
  );

/** Why a signing call that was not confirmed in a later message is refused. */
export function unconfirmedRefusal(
  claim: 'not-previewed' | 'same-request',
  tool: string,
): string {
  return claim === 'not-previewed'
    ? `Nothing was sent: this exact ${tool} call (the same fields) was not shown to the user first in this conversation, or its preview was already used. Call ${tool} without riskConfirmation, show the user the summary and every risk, and wait for their reply in a new message.`
    : `Nothing was sent: the summary was shown in this same turn. Show it to the user and wait for their reply in a new message; only then call ${tool} again with the same fields and riskConfirmation.`;
}

async function runDaoStep(
  ctx: RuntimeContext,
  options: IxoTransactionToolOptions,
  tool: string,
  build: (sender: string, network: Network) => DaoStep,
): Promise<DaoProposalStepResult> {
  const signer = daoSigner(
    ctx,
    options,
    'the user can act on the proposal in the Portal’s Decisions tab instead.',
  );
  if (!('ok' in signer)) return signer;
  const confirmations = confirmationsOf(ctx);
  if (!('ok' in confirmations)) return confirmations;
  const { store } = confirmations;
  const { sender, network } = signer;
  let daoStep: DaoStep;
  let message: ITrxMsg;
  try {
    daoStep = build(sender, network);
    message = buildDaoDaoProposalMessage(daoStep.input);
  } catch (error) {
    return {
      status: 'validation_error',
      error: describeValidationError(error),
    };
  }
  const { step } = daoStep;
  // The step as the user is shown it and as it is signed: the same fields.
  const digest = await operationKey(tool, { network, input: daoStep.input });
  const turn = { digest, requestId: ctx.session.requestId };
  const batch = (proposal?: ProposalSeen) => ({
    network,
    summary: daoStep.summary(proposal),
    messages: [message],
  });
  /** The proposal's state now, or why the step cannot go ahead (nothing is sent then). */
  const check = async () =>
    daoStep.target ? checkDaoProposal(ctx, daoStep.target) : undefined;
  const refusedBy = (refusal: { retryable: boolean; message: string }) => ({
    status: 'refused' as const,
    step,
    retryable: refusal.retryable,
    message: refusal.message,
  });
  const invalid = (error: unknown) => ({
    status: 'validation_error' as const,
    error: describeValidationError(error),
  });

  if (!daoStep.riskConfirmation) {
    const proposal = await check();
    if (proposal && !proposal.ok) return refusedBy(proposal);
    let validated: ReturnType<typeof validateTransactionBatch>;
    try {
      validated = validateTransactionBatch(batch(proposal), {
        allowMainnet: options.allowMainnet,
      });
    } catch (error) {
      return invalid(error);
    }
    await store.preview(ctx.user.did, ctx.session.id, turn);
    const actions =
      step === 'execute' && proposal
        ? proposal.actions.map((action) => action.text)
        : undefined;
    return {
      status: 'confirm',
      network,
      summary: validated.summary,
      risks: uniqueRisks(validated.risks, actionRisks(proposal)),
      ...(proposal ? { proposal: proposal.state } : {}),
      ...(actions ? { actions } : {}),
      message: `Nothing was sent. Show the user this summary and every risk, word for word${proposal ? ', with the proposal’s state' : ''}${actions ? ' and every action it carries out' : ''}, and stop. Only when they agree in a later message, call this tool again with the same fields and riskConfirmation quoting each risk exactly.${proposal?.note ? ` ${proposal.note}` : ''}`,
    };
  }
  const confirmation = daoStep.riskConfirmation;
  const signArgsFor = (proposal?: ProposalSeen) =>
    buildBatchSignTransactionActionArgs(
      { ...batch(proposal), riskConfirmation: confirmation },
      { allowMainnet: options.allowMainnet, chainIds: options.chainIds },
    );
  let signArgs: ReturnType<typeof buildBatchSignTransactionActionArgs>;
  try {
    // The confirmation is checked before anything is read.
    signArgs = signArgsFor();
  } catch (error) {
    return invalid(error);
  }
  const unavailable = walletUnavailableReason(ctx);
  if (unavailable !== null)
    return { status: 'unavailable', error: unavailable };
  const claim = await store.claim(ctx.user.did, ctx.session.id, turn);
  if (claim !== 'ok')
    return refusedBy({
      retryable: false,
      message: unconfirmedRefusal(claim, tool),
    });
  // Read again right before sending: the proposal may have changed since
  // the preview (voting closed, another member carried it out).
  const proposal = await check();
  if (proposal && !proposal.ok) return refusedBy(proposal);
  if (proposal) {
    const missing = unaccepted(actionRisks(proposal), confirmation);
    if (missing.length > 0)
      return {
        status: 'validation_error',
        error: `Risk confirmation required before signing: the proposal’s actions carry risks the user must accept, word for word: ${missing.map((risk) => JSON.stringify(risk)).join(', ')}. Show the preview again (call without riskConfirmation) and wait for the user’s answer.`,
      };
    try {
      signArgs = signArgsFor(proposal);
    } catch (error) {
      return invalid(error);
    }
  }
  const outcome = await requestWalletSignature(ctx, {
    args: signArgs,
    callIdPrefix: `dao_${step}`,
    timeoutMs: options.signTimeoutMs,
  });
  const chainId = signArgs.chainId;
  let result: DaoProposalStepResult;
  if (outcome.status === 'signed') {
    result = { ...outcome, step, network, chainId, message: NEXT_STEP[step] };
  } else {
    const unsigned = unsignedResult(outcome, network, chainId, tool, (error) =>
      daoStepHint(step, error),
    );
    result =
      unsigned.status === 'unavailable' ? unsigned : { ...unsigned, step };
  }
  logSigning(ctx, signArgs, result);
  return result;
}

/** How every DAO DAO tool is signed: confirm first, then the wallet. */
export const SIGNING_RULES =
  'Signed by the user in their Portal wallet (Portal chats only); the oracle never signs. Call first without riskConfirmation: nothing is sent and you get the summary and risks to show the user; stop there. Only after they agree in a later message, call again with the same fields and riskConfirmation: a signing call in the same turn as its preview, or with other fields, is refused.';

/** The wallet's answers other than success, as every DAO DAO tool returns them. */
export const UNSIGNED_OUTCOMES =
  'failed (on chain, with the reason and a `hint`), rejected (the user declined), error (nothing sent: the wallet’s reason, often the chain refusing the step, with a `hint`; tell the user that reason), timeout (outcome unknown: do not send it again, ask the user) or unavailable';

const SHARED_RULES = `${SIGNING_RULES} Returns signed, ${UNSIGNED_OUTCOMES}.`;

/** The proposal tools read the proposal first: what that adds to their contract. */
const PROPOSAL_CHECK_RULES =
  "Both calls read the proposal on chain first and answer `refused` (nothing sent) when its state rules the step out or it can't be read (`retryable`: try again later): tell the user its `message` (status, votes, when voting closes). The preview's `proposal` is its state now: tell the user.";

/**
 * The four DAO DAO step tools (writes): `create_dao_proposal`,
 * `vote_on_dao_proposal`, `execute_dao_proposal`, `close_dao_proposal`.
 */
export function createDaoProposalTools(
  options: IxoTransactionToolOptions,
): PluginTool[] {
  return [
    tool(
      (args, ctx) =>
        runDaoStep(ctx, options, 'create_dao_proposal', (sender, network) =>
          proposeStep(args, sender, network),
        ),
      {
        name: 'create_dao_proposal',
        description: `Create a proposal in a DAO DAO group (for example a POD's governance group) the user is a member of, from their own account. Find the group's \`intake\` with chain_lookup daos (or the POD's \`governingGroup\` with chain_lookup entity). Title and description are the user's own words. ${SHARED_RULES}`,
        schema: proposeSchema,
      },
    ),
    tool(
      (args, ctx) =>
        runDaoStep(ctx, options, 'vote_on_dao_proposal', (sender, network) =>
          voteStep(args, sender, network),
        ),
      {
        name: 'vote_on_dao_proposal',
        description: `Vote yes, no or abstain on an open proposal of a DAO DAO group, from the user's own account: only a member with voting power when the proposal opened can vote. Before asking how they vote, tell the user the proposal's title, label and when voting closes (chain_lookup dao_proposals); never vote without the user saying how. A vote is refused once voting closed; on a proposal whose result is already decided it is still recorded but cannot change it. ${PROPOSAL_CHECK_RULES} ${SHARED_RULES}`,
        schema: voteSchema,
      },
    ),
    tool(
      (args, ctx) =>
        runDaoStep(ctx, options, 'execute_dao_proposal', (sender, network) =>
          settleStep('execute', args, sender, network),
        ),
      {
        name: 'execute_dao_proposal',
        description: `Carry out a passed proposal of a DAO DAO group (\`canRun\` in chain_lookup dao_proposals): the group's own account does every action in it, which cannot be undone. Only when the user asks for it. Only a proposal whose status is passed: in a group that lets members change their votes, a proposal stays open until voting closes even with enough yes votes, and can be carried out only then. ${PROPOSAL_CHECK_RULES} ${SHARED_RULES}`,
        schema: proposalStepSchema,
      },
    ),
    tool(
      (args, ctx) =>
        runDaoStep(ctx, options, 'close_dao_proposal', (sender, network) =>
          settleStep('close', args, sender, network),
        ),
      {
        name: 'close_dao_proposal',
        description: `Close a proposal of a DAO DAO group that did not pass (\`canClose\` in chain_lookup dao_proposals), so none of its actions happen. Only when the user asks for it; only a rejected proposal can be closed. ${PROPOSAL_CHECK_RULES} ${SHARED_RULES}`,
        schema: proposalStepSchema,
      },
    ),
  ];
}

/* ── a new group ──────────────────────────────────────────────────────── */

/** What `create_dao_group` returns to the model. */
export type CreateDaoGroupResult =
  | {
      /** Nothing was sent: the group to show the user, and every risk. */
      status: 'confirm';
      network: Network;
      name: string;
      /** Published with the group; empty when the user gave none. */
      description: string;
      members: string[];
      threshold: number;
      votingPeriodSeconds: number;
      allowRevoting: boolean;
      summary: string;
      risks: string[];
      message: string;
    }
  | {
      status: 'created';
      network: Network;
      name: string;
      txHash?: string;
      /** The group (`dao` in chain_lookup); absent while its transaction could not be read. */
      coreAddress?: string;
      /** Its proposal list: `proposalModule` of the vote, carry-out and close tools. */
      proposalModule?: string;
      /** Its intake: `intake` of create_dao_proposal. */
      intake?: string;
      message: string;
    }
  | {
      /**
       * Nothing was sent: not confirmed in a later message than its
       * preview, or this exact group was already sent in this
       * conversation (`retryable`: a read that can be tried again).
       */
      status: 'refused';
      retryable: boolean;
      message: string;
    }
  | UnsignedResult
  | NotSignable;

const createGroupSchema = z
  .strictObject({
    name: publishedText(
      DAODAO_MAX_NAME_LENGTH,
      `The group’s public name, as the user chose it (one line, at most ${DAODAO_MAX_NAME_LENGTH} characters).`,
    ),
    members: groupMembersField(
      `The members’ ixo1… account addresses, each with one vote, exactly as the user gave or confirmed them (at most ${MAX_DAO_GROUP_MEMBERS}, each once). The user’s own account must be one of them. Never invent or complete one.`,
    ),
    threshold: groupThresholdField,
    votingPeriodSeconds: groupVotingPeriodField,
    allowRevoting: groupAllowRevotingField,
    description: publishedText(
      DAODAO_MAX_DESCRIPTION_LENGTH,
      'Optional: what the group is for, as the user wants it published (one line, plain text).',
    ).optional(),
    riskConfirmation,
    txHash: z
      .string()
      .regex(TX_HASH_PATTERN, 'expected a 64-character hex transaction hash')
      .optional()
      .describe(
        'Only when create_dao_group said this exact group was sent earlier and its outcome is unknown: the transaction hash from the user’s wallet, with the same fields, to read that attempt back. Nothing is sent then.',
      ),
  })
  .superRefine((input, issues) => {
    const seen = new Set<string>();
    input.members.forEach((member, index) => {
      if (seen.has(member))
        issues.addIssue({
          code: 'custom',
          path: ['members', index],
          message: `${member} is listed twice: each member is listed once, with one vote`,
        });
      seen.add(member);
    });
    if (input.threshold > input.members.length)
      issues.addIssue({
        code: 'custom',
        path: ['threshold'],
        message: `A proposal can need at most as many yes votes as the group has members (${input.members.length})`,
      });
  });

/**
 * What the user approves for a new group: its name, every member, the
 * threshold and the voting rules. Every value fits the wallet's 1000
 * characters at the bounds (12 members, a 64-character name); the
 * description does not always, so it is shown in the preview and in the
 * wallet's view of the message.
 */
function newGroupSummary(
  network: Network,
  sender: string,
  group: DaoGroupSpec,
): string {
  return `Create the DAO DAO group "${group.name}" on ${network} from your account ${sender}: ${membersText(group.members)}. ${passRuleText(group)} You are a member.`;
}

/** What the model tells the user once the group exists, by what the transaction showed. */
function createdMessage(found: Extract<DaoGroupLookup, { status: 'found' }>) {
  const lists =
    found.proposalModule !== undefined && found.intake !== undefined
      ? 'For its proposals, pass `intake` to create_dao_proposal and `proposalModule` to vote_on_dao_proposal, execute_dao_proposal and close_dao_proposal.'
      : 'Its proposal list and intake were not both in the transaction: read them with chain_lookup daos before creating a proposal (the index is seconds behind).';
  return `The group exists at coreAddress. Tell the user its name and address. ${lists} chain_lookup daos lists it among the user’s groups once indexed (seconds behind). If it is to govern a POD or other entity the user controls, link_dao_group with this coreAddress links it.`;
}

/** The new group's result once its transaction was read (`found`), as the model gets it. */
function createdResult(
  network: Network,
  name: string,
  txHash: string,
  found: Extract<DaoGroupLookup, { status: 'found' }>,
): Extract<CreateDaoGroupResult, { status: 'created' }> {
  return {
    status: 'created',
    network,
    name,
    txHash,
    coreAddress: found.coreAddress,
    ...(found.proposalModule !== undefined
      ? { proposalModule: found.proposalModule }
      : {}),
    ...(found.intake !== undefined ? { intake: found.intake } : {}),
    message: createdMessage(found),
  };
}

/** A moment as people read it: `2026-11-16 07:13 UTC`. */
export const utc = (ms: number) =>
  `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** Why the same group is not sent again, by what became of the attempt that blocks it. */
function attemptedRefusal(attempt: GroupAttempt): string {
  switch (attempt.state) {
    case 'created':
      return `Nothing was sent: this exact group was already created in this conversation${attempt.coreAddress ? ` (${attempt.coreAddress})` : ''}${attempt.txHash ? `, in transaction ${attempt.txHash}` : ''}; a group is created once. Tell the user; chain_lookup daos lists it among their groups (seconds behind). A different group needs different choices from the user.`;
    case 'sending':
      return 'Nothing was sent: this exact group is being sent to the user’s wallet right now. Do not send it again; wait for that answer.';
    case 'unknown':
      return `Nothing was sent: this exact group was sent to the user’s wallet earlier in this conversation and its answer never arrived, so it may exist. Do not send it again. Check with chain_lookup daos whether it is among the user’s groups (seconds behind); if the user has the transaction hash from their wallet, call create_dao_group again with the same fields and txHash to read it back. Only if neither shows it may this exact group be shown and sent again, after ${utc(attempt.at + GROUP_ATTEMPT_HOLD_MS)}.`;
  }
}

/**
 * Read back a group whose wallet answer was lost, by the hash the user
 * gave: found, the attempt is recorded created; anything else leaves its
 * outcome unknown. Nothing is sent.
 */
async function readBackGroup(
  ctx: RuntimeContext,
  store: KvDaoConfirmationStore,
  attempt: { digest: string; txHash: string },
  input: { sender: string; group: DaoGroupSpec; network: Network },
): Promise<CreateDaoGroupResult> {
  const found = await findDaoGroup(
    oracleChainCall(ctx, TOOL_BUDGET_MS),
    { ...input, txHash: attempt.txHash },
    {
      label: 'dao group transaction',
      tag: '[ixo-transaction]',
      what: 'the group',
    },
  );
  if (found.status !== 'found')
    return {
      status: 'refused',
      retryable: found.retryable,
      message: `Nothing was sent: ${found.message} The earlier attempt’s outcome stays unknown${found.retryable ? '; try reading it again in a moment' : ''}.`,
    };
  await store.settleGroup(ctx.user.did, ctx.session.id, attempt.digest, {
    state: 'created',
    txHash: attempt.txHash,
    coreAddress: found.coreAddress,
  });
  ctx.logger.log(
    `[ixo-transaction] dao group ${found.coreAddress} read back user=${ctx.user.did} tx=${attempt.txHash}`,
  );
  return createdResult(input.network, input.group.name, attempt.txHash, found);
}

async function createDaoGroup(
  ctx: RuntimeContext,
  options: IxoTransactionToolOptions,
  args: unknown,
): Promise<CreateDaoGroupResult> {
  const signer = daoSigner(ctx, options, 'no group is created here.');
  if (!('ok' in signer)) return signer;
  const confirmations = confirmationsOf(ctx);
  if (!('ok' in confirmations)) return confirmations;
  const { store } = confirmations;
  const { sender, network } = signer;
  let input: z.infer<typeof createGroupSchema>;
  let message: ITrxMsg;
  let group: DaoGroupSpec;
  try {
    input = createGroupSchema.parse(args);
    group = {
      name: input.name,
      members: input.members,
      threshold: input.threshold,
      votingPeriodSeconds:
        input.votingPeriodSeconds ?? DAODAO_VOTING_PERIOD_SECONDS.default,
      allowRevoting: input.allowRevoting ?? DAODAO_DEFAULT_ALLOW_REVOTING,
    };
    // A group its creator is not in is almost always a slip: they could
    // not propose, vote or carry out anything in it, and it would not be
    // among their groups in chain_lookup daos.
    if (!group.members.includes(sender))
      return {
        status: 'validation_error',
        error: `Nothing was sent: your own account ${sender} is not one of the members. A group is created here only with its creator as a member, since otherwise you could not propose, vote or carry out anything in it. Ask the user to add their account to the members, or to have one of the members create the group.`,
      };
    message = buildDaoDaoGroupInstantiate(network, {
      sender,
      ...group,
      description: input.description ?? '',
    });
  } catch (error) {
    return {
      status: 'validation_error',
      error: describeValidationError(error),
    };
  }
  const description = input.description ?? '';
  // The group as the user is shown it and as it is signed, and the key of
  // its one creation in this conversation.
  const digest = await operationKey('create_dao_group', {
    network,
    sender,
    ...group,
    description,
  });
  const attempt = await store.groupAttempt(
    ctx.user.did,
    ctx.session.id,
    digest,
  );
  if (input.txHash !== undefined) {
    if (!attempt || attempt.state === 'created')
      return {
        status: 'validation_error',
        error: attempt
          ? attemptedRefusal(attempt)
          : 'txHash only reads back this exact group after create_dao_group said its earlier attempt’s outcome is unknown; there is none in this conversation. To create the group, call create_dao_group without txHash.',
      };
    return readBackGroup(
      ctx,
      store,
      { digest, txHash: input.txHash },
      { sender, group, network },
    );
  }
  if (attempt)
    return {
      status: 'refused',
      retryable: false,
      message: attemptedRefusal(attempt),
    };
  const batch = {
    network,
    summary: newGroupSummary(network, sender, group),
    messages: [message],
  };
  const turn = { digest, requestId: ctx.session.requestId };

  if (!input.riskConfirmation) {
    let validated: ReturnType<typeof validateTransactionBatch>;
    try {
      validated = validateTransactionBatch(batch, {
        allowMainnet: options.allowMainnet,
      });
    } catch (error) {
      return {
        status: 'validation_error',
        error: describeValidationError(error),
      };
    }
    await store.preview(ctx.user.did, ctx.session.id, turn);
    return {
      status: 'confirm',
      network,
      ...group,
      description,
      summary: validated.summary,
      risks: validated.risks,
      message:
        'Nothing was sent. Show the user this group exactly (its name, every member address, how many yes votes pass a proposal, how long voting lasts, whether votes can be changed, and the description if any) and every risk, word for word, and stop. Only when they agree in a later message, call create_dao_group again with the same fields and riskConfirmation quoting each risk exactly.',
    };
  }
  let signArgs: ReturnType<typeof buildBatchSignTransactionActionArgs>;
  try {
    signArgs = buildBatchSignTransactionActionArgs(
      { ...batch, riskConfirmation: input.riskConfirmation },
      { allowMainnet: options.allowMainnet, chainIds: options.chainIds },
    );
  } catch (error) {
    return {
      status: 'validation_error',
      error: describeValidationError(error),
    };
  }
  const unavailable = walletUnavailableReason(ctx);
  if (unavailable !== null)
    return { status: 'unavailable', error: unavailable };
  const claim = await store.claimGroup(ctx.user.did, ctx.session.id, turn);
  switch (claim.status) {
    case 'attempted':
      return {
        status: 'refused',
        retryable: false,
        message: attemptedRefusal(claim.attempt),
      };
    case 'not-previewed':
    case 'same-request':
      return {
        status: 'refused',
        retryable: false,
        message: unconfirmedRefusal(claim.status, 'create_dao_group'),
      };
    case 'ok':
      break;
  }
  const settle = (settlement: GroupSettlement) =>
    store.settleGroup(ctx.user.did, ctx.session.id, digest, settlement);
  const outcome = await requestWalletSignature(ctx, {
    args: signArgs,
    callIdPrefix: 'dao_create_group',
    timeoutMs: options.signTimeoutMs,
  });
  if (outcome.status !== 'signed') {
    // A timeout may still be signed: the same group stays blocked. Anything
    // else made no group, so it can be shown and sent again.
    await settle(
      outcome.status === 'timeout'
        ? { state: 'unknown' }
        : { state: 'released' },
    );
    // No DAO DAO contract has run yet, so no group refusal to explain.
    const result = unsignedResult(
      outcome,
      network,
      signArgs.chainId,
      'create_dao_group',
      () => undefined,
    );
    logSigning(ctx, signArgs, result);
    return result;
  }
  const txHash = outcome.transactionHash;
  const created = { status: 'created' as const, network, name: group.name };
  let result: CreateDaoGroupResult;
  if (txHash === undefined) {
    await settle({ state: 'created' });
    result = {
      ...created,
      message:
        'The wallet reports the group signed but returned no transaction hash, so its address cannot be read here. Do not create it again: chain_lookup daos lists the user’s groups, this one included once indexed (seconds behind).',
    };
  } else {
    // The wallet answers with the hash only: the group's address is in
    // the transaction's events, read back within the tool's budget.
    const found = await findDaoGroup(
      oracleChainCall(ctx, TOOL_BUDGET_MS),
      { txHash, sender, group, network },
      {
        label: 'dao group transaction',
        tag: '[ixo-transaction]',
        what: 'the group',
      },
    );
    await settle({
      state: 'created',
      txHash,
      ...(found.status === 'found' ? { coreAddress: found.coreAddress } : {}),
    });
    if (found.status === 'found') {
      result = createdResult(network, group.name, txHash, found);
    } else {
      ctx.logger.warn(
        `[ixo-transaction] dao group ${found.status} user=${ctx.user.did} tx=${txHash}: ${found.message}`,
      );
      result = {
        ...created,
        txHash,
        message:
          found.status === 'failed'
            ? `The wallet reports the group signed, but its transaction does not show it (${found.message}). Tell the user to check the transaction in their wallet; do not create the group again unless they ask.`
            : `The wallet reports the group signed, but its address cannot be read yet. ${found.message} Do not create the group again: chain_lookup daos lists it among the user’s groups once indexed (seconds behind).`,
      };
    }
  }
  logSigning(ctx, signArgs, result);
  return result;
}

/** `create_dao_group` (a write): a DAO DAO group of its own, not a POD's. */
export function createDaoGroupTool(
  options: IxoTransactionToolOptions,
): PluginTool {
  return tool((args, ctx) => createDaoGroup(ctx, options, args), {
    name: 'create_dao_group',
    description: `Create a new DAO DAO group (a multisig: each member one vote, a proposal passes with \`threshold\` yes votes) from the user's own account, signed in their Portal wallet; the user must be one of the members. For the governance group of a POD created in this conversation, use create_pod_group instead (it also links the group to the POD); to make a new group govern an existing POD or other entity, create it here, then link it with link_dao_group. Only when the user asks for a group, with the name, members and threshold they gave or confirmed: never invent or complete a member address. ${GROUP_VOTING_RULES_GUIDANCE} ${SIGNING_RULES} Each group is sent once per conversation: the same group again is refused while it is being signed, once created, and after a timeout until chain_lookup daos or its transaction hash (\`txHash\`) shows what happened. Returns created (signed: the group's \`coreAddress\` and, when the transaction shows them, its \`proposalModule\` and \`intake\` for the proposal tools), refused (nothing sent: tell the user its \`message\`), ${UNSIGNED_OUTCOMES}.`,
    schema: createGroupSchema,
  });
}
