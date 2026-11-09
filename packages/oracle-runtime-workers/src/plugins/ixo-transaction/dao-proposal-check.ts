/**
 * The check the DAO DAO vote, carry-out and close tools run on a proposal
 * before they show or send a step: one CosmWasm smart query of the proposal
 * module (`{ proposal: { proposal_id } }` through chain REST, under the
 * ixo-chain retry policy and permits), then whether the step can succeed by
 * the rules of DAO DAO 2.0.3 `dao-proposal-single`:
 *
 * - vote: the contract refuses a vote once the proposal's voting time is
 *   over (`Expired`), whatever its status; before that a vote is recorded
 *   even when the result is already decided (it cannot change it).
 * - execute: only a `passed` proposal (`NotPassed` otherwise). A proposal
 *   whose run failed is `execution_failed` and is never run again.
 * - close: only a `rejected` proposal (`WrongCloseStatus` otherwise).
 *
 * The query answers the proposal's current status (the contract recomputes
 * it at the block it answers for), so an expired open proposal already
 * reads `passed` or `rejected`. A group that lets members change their
 * votes keeps a proposal `open` until voting closes, even with enough yes
 * votes; the refusal then says when it will pass and can be carried out.
 *
 * The same answer carries the proposal's actions (`msgs`): what carrying it
 * out makes the group's own account do, read with `readProposalAction` so
 * the carry-out's summary and risks name each of them.
 */
import type { DaoDaoExecuteAction } from '@ixo/ixo-transaction';
import { z } from 'zod';
import type { RuntimeContext } from '../../plugin-api/types';
import { bytesToBase64 } from '../base64';
import type { ChainCall } from '../ixo-chain/http';
import { chainRestUrl, networkOf } from '../ixo-chain/ixo-chain.plugin';
import { restJson } from '../ixo-chain/rest';
import { clip } from '../ixo-chain/summaries';
import { readProposalAction, type ProposalAction } from './proposal-actions';

/** The whole check's time: one read, and its one retry when there is time. */
const PROPOSAL_CHECK_BUDGET_MS = 10_000;
/** A proposal answer is its text and up to a few actions: far below this. */
const PROPOSAL_MAX_BYTES = 64 * 1024;
/** A title as the user sees it in a summary or a refusal. */
const TITLE_CHARS = 100;

const UINT = z.string().regex(/^\d{1,40}$/);

/** cw-utils `Expiration`. */
const expirationSchema = z.union([
  z.strictObject({ at_time: z.string().regex(/^\d{1,20}$/) }),
  z.strictObject({ at_height: z.number().int().nonnegative() }),
  z.strictObject({ never: z.strictObject({}) }),
]);

/** dao-voting `PercentageThreshold`. */
const percentageSchema = z.union([
  z.strictObject({ majority: z.strictObject({}) }),
  z.strictObject({ percent: z.string() }),
]);

/** dao-voting `Threshold`. */
export const thresholdSchema = z.union([
  z.strictObject({ absolute_count: z.strictObject({ threshold: UINT }) }),
  z.strictObject({
    absolute_percentage: z.strictObject({ percentage: percentageSchema }),
  }),
  z.strictObject({
    threshold_quorum: z.strictObject({
      threshold: percentageSchema,
      quorum: percentageSchema,
    }),
  }),
]);

const DAODAO_PROPOSAL_STATUSES = [
  'open',
  'rejected',
  'passed',
  'executed',
  'closed',
  'execution_failed',
] as const;

/** `dao-proposal-single` 2.0.3 `ProposalResponse`, the fields the check reads. */
const proposalAnswerSchema = z.object({
  data: z.object({
    id: z.number().int(),
    proposal: z.object({
      title: z.string(),
      status: z.enum(DAODAO_PROPOSAL_STATUSES),
      expiration: expirationSchema,
      min_voting_period: expirationSchema.nullable(),
      threshold: thresholdSchema,
      total_power: UINT,
      votes: z.object({ yes: UINT, no: UINT, abstain: UINT }),
      allow_revoting: z.boolean(),
      /** cw `CosmosMsg`s, each read by `readProposalAction`. */
      msgs: z.array(z.unknown()),
    }),
  }),
});

type DaoProposal = z.infer<typeof proposalAnswerSchema>['data'];
type Expiration = z.infer<typeof expirationSchema>;
type Percentage = z.infer<typeof percentageSchema>;

/** What the check found: a proposal the step can act on, or why not. */
export type ProposalCheck =
  | {
      ok: true;
      /** The proposal's title, one line, clipped, for the summary. */
      title: string;
      /** Its state in plain words: status, tally, threshold, deadline. */
      state: string;
      /** For a vote on a proposal whose result is already decided. */
      note?: string;
      /** What carrying it out does, action by action, in its order. */
      actions: ProposalAction[];
    }
  | { ok: false; retryable: boolean; message: string };

/**
 * Text someone else wrote on chain (a proposal's title, a group's name) as
 * it is shown in a summary or a refusal: one line, no hidden characters,
 * clipped to `max`.
 */
export function plainLine(text: string, max: number): string {
  const line = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(line, max);
}

/** Title text written by the proposer: one line, no hidden characters, clipped. */
function titleOf(proposal: DaoProposal['proposal']): string {
  return plainLine(proposal.title, TITLE_CHARS);
}

/** Epoch ms of an `at_time` expiration; undefined for a height or never. */
function expiresAtMs(expiration: Expiration): number | undefined {
  return 'at_time' in expiration
    ? Number(BigInt(expiration.at_time) / 1_000_000n)
    : undefined;
}

/** A moment as people read it: `2026-11-16 07:13 UTC`. */
function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** When voting closes (or closed, by `now`), in plain words. */
function deadlineText(expiration: Expiration, now: number): string {
  const ms = expiresAtMs(expiration);
  if (ms !== undefined)
    return ms <= now
      ? `Voting closed at ${utc(ms)}.`
      : `Voting closes at ${utc(ms)}.`;
  if ('at_height' in expiration)
    return `Voting closes at block height ${expiration.at_height}.`;
  return 'Voting has no end time.';
}

function percentText(percentage: Percentage): string {
  if ('majority' in percentage) return 'more than half';
  const value = Number(percentage.percent);
  return Number.isFinite(value)
    ? `${+(value * 100).toFixed(2)}%`
    : percentage.percent;
}

const plural = (count: string, word: string) =>
  `${count} ${word}${count === '1' ? '' : 's'}`;

/** What passes a proposal, in plain words. */
export function thresholdText(
  threshold: z.infer<typeof thresholdSchema>,
): string {
  if ('absolute_count' in threshold)
    return `it needs ${plural(threshold.absolute_count.threshold, 'yes vote')} to pass`;
  if ('absolute_percentage' in threshold)
    return `it needs ${percentText(threshold.absolute_percentage.percentage)} of the voting power (abstentions aside) to vote yes`;
  return `it needs ${percentText(threshold.threshold_quorum.threshold)} yes among the votes cast, with a turnout of ${percentText(threshold.threshold_quorum.quorum)}`;
}

const STATUS_WORDS: Record<DaoProposal['proposal']['status'], string> = {
  open: 'open for votes',
  passed: 'passed (not carried out yet)',
  rejected: 'rejected (it did not pass)',
  executed: 'carried out',
  closed: 'closed (it did not pass)',
  execution_failed:
    'carried out, but its actions failed (DAO DAO does not run a proposal again)',
};

/** Whether an absolute-count proposal already has enough yes votes; undefined for a percentage threshold. */
function thresholdMet(proposal: DaoProposal['proposal']): boolean | undefined {
  const { threshold } = proposal;
  return 'absolute_count' in threshold
    ? BigInt(proposal.votes.yes) >= BigInt(threshold.absolute_count.threshold)
    : undefined;
}

/** A proposal's name inside a sentence: its number and, when it has one, its title. */
export function proposalNamed(id: number, title: string | undefined): string {
  return title ? `proposal ${id} ("${title}")` : `proposal ${id}`;
}

/** Status, tally against the threshold, and the deadline, in plain words. */
function proposalState({ id, proposal }: DaoProposal, now: number): string {
  const { votes } = proposal;
  const name = proposalNamed(id, titleOf(proposal));
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} is ${STATUS_WORDS[proposal.status]}. Votes so far: ${votes.yes} yes, ${votes.no} no, ${votes.abstain} abstain, of ${proposal.total_power} voting power; ${thresholdText(proposal.threshold)}. ${deadlineText(proposal.expiration, now)}`;
}

/**
 * Why an open proposal is still open, and when it can pass: with vote
 * changes allowed DAO DAO decides it only when voting closes, even once
 * enough members voted yes; a minimum voting time holds it open too.
 */
function whenItCanPass(proposal: DaoProposal['proposal'], now: number): string {
  const closes = expiresAtMs(proposal.expiration);
  const closing = closes !== undefined ? ` at ${utc(closes)}` : '';
  const minimum = proposal.min_voting_period
    ? expiresAtMs(proposal.min_voting_period)
    : undefined;
  const met = thresholdMet(proposal);
  if (proposal.allow_revoting) {
    const rule =
      'The group lets members change their votes until voting closes, so DAO DAO decides a proposal only when voting closes, even once enough members voted yes';
    return met === true
      ? `${rule}: it already has enough yes votes, so it will pass when voting closes${closing} and can be carried out then.`
      : `${rule}: it passes if it has enough yes votes when voting closes${closing}.`;
  }
  if (met === true && minimum !== undefined && minimum > now)
    return `It already has enough yes votes and will pass once its minimum voting time ends at ${utc(minimum)}; it can be carried out then.`;
  return 'It passes as soon as enough members vote yes.';
}

/**
 * Why a proposal in `proposal`'s status cannot be carried out now (only a
 * `passed` one can); undefined when it can.
 */
function executeRefusal(
  name: string,
  state: string,
  proposal: DaoProposal['proposal'],
  now: number,
): string | undefined {
  switch (proposal.status) {
    case 'passed':
      return undefined;
    case 'open':
      return `Nothing was sent: ${name} cannot be carried out yet. ${state} ${whenItCanPass(proposal, now)}`;
    case 'rejected':
      return `Nothing was sent: ${name} did not pass, so it cannot be carried out; it can be closed instead (close_dao_proposal). ${state}`;
    case 'closed':
      return `Nothing was sent: ${name} did not pass and is already closed. ${state}`;
    case 'executed':
      return `Nothing was sent: ${name} was already carried out. ${state}`;
    case 'execution_failed':
      return `Nothing was sent: ${name} was carried out once and its actions failed; DAO DAO does not run a proposal again, so trying again needs a new proposal. ${state}`;
  }
}

/**
 * Why `step` cannot succeed on this proposal at `now`, as the sentence
 * that tells the user; undefined when it can. The vote check reads an
 * `at_time` deadline only: a deadline in blocks is left to the chain.
 */
function proposalRefusal(
  step: Exclude<DaoDaoExecuteAction, 'propose'>,
  answer: DaoProposal,
  now: number,
): string | undefined {
  const { proposal } = answer;
  const name = proposalNamed(answer.id, titleOf(proposal));
  const state = proposalState(answer, now);
  switch (step) {
    case 'vote': {
      const closes = expiresAtMs(proposal.expiration);
      if (closes === undefined || closes > now) return undefined;
      return `Nothing was sent: voting on ${name} closed at ${utc(closes)}, so the group no longer takes votes on it. ${state}`;
    }
    case 'execute':
      return executeRefusal(name, state, proposal, now);
    case 'close':
      switch (proposal.status) {
        case 'rejected':
          return undefined;
        case 'open':
          return `Nothing was sent: ${name} cannot be closed while it is open: only a proposal that did not pass can be closed. ${state} ${proposal.allow_revoting ? 'It is decided when voting closes.' : 'It is rejected when voting closes without enough yes votes, or as soon as too few votes are left for it to pass.'}`;
        case 'passed':
          return `Nothing was sent: ${name} passed, so it cannot be closed; it can be carried out instead (execute_dao_proposal). ${state}`;
        case 'closed':
          return `Nothing was sent: ${name} is already closed. ${state}`;
        case 'executed':
          return `Nothing was sent: ${name} was carried out, so there is nothing to close. ${state}`;
        case 'execution_failed':
          return `Nothing was sent: ${name} was carried out and its actions failed; that is final and it cannot be closed. ${state}`;
      }
  }
}

/** A vote on a proposal whose result is decided, before voting closes: recorded, but cannot change it. */
function decidedNote(answer: DaoProposal): string | undefined {
  const { proposal } = answer;
  if (proposal.status === 'open') return undefined;
  const closes = expiresAtMs(proposal.expiration);
  return `Its result is already decided (${STATUS_WORDS[proposal.status]}): DAO DAO still records a vote${closes !== undefined ? ` until voting closes at ${utc(closes)}` : ' until voting closes'}, but the vote cannot change the result. Tell the user before they decide.`;
}

/**
 * A DAO tool's chain reads: the oracle's network and chain REST, one
 * budget of `budgetMs` from now.
 */
export function oracleChainCall(
  ctx: RuntimeContext,
  budgetMs: number,
): ChainCall {
  return {
    network: networkOf(ctx.config),
    restUrl: chainRestUrl(ctx.config),
    blocksyncUrl: '',
    // The user's reads share ixo-chain's per-user permits.
    user: ctx.user.did,
    deadline: Date.now() + budgetMs,
    signal: ctx.abortSignal,
    // Looked up per call, as in ixo-chain: workerd rejects a foreign `this`.
    fetch: (input, init) => globalThis.fetch(input, init),
  };
}

/** The chain REST path of a CosmWasm smart query of `contract`: the query as base64 of its JSON. */
export function smartQueryPath(contract: string, query: unknown): string {
  return `/cosmwasm/wasm/v1/contract/${contract}/smart/${encodeURIComponent(
    bytesToBase64(new TextEncoder().encode(JSON.stringify(query))),
  )}`;
}

const VERB: Record<Exclude<DaoDaoExecuteAction, 'propose'>, string> = {
  vote: 'voted on',
  execute: 'carried out',
  close: 'closed',
};

/**
 * Read proposal `proposalId` of `proposalModule` and check that `step` can
 * succeed on it now. A proposal the chain does not have (the contract
 * refuses the query) and an answer that is not a single-choice proposal are
 * refusals the user must fix; a read that failed is a retryable refusal,
 * never a guess.
 */
export async function checkDaoProposal(
  ctx: RuntimeContext,
  target: {
    step: Exclude<DaoDaoExecuteAction, 'propose'>;
    proposalModule: string;
    proposalId: number;
  },
): Promise<ProposalCheck> {
  const { step } = target;
  const read = await restJson(
    oracleChainCall(ctx, PROPOSAL_CHECK_BUDGET_MS),
    smartQueryPath(target.proposalModule, {
      proposal: { proposal_id: target.proposalId },
    }),
    proposalAnswerSchema,
    {
      label: 'dao proposal',
      tag: '[ixo-transaction]',
      maxBytes: PROPOSAL_MAX_BYTES,
      contractQuery: true,
    },
  );
  if (!read.ok) {
    const { failure } = read;
    if (failure.reason === 'invalid_input')
      return {
        ok: false,
        retryable: false,
        message: `Nothing was sent: the chain has no proposal ${target.proposalId} in the proposal list ${target.proposalModule} (${failure.detail}). Check the proposalModule and the proposal id with chain_lookup dao_proposals.`,
      };
    return {
      ok: false,
      retryable: failure.retryable,
      message: `Nothing was sent: proposal ${target.proposalId} could not be read from the chain to check that it can be ${VERB[step]} (${failure.detail})${failure.retryable ? ' Try again in a moment.' : ' It may not be a single-choice DAO DAO proposal, which these tools act on.'}`,
    };
  }
  const answer = read.value.data;
  const now = Date.now();
  const refusal = proposalRefusal(step, answer, now);
  if (refusal !== undefined)
    return { ok: false, retryable: false, message: refusal };
  const note = step === 'vote' ? decidedNote(answer) : undefined;
  return {
    ok: true,
    title: titleOf(answer.proposal),
    state: proposalState(answer, now),
    ...(note !== undefined ? { note } : {}),
    actions: answer.proposal.msgs.map(readProposalAction),
  };
}
